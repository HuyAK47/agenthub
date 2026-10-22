import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createNewGitProject, inspectProject } from '../src/projects/inspect.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function tempDir() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-inspect-')); dirs.push(dir); return dir; }

describe('project wizard inspection', () => {
  it('reports git, monorepo, hooks, lockfile and guidance metadata without reading secrets', () => {
    const dir = tempDir();
    execFileSync('git', ['init', '-q', dir]);
    execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'integration']);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' }, workspaces: ['packages/*'] }));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    fs.writeFileSync(path.join(dir, 'nx.json'), '{}');
    fs.mkdirSync(path.join(dir, '.husky'));
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'rules');
    const result = inspectProject(dir, tempDir());
    expect(result.isGitRepo).toBe(true);
    expect(result.currentBranch).toBe('integration');
    expect(result.lockfiles).toContain('pnpm-lock.yaml');
    expect(result.monorepo).toEqual({ detected: true, type: 'nx' });
    expect(result.gitHooks.husky).toBe(true);
    expect(result.guidanceFiles).toContain('AGENTS.md');
    expect(result.suggestedSettings.skipInstall).toBe(true);
    expect(result.suggestedSettings.checks[0].cmd).toEqual(['npm', 'run', 'lint']);
  });

  it('creates a new project with the requested branch and empty initial commit', () => {
    const parent = tempDir();
    const dir = path.join(parent, 'new project');
    createNewGitProject(dir, 'integration');
    expect(inspectProject(dir, tempDir()).currentBranch).toBe('integration');
    expect(execFileSync('git', ['-C', dir, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1');
  });

  it('rejects an invalid default branch before creating the directory', () => {
    const parent = tempDir();
    const dir = path.join(parent, 'invalid');
    expect(() => createNewGitProject(dir, '-bad')).toThrow(/không hợp lệ/);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('stops size inspection at the entry limit', () => {
    const dir = tempDir();
    for (let i = 0; i < 20_005; i += 1) fs.writeFileSync(path.join(dir, `file-${i}`), 'x');
    const result = inspectProject(dir, tempDir());
    expect(result.sizeTruncated).toBe(true);
  });

  it('returns safe session metadata and a bounded memory preview', () => {
    const dir = tempDir();
    const home = tempDir();
    const encoded = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const claudeDir = path.join(home, '.claude', 'projects', encoded);
    fs.mkdirSync(path.join(claudeDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'session.jsonl'), '{"secret":"should not be returned"}\n');
    fs.writeFileSync(path.join(claudeDir, 'memory', 'MEMORY.md'), '# remembered\nUse the project conventions.');

    const result = inspectProject(dir, home);
    expect(result.claudeSessions).toHaveLength(1);
    expect(result.claudeSessions[0]).toMatchObject({ name: 'session.jsonl', sizeBytes: expect.any(Number) });
    expect(result.claudeSessions[0]).not.toHaveProperty('path');
    expect(result.memoryPreview).toContain('Use the project conventions.');
    expect(result.memoryPreview).not.toContain('secret');
  });
});
