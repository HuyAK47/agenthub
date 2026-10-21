import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInProcessGroup } from './priority.js';
import { workerEnvironment } from './worker-guard.js';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 8192;

export interface MergeConfig {
  enabled: boolean;
  worktrees: Record<string, string>;
  checks: string[];
  timeoutSec: number;
}

interface MergeTask {
  slug: string;
  branch: string | null;
  baseRef: string | null;
}

interface MergeProject {
  defaultBranch: string;
  merge?: string | null;
  settings?: string | null;
}

export class MergeError extends Error {
  constructor(public statusCode: 409 | 422, public error: 'conflict' | 'unprocessable_entity', message: string) {
    super(message);
    this.name = 'MergeError';
  }
}

function parseConfig(value: string | null | undefined): MergeConfig {
  if (!value) throw new MergeError(409, 'conflict', 'Project chưa cấu hình merge tự động');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new MergeError(409, 'conflict', 'Cấu hình merge không hợp lệ'); }
  const config = parsed as Partial<MergeConfig>;
  if (config.enabled !== true || !config.worktrees || typeof config.worktrees !== 'object') {
    throw new MergeError(409, 'conflict', 'Merge tự động chưa được bật hoặc chưa có worktree tích hợp');
  }
  return {
    enabled: true,
    worktrees: config.worktrees as Record<string, string>,
    checks: Array.isArray(config.checks) ? config.checks.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [],
    timeoutSec: typeof config.timeoutSec === 'number' && config.timeoutSec > 0 ? config.timeoutSec : 600,
  };
}

function tail(value: string): string {
  return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
}

function splitCommand(command: string): string[] {
  const result: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  for (const match of command.matchAll(re)) result.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  return result;
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: repo, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

export async function mergeTaskIntoBase(task: MergeTask, project: MergeProject): Promise<{ mergeCommit: string; checks: string[] }> {
  const config = parseConfig(project.merge);
  const baseRef = task.baseRef || project.defaultBranch;
  const integrationPath = config.worktrees[baseRef];
  if (!integrationPath || !path.isAbsolute(integrationPath)) {
    throw new MergeError(409, 'conflict', `Chưa khai báo worktree tích hợp cho baseRef "${baseRef}"`);
  }
  const repo = path.resolve(integrationPath);
  const branch = task.branch || `agenthub/${task.slug}`;
  const status = await git(repo, ['status', '--porcelain']);
  if (status) throw new MergeError(409, 'conflict', 'worktree tích hợp có thay đổi chưa commit');

  const before = await git(repo, ['rev-parse', 'HEAD']);
  const hubHome = process.env.AGENTHUB_HOME || path.join(process.env.HOME || process.cwd(), '.agenthub');
  const env = workerEnvironment(hubHome, process.env, { project });
  try {
    await execFileAsync('git', ['merge', '--no-ff', branch, '-m', `Merge branch '${branch}' into ${baseRef}`], { cwd: repo, env });
  } catch {
    let conflicts = '';
    try { conflicts = await git(repo, ['diff', '--name-only', '--diff-filter=U']); } catch { /* keep original error */ }
    try { await execFileAsync('git', ['merge', '--abort'], { cwd: repo, env }); } catch { /* best effort; caller sees conflict */ }
    throw new MergeError(409, 'conflict', conflicts ? `Xung đột merge ở: ${conflicts.split('\n').filter(Boolean).join(', ')}` : 'Merge bị xung đột');
  }

  const mergeCommit = await git(repo, ['rev-parse', 'HEAD']);
  const parents = (await git(repo, ['show', '-s', '--format=%P', mergeCommit])).split(/\s+/).filter(Boolean);
  if (mergeCommit === before || !parents.includes(before) || parents.length < 2) {
    throw new MergeError(422, 'unprocessable_entity', 'Không xác minh được merge commit vừa tạo');
  }

  const failures: string[] = [];
  for (const command of config.checks) {
    const argv = splitCommand(command);
    if (argv.length === 0) continue;
    const result = await runInProcessGroup(argv[0], argv.slice(1), {
      cwd: repo,
      env: process.env,
      timeoutMs: config.timeoutSec * 1000,
    });
    if (result.code !== 0 || result.timedOut) failures.push(`${command}: ${tail(`${result.output}${result.timedOut ? `\nTimeout sau ${config.timeoutSec}s` : ''}`)}`);
  }
  if (failures.length > 0) {
    const current = await git(repo, ['rev-parse', 'HEAD']);
    const orig = await git(repo, ['rev-parse', 'ORIG_HEAD']).catch(() => '');
    if (current !== mergeCommit || orig !== before) throw new MergeError(422, 'unprocessable_entity', 'Không an toàn để rollback merge thất bại');
    await execFileAsync('git', ['reset', '--hard', 'ORIG_HEAD'], { cwd: repo });
    throw new MergeError(422, 'unprocessable_entity', `Checks sau merge thất bại:\n${failures.join('\n\n')}`);
  }
  return { mergeCommit, checks: config.checks };
}
