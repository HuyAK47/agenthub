import fs from 'node:fs';
import path from 'node:path';
import type { BrainConfig } from '../config.js';
import { projectSettings } from '../projects/settings.js';
import { effectiveBrainModeFromSettings, effectiveBrainPermission, type BrainPermission } from './mode.js';

export type BrainPolicyAction = 'allow' | 'deny';
export interface BrainPolicyDecision {
  action: BrainPolicyAction;
  reason: 'policy:auto_allow' | 'policy:deny';
  message: string;
}

export interface BrainPolicyRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface BrainPolicyOptions {
  roots: string[];
  readOnlyRoots?: string[];
  extraPatterns?: RegExp[];
  mode?: 'suggest' | 'auto';
  denyBashWrites?: boolean;
  denyToolWrites?: boolean;
  permissions?: BrainPermission;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const GIT_COMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'merge-base', 'merge-tree']);
const DENY_COMMAND = /(?:^|[\s/])(?:systemctl|launchctl|docker|podman|sudo|su|ssh|scp)(?:$|\s)|rm\s+-rf|prisma\s+migrate\s+reset|db\s+push\s+--accept-data-loss|git\s+push\s+--force/i;
const SECRET_PATH = /(?:^|\/)(?:auth\.json|\.credentials\.json|.*oauth.*token.*|\.agenthub\/token|secrets)(?:\/|$)/i;

function realPath(value: string): string | undefined {
  try {
    return fs.realpathSync(value);
  } catch {
    const parent = path.dirname(value);
    if (parent === value) return undefined;
    const resolvedParent = realPath(parent);
    return resolvedParent ? path.join(resolvedParent, path.basename(value)) : undefined;
  }
}

