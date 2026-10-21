import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { HttpError } from '../errors.js';
import { projectSettings } from './settings.js';

export interface IntegrationStatus {
  path: string;
  branch: string;
  exists: boolean;
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
    try {
      const inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      if (inside === 'true') {
        return integrationPath;
      }
    } catch {
      try {
        execFileSync('git', ['-C', project.path, 'worktree', 'remove', '--force', integrationPath], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        // ignore
      }
      fs.rmSync(integrationPath, { recursive: true, force: true });
    }
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

  let branchExists = false;
  try {
    execFileSync('git', ['-C', project.path, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    branchExists = true;
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    execFileSync('git', ['-C', project.path, 'worktree', 'add', integrationPath, branch], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } else {
    execFileSync('git', ['-C', project.path, 'worktree', 'add', '-b', branch, integrationPath, baseRef], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  addExcludeRules(integrationPath);
  return integrationPath;
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
  if (fs.existsSync(integrationPath)) {
    try {
      const inside = execFileSync('git', ['-C', integrationPath, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      exists = inside === 'true';
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
    ahead,
    behind,
  };
}

/**
 * Remove integration worktree (without deleting the branch).
 */
export function removeIntegrationWorktree(project: { id: string; path?: string | null }, hubHome: string): void {
  const integrationPath = getIntegrationPath(hubHome, project.id);
  if (fs.existsSync(integrationPath)) {
    if (project.path && fs.existsSync(project.path)) {
      try {
        execFileSync('git', ['-C', project.path, 'worktree', 'remove', '--force', integrationPath], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        // ignore
      }
      try {
        execFileSync('git', ['-C', project.path, 'worktree', 'prune'], {
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(integrationPath)) {
      fs.rmSync(integrationPath, { recursive: true, force: true });
    }
  }
}
