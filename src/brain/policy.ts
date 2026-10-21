import fs from 'node:fs';
import path from 'node:path';

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
  extraPatterns?: RegExp[];
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

function words(command: string): string[] | undefined {
  const result: string[] = [];
  const re = /(?:[^\s"']|"[^"]*"|'[^']*')+/g;
  const matches = command.match(re);
  if (!matches) return undefined;
  for (const match of matches) result.push(match.replace(/^(['"])(.*)\1$/, '$2'));
  return result;
}

function splitShell(command: string): string[] | undefined {
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
    if (char === '$' && command[i + 1] === '(') { depth += 1; i += 1; continue; }
    if (char === ')' && depth > 0) { depth -= 1; continue; }
    if (char === '`' && depth === 0) { return undefined; }
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

function allowedCommand(command: string, roots: string[], cwd: string): boolean {
  const parts = splitShell(command);
  if (!parts || parts.some((part) => !part.trim())) return false;
  return parts.every((part) => {
    const tokens = words(part.trim());
    if (!tokens || tokens.length === 0) return false;
    const redirect = tokens.findIndex((token) => /^(?:>>?|<<?)$/.test(token) || /^(?:>>?|<<?)/.test(token));
    if (redirect >= 0) {
      const target = tokens[redirect].replace(/^(?:>>?|<<?)/, '') || tokens[redirect + 1];
      if (!safePath(target, roots, cwd)) return false;
    }
    const executable = path.basename(tokens[0]);
    const args = tokens.slice(1).filter((token) => !/^(?:>>?|<<?)$/.test(token));
    if (executable === 'git') return args.length > 0 && GIT_COMMANDS.has(args[0]) && !args.includes('--hard');
    if (executable === 'npm' || executable === 'pnpm') {
      if (executable === 'npm' && args[0] === 'run') return ['test', 'lint', 'typecheck', 'build', 'build:web'].includes(args[1]);
      return ['test', 'lint', 'typecheck', 'build'].includes(args[0]);
    }
    if (executable === 'npx') return args[0] === 'vitest' && args[1] === 'run';
    if (executable === 'cat' || executable === 'head' || executable === 'tail' || executable === 'wc' || executable === 'ls') {
      return args.filter((arg) => !arg.startsWith('-') && !/^\d+$/.test(arg)).every((arg) => safePath(arg, roots, cwd));
    }
    return false;
  });
}

export class BrainPolicy {
  private roots: string[];
  constructor(options: BrainPolicyOptions) {
    this.roots = options.roots.filter((root) => Boolean(realPath(root)));
    this.extraPatterns = options.extraPatterns || [];
  }
  private extraPatterns: RegExp[];

  decide(request: BrainPolicyRequest): BrainPolicyDecision | null {
    const { toolName, input } = request;
    const command = typeof input.command === 'string' ? input.command : '';
    const paths = [input.file_path, input.path].filter((value): value is string => typeof value === 'string');
    if (SECRET_PATH.test(paths.join(' ')) || SECRET_PATH.test(command)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Policy từ chối truy cập token/credential' };
    }
    if (toolName.startsWith('mcp__agenthub__')) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'MCP AgentHub được policy tự cho phép' };
    }
    if (toolName === 'Bash' && DENY_COMMAND.test(command)) {
      return { action: 'deny', reason: 'policy:deny', message: 'Lệnh thuộc danh sách luôn từ chối' };
    }
    if (this.extraPatterns.some((pattern) => pattern.test(command || JSON.stringify(input)))) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Khớp brain.policy' };
    }
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    if (!this.roots.some((root) => within(cwd, root))) return null;
    if (READ_TOOLS.has(toolName)) {
      return paths.length === 0 || paths.every((value) => safePath(value, this.roots, cwd))
        ? { action: 'allow', reason: 'policy:auto_allow', message: 'Đọc trong phạm vi project/worktree' }
        : null;
    }
    if (toolName === 'Bash' && allowedCommand(command, this.roots, cwd)) {
      return { action: 'allow', reason: 'policy:auto_allow', message: 'Lệnh Bash an toàn trong phạm vi project/worktree' };
    }
    return null;
  }
}
