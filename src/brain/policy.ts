import fs from 'node:fs';
import path from 'node:path';
import type { BrainConfig } from '../config.js';
import { projectSettings } from '../projects/settings.js';
import { effectiveBrainModeFromSettings } from './mode.js';

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
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS']);
const GIT_COMMANDS = new Set(['status', 'log', 'diff', 'show', 'branch', 'rev-parse', 'merge-base', 'merge-tree']);
const DENY_COMMAND = /(?:^|[\s/])(?:systemctl|launchctl|docker|sudo)(?:$|\s)|rm\s+-rf|prisma\s+migrate\s+reset|db\s+push\s+--accept-data-loss|git\s+push\s+--force/i;
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

function allowedCommand(command: string, roots: string[], cwd: string): boolean {
  const parts = splitShell(command);
  if (!parts || parts.some((part) => !part.trim())) return false;
  return parts.every((part) => {
    if (/^(?:eval|exec|source|\.)\b/u.test(part.trim())) return false;
    const parsed = shellWords(part.trim());
    if (!parsed || parsed.words.length === 0 || parsed.redirects.some((target) => !safePath(target, roots, cwd))) return false;
    const executable = path.basename(parsed.words[0]);
    const args = parsed.words.slice(1);
    if (executable === 'git') return allowedGit(args);
    if (executable === 'npm' || executable === 'pnpm') {
      const script = args[0] === 'run' ? args[1] : args[0];
      return ['test', 'lint', 'typecheck', 'build', 'build:web'].includes(script || '');
    }
    if (executable === 'npx') return (args[0] === 'vitest' && args[1] === 'run') || (args[0] === 'tsc' && args[1] === '--noEmit');
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
  constructor(options: BrainPolicyOptions) {
    this.roots = options.roots.filter((root) => Boolean(realPath(root)));
    this.readOnlyRoots = (options.readOnlyRoots || []).filter((root) => Boolean(realPath(root)));
    this.extraPatterns = options.extraPatterns || [];
    this.mode = options.mode || 'auto';
    this.denyBashWrites = options.denyBashWrites === true;
  }
  private extraPatterns: RegExp[];

  decide(request: BrainPolicyRequest): BrainPolicyDecision | null {
    const { toolName, input } = request;
    const command = typeof input.command === 'string' ? input.command : '';
    const paths = [input.file_path, input.path].filter((value): value is string => typeof value === 'string');
    if (SECRET_PATH.test(paths.join(' ')) || SECRET_PATH.test(command)) {
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
    if (toolName === 'Bash' && DENY_COMMAND.test(command)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Lệnh thuộc danh sách luôn từ chối' };
    }
    if (toolName === 'Bash' && this.denyBashWrites && !allowedCommand(command, this.roots, typeof input.cwd === 'string' ? input.cwd : process.cwd())) {
      return { action: 'deny', reason: 'policy:deny', message: 'Trợ lý chỉ được dùng Bash cho thao tác đọc an toàn' };
    }
    const touchesReadOnly = paths.some((value) => this.readOnlyRoots.some((root) => within(path.isAbsolute(value) ? value : path.resolve(process.cwd(), value), root)));
    if (touchesReadOnly && !READ_TOOLS.has(toolName)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Policy chỉ cho phép đọc trong references của project' };
    }
    if (this.extraPatterns.some((pattern) => pattern.test(command || JSON.stringify(input)))) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Khớp brain.policy' };
    }
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    if (READ_TOOLS.has(toolName)) {
      return paths.length === 0 || paths.every((value) => safePath(value, [...this.roots, ...this.readOnlyRoots], cwd))
        ? { action: 'allow', reason: 'policy:auto_allow', message: 'Đọc trong phạm vi project/worktree' }
        : null;
    }
    if (toolName === 'Write' || toolName === 'Edit') {
      if (!paths.every((value) => safePath(value, this.roots, cwd))) {
        return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối ghi ngoài phạm vi project/worktree' };
      }
    }
    if (!this.roots.some((root) => within(cwd, root))) return null;
    if (toolName === 'Bash' && allowedCommand(command, this.roots, cwd)) {
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
  config: { worktreesDir: string; brain: Pick<BrainConfig, 'mode' | 'policy'> },
): BrainPolicy {
  const settings = projectSettings(project);
  return new BrainPolicy({
    roots: [project.path, path.join(config.worktreesDir, project.id)],
    readOnlyRoots: settings.references.map((reference) => reference.path),
    extraPatterns: config.brain.policy.flatMap((pattern) => {
      try { return [new RegExp(pattern)]; } catch { return []; }
    }),
    mode: effectiveBrainModeFromSettings(settings, config.brain) === 'auto' ? 'auto' : 'suggest',
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
  });
}