function within(value: string, root: string): boolean {
  const resolved = realPath(value);
  const resolvedRoot = realPath(root);
  if (!resolved || !resolvedRoot) return false;
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function safePath(value: unknown, roots: string[], base = roots[0]): boolean {
  if (typeof value !== 'string' || !value) return false;
  return roots.some((root) => within(path.isAbsolute(value) ? value : path.resolve(base, value), root));
}

function isSecretPath(value: string, cwd: string): boolean {
  if (SECRET_PATH.test(value)) return true;
  const abs = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  if (SECRET_PATH.test(abs)) return true;
  const resolved = realPath(abs);
  if (resolved && SECRET_PATH.test(resolved)) return true;
  return false;
}

function isInGitDir(value: string, cwd: string): boolean {
  const abs = path.isAbsolute(value) ? value : path.resolve(cwd, value);
  const normalizedParts = path.normalize(abs).split(path.sep);
  if (normalizedParts.includes('.git')) return true;
  const resolved = realPath(abs);
  if (resolved) {
    const resolvedParts = resolved.split(path.sep);
    if (resolvedParts.includes('.git')) return true;
  }
  return false;
}

function splitShell(command: string): string[] | undefined {
  if (/\r|\n|\$\(|<\(|>\(|`|\$\{/u.test(command)) return undefined;
  const parts: string[] = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote && command[i - 1] !== '\\') quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '$' && command[i + 1] === '(') return undefined;
    if (char === ')' && depth > 0) { depth -= 1; continue; }
    if (char === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) continue;
    if (depth === 0 && (char === ';' || char === '|' || char === '&')) {
      if ((char === '|' || char === '&') && command[i + 1] === char) i += 1;
      else if (char === '&') return undefined;
      parts.push(command.slice(start, i));
      start = i + 1;
    }
  }
  if (quote || depth !== 0) return undefined;
  parts.push(command.slice(start));
  return parts;
}

function shellWords(command: string): { words: string[]; redirects: string[] } | undefined {
  const wordsResult: string[] = [];
  const redirects: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  let hadWhitespace = true;
  const flush = () => {
    if (word) wordsResult.push(word);
    word = '';
  };
  const readWord = (start: number): { value: string; end: number } | undefined => {
    let value = '';
    let currentQuote = '';
    let escapedWord = false;
    let i = start;
    for (; i < command.length; i += 1) {
      const char = command[i];
      if (escapedWord) { value += char; escapedWord = false; continue; }
      if (char === '\\' && !currentQuote) { escapedWord = true; continue; }
      if (currentQuote) {
        if (char === currentQuote) currentQuote = '';
        else value += char;
        continue;
      }
      if (char === '"' || char === "'") { currentQuote = char; continue; }
      if (/\s/u.test(char) || char === '>' || char === '<' || (char === '&' && command[i + 1] === '>')) break;
      value += char;
    }
    if (currentQuote || escapedWord) return undefined;
    return { value, end: i };
  };

  for (let i = 0; i < command.length;) {
    const char = command[i];
    if (quote) {
      if (escaped) { word += char; escaped = false; }
      else if (char === '\\' && quote === '"') escaped = true;
      else if (char === quote) quote = '';
      else word += char;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; hadWhitespace = false; i += 1; continue; }
    if (/\s/u.test(char)) { flush(); hadWhitespace = true; i += 1; continue; }
    const redirectStart = (char === '&' && command[i + 1] === '>') || char === '>' || char === '<';
    if (redirectStart) {
      const fdOnly = /^\d+$/u.test(word) && !hadWhitespace;
      if (fdOnly) word = '';
      else flush();
      const operator = char === '&' ? '&>' : command.slice(i, i + 2) === '>>' || command.slice(i, i + 2) === '>|' ? command.slice(i, i + 2) : char;
      i += operator.length;
      while (i < command.length && /\s/u.test(command[i])) i += 1;
      if (command[i] === '&') {
        i += 1;
        while (i < command.length && /\d/u.test(command[i])) i += 1;
        continue;
      }
      const target = readWord(i);
      if (!target || !target.value) return undefined;
      redirects.push(target.value);
      i = target.end;
      hadWhitespace = false;
      continue;
    }
    const target = readWord(i);
    if (!target || !target.value) return undefined;
    word += target.value;
    i = target.end;
    hadWhitespace = false;
  }
  if (quote || escaped) return undefined;
  flush();
  return { words: wordsResult, redirects };
}

function allowedGit(args: string[]): boolean {
  if (args.length === 0 || !GIT_COMMANDS.has(args[0])) return false;
  const subcommand = args[0];
  const options = args.slice(1);
  if (options.some((arg) => /^(?:--output(?:=|$)|-o(?:$|[^-]))/u.test(arg))) return false;
  if (subcommand === 'branch') {
    if (options.some((arg) => /^(?:-D|-d|-M|-m|-C|-c|-f|--delete|--move|--copy|--force|--set-upstream-to)/u.test(arg))) return false;
    let expectsValue = false;
    for (const option of options) {
      if (expectsValue) { expectsValue = false; continue; }
      if (option === '--contains') { expectsValue = true; continue; }
      if (!['-a', '-r', '-v', '--list', '--show-current'].includes(option)) return false;
    }
    return !expectsValue;
  }
  return !options.includes('--hard');
}

function allowedCommand(command: string, roots: string[], cwd: string, permissions: BrainPermission): boolean {
  const parts = splitShell(command);
  if (!parts || parts.some((part) => !part.trim())) return false;
  return parts.every((part) => {
    if (/^(?:eval|exec|source|\.)\b/u.test(part.trim())) return false;
    const parsed = shellWords(part.trim());
    if (!parsed || parsed.words.length === 0) return false;
    if (parsed.redirects.some((target) => !safePath(target, roots, cwd) || isInGitDir(target, cwd) || isSecretPath(target, cwd))) {
      return false;
    }
    const executable = path.basename(parsed.words[0]);
    const args = parsed.words.slice(1);
    if (executable === 'git') {
      if (permissions === 'standard') return allowedGit(args);
      const subcommand = args[0] || '';
      if (subcommand === 'push') {
        const pushArgs = args.slice(1);
        if (pushArgs.length === 0) return false;
        const hasForbidden = pushArgs.some((arg) => {
          if (arg === '-f' || arg.startsWith('-f=') || /force/i.test(arg)) return true;
          if (arg === '--mirror' || arg === '--all' || arg === '--tags') return true;
          if (arg === '-d' || arg === '--delete') return true;
          if (arg.startsWith('+')) return true;
          if (arg.startsWith(':')) return true;
          if (arg.includes(':')) {
            const [src] = arg.split(':');
            if (!src || src.startsWith('+')) return true;
          }
          return false;
        });
        if (hasForbidden) return false;

        const protectedBranches = new Set(['main', 'master', 'integration']);
        const targetsProtected = pushArgs.some((arg) => {
          if (arg.startsWith('-')) return false;
          const normalizeRef = (ref: string) => ref.replace(/^\+/, '').replace(/^refs\/heads\//, '');
          if (protectedBranches.has(normalizeRef(arg))) return true;
          if (arg.includes(':')) {
            const parts = arg.split(':');
            const target = normalizeRef(parts[parts.length - 1]);
            if (protectedBranches.has(target)) return true;
          }
          return false;
        });
        if (targetsProtected) return false;

        return true;
      }
      if (subcommand === 'branch') {
        if (args.some((arg) => /^(?:-D|-d|--delete)/u.test(arg))) return false;
      }
      const allowedGitSubcommands = [
        'status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'merge-base', 'merge-tree',
        'add', 'commit', 'checkout', 'switch', 'pull', 'fetch', 'push'
      ];
      return allowedGitSubcommands.includes(subcommand) && !args.includes('--hard');
    }
    if (executable === 'npm' || executable === 'pnpm') {
      if (args[0] === 'exec') return false;
      const lockfile = executable === 'npm' ? 'package-lock.json' : 'pnpm-lock.yaml';
      const hasLockfile = fs.existsSync(path.join(cwd, lockfile));
      if (args[0] === 'ci') return permissions !== 'standard' && args.length === 1;
      if (args[0] === 'install') {
        if (permissions === 'standard') return false;
        return args.length === 1 && hasLockfile;
      }
      const script = args[0] === 'run' ? args[1] : args[0];
      return ['test', 'lint', 'typecheck', 'build', 'build:web'].includes(script || '');
    }
    if (executable === 'npx') {
      return (args[0] === 'vitest' && args[1] === 'run') || (args[0] === 'tsc' && args[1] === '--noEmit');
    }
    if (executable === 'grep') {
      if (args.some((arg) => arg === '-f' || arg === '--file' || arg.startsWith('--file='))) return false;
      let hasExplicitPattern = false;
      let skipNext = false;
      const operands: string[] = [];
      for (const arg of args) {
        if (skipNext) { skipNext = false; continue; }
        if (arg === '-e' || arg === '--regexp') { hasExplicitPattern = true; skipNext = true; continue; }
        if (arg.startsWith('--regexp=') || (arg.startsWith('-e') && arg.length > 2)) { hasExplicitPattern = true; continue; }
        if (!arg.startsWith('-')) operands.push(arg);
      }
      const fileOperands = hasExplicitPattern ? operands : operands.slice(1);
      return operands.length >= (hasExplicitPattern ? 0 : 1)
        && fileOperands.every((arg) => safePath(arg, roots, cwd) && !isSecretPath(arg, cwd));
    }
    if (executable === 'curl') {
      let url: string | undefined;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '-X' || arg === '--request') {
          if (args[++i]?.toUpperCase() !== 'GET') return false;
        } else if (arg.startsWith('--request=')) {
          if (arg.slice('--request='.length).toUpperCase() !== 'GET') return false;
        } else if (arg === '-H' || arg === '--header') {
          const header = args[++i];
          if (!header || header.startsWith('@') || /[$`]/u.test(header)) return false;
        } else if (arg.startsWith('-')) {
          if (!['-s', '-S', '-L', '--silent', '--show-error', '--location'].includes(arg)) return false;
        } else if (url) {
          return false;
        } else {
          url = arg;
        }
      }
      return Boolean(url && /^https:\/\/api\.github\.com(?:\/|$)/i.test(url));
    }
    if (executable === 'node') {
      if (permissions === 'standard') return false;
      if (args.length === 0) return false;
      const script = args[0];
      if (script.startsWith('-')) return false;
      if (!/\.(?:[cm]?js|[cm]?ts)$/i.test(script)) return false;
      if (!safePath(script, roots, cwd) || isInGitDir(script, cwd) || isSecretPath(script, cwd)) return false;
      return args.slice(1).every((arg) => !arg.startsWith('-') && safePath(arg, roots, cwd) && !isInGitDir(arg, cwd) && !isSecretPath(arg, cwd));
    }
    if (executable === 'cat' || executable === 'head' || executable === 'tail' || executable === 'wc' || executable === 'ls') {
      if (executable === 'tail' && args.some((arg) => arg === '-f' || arg === '--follow' || arg.startsWith('--follow='))) return false;
      return args.filter((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg)).every((arg) => safePath(arg, roots, cwd));
    }
    return false;
  });
}

