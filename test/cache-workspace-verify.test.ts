import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyWorkspaceInstall } from '../src/cache.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ws-verify-'));
  dirs.push(root);
  write(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
  write(path.join(root, 'package.json'), { name: 'root', devDependencies: { turbo: '1' } });
  write(path.join(root, 'node_modules/turbo/package.json'), { name: 'turbo', bin: { turbo: 'bin.js' } });
  write(path.join(root, 'node_modules/.bin/turbo'), '');
  // Package có devDependency kèm bin và một gói chỉ có type (không có bin)
  write(path.join(root, 'apps/api/package.json'), {
    name: 'api',
    devDependencies: { typescript: '5', '@types/node': '22' },
  });
  write(path.join(root, 'apps/api/node_modules/typescript/package.json'), {
    name: 'typescript',
    bin: { tsc: 'bin/tsc' },
  });
  write(path.join(root, 'apps/api/node_modules/@types/node/package.json'), { name: '@types/node' });
  write(path.join(root, 'apps/api/node_modules/.bin/tsc'), '');
  // Package không có dependency: pnpm không tạo node_modules
  write(path.join(root, 'packages/config/package.json'), { name: 'config' });
  return root;
}

describe('verifyWorkspaceInstall', () => {
  it('chấp nhận package không có dependency và gói không khai báo bin', () => {
    expect(verifyWorkspaceInstall(workspace())).toBe(true);
  });

  it('phát hiện thiếu bin của devDependency', () => {
    const root = workspace();
    fs.rmSync(path.join(root, 'apps/api/node_modules/.bin/tsc'));
    expect(verifyWorkspaceInstall(root)).toBe(false);
  });

  it('phát hiện package có dependency nhưng thiếu node_modules', () => {
    const root = workspace();
    fs.rmSync(path.join(root, 'apps/api/node_modules'), { recursive: true });
    expect(verifyWorkspaceInstall(root)).toBe(false);
  });
});
