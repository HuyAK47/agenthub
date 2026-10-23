import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectSettings } from './projects/settings.js';
import { execFileSync } from 'node:child_process';
import { testThreadLimit } from './priority.js';

export const WORKER_SERVICE_MESSAGE = 'AgentHub: worker không được điều khiển service của hub';
export const WORKER_BLOCKED_COMMANDS = ['ssh', 'scp', 'sftp', 'docker', 'docker-compose', 'podman'] as const;
const OLD_SHIM_NAMES = ['git', 'systemctl', 'launchctl', ...WORKER_BLOCKED_COMMANDS] as const;

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

function isHubShimPath(hubHome: string, candidate: string): boolean {
  const shimRoot = path.resolve(hubHome, 'shims');
  const roots = [shimRoot];
  try {
    roots.push(fs.realpathSync(shimRoot));
  } catch {
    // The lexical path still protects PATH entries before the directory exists.
  }

  const resolved = path.resolve(candidate);
  if (roots.some(root => isWithin(root, resolved))) return true;
  if (resolved.includes(`${path.sep}shims${path.sep}worker`) || resolved.includes(`${path.sep}shims${path.sep}service`)) {
    return true;
  }

  try {
    const real = fs.realpathSync(candidate);
    return roots.some(root => isWithin(root, real));
  } catch {
    return false;
  }
}

function findExecutable(name: string, env: NodeJS.ProcessEnv, hubHome: string): string | null {
  for (const dir of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (isHubShimPath(hubHome, dir)) continue;
    const candidate = path.resolve(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return candidate;
    } catch { /* try the next PATH entry */ }
  }
  return null;
}

function cleanOldShims(hubHome: string): void {
  const rootShimsDir = path.join(hubHome, 'shims');
  if (!fs.existsSync(rootShimsDir)) return;
  let realRootShimsDir: string;
  try {
    realRootShimsDir = fs.realpathSync(rootShimsDir);
  } catch {
    return;
  }

  for (const name of OLD_SHIM_NAMES) {
    const filePath = path.join(rootShimsDir, name);
    try {
      const lstat = fs.lstatSync(filePath);
      if (!lstat.isFile() && !lstat.isSymbolicLink()) continue;
      const real = fs.realpathSync(filePath);
      if (real.startsWith(realRootShimsDir + path.sep)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // file might not exist or cannot be accessed
    }
  }
}

function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

function writeShimFile(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content, { mode: 0o700 });
    fs.chmodSync(file, 0o700);
  } catch {
    fs.writeFileSync(file, content, { mode: 0o700 });
  }
}

function shimScript(realBinary: string): string {
  return `#!/bin/sh
blocked_action=0
blocked_unit=0
blocked_service_path=0
for arg in "$@"; do
  case "$arg" in
    stop|disable|kill|restart|mask|bootout|unload) blocked_action=1 ;;
    agenthub|agenthub.service|dev.agenthub) blocked_unit=1 ;;
    "$HOME/.config/systemd/user/"*|"$HOME/Library/LaunchAgents/"*) blocked_service_path=1 ;;
  esac
done
if [ "$blocked_service_path" -eq 1 ]; then
  echo ${shellQuote(WORKER_SERVICE_MESSAGE)} >&2
  exit 1
fi
if [ "$blocked_action" -eq 1 ] && [ "$blocked_unit" -eq 1 ]; then
  echo ${shellQuote(WORKER_SERVICE_MESSAGE)} >&2
  exit 1
fi
exec ${shellQuote(realBinary)} "$@"
`;
}

export function blockedCommandScript(name: string): string {
  return `#!/bin/sh
# Shim chặn lệnh ${name}: hàng rào chống nhầm, không phải sandbox (chỉ chặn khi gọi theo tên).
echo ${shellQuote(`AgentHub: worker không được chạy lệnh '${name}'`)} >&2
exit 1
`;
}

/**
 * Interpreter guard used by brain sandboxes. The Codex executable may be a
 * JavaScript fixture (or a managed JS launcher), so permit only the exact
 * entrypoint that AgentHub started; all other interpreter invocations remain
 * blocked, including `node -e` and arbitrary scripts.
 */
