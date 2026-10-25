import os from 'node:os';
import path from 'node:path';

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + path.sep);
}

/**
 * Service files are host-level state. A worker must never write them, and a
 * Vitest process must not write the real user's files by accident. Tests may
 * opt in only after selecting a temporary HOME.
 */
export function assertServiceWriteAllowed(file: string): void {
  if (process.env.AGENTHUB_ALLOW_SERVICE_WRITE === '1') return;

  if (process.env.AGENTHUB_WORKER === '1') {
    throw new Error('AgentHub: worker không được ghi service file thật; dùng HOME tạm và AGENTHUB_ALLOW_SERVICE_WRITE=1 trong test');
  }

  const realHome = path.resolve(os.userInfo().homedir);
  const target = path.resolve(file);
  const testTmp = process.env.AGENTHUB_TEST_TMP_ROOT;
  if (testTmp && isWithin(path.resolve(testTmp), target)) {
    return;
  }
  if (process.env.VITEST && isWithin(realHome, target)) {
    throw new Error(`AgentHub: Vitest bị từ chối ghi service file dưới HOME thật: ${target}; dùng HOME tạm hoặc AGENTHUB_ALLOW_SERVICE_WRITE=1`);
  }
}
