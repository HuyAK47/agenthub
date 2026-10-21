import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../errors.js';
import { projectSettings } from './settings.js';

export interface IntegrationStatus {
  path: string;
  branch: string;
  exists: boolean;
  currentBranch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

export interface ProjectLike {
  id: string;
  path?: string | null;
  defaultBranch: string;
  settings?: string | null;
}

/**
 * Validate integration branch name format and ensure it does not collide with main/master defaultBranch.
 */
export function validateIntegrationBranch(branch: string, defaultBranch: string): void {
  try {
    execFileSync('git', ['check-ref-format', '--branch', branch], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new HttpError(400, 'bad_request', `Tên nhánh tích hợp không hợp lệ: "${branch}"`);
  }

  if ((defaultBranch === 'main' || defaultBranch === 'master') && branch === defaultBranch) {
    throw new HttpError(
      400,
      'bad_request',
      `Tên nhánh tích hợp không được trùng với defaultBranch (${defaultBranch}) khi defaultBranch là main/master`,
    );
  }
}

/**
 * Path to the integration worktree for a project.
 */
export function getIntegrationPath(hubHome: string, projectId: string): string {
  return path.join(hubHome, 'integration', projectId);
}

function addExcludeRules(worktreePath: string): void {
  try {
    const gitDir = execFileSync('git', ['-C', worktreePath, 'rev-parse', '--git-dir'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.join(worktreePath, gitDir);
    const excludePath = path.join(resolvedGitDir, 'info', 'exclude');
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
    if (!lines.includes('.agenthub/')) toAppend += '\n.agenthub/\n';
    if (!lines.includes('node_modules')) toAppend += 'node_modules\n';
    if (toAppend) fs.appendFileSync(excludePath, toAppend);
  } catch {
    // non-critical
  }
}

function integrationRoot(hubHome: string): string {
  return path.resolve(hubHome, 'integration');
}

function isSafeIntegrationPath(worktreePath: string, hubHome: string): boolean {
  try {
    const root = fs.realpathSync(integrationRoot(hubHome));
    const resolved = fs.realpathSync(worktreePath);
    const relative = path.relative(root, resolved);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function currentBranch(worktreePath: string): string | null {
  try {
    return execFileSync('git', ['-C', worktreePath, 'symbolic-ref', '--short', 'HEAD'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim() || null;
  } catch {
    return null;
  }
}

function isDirty(worktreePath: string): boolean {
  const status = execFileSync('git', ['-C', worktreePath, 'status', '--porcelain'], {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return status.trim().length > 0;
}

function branchWorktreePath(repoPath: string, branch: string): string | null {
  try {
    const listing = execFileSync('git', ['-C', repoPath, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const entries = listing.split(/\n\n+/);
    for (const entry of entries) {
      if (entry.split('\n').some((line) => line === `branch refs/heads/${branch}`)) {
        return entry.split('\n')[0]?.replace(/^worktree /, '') || null;
      }
    }
  } catch {
    // The caller will report the original git error if the worktree list is unavailable.
  }
  return null;
}

function throwBranchCheckoutError(repoPath: string, branch: string, error: unknown): never {
  const checkedOutAt = branchWorktreePath(repoPath, branch);
  if (checkedOutAt) {
    throw new HttpError(409, 'conflict', `Nhánh ${branch} đang được checkout tại ${checkedOutAt}; chọn tên nhánh tích hợp khác`);
  }
  throw error;
}

/**
 * Ensure the hub-managed integration worktree exists at <hubHome>/integration/<projectId>.
 * Reuses existing worktree if present. If branch does not exist, creates it from baseRef with -b.
 * Never checks out branches in the user's working directory.
 */
export function ensureIntegrationWorktree(project: ProjectLike, hubHome: string): string {
  if (!project.path || !fs.existsSync(project.path)) {
    throw new HttpError(400, 'bad_request', `Thư mục repo không tồn tại: ${project.path}`);
  }

  const settings = projectSettings(project);
  const branch = settings.integration.branch || 'agenthub/integration';
  const baseRef = settings.integration.baseRef || project.defaultBranch;

  validateIntegrationBranch(branch, project.defaultBranch);

  const integrationPath = getIntegrationPath(hubHome, project.id);

  if (fs.existsSync(integrationPath)) {
    let inside = '';
    try {
      inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch {
      throw new HttpError(503, 'unavailable', `Worktree tích hợp ${integrationPath} không sử dụng được; kiểm tra quyền truy cập, index.lock hoặc khôi phục repo rồi thử lại`);
    }
    if (inside === 'true') {
      const dirty = isDirty(integrationPath);
      const checkedOutBranch = currentBranch(integrationPath);
      if (checkedOutBranch === branch) return integrationPath;
      if (dirty) {
        throw new HttpError(409, 'conflict', `Worktree tích hợp ${integrationPath} có thay đổi chưa commit; không thể chuyển sang nhánh ${branch}`);
      }
      try {
        if (branchExistsInRepo(project.path, branch)) {
          execFileSync('git', ['-C', integrationPath, 'switch', branch], { stdio: ['pipe', 'pipe', 'pipe'] });
        } else {
          execFileSync('git', ['-C', integrationPath, 'switch', '-c', branch, baseRef], { stdio: ['pipe', 'pipe', 'pipe'] });
        }
      } catch (error) {
        throwBranchCheckoutError(project.path, branch, error);
      }
      addExcludeRules(integrationPath);
      return integrationPath;
    }
    throw new HttpError(503, 'unavailable', `Worktree tích hợp ${integrationPath} không sử dụng được; kiểm tra quyền truy cập, index.lock hoặc khôi phục repo rồi thử lại`);
  }

  const parentDir = path.dirname(integrationPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  try {
    execFileSync('git', ['-C', project.path, 'worktree', 'prune'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    // ignore
  }

  const branchExists = branchExistsInRepo(project.path, branch);

  try {
    if (branchExists) {
      execFileSync('git', ['-C', project.path, 'worktree', 'add', integrationPath, branch], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      execFileSync('git', ['-C', project.path, 'worktree', 'add', '-b', branch, integrationPath, baseRef], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
  } catch (error) {
    throwBranchCheckoutError(project.path, branch, error);
  }

  addExcludeRules(integrationPath);
  return integrationPath;
}

function branchExistsInRepo(repoPath: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current integration status: { path, branch, exists, ahead, behind }
 */
export function getIntegrationStatus(project: ProjectLike, hubHome: string): IntegrationStatus {
  const settings = projectSettings(project);
  const branch = settings.integration.branch || 'agenthub/integration';
  const baseRef = settings.integration.baseRef || project.defaultBranch;
  const integrationPath = getIntegrationPath(hubHome, project.id);

  let exists = false;
  let currentBranchName: string | null = null;
  let dirty = false;
  if (fs.existsSync(integrationPath)) {
    try {
      const inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      exists = inside === 'true';
      if (exists) {
        currentBranchName = currentBranch(integrationPath);
        try { dirty = isDirty(integrationPath); } catch { dirty = true; }
      }
    } catch {
      exists = false;
    }
  }

  let ahead = 0;
  let behind = 0;

  if (project.path && fs.existsSync(project.path)) {
    try {
      const aheadOut = execFileSync(
        'git',
        ['-C', project.path, 'rev-list', '--count', `${baseRef}..${branch}`],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim();
      ahead = parseInt(aheadOut, 10) || 0;
    } catch {
      ahead = 0;
    }

    try {
      const behindOut = execFileSync(
        'git',
        ['-C', project.path, 'rev-list', '--count', `${branch}..${baseRef}`],
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] },
      ).trim();
      behind = parseInt(behindOut, 10) || 0;
    } catch {
      behind = 0;
    }
  }

  return {
    path: integrationPath,
    branch,
    exists,
    currentBranch: currentBranchName,
    dirty,
    ahead,
    behind,
  };
}

/**
 * Remove integration worktree (without deleting the branch).
 */
export function removeIntegrationWorktree(project: { id: string; path?: string | null }, hubHome: string): string | null {
  const integrationPath = getIntegrationPath(hubHome, project.id);
  if (!fs.existsSync(integrationPath)) return null;
  if (!isSafeIntegrationPath(integrationPath, hubHome)) {
    return `Không thể gỡ worktree tích hợp ${integrationPath}: đường dẫn không an toàn`;
  }
  if (!project.path || !fs.existsSync(project.path)) {
    return `Không thể gỡ worktree tích hợp ${integrationPath}: repo project không tồn tại`;
  }

  try {
    if (isDirty(integrationPath)) {
      return `Giữ nguyên worktree tích hợp ${integrationPath} vì có thay đổi chưa commit`;
    }
  } catch {
    return `Không thể kiểm tra trạng thái worktree tích hợp ${integrationPath}; giữ nguyên để tránh mất dữ liệu`;
  }

  try {
    execFileSync('git', ['-C', project.path, 'worktree', 'remove', integrationPath], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    execFileSync('git', ['-C', project.path, 'worktree', 'prune'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
  } catch {
    return `Không thể gỡ worktree tích hợp ${integrationPath}; giữ nguyên để tránh mất dữ liệu`;
  }
  return null;
}