export function brainInterpreterShimScript(name: string, realBinary: string, interpreter = '/bin/sh'): string {
  return `#!${interpreter}
shim_path="$1"
shift
if [ "$1" = "$AGENTHUB_BRAIN_ENTRYPOINT" ] && [ -n "$AGENTHUB_BRAIN_ENTRYPOINT" ]; then
  exec ${shellQuote(realBinary)} "$@"
fi
echo ${shellQuote(`AgentHub: brain policy chặn interpreter '${name}'`)} >&2
exit 1
`;
}

export function gitShimScript(realBinary: string, interpreter = '/bin/sh'): string {
  return `#!${interpreter}
# Shim git: chặn push và remote set-url, chuyển tiếp nguyên vẹn mọi lệnh khác.
# Lưu ý: shim chỉ chặn lệnh gọi theo tên 'git', không chặn đường dẫn tuyệt đối (hàng rào chống nhầm, không phải sandbox).

skip_next=0
subcmd=""
for arg in "$@"; do
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path)
      skip_next=1
      continue
      ;;
    --git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--exec-path=*|-c*)
      continue
      ;;
    -*)
      continue
      ;;
    *)
      subcmd="$arg"
      break
      ;;
  esac
done

if [ "$subcmd" = "push" ]; then
  echo "AgentHub: worker không được chạy lệnh 'git push'" >&2
  exit 1
fi

if [ "$subcmd" = "remote" ]; then
  found_remote=0
  for arg in "$@"; do
    if [ "$found_remote" -eq 1 ]; then
      case "$arg" in
        -*) continue ;;
        set-url)
          echo "AgentHub: worker không được chạy lệnh 'git remote set-url'" >&2
          exit 1
          ;;
        *) break ;;
      esac
    fi
    if [ "$arg" = "remote" ]; then
      found_remote=1
    fi
  done
fi

exec ${shellQuote(realBinary)} "$@"
`;
}

export function brainGitShimScript(realBinary: string, permissions: 'standard' | 'trusted', interpreter = '/bin/sh'): string {
  if (permissions === 'trusted') return gitShimScript(realBinary, interpreter);
  return `#!${interpreter}
# Brain standard policy: only read-only git commands are autonomous.
subcmd=""
skip_next=0
for arg in "$@"; do
  if [ "$skip_next" -eq 1 ]; then skip_next=0; continue; fi
  case "$arg" in
    -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path) skip_next=1; continue ;;
    --git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--exec-path=*|-c*) continue ;;
    -*) continue ;;
    *) subcmd="$arg"; break ;;
  esac
done
case "$subcmd" in
  status|log|diff|show|branch|rev-parse|merge-base|merge-tree) exec ${shellQuote(realBinary)} "$@" ;;
  *) echo ${shellQuote('AgentHub: brain standard policy chặn git')} "$subcmd" >&2; exit 1 ;;
esac
`;
}

function brainBlockedShimScript(name: string, interpreter = '/bin/sh'): string {
  return `#!${interpreter}
# AgentHub BrainPolicy enforcement. Codex approvals cannot override this guard.
echo ${shellQuote(`AgentHub: brain policy chặn lệnh '${name}'`)} >&2
exit 1
`;
}

/**
 * Shells are a particularly important escape hatch: even if every mutating
 * utility is hidden, `sh -c` can still use builtins such as redirection.  A
 * brain may use a shell only for one of the commands that BrainPolicy can
 * autonomously allow, without shell operators or indirection.
 */
export function brainShellShimScript(interpreter = '/bin/sh'): string {
  return `#!${interpreter}
shim_path="$1"
shift
script="$2"
case "$1" in
  -c|--command)
    case "$script" in
      *';'*|*'|'*|*'&'*|*'>'*|*'<'*)
        echo 'AgentHub: brain policy chặn shell syntax' >&2
        exit 1
        ;;
    esac
    # Shell commands do not go through BrainPolicy's parser.  Keep this
    # fallback deliberately conservative: commands containing path
    # indirection or an absolute path are denied here and must be invoked by
    # the Codex tool runner through the dedicated read-command shims below.
    case "$script" in
      */*|*..*|*'~'*)
        echo 'AgentHub: brain policy chặn đường dẫn shell không an toàn' >&2
        exit 1
        ;;
    esac
    case "$script" in
      *'$('*)
        echo 'AgentHub: brain policy chặn shell syntax' >&2
        exit 1
        ;;
    esac
    case "$script" in
      git[[:space:]]*|grep[[:space:]]*|curl[[:space:]]*|cat[[:space:]]*|head[[:space:]]*|tail[[:space:]]*|wc[[:space:]]*|ls[[:space:]]*|npm[[:space:]]*|pnpm[[:space:]]*|npx[[:space:]]*)
        exec ${interpreter} "$@"
        ;;
      *)
        echo 'AgentHub: brain policy chặn lệnh shell' >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo 'AgentHub: brain policy chặn interactive shell' >&2
    exit 1
    ;;
esac
`;
}

