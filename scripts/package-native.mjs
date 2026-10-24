import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function prepareMacosNativeBinaries(staging, platform = process.platform) {
  if (platform !== 'darwin') return;

  const nodePtyRoot = path.join(staging, 'node_modules', 'node-pty');
  if (fs.existsSync(nodePtyRoot)) {
    const helpers = execFileSync('find', [nodePtyRoot, '-type', 'f', '-name', 'spawn-helper'], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const helper of helpers) fs.chmodSync(helper, 0o755);
  }

  // A downloaded release must not carry a Gatekeeper quarantine attribute into
  // the extracted helper. Missing xattr or an absent attribute is harmless.
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', staging], { stdio: 'ignore' });
  } catch {
    // Keep packaging usable on minimal/custom macOS runners.
  }
}
