import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentHubConfig, DeployProjectConfig } from './config.js';
import { ProjectRepo, ProjectRow } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { ensureIntegrationWorktree } from './projects/integration.js';
import { projectSettings } from './projects/settings.js';
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
type ProcessRunner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; output: string; timedOut?: boolean }>;
type RestartRunner = (command: string, args: string[]) => { on?: (event: string, listener: (error: Error) => void) => unknown } | void;

const hubPackageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class DeployService {
  private pending = new Map<string, { commit?: string; timer?: NodeJS.Timeout }>();
  private latest = new Map<string, DeployStatus>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private config: AgentHubConfig,
    private projectRepo: ProjectRepo,
    private eventBus: EventBus,
    private debounceMs = 60_000,
    private commandRunner: GitRunner = async (cwd, args) => {
      const result = await runInProcessGroup('git', args, { cwd, env: process.env, timeoutMs: 120_000, maxOutput: 1024 * 1024 });
      return { code: result.code ?? 1, output: result.output };
    },
    private processRunner: ProcessRunner = async (command, args, options) => {
      const result = await runInProcessGroup(command, args, options);
      return { code: result.code ?? 1, output: result.output, timedOut: result.timedOut };
    },
    private restartRunner: RestartRunner = (command, args) => {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      return child;
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
      this.enqueue(projectId, entry.commit);
    }, this.debounceMs);
    entry.timer.unref();
    this.pending.set(projectId, entry);
    this.latest.set(projectId, { projectId, status: 'queued' });
  }

  private enqueue(projectId: string, commit?: string): DeployStatus {
    const queued: DeployStatus = { projectId, status: 'queued', commit };
    this.latest.set(projectId, queued);
    this.queue = this.queue
      .then(() => this.execute(projectId, commit))
      .then(() => undefined)
      .catch((error) => console.error(`[deploy] ${projectId} failed outside execute`, error));
    return queued;
  }

  async run(projectId: string, commit?: string): Promise<DeployStatus> {
    let result: DeployStatus | undefined;
    const previous = this.queue;
    this.queue = previous
      .then(async () => { result = await this.execute(projectId, commit); })
      .catch((error) => console.error(`[deploy] ${projectId} failed outside execute`, error));
    await this.queue;
    return result || { projectId, status: 'skipped' };
  }

  private async execute(projectId: string, commit?: string): Promise<DeployStatus> {
    const definition = this.definition(projectId);
    const project = this.projectRepo.get(projectId);
    if (!definition || !project) return { projectId, status: 'skipped' };
    const startedAt = new Date().toISOString();
    const logDir = path.join(this.config.logsDir, 'deploy', projectId);
    const logPath = path.join(logDir, `${Date.now()}.log`);
    const write = (line: string) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    const status: DeployStatus = { projectId, status: 'running', startedAt, commit, logPath };
    try {
      fs.mkdirSync(logDir, { recursive: true });
      this.latest.set(projectId, status);
      this.eventBus.emit('deploy.started', undefined, { projectId, commit, logPath });
      write(`deploy started project=${projectId} commit=${commit || 'unknown'}`);
      const worktree = this.resolveWorktree(project);
      if (!worktree) {
        status.status = 'skipped';
        status.finishedAt = new Date().toISOString();
        status.error = 'Không có worktree đích tích hợp được cấu hình';
        write(`deploy skipped: ${status.error}`);
        this.latest.set(projectId, { ...status });
        return status;
      }
      for (const [index, argv] of definition.steps.entries()) {
        if (!argv.length) continue;
        write(`step ${index + 1}: ${JSON.stringify(argv)}`);
        const result = await this.processRunner(argv[0], argv.slice(1), {
          cwd: worktree,
          env: process.env,
          timeoutMs: definition.timeoutSec * 1000,
        });
        if (result.output) write(result.output.replace(/\n$/, ''));
        if (result.code !== 0 || result.timedOut) throw new Error(`Bước ${index + 1} thất bại${result.timedOut ? ' do timeout' : ` (exit ${result.code})`}`);
      }
      if (definition.push) {
        if (!definition.push.ffOnly) throw new Error('push chỉ hỗ trợ ffOnly');
        const pushed = await this.commandRunner(worktree, ['push', definition.push.remote, `${definition.push.from}:refs/heads/${definition.push.to}`]);
        write(`remote push ${definition.push.remote} ${definition.push.from}:refs/heads/${definition.push.to}\n${pushed.output}`);
        if (pushed.code !== 0) throw new Error(`git push thất bại (exit ${pushed.code})`);
      }
      status.status = definition.restartHub && this.isHubProject(project) ? 'restarting' : 'succeeded';
      status.finishedAt = new Date().toISOString();
      write(status.status === 'restarting' ? 'deploy completed; hub is restarting' : 'deploy succeeded');
      if (status.status === 'restarting') {
        this.eventBus.emit('deploy.restarting', undefined, { projectId, commit, logPath });
        this.restartHub(status);
      } else {
        this.eventBus.emit('deploy.succeeded', undefined, { projectId, commit, logPath });
      }
    } catch (error) {
      status.status = 'failed';
      status.finishedAt = new Date().toISOString();
      status.error = error instanceof Error ? error.message : String(error);
      write(`deploy failed: ${status.error}`);
      this.eventBus.emit('deploy.failed', undefined, { projectId, commit, logPath, error: status.error, level: 'incident' });
    } finally {
      this.latest.set(projectId, { ...status });
    }
    return status;
  }

  private isHubProject(project: ProjectRow): boolean {
    try { return fs.realpathSync(project.path) === fs.realpathSync(hubPackageRoot); } catch { return false; }
  }

  private resolveWorktree(project: ProjectRow): string | null {
    const settings = projectSettings(project);
    if (settings.integration.enabled) return ensureIntegrationWorktree(project, this.config.hubHome);
    if (!project.merge) return null;
    try {
      const merge = JSON.parse(project.merge) as { enabled?: boolean; worktrees?: Record<string, string> };
      if (merge.enabled !== true || !merge.worktrees) return null;
      const target = merge.worktrees[project.defaultBranch];
      return target && path.isAbsolute(target) ? path.resolve(target) : null;
    } catch { return null; }
  }

  private restartHub(status: DeployStatus): void {
    const command = process.platform === 'darwin' ? (process.env.AGENTHUB_LAUNCHCTL || 'launchctl') : (process.env.AGENTHUB_SYSTEMCTL || 'systemctl');
    const args = process.platform === 'darwin' ? ['kickstart', '-k', `gui/${process.getuid?.() ?? os.userInfo().uid}/dev.agenthub`] : ['--user', 'restart', 'agenthub', '--no-block'];
    const statePath = path.join(this.config.hubHome, 'deploy-restart.json');
    fs.writeFileSync(statePath, JSON.stringify({ projectId: status.projectId, commit: status.commit, logPath: status.logPath }));
    let child;
    try {
      child = this.restartRunner(command, args);
    } catch (error) {
      try { fs.rmSync(statePath, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
    child?.on?.('error', (error) => this.failRestart(status, error, statePath));
  }

  private failRestart(status: DeployStatus, error: unknown, statePath: string): void {
    try { fs.rmSync(statePath, { force: true }); } catch { /* best effort cleanup */ }
    status.status = 'failed';
    status.finishedAt = new Date().toISOString();
    status.error = error instanceof Error ? error.message : String(error);
    this.latest.set(status.projectId, { ...status });
    this.eventBus.emit('deploy.failed', undefined, {
      projectId: status.projectId,
      commit: status.commit,
      logPath: status.logPath,
      error: status.error,
      level: 'incident',
    });
  }

  getStatus(projectId: string): DeployStatus | null { return this.latest.get(projectId) || null; }
  getAllStatus(): DeployStatus[] { return [...this.latest.values()]; }
  rerun(projectId: string): DeployStatus {
    if (!this.definition(projectId) || !this.projectRepo.get(projectId)) return { projectId, status: 'skipped' };
    return this.enqueue(projectId);
  }
}
