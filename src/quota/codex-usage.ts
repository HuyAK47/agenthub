import fs from 'node:fs';
import path from 'node:path';

export interface CodexWindow {
  window: '5h' | 'week';
  usedPercent: number;
  resetAt: number;
}

export interface CodexRateLimits {
  windows: CodexWindow[];
  planType: string | null;
  observedAt: number;
}

const TAIL_BYTES = 256 * 1024;

/** Newest rollout files first, walking sessions/YYYY/MM/DD in reverse order. */
function newestRolloutFiles(sessionsDir: string, max = 5): string[] {
  const sortedDirs = (dir: string) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => Number(b) - Number(a));
    } catch {
      return [];
    }
  };
  const files: string[] = [];
  for (const y of sortedDirs(sessionsDir)) {
    for (const m of sortedDirs(path.join(sessionsDir, y))) {
      for (const d of sortedDirs(path.join(sessionsDir, y, m))) {
        const dayDir = path.join(sessionsDir, y, m, d);
        let names: string[] = [];
        try {
          names = fs.readdirSync(dayDir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
        } catch {
          continue;
        }
        const withTime = names
          .map((n) => {
            const full = path.join(dayDir, n);
            try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
          })
          .filter((x): x is { full: string; mtime: number } => x !== null)
          .sort((a, b) => b.mtime - a.mtime);
        for (const f of withTime) {
          files.push(f.full);
          if (files.length >= max) return files;
        }
      }
    }
  }
  return files;
}

function readTail(file: string): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

export function parseCodexRateLimits(jsonl: string, observedAt: number): CodexRateLimits | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (data.payload && typeof data.payload === 'object' ? data.payload : data) as Record<string, unknown>;
    const limits = payload.rate_limits as Record<string, unknown> | null | undefined;
    if (!limits || typeof limits !== 'object') continue;
    const windows: CodexWindow[] = [];
    for (const key of ['primary', 'secondary']) {
      const w = limits[key] as { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined;
      if (!w || typeof w.used_percent !== 'number') continue;
      const minutes = w.window_minutes ?? (key === 'primary' ? 300 : 10080);
      windows.push({
        window: minutes <= 300 ? '5h' : 'week',
        usedPercent: w.used_percent,
        resetAt: typeof w.resets_at === 'number' ? w.resets_at : 0,
      });
    }
    if (windows.length === 0) continue;
    return { windows, planType: typeof limits.plan_type === 'string' ? limits.plan_type : null, observedAt };
  }
  return null;
}

/**
 * Read the latest Codex rate limits from session logs (no network, no auth files).
 * `codexDir` is the CODEX_HOME directory (default ~/.codex).
 */
export function readCodexRateLimits(codexDir: string): CodexRateLimits | null {
  for (const file of newestRolloutFiles(path.join(codexDir, 'sessions'))) {
    try {
      const mtime = Math.floor(fs.statSync(file).mtimeMs / 1000);
      const parsed = parseCodexRateLimits(readTail(file), mtime);
      if (parsed) return parsed;
    } catch {
      // unreadable file: try the next one
    }
  }
  return null;
}
