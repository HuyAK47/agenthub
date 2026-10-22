import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/** Version of the running AgentHub, read once from its package.json (src/ and dist/ sit next to it). */
export function hubVersion(): string {
  if (cached) return cached;
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
