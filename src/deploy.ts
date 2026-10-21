import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { AgentHubConfig, DeployProjectConfig } from './config.js';
import { ProjectRepo, ProjectRow } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { ensureIntegrationWorktree } from './projects/integration.js';
import { runInProcessGroup } from './priority.js';

export interface DeployStatus {
  projectId: string;
  status: 'queued' | 'running' | 'restarting' | 'succeeded' | 'failed' | 'skipped';
  startedAt?: string;
  finishedAt?: string;
  commit?: string;
  error?: string;
  logPath?: string;
}

type GitRunner = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>;

export class DeployService {
  private pending = new Map<string, { commit?: string; timer?: NodeJS.Timeout }>();
  private latest = new Map<string, DeployStatus>();
  private running = false;

  constructor(
    private config: AgentHubConfig,
    private projectRepo: ProjectRepo,
    private eventBus: EventBus,
    private debounceMs = 60_000,
    private commandRunner: GitRunner = async (cwd, args) => {
      const result = await runInProcessGroup('git', args, { cwd, env: process.env, timeoutMs: 120_000, maxOutput: 1024 * 1024 });
      return { code: result.code ?? 1, output: result.output };
    },
  ) {}

  start(): void {
    this.restoreRestartState();
    this.eventBus.on('task.merged', (_taskId, payload) => {
      const value = (payload && typeof payload === 'object' ? payload : {}) as { projectId?: string; mergeCommit?: string };
      const taskId = _taskId || '';
      const projectId = value.projectId || taskId.split('/')[0];
      if (projectId) this.schedule(projectId, value.mergeCommit);
    });
  }

  private restoreRestartState(): void {
    const statePath = path.join(this.config.hubHome, 'deploy-restart.json');
    try {
      if (!fs.existsSync(statePath)) return;
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { projectId?: string; commit?: string; logPath?: string };
      if (!state.projectId) return;
      fs.rmSync(statePath, { force: true });
      const status: DeployStatus = { projectId: state.projectId, status: 'succeeded', finishedAt: new Date().toISOString(), commit: state.commit, logPath: state.logPath };
      this.latest.set(state.projectId, status);
      this.eventBus.emit('deploy.succeeded', undefined, { projectId: state.projectId, commit: state.commit, logPath: state.logPath, afterRestart: true });
    } catch {
      // A malformed recovery marker must not prevent the daemon from starting.
    }
  }

  private definition(projectId: string): DeployProjectConfig | undefined {
    return this.config.deploy?.[projectId];
  }

  schedule(projectId: string, commit?: string): void {
    if (!this.definition(projectId)) return;
    const existing = this.pending.get(projectId);
    if (existing?.timer) clearTimeout(existing.timer);
    const entry: { commit?: string; timer?: NodeJS.Timeout } = { commit: commit || existing?.commit };
    entry.timer = setTimeout(() => {
      this.pending.delete(projectId);
      void this.run(projectId, entry.commit);
    }, this.debounceMs);
    entry.timer.unref();
    this.pending.set(projectId, entry);
    this.latest.set(projectId, { projectId, status: 'queued' });
  }

  async run(projectId: string, commit?: string): Promise<DeployStatus> {
    const definition = this.definition(projectId);
    const project = this.projectRepo.get(projectId);
    if (!definition || !project) return { projectId, status: 'skipped' };
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
    this.running = true;
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.config.logsDir, 'deploy', projectId);
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${Date.now()}.log`);
    const write = (line: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    const status: DeployStatus = { projectId, status: 'running', startedAt, commit, logPath };
    this.latest.set(projectId, status);
    this.eventBus.emit('deploy.started', undefined, { projectId, commit, logPath });
    write(`deploy started project=${projectId} commit=${commit || 'unknown'}`);
    try {
      const worktree = ensureIntegrationWorktree(project, this.config.hubHome);
      for (const [index, argv] of definition.steps.entries()) {
        if (!argv.length) continue;
        write(`step ${index + 1}: ${JSON.stringify(argv)}`);
        const result = await runInProcessGroup(argv[0], argv.slice(1), {
          cwd: worktree,
          env: process.env,
          timeoutMs: definition.timeoutSec * 1000,
        });
        if (result.output) write(result.output.replace(/\n$/, ''));
        if (result.code !== 0 || result.timedOut) throw new Error(`Bước ${index + 1} thất bại${result.timedOut ? ' do timeout' : ` (exit ${result.code})`}`);
      }
      if (definition.push) {
        if (!definition.push.ffOnly) throw new Error('push chỉ hỗ trợ ffOnly');
        const ff = await this.commandRunner(worktree, ['merge', '--ff-only', definition.push.from]);
        write(`git merge --ff-only ${definition.push.from}\n${ff.output}`);
        if (ff.code !== 0) throw new Error(`Không thể fast-forward ${definition.push.to}`);
        const pushed = await this.commandRunner(worktree, ['push', definition.push.remote, `${definition.push.to}`]);
        write(`remote push ${definition.push.remote} ${definition.push.to}\n${pushed.output}`);
        if (pushed.code !== 0) throw new Error(`git push thất bại (exit ${pushed.code})`);
      }
      status.status = definition.restartHub && this.isHubProject(project) ? 'restarting' : 'succeeded';
      status.finishedAt = new Date().toISOString();
      write(status.status === 'restarting' ? 'deploy completed; hub is restarting' : 'deploy succeeded');
      if (status.status === 'succeeded') this.eventBus.emit('deploy.succeeded', undefined, { projectId, commit, logPath });
    } catch (error) {
      status.status = 'failed';
      status.finishedAt = new Date().toISOString();
      status.error = error instanceof Error ? error.message : String(error);
      write(`deploy failed: ${status.error}`);
      this.eventBus.emit('deploy.failed', undefined, { projectId, commit, logPath, error: status.error, level: 'incident' });
    } finally {
      this.latest.set(projectId, { ...status });
      this.running = false;
    }
    if (status.status === 'restarting') {
      this.eventBus.emit('deploy.restarting', undefined, { projectId, commit, logPath });
      this.restartHub(projectId, commit, logPath);
    }
    return status;
  }

  private isHubProject(project: ProjectRow): boolean {
    try { return path.resolve(project.path) === path.resolve(process.cwd()); } catch { return false; }
  }

  private restartHub(projectId: string, commit: string | undefined, logPath: string): void {
    const command = process.platform === 'darwin' ? 'launchctl' : (process.env.AGENTHUB_SYSTEMCTL || 'systemctl');
    const args = process.platform === 'darwin' ? ['kickstart', '-k', `gui/${process.getuid?.() ?? os.userInfo().uid}/dev.agenthub`] : ['--user', 'restart', 'agenthub', '--no-block'];
    const statePath = path.join(this.config.hubHome, 'deploy-restart.json');
    fs.writeFileSync(statePath, JSON.stringify({ projectId, commit, logPath }));
    const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }

  getStatus(projectId: string): DeployStatus | null { return this.latest.get(projectId) || null; }
  getAllStatus(): DeployStatus[] { return [...this.latest.values()]; }
  async rerun(projectId: string): Promise<DeployStatus> { return this.run(projectId); }
}