/**
 * Read-only utilities still need a guard when Codex invokes them by absolute
 * path.  The sandbox makes writes outside the worktree impossible, while
 * this shim prevents reads of credentials and unrelated host files.
 */
export function brainReadShimScript(name: string, realBinary: string, interpreter = '/bin/sh'): string {
  return `#!${interpreter}
root="${'${AGENTHUB_BRAIN_ROOT:-$PWD}'}"
for arg in "$@"; do
  case "$arg" in
    -*|[0-9]*) continue ;;
    */.git|*/.git/*|*/auth.json|*/.credentials.json|*oauth*token*|*/.agenthub/token|*/secrets/*|*/.ssh/*|*/.codex/*|*/.agy-homes/*)
      echo 'AgentHub: brain policy chặn đọc secret hoặc .git' >&2
      exit 1
      ;;
    /*)
      case "$arg" in
        "$root"|"$root"/*) ;;
        *) echo 'AgentHub: brain policy chặn đọc ngoài project/worktree' >&2; exit 1 ;;
      esac
      ;;
    ../*|*/../*|*'~'*)
      echo 'AgentHub: brain policy chặn đường dẫn đọc không an toàn' >&2
      exit 1
      ;;
  esac
done
exec ${shellQuote(realBinary)} "$@"
`;
}

export interface WorkerEnvOptions {
  gitHooks?: 'run' | 'skip';
  project?: { settings?: string | null } | null;
  guards?: boolean;
  cwd?: string;
  workerCount?: number;
  brainPolicy?: 'standard' | 'trusted';
  brainInterpreter?: string;
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
  const workerCount = Math.max(1, Math.floor(options && 'workerCount' in options ? (options.workerCount || 1) : Number(env.AGENTHUB_WORKER_COUNT || 1)));
  env.AGENTHUB_WORKER_COUNT = String(workerCount);
  const threadLimit = testThreadLimit(workerCount);
  env.VITEST_MAX_THREADS = String(threadLimit);
  env.VITEST_MIN_THREADS = '1';
  env.VITEST_MAX_FORKS = String(threadLimit);
  env.VITEST_MIN_FORKS = '1';
  env.JEST_WORKERS = String(threadLimit);
  env.UV_THREADPOOL_SIZE = String(Math.min(4, threadLimit));
  if (!hasGitIdentity(options && 'cwd' in options ? options.cwd : undefined, env)) {
    env.GIT_AUTHOR_NAME ??= HUB_GIT_NAME;
    env.GIT_AUTHOR_EMAIL ??= HUB_GIT_EMAIL;
    env.GIT_COMMITTER_NAME ??= HUB_GIT_NAME;
    env.GIT_COMMITTER_EMAIL ??= HUB_GIT_EMAIL;
  }
  const serviceDir = path.join(hubHome, 'shims', 'service');
  const workerDir = path.join(hubHome, 'shims', 'worker');
  const guards = !options || !('guards' in options) || options.guards !== false;

  cleanOldShims(hubHome);
  fs.mkdirSync(serviceDir, { recursive: true, mode: 0o700 });

  // 1. systemctl & launchctl shims (service guards)
  for (const name of ['systemctl', 'launchctl']) {
    const realBinary = findExecutable(name, env, hubHome);
    if (!realBinary) continue;
    const file = path.join(serviceDir, name);
    const content = shimScript(realBinary);
    writeShimFile(file, content);
  }