export class BrainPolicy {
  private roots: string[];
  private readOnlyRoots: string[];
  private mode: 'suggest' | 'auto';
  private denyBashWrites: boolean;
  private denyToolWrites: boolean;
  constructor(options: BrainPolicyOptions) {
    this.roots = options.roots.filter((root) => Boolean(realPath(root)));
    this.readOnlyRoots = (options.readOnlyRoots || []).filter((root) => Boolean(realPath(root)));
    this.extraPatterns = options.extraPatterns || [];
    this.mode = options.mode || 'auto';
    this.denyBashWrites = options.denyBashWrites === true;
    this.denyToolWrites = options.denyToolWrites === true;
    this.permissions = options.permissions || 'standard';
  }
  private extraPatterns: RegExp[];
  private permissions: BrainPermission;

  decide(request: BrainPolicyRequest): BrainPolicyDecision | null {
    const { toolName, input } = request;
    const command = typeof input.command === 'string' ? input.command : '';
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    const paths = [
      input.file_path,
      input.path,
      input.filePath,
      ...(Array.isArray(input.paths) ? input.paths : []),
      ...(Array.isArray(input.files) ? input.files.map((f) => (typeof f === 'string' ? f : (f as Record<string, unknown>)?.path || (f as Record<string, unknown>)?.file_path)) : []),
      ...(Array.isArray(input.changes) ? input.changes.map((c) => (c as Record<string, unknown>)?.file_path || (c as Record<string, unknown>)?.path) : []),
    ].filter((value): value is string => typeof value === 'string');

    if (paths.some((p) => isSecretPath(p, cwd)) || SECRET_PATH.test(command)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối truy cập token/credential' };
    }
    if (toolName === 'Bash' && /\r|\n|\$\(|<\(|>\(|`|\$\{/u.test(command)) return null;
    if (toolName.startsWith('mcp__agenthub__')) {
      if (this.mode === 'suggest' && new Set([
        'mcp__agenthub__hub_review',
        'mcp__agenthub__hub_cancel',
        'mcp__agenthub__hub_dispatch_batch',
      ]).has(toolName)) return null;
      return { action: 'allow', reason: 'policy:auto_allow', message: 'MCP AgentHub được policy tự cho phép' };
    }
    if (toolName === 'Bash' && this.denyBashWrites && (/[;&|\n]/u.test(command) || !allowedCommand(command, this.roots, cwd, 'standard'))) {
      return { action: 'deny', reason: 'policy:deny', message: 'Việc này dành cho bộ não — dùng hub_ask_brain hoặc hub_brain_directive' };
    }
    if (toolName === 'Bash' && DENY_COMMAND.test(command)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Lệnh thuộc danh sách luôn từ chối' };
    }
    if (this.denyToolWrites && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Việc này dành cho bộ não — dùng hub_ask_brain hoặc hub_brain_directive' };
    }
    const touchesReadOnly = paths.some((value) => this.readOnlyRoots.some((root) => within(path.isAbsolute(value) ? value : path.resolve(cwd, value), root)));
    if (touchesReadOnly && !READ_TOOLS.has(toolName)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Policy chỉ cho phép đọc trong references của project' };
    }
    if (this.extraPatterns.some((pattern) => pattern.test(command || JSON.stringify(input)))) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Khớp brain.policy' };
    }
    if (READ_TOOLS.has(toolName)) {
      return paths.length === 0 || paths.every((value) => safePath(value, [...this.roots, ...this.readOnlyRoots], cwd))
        ? { action: 'allow', reason: 'policy:auto_allow', message: 'Đọc trong phạm vi project/worktree' }
        : null;
    }
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
      if (paths.some((p) => isSecretPath(p, cwd))) {
        return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối truy cập token/credential' };
      }
      if (paths.some((p) => isInGitDir(p, cwd))) {
        return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối can thiệp vào .git' };
      }
      if (!paths.every((value) => safePath(value, this.roots, cwd))) {
        return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối ghi ngoài phạm vi project/worktree' };
      }
      if (this.permissions === 'standard') return null;
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Ghi trong phạm vi project/worktree được policy trusted cho phép' };
    }
    if (!this.roots.some((root) => within(cwd, root))) return null;
    if (toolName === 'Bash' && allowedCommand(command, this.roots, cwd, this.permissions)) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Lệnh Bash an toàn trong phạm vi project/worktree' };
    }
    return null;
  }
}

/**
 * Policy for a project's brain session: it may work in the project repo and that project's
 * worktrees, only read the project's references, and acts in the project's own effective mode
 * (a project set to `auto` gets auto permissions even when the global brain is `suggest`).
 */
export function projectBrainPolicy(
  project: { id: string; path: string; settings?: string | null },
  config: { worktreesDir: string; brain: Pick<BrainConfig, 'mode' | 'policy' | 'permissions'> },
): BrainPolicy {
  const settings = projectSettings(project);
  return new BrainPolicy({
    roots: [project.path, path.join(config.worktreesDir, project.id)],
    readOnlyRoots: settings.references.map((reference) => reference.path),
    extraPatterns: config.brain.policy.flatMap((pattern) => {
      try { return [new RegExp(pattern)]; } catch { return []; }
    }),
    mode: effectiveBrainModeFromSettings(settings, config.brain) === 'auto' ? 'auto' : 'suggest',
    permissions: effectiveBrainPermission(project, config.brain),
  });
}

export function assistantPolicy(
  project: { id: string; path: string },
  config: { worktreesDir: string; assistant: Pick<BrainConfig, 'policy'> },
): BrainPolicy {
  return new BrainPolicy({
    roots: [project.path, path.join(config.worktreesDir, project.id)],
    extraPatterns: config.assistant.policy.flatMap((pattern) => {
      try { return [new RegExp(pattern)]; } catch { return []; }
    }),
    mode: 'auto',
    denyBashWrites: true,
    denyToolWrites: true,
  });
}

export function globalAssistantPolicy(config: { worktreesDir: string; assistant: Pick<BrainConfig, 'policy'> }): BrainPolicy {
  return new BrainPolicy({
    roots: [config.worktreesDir],
    extraPatterns: config.assistant.policy.flatMap((pattern) => {
      try { return [new RegExp(pattern)]; } catch { return []; }
    }),
    mode: 'auto',
    denyBashWrites: true,
    denyToolWrites: true,
  });
}
