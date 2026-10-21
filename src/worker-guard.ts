import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSettings } from './projects/settings.js';
import { execFileSync } from 'node:child_process';

export const WORKER_SERVICE_MESSAGE = 'AgentHub: worker không được điều khiển service của hub';

function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.resolve(dir, name);
    if (candidate.includes(`${path.sep}shims${path.sep}`)) continue;
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function shimScript(realBinary: string): string {
  return `#!/bin/sh
blocked_action=0
blocked_unit=0
for arg in "$@"; do
  case "$arg" in
    stop|disable|kill|restart|mask|bootout|unload) blocked_action=1 ;;
    agenthub|agenthub.service|dev.agenthub) blocked_unit=1 ;;
  esac
done
if [ "$blocked_action" -eq 1 ] && [ "$blocked_unit" -eq 1 ]; then
  echo ${shellQuote(WORKER_SERVICE_MESSAGE)} >&2
  exit 1
fi
exec ${shellQuote(realBinary)} "$@"
`;
}

export interface WorkerEnvOptions {
  gitHooks?: 'run' | 'skip';
  project?: { settings?: string | null } | null;
  cwd?: string;
}

const HUB_GIT_NAME = 'AgentHub';
const HUB_GIT_EMAIL = 'agenthub@localhost';

function hasGitIdentity(cwd: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (env.GIT_AUTHOR_NAME && env.GIT_AUTHOR_EMAIL && env.GIT_COMMITTER_NAME && env.GIT_COMMITTER_EMAIL) return true;
  try {
    const name = execFileSync('git', ['config', '--get', 'user.name'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    const email = execFileSync('git', ['config', '--get', 'user.email'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim();
    return Boolean(name && email);
  } catch {
    return false;
  }
}

export function workerEnvironment(
  hubHome: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  options?: WorkerEnvOptions | { settings?: string | null } | null,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv, AGENTHUB_WORKER: '1' };
  if (!hasGitIdentity(options && 'cwd' in options ? options.cwd : undefined, env)) {
    env.GIT_AUTHOR_NAME ??= HUB_GIT_NAME;
    env.GIT_AUTHOR_EMAIL ??= HUB_GIT_EMAIL;
    env.GIT_COMMITTER_NAME ??= HUB_GIT_NAME;
    env.GIT_COMMITTER_EMAIL ??= HUB_GIT_EMAIL;
  }
  const shimDir = path.join(hubHome, 'shims');
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
  for (const name of ['systemctl', 'launchctl']) {
    const realBinary = findExecutable(name, env);
    if (!realBinary) continue;
    const file = path.join(shimDir, name);
    const content = shimScript(realBinary);
    try {
      if (fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content, { mode: 0o700 });
      fs.chmodSync(file, 0o700);
    } catch { fs.writeFileSync(file, content, { mode: 0o700 }); }
  }
  env.PATH = [shimDir, env.PATH || ''].filter(Boolean).join(path.delimiter);

  // Check gitHooks option
  let gitHooks: 'run' | 'skip' | undefined;
  if (options) {
    if ('gitHooks' in options && options.gitHooks) {
      gitHooks = options.gitHooks;
    } else if ('settings' in options || ('project' in options && options.project)) {
      const proj = 'project' in options ? options.project : options;
      gitHooks = projectSettings(proj as { settings?: string | null }).worktree.gitHooks;
    }
  }

  if (gitHooks === 'skip') {
    const emptyHooksDir = path.join(hubHome, 'empty-hooks');
    fs.mkdirSync(emptyHooksDir, { recursive: true, mode: 0o700 });
    env.HUSKY = '0';
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'core.hooksPath';
    env.GIT_CONFIG_VALUE_0 = emptyHooksDir;
    env.GIT_CONFIG_PARAMETERS = `'core.hooksPath=${emptyHooksDir}'`;
  }

  return env;
}

export function isRealHubHome(): boolean {
  const configured = process.env.AGENTHUB_HOME;
  return !configured || path.resolve(configured) === path.resolve(path.join(os.homedir(), '.agenthub'));
}

export function assertWorkerMayControlHub(command: string): void {
  if (process.env.AGENTHUB_WORKER === '1' && isRealHubHome()) throw new Error(`${WORKER_SERVICE_MESSAGE}: không được chạy agenthub ${command}`);
}
