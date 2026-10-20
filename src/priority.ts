import { spawn } from 'node:child_process';
import fs from 'node:fs';

const processGroups = new Set<number>();

/**
 * Giới hạn worker của test runner trong tiến trình con của worker và bước kiểm tra.
 * Máy người dùng 12 nhân chạy 4–6 worker song song; vitest mặc định bật số thread = số nhân.
 */
export const LIMITED_TEST_ENV: Record<string, string> = {
  VITEST_MAX_THREADS: '2',
  VITEST_MIN_THREADS: '1',
  VITEST_MAX_FORKS: '2',
  VITEST_MIN_FORKS: '1',
};

function findBinary(name: string): string | null {
  for (const dir of ['/usr/bin', '/bin', '/usr/local/bin']) {
    const candidate = `${dir}/${name}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Chạy lệnh với độ ưu tiên CPU/IO thấp (nice 10, ionice best-effort mức 7) để IDE, trình duyệt
 * của người dùng luôn được ưu tiên. `nice`/`ionice` dùng exec nên PID giữ nguyên.
 */
export function lowPriority(executable: string, args: string[]): [string, string[]] {
  if (process.platform !== 'linux' || process.env.AGENTHUB_NO_NICE === '1') return [executable, args];
  const nice = findBinary('nice');
  const ionice = findBinary('ionice');
  if (!nice) return [executable, args];
  const inner = ionice ? [ionice, '-c', '2', '-n', '7', executable, ...args] : [executable, ...args];
  return [nice, ['-n', '10', ...inner]];
}

export interface GroupRunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

/**
 * Chạy lệnh trong process group riêng; khi xong hoặc hết giờ thì kill CẢ group để không còn
 * tiến trình cháu (vitest pool, next build worker…) sống sót sau bước kiểm tra.
 */
export function runInProcessGroup(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutput?: number },
): Promise<GroupRunResult> {
  const maxOutput = opts.maxOutput ?? 4 * 1024 * 1024;
  const [exe, finalArgs] = lowPriority(command, args);
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(exe, finalArgs, {
      cwd: opts.cwd,
      env: { ...opts.env, ...LIMITED_TEST_ENV },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) processGroups.add(child.pid);
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > maxOutput) output = output.slice(-maxOutput);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const killGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // group đã thoát
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 5000).unref();
    }, opts.timeoutMs);
    timer.unref();
    const finish = (code: number | null, extra = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Dọn tiến trình cháu còn sót trong group sau khi lệnh chính đã thoát.
      killGroup('SIGKILL');
      if (child.pid) processGroups.delete(child.pid);
      resolve({ code, output: output + extra, timedOut });
    };
    child.on('error', (err) => finish(null, String(err)));
    child.on('close', (code) => finish(code));
  });
}

/** Stop every check/merge process group started by this daemon instance. */
export function stopProcessGroups(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const pid of processGroups) {
    try { process.kill(-pid, signal); } catch { /* group already exited */ }
    if (signal === 'SIGTERM') {
      const timer = setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* group already exited */ }
      }, 10_000);
      timer.unref();
    }
  }
}