  if (guards) {
    fs.mkdirSync(workerDir, { recursive: true, mode: 0o700 });

    // 2. Blocked command shims (ssh, scp, sftp, docker, docker-compose, podman)
    for (const name of WORKER_BLOCKED_COMMANDS) {
      const file = path.join(workerDir, name);
      const content = blockedCommandScript(name);
      writeShimFile(file, content);
    }

    // 3. git wrapper shim
    const realGit = findExecutable('git', env, hubHome) || findExecutable('git', process.env, hubHome) || '/usr/bin/git';
    const gitFile = path.join(workerDir, 'git');
    const brainPolicy = options && 'brainPolicy' in options ? options.brainPolicy : undefined;
    const brainInterpreter = options && 'brainInterpreter' in options ? options.brainInterpreter : '/bin/sh';
    const gitContent = brainPolicy ? brainGitShimScript(realGit, brainPolicy, brainInterpreter) : gitShimScript(realGit);
    writeShimFile(gitFile, gitContent);

    if (brainPolicy) {
      if (options && 'cwd' in options && options.cwd) env.AGENTHUB_BRAIN_ROOT = path.resolve(options.cwd);
      // Brain sessions do not get an interactive approval path that can be
      // consulted by this process. Keep the command-level guard conservative:
      // interpreters and filesystem mutation tools can all be used to bypass a
      // name-based deny-list (for example `node -e`, `find -delete`, or
      // `mv`), so they must not reach the real binary from a brain sandbox.
      const brainShells = ['sh', 'bash', 'zsh', 'dash', 'fish'];
      for (const name of brainShells) {
        writeShimFile(path.join(workerDir, name), brainShellShimScript(brainInterpreter));
      }

      const blockedNames = new Set([
        'rm', 'mv', 'cp', 'install', 'find', 'xargs', 'sed', 'perl', 'python', 'python3', 'ruby', 'node',
        'systemctl', 'launchctl', 'sudo', 'su', 'ssh', 'scp', 'sftp', 'docker', 'docker-compose', 'podman',
        'mkfs', 'dd', 'truncate', 'chown', 'chmod', 'chgrp', 'mount', 'umount', 'tar', 'zip', 'unzip',
        'sh', 'bash', 'zsh', 'dash', 'fish', 'echo', 'printf', 'touch', 'mkdir', 'rmdir', 'ln', 'tee', 'awk', 'gawk',
        'busybox', 'env', 'nohup', 'timeout', 'watch', 'yes', 'sort', 'uniq', 'xargs',
        'ed', 'ex', 'vim', 'vi', 'nvim', 'emacs', 'make', 'cmake', 'gcc', 'clang', 'go', 'java', 'php',
        ...brainShells,
      ]);
      const brainReadCommands = ['cat', 'grep', 'head', 'tail', 'wc', 'ls'];
      for (const name of brainReadCommands) {
        const realBinary = findExecutable(name, env, hubHome);
        if (realBinary) writeShimFile(path.join(workerDir, name), brainReadShimScript(name, realBinary, brainInterpreter));
      }
      for (const name of blockedNames) {
        const content = name === 'node'
          ? brainInterpreterShimScript(name, findExecutable(name, env, hubHome) || process.execPath, brainInterpreter)
          : brainShells.includes(name) ? brainShellShimScript(brainInterpreter) : brainBlockedShimScript(name, brainInterpreter);
        writeShimFile(path.join(workerDir, name), content);
      }
      // serviceDir precedes workerDir in PATH, so replace the permissive worker
      // service guard for brain sessions with the same unconditional policy.
      for (const name of ['systemctl', 'launchctl']) {
        writeShimFile(path.join(serviceDir, name), brainBlockedShimScript(name, brainInterpreter));
      }
    }
  }

  const existingPath = (env.PATH || '')
    .split(path.delimiter)
    .filter(dir => {
      if (!dir) return false;
      return !isHubShimPath(hubHome, dir);
    })
    .join(path.delimiter);

  const shimDirs = guards ? [serviceDir, workerDir] : [serviceDir];
  env.PATH = [...shimDirs, existingPath].filter(Boolean).join(path.delimiter);

  // Check project settings for gitHooks and references
  let gitHooks: 'run' | 'skip' | undefined;
  let settings: ReturnType<typeof projectSettings> | undefined;

  if (options) {
    if ('gitHooks' in options && options.gitHooks) {
      gitHooks = options.gitHooks;
    }
    if ('settings' in options || ('project' in options && options.project)) {
      const proj = 'project' in options ? options.project : options;
      settings = projectSettings(proj as { settings?: string | null });
      if (!gitHooks) {
        gitHooks = settings.worktree.gitHooks;
      }
    }
  }

  // Set reference env vars: AGENTHUB_REF_<NAME>
  if (settings?.references) {
    for (const ref of settings.references) {
      const varName = `AGENTHUB_REF_${ref.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      env[varName] = ref.path;
      if (ref.name !== ref.name.toUpperCase()) {
        env[`AGENTHUB_REF_${ref.name}`] = ref.path;
      }
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
