import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ProjectInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  currentBranch: string | null;
  branches: string[];
  remoteHost: string | null;
  estimatedSizeBytes: number;
  lockfiles: string[];
  monorepo: { detected: boolean; type: string | null };
  gitHooks: { husky: boolean; commitlint: boolean };
  language: string;
  projectFiles: string[];
  guidanceFiles: string[];
  mount: { mountpoint: string | null; temporary: boolean; encrypted: boolean };
  claudeSessions: { count: number; paths: string[] };
  hasClaudeMemory: boolean;
  suggestedSettings: {
    skipInstall: boolean;
    skipGitHooks: boolean;
    sensitiveProject: boolean;
    checks: Array<{ name: string; cmd: string[]; reason: string }>;
  };
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock'];
const PROJECT_FILES = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'Makefile'];
const MAX_SCAN_BYTES = 512 * 1024 * 1024;

function command(cwd: string, args: string[]): string | null {
  try { return execFileSync(cwd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null; } catch { return null; }
}

function walkSize(root: string): number {
  let total = 0;
  const visit = (dir: string) => {
    if (total >= MAX_SCAN_BYTES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.cache') continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(file);
        if (stat.isDirectory()) visit(file);
        else total += Math.min(stat.size, MAX_SCAN_BYTES - total);
      } catch { /* an unreadable entry is not fatal to inspection */ }
      if (total >= MAX_SCAN_BYTES) return;
    }
  };
  visit(root);
  return total;
}

function encodedProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function detectLanguage(root: string, packageJson: Record<string, unknown> | null): string {
  if (packageJson) return 'JavaScript/TypeScript';
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) return 'Python';
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return 'Rust';
  if (fs.existsSync(path.join(root, 'go.mod'))) return 'Go';
  if (fs.readdirSync(root, { withFileTypes: true }).some((e) => /\.(csproj|sln)$/.test(e.name))) return '.NET';
  if (fs.existsSync(path.join(root, 'pom.xml')) || fs.existsSync(path.join(root, 'build.gradle'))) return 'JVM';
  return 'Unknown';
}

function remoteHost(remote: string | null): string | null {
  if (!remote) return null;
  try { return new URL(remote.includes('://') ? remote : `ssh://${remote}`).hostname || null; } catch { return remote.split(':')[0].split('@').at(-1) || null; }
}

export function inspectProject(projectPath: string, home = os.homedir()): ProjectInspection {
  const resolved = path.resolve(projectPath);
  const stat = fs.existsSync(resolved) ? fs.statSync(resolved) : null;
  const isDirectory = Boolean(stat?.isDirectory());
  const isGitRepo = isDirectory && Boolean(command('git', ['-C', resolved, 'rev-parse', '--show-toplevel']));
  const packageJson = isDirectory ? (() => { try { return JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8')) as Record<string, unknown>; } catch { return null; } })() : null;
  const files = isDirectory ? new Set(fs.readdirSync(resolved)) : new Set<string>();
  const lockfiles = LOCKFILES.filter((name) => files.has(name));
  const monorepoType = files.has('nx.json') ? 'nx' : files.has('turbo.json') ? 'turbo' : files.has('pnpm-workspace.yaml') ? 'pnpm-workspace' : files.has('lerna.json') ? 'lerna' : packageJson && packageJson.workspaces ? 'workspaces' : null;
  const packageScripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts as Record<string, unknown> : {};
  const checks: Array<{ name: string; cmd: string[]; reason: string }> = [];
  for (const name of ['lint', 'typecheck', 'test', 'build']) if (packageScripts[name]) checks.push({ name, cmd: ['npm', 'run', name], reason: `package.json có script ${name}` });
  if (files.has('pyproject.toml')) checks.push({ name: 'python-check', cmd: ['python', '-m', 'pytest'], reason: 'Có pyproject.toml' });
  if ([...files].some((name) => /\.(csproj|sln)$/.test(name))) checks.push({ name: 'dotnet-build', cmd: ['dotnet', 'build'], reason: 'Có project .NET' });
  const branches = isGitRepo ? (command('git', ['-C', resolved, 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']) || '').split('\n').filter(Boolean) : [];
  const currentBranch = isGitRepo ? command('git', ['-C', resolved, 'symbolic-ref', '--short', 'HEAD']) : null;
  const gitRemote = isGitRepo ? command('git', ['-C', resolved, 'config', '--get', 'remote.origin.url']) : null;
  const encoded = encodedProjectDir(resolved);
  const claudeRoot = path.join(home, '.claude', 'projects', encoded);
  let sessionPaths: string[] = [];
  try { sessionPaths = fs.readdirSync(claudeRoot).filter((name) => /\.(jsonl|json)$/.test(name)).map((name) => path.join(claudeRoot, name)); } catch { /* optional */ }
  const mountpoint = command('findmnt', ['-T', resolved, '-n', '-o', 'TARGET']);
  const mountType = command('findmnt', ['-T', resolved, '-n', '-o', 'FSTYPE']) || '';
  const sensitiveProject = resolved.startsWith('/media/') || mountType.toLowerCase().includes('crypt');
  const guidanceFiles = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'].filter((name) => files.has(name));
  return {
    path: resolved, exists: Boolean(stat), isDirectory, isGitRepo, currentBranch,
    branches, remoteHost: remoteHost(gitRemote), estimatedSizeBytes: isDirectory ? walkSize(resolved) : 0,
    lockfiles, monorepo: { detected: Boolean(monorepoType), type: monorepoType },
    gitHooks: { husky: files.has('.husky') || Boolean(packageJson?.devDependencies && typeof packageJson.devDependencies === 'object' && 'husky' in packageJson.devDependencies), commitlint: files.has('commitlint.config.js') || files.has('.commitlintrc') },
    language: isDirectory ? detectLanguage(resolved, packageJson) : 'Unknown',
    projectFiles: PROJECT_FILES.filter((name) => files.has(name)), guidanceFiles,
    mount: { mountpoint, temporary: resolved.startsWith('/tmp/') || resolved.startsWith('/run/'), encrypted: mountType.toLowerCase().includes('crypt') },
    claudeSessions: { count: sessionPaths.length, paths: sessionPaths }, hasClaudeMemory: fs.existsSync(path.join(claudeRoot, 'memory', 'MEMORY.md')),
    suggestedSettings: { skipInstall: lockfiles.length > 0 || Boolean(monorepoType), skipGitHooks: Boolean(files.has('.husky') || files.has('commitlint.config.js')), sensitiveProject, checks },
  };
}

export function createNewGitProject(projectPath: string, defaultBranch: string): void {
  const resolved = path.resolve(projectPath);
  if (!path.isAbsolute(projectPath) || resolved === path.parse(resolved).root || fs.existsSync(resolved)) throw new Error('Đường dẫn tạo project phải là thư mục mới, không phải root hoặc đường dẫn đã tồn tại');
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error(`Thư mục cha không tồn tại: ${parent}`);
  fs.mkdirSync(resolved);
  try {
    execFileSync('git', ['-C', resolved, 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', resolved, 'checkout', '-b', defaultBranch], { stdio: 'ignore' });
    execFileSync('git', ['-C', resolved, 'commit', '--allow-empty', '-m', 'chore: initialize project'], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'AgentHub', GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'agenthub@localhost', GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'AgentHub', GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'agenthub@localhost' } });
  } catch (error) {
    fs.rmSync(resolved, { recursive: true, force: true });
    throw error;
  }
}
