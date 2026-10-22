import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export interface WorktreeProjectPath {
  id: string;
  path: string;
  settings?: string | null;
}

/**
 * Return the parent directory used for this project's task worktrees.
 * An explicit root is used as-is; otherwise retain the historical location.
 */
export function projectWorktreeRoot(
  project: WorktreeProjectPath,
  hubHome = path.join(os.homedir(), '.agenthub'),
  legacyWorktreesDir = path.join(hubHome, 'worktrees'),
): string {
  let configured: string | undefined;
  if (project.settings) {
    try {
      const raw = JSON.parse(project.settings) as { worktree?: { root?: unknown } };
      if (typeof raw.worktree?.root === 'string' && path.isAbsolute(raw.worktree.root)) configured = raw.worktree.root;
    } catch {
      // Invalid project settings fall back to the default location.
    }
  }
  if (configured) return path.resolve(configured);

  return path.join(legacyWorktreesDir, project.id);
}

/** Both the current configured root and the historical root may contain a task. */
export function projectWorktreeRoots(
  project: WorktreeProjectPath,
  hubHome = path.join(os.homedir(), '.agenthub'),
  legacyWorktreesDir = path.join(hubHome, 'worktrees'),
): string[] {
  const current = projectWorktreeRoot(project, hubHome, legacyWorktreesDir);
  const legacy = path.join(legacyWorktreesDir, project.id);
  return current === legacy ? [current] : [current, legacy];
}

export function validateProjectWorktreeRoot(root: string, projectPath: string, hubHome: string): void {
  if (!path.isAbsolute(root)) throw new Error('Worktree root phải là đường dẫn tuyệt đối');
  const resolved = path.resolve(root);
  const realProject = resolveRealPath(projectPath);
  const realRoot = fs.existsSync(resolved) ? resolveRealPath(resolved) : resolved;
  if (realRoot === path.parse(realRoot).root) throw new Error('Worktree root không được là filesystem root');
  if (realRoot === resolveRealPath(os.homedir())) throw new Error('Worktree root không được là HOME');
  if (realRoot === resolveRealPath(hubHome)) throw new Error('Worktree root không được là hubHome');
  if (realRoot === realProject || realProject.startsWith(realRoot + path.sep)) {
    throw new Error('Worktree root không được chứa project repository');
  }
  if (realRoot.startsWith(realProject + path.sep)) {
    let ignored = false;
    try {
      execFileSync('git', ['-C', projectPath, 'check-ignore', '-q', '--', path.relative(projectPath, resolved)], { stdio: 'ignore' });
      ignored = true;
    } catch {
      ignored = false;
    }
    if (!ignored) throw new Error('Worktree root nằm trong project nhưng chưa được gitignore');
  }
  if (!fs.existsSync(resolved)) throw new Error(`Worktree root không tồn tại: ${resolved}`);
  try { fs.accessSync(resolved, fs.constants.W_OK); } catch { throw new Error(`Worktree root không ghi được: ${resolved}`); }
}

function resolveRealPath(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

export function isSafeProjectRelativePath(value: string): boolean {
  if (!value || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return value.split(/[\\/]+/).every((part) => part !== '..');
}

/** Resolve a project-local file and reject symlinks that escape the project. */
export function resolveProjectFile(projectPath: string, relativePath: string): string | null {
  if (!isSafeProjectRelativePath(relativePath)) return null;
  const root = path.resolve(projectPath);
  const candidate = path.resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const realCandidate = fs.realpathSync(candidate);
    if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}
