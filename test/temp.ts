import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getTestTmpRoot(): string {
  return process.env.AGENTHUB_TEST_TMP_ROOT || process.env.TMPDIR || os.tmpdir();
}

export function makeTestTempDir(prefix = 'agenthub-test-'): string {
  const root = getTestTmpRoot();
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

export async function withTempDir<T>(
  prefixOrFn: string | ((tmpDir: string) => Promise<T> | T),
  maybeFn?: (tmpDir: string) => Promise<T> | T,
): Promise<T> {
  const prefix = typeof prefixOrFn === 'string' ? prefixOrFn : 'agenthub-test-';
  const fn = typeof prefixOrFn === 'function' ? prefixOrFn : maybeFn!;
  const tmpDir = makeTestTempDir(prefix);
  try {
    return await fn(tmpDir);
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
