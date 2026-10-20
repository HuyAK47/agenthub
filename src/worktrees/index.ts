import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { AgentHubConfig } from '../config.js';
import { reapSyncForWorktree } from '../reaper.js';

export interface WorktreeInfo {
  worktreePath: string;
  slot: number;
}

export interface WorktreeHookContext {
  slot?: number | null;
  slug?: string;
  projectId?: string;
  taskId?: string;
  hooks?: { onWorktreeRemoved?: string[] } | null;
  eventBus?: { emit: (type: string, taskId?: string, payload?: unknown) => boolean };
}

export interface DependencyContext {
  id: string;
  title: string;
  doneContent?: string;
  review?: string;
  diffStat?: string;
}

function resolveReal(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/**
 * A path may only be deleted by AgentHub if it lies strictly inside the hub's worktrees
 * directory and is neither a project root nor an ancestor of one.
 *
 * Sự cố 16/10: task import từ thời agy-run có worktreePath = thư mục gốc repo; `git worktree
 * remove` từ chối worktree chính và nhánh fallback rmSync đã xóa cả repo (kèm .git).
 */
export function isDeletableWorktreePath(
  worktreesDir: string,
  target: string | null | undefined,
  protectedPaths: Array<string | null | undefined> = [],
): boolean {
  if (!target) return false;
  const base = resolveReal(worktreesDir);
  const resolved = resolveReal(target);
  if (!resolved.startsWith(base + path.sep)) return false;
  for (const p of protectedPaths) {
    if (!p) continue;
    const prot = resolveReal(p);
    if (resolved === prot || prot.startsWith(resolved + path.sep)) return false;
  }
  return true;
}

export class WorktreeService {
  constructor(
    private config: AgentHubConfig,
    private eventBus?: { emit: (type: string, taskId?: string, payload?: unknown) => boolean },
  ) {}

  /**
   * Allocate a slot number (1-9) for a project.
   * Uses the smallest number not taken by currently running tasks.
   */
  allocateSlot(projectId: string, usedSlots: number[]): number {
    for (let i = 1; i <= 9; i++) {
      if (!usedSlots.includes(i)) return i;
    }
    throw new Error(`All 9 slots for project ${projectId} are in use`);
  }

  /**
   * Create a git worktree for a task.
   * Returns the worktree path.
   */
  create(opts: {
    projectPath: string;
    projectId: string;
    slug: string;
    branch: string;
    baseRef: string;
  }): string {
    const worktreePath = path.join(
      this.config.worktreesDir,
      opts.projectId,
      opts.slug,
    );

    // Ensure parent directory exists
    const parentDir = path.dirname(worktreePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // Remove existing worktree if present
    if (fs.existsSync(worktreePath)) {
      this.remove(opts.projectPath, worktreePath);
    }

    // Create worktree
    try {
      execFileSync('git', [
        '-C', opts.projectPath,
        'worktree', 'add',
        worktreePath,
        '-b', opts.branch,
        opts.baseRef,
      ]);
    } catch {
      // Branch might already exist, try without -b
      try {
        execFileSync('git', [
          '-C', opts.projectPath,
          'worktree', 'add',
          worktreePath,
          opts.branch,
        ]);
      } catch (e) {
        throw new Error(`Failed to create worktree: ${e}`);
      }
    }

    // Add .agenthub/ to .git/info/exclude
    this.addToExclude(worktreePath);

    return worktreePath;
  }

  /**
   * Add .agenthub/ and node_modules to .git/info/exclude of the worktree
   */
  private addToExclude(worktreePath: string): void {
    try {
      const excludePaths: string[] = [];

      try {
        const gitPath = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-path', 'info/exclude'], {
          encoding: 'utf-8',
        }).trim();
        if (gitPath) {
          excludePaths.push(path.isAbsolute(gitPath) ? gitPath : path.join(worktreePath, gitPath));
        }
      } catch {
        // ignore
      }

      const gitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
        encoding: 'utf-8',
      }).trim();
      const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
      excludePaths.push(path.join(resolvedGitDir, 'info', 'exclude'));

      for (const excludePath of new Set(excludePaths)) {
        const infoDir = path.dirname(excludePath);
        if (!fs.existsSync(infoDir)) {
          fs.mkdirSync(infoDir, { recursive: true });
        }

        let content = '';
        if (fs.existsSync(excludePath)) {
          content = fs.readFileSync(excludePath, 'utf-8');
        }

        const lines = content.split('\n').map((l) => l.trim());
        let toAppend = '';
        if (!lines.includes('.agenthub/')) {
          toAppend += '\n.agenthub/\n';
        }
        if (!lines.includes('node_modules')) {
          toAppend += 'node_modules\n';
        }

        if (toAppend) {
          fs.appendFileSync(excludePath, toAppend);
        }
      }
    } catch {
      // non-critical
    }
  }

  /**
   * Remove a worktree
   */
  remove(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
  ): boolean {
    if (!isDeletableWorktreePath(this.config.worktreesDir, worktreePath, [projectPath, this.config.hubHome])) {
      console.error(`[worktree] REFUSED to remove ${worktreePath}: outside ${this.config.worktreesDir} or a project root`);
      return false;
    }
    reapSyncForWorktree(worktreePath, {
      worktreesDir: this.config.worktreesDir,
      protectedPaths: [projectPath, this.config.hubHome],
      graceMs: 5000,
    });
    if (projectPath && fs.existsSync(projectPath)) {
      try {
        execFileSync('git', ['-C', projectPath, 'worktree', 'remove', '--force', worktreePath], {
          timeout: 30000,
        });
      } catch {
        // fall through to manual cleanup (path already verified to be inside worktreesDir)
      }
    }
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    if (fs.existsSync(worktreePath)) {
      console.error(`[worktree] Failed to remove worktree path: ${worktreePath}`);
      return false;
    }

    this.runOnWorktreeRemovedHooks(projectPath, worktreePath, context);
    return true;
  }

  private runOnWorktreeRemovedHooks(
    projectPath: string | null | undefined,
    worktreePath: string,
    context?: WorktreeHookContext,
  ): void {
    const hooks = context?.hooks?.onWorktreeRemoved;
    if (!hooks || !Array.isArray(hooks) || hooks.length === 0) {
      return;
    }

    const eventBus = context?.eventBus || this.eventBus;
    const slug = context?.slug || path.basename(worktreePath);
    const taskId = context?.taskId || (context?.projectId ? `${context.projectId}/${slug}` : undefined);

    // Security protection: slug only allows [a-z0-9_-], reject otherwise
    if (!slug || !/^[a-z0-9_-]+$/.test(slug)) {
      console.error(`[worktree] REFUSED hooks for ${worktreePath}: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`);
      eventBus?.emit('worktree.hook', taskId, {
        hook: 'onWorktreeRemoved',
        ok: false,
        error: `Refused hooks: slug "${slug}" contains invalid characters (must match [a-z0-9_-])`,
        slug,
      });
      return;
    }

    const slotStr = context?.slot != null ? String(context.slot) : '';
    const slugUnderscored = slug.replace(/-/g, '_');
    const project = context?.projectId || (projectPath ? path.basename(projectPath) : '');
    const cwd = projectPath || undefined;

    for (const rawCmd of hooks) {
      if (typeof rawCmd !== 'string' || !rawCmd.trim()) continue;

      const expandedCmd = rawCmd
        .replace(/\{slot\}/g, slotStr)
        .replace(/\{slug\}/g, slug)
        .replace(/\{slug_underscored\}/g, slugUnderscored)
        .replace(/\{worktree\}/g, worktreePath)
        .replace(/\{project\}/g, project);

      const startTime = Date.now();
      try {
        const stdout = execFileSync('sh', ['-c', expandedCmd], {
          cwd,
          timeout: 60000,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const durationMs = Date.now() - startTime;
        eventBus?.emit('worktree.hook', taskId, {
          hook: 'onWorktreeRemoved',
          cmd: expandedCmd,
          rawCmd,
          ok: true,
          exitCode: 0,
          durationMs,
          output: stdout,
        });
      } catch (err) {
        const error = err as { status?: number; killed?: boolean; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
        const durationMs = Date.now() - startTime;
        const exitCode = typeof error.status === 'number' ? error.status : (error.killed ? 137 : 1);
        const output = (error.stdout ? String(error.stdout) : '') + (error.stderr ? String(error.stderr) : '');
        console.error(`[worktree] Hook command failed: ${expandedCmd} (exit ${exitCode}): ${error.message ?? String(err)}`);
        eventBus?.emit('worktree.hook', taskId, {
          hook: 'onWorktreeRemoved',
          cmd: expandedCmd,
          rawCmd,
          ok: false,
          exitCode,
          durationMs,
          error: error.message ?? String(err),
          output,
        });
      }
    }
  }

  /**
   * Clean node_modules inside worktree (both root and web/ if present)
   */
  cleanNodeModules(worktreePath: string): { removed: string[]; freedBytes: number } {
    const dirs = [
      path.join(worktreePath, 'node_modules'),
      path.join(worktreePath, 'web', 'node_modules'),
    ];
    const removed: string[] = [];
    let freedBytes = 0;
    for (const dir of dirs) {
      if (fs.existsSync(dir)) {
        try {
          freedBytes += this.getDirectorySize(dir);
          fs.rmSync(dir, { recursive: true, force: true });
          removed.push(dir);
        } catch {
          // ignore
        }
      }
    }
    return { removed, freedBytes };
  }

  /**
   * Calculate size of a directory recursively in bytes
   */
  getDirectorySize(dir: string): number {
    let size = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        try {
          if (entry.isDirectory()) {
            size += this.getDirectorySize(fullPath);
          } else if (entry.isFile()) {
            size += fs.statSync(fullPath).size;
          }
        } catch {
          // ignore broken symlinks or unreadable files
        }
      }
    } catch {
      // ignore
    }
    return size;
  }

  /**
   * Write the task.md file (protocol + body) into the worktree
   */
  writeTaskFile(
    worktreePath: string,
    body: string,
    resume: boolean,
    feedback?: string,
    dependencies: DependencyContext[] = [],
    depsMaxChars = 16000,
  ): void {
    const agentHubDir = path.join(worktreePath, '.agenthub');
    if (!fs.existsSync(agentHubDir)) {
      fs.mkdirSync(agentHubDir, { recursive: true });
    }

    let content = body;

    const contextPath = path.join(agentHubDir, 'context', 'deps.md');
    if (dependencies.length > 0) {
      const contextContent = this.buildDependencyContext(dependencies, depsMaxChars);
      fs.mkdirSync(path.dirname(contextPath), { recursive: true });
      fs.writeFileSync(contextPath, contextContent, 'utf-8');
      content = 'Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\n' + content;
    } else if (fs.existsSync(contextPath)) {
      fs.rmSync(contextPath, { force: true });
    }

    if (feedback) {
      content += '\n\n## Feedback review\n\n' + feedback;
    }

    fs.writeFileSync(path.join(agentHubDir, 'task.md'), content, 'utf-8');

    // Remove old markers
    const donePath = path.join(agentHubDir, 'DONE');
    const blockedPath = path.join(agentHubDir, 'BLOCKED');
    if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
    if (fs.existsSync(blockedPath)) fs.unlinkSync(blockedPath);
  }

  private buildDependencyContext(dependencies: DependencyContext[], maxChars: number): string {
    const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 16000;
    const sections = dependencies.map((dependency) => {
      const done = (dependency.doneContent || '').slice(0, 4000);
      const diff = (dependency.diffStat || '').split('\n').slice(0, 60).join('\n');
      return [
        `## ${dependency.title} (${dependency.id})`,
        '',
        '### DONE',
        done || '(không có DONE)',
        '',
        '### Review cuối',
        dependency.review || '(chưa có review approved)',
        '',
        '### Diff stat',
        diff || '(không lấy được diff stat)',
      ].join('\n');
    });
    const full = sections.join('\n\n');
    if (full.length <= limit) return full;

    const note = '\n\n[Đã cắt bớt context dependency vì vượt giới hạn cấu hình.]';
    const available = Math.max(0, limit - note.length);
    return full.slice(0, available) + note.slice(0, limit);
  }

  /**
   * Generate env file in worktree based on project's envTemplate
   */
  generateEnvFile(
    worktreePath: string,
    envTemplate: { file: string; copyFrom?: string; vars?: Record<string, string> },
    slot: number,
    slug: string,
  ): void {
    const targetFile = path.join(worktreePath, envTemplate.file);

    // Copy base file if specified
    if (envTemplate.copyFrom) {
      const src = path.join(worktreePath, envTemplate.copyFrom);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, targetFile);
      }
    }

    // Read existing content or start empty
    let lines: string[] = [];
    if (fs.existsSync(targetFile)) {
      lines = fs.readFileSync(targetFile, 'utf-8').split('\n');
    }

    // Apply vars
    if (envTemplate.vars) {
      const slugUnderscored = slug.replace(/-/g, '_');
      for (const [key, template] of Object.entries(envTemplate.vars)) {
        const value = template
          .replace(/\{slot\}/g, String(slot))
          .replace(/\{slug\}/g, slug)
          .replace(/\{slug_underscored\}/g, slugUnderscored);

        // Find and replace existing key or append
        const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
        if (idx >= 0) {
          lines[idx] = `${key}=${value}`;
        } else {
          lines.push(`${key}=${value}`);
        }
      }
    }

    fs.writeFileSync(targetFile, lines.join('\n'), 'utf-8');
  }

  /**
   * Check if DONE or BLOCKED marker exists in the worktree
   */
  checkMarkers(worktreePath: string): { done: boolean; blocked: boolean; doneContent?: string; blockedContent?: string } {
    const agentHubDir = path.join(worktreePath, '.agenthub');
    const donePath = path.join(agentHubDir, 'DONE');
    const blockedPath = path.join(agentHubDir, 'BLOCKED');

    const result: { done: boolean; blocked: boolean; doneContent?: string; blockedContent?: string } = {
      done: false,
      blocked: false,
    };

    if (fs.existsSync(donePath)) {
      result.done = true;
      result.doneContent = fs.readFileSync(donePath, 'utf-8');
    }
    if (fs.existsSync(blockedPath)) {
      result.blocked = true;
      result.blockedContent = fs.readFileSync(blockedPath, 'utf-8');
    }

    return result;
  }
}
