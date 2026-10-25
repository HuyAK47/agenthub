import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupStaleAgentHubTempDirs, cleanupTaskRunArtifacts, countAgentHubTempDirectories } from '../src/temp-cleanup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('temp cleanup', () => {
  it('removes only old agenthub directories owned by the test user', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-fixture-'));
    roots.push(root);
    const old = path.join(root, 'agenthub-old');
    const fresh = path.join(root, 'agenthub-fresh');
    const other = path.join(root, 'other-old');
    fs.mkdirSync(old); fs.mkdirSync(fresh); fs.mkdirSync(other);
    const now = Date.now();
    fs.utimesSync(old, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    fs.utimesSync(other, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));

    expect(await cleanupStaleAgentHubTempDirs({ tmpDir: root, now })).toEqual([old]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(other)).toBe(true);
  });

  it('removes final output while preserving the main log', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-fixture-'));
    roots.push(root);
    const log = path.join(root, 'run.log');
    const final = path.join(root, 'run.final.json');
    fs.writeFileSync(log, 'main log'); fs.writeFileSync(final, '{}');
    expect(cleanupTaskRunArtifacts([log])).toEqual([final]);
    expect(fs.existsSync(log)).toBe(true);
    expect(fs.existsSync(final)).toBe(false);
  });

  it('counts only agenthub directories', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-fixture-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'agenthub-one'));
    fs.mkdirSync(path.join(root, 'not-agenthub'));
    expect(await countAgentHubTempDirectories(root)).toBe(1);
  });

  it('skips old directories containing a git repository', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-cleanup-fixture-'));
    roots.push(root);
    const repo = path.join(root, 'agenthub-repo', 'nested');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const now = Date.now();
    fs.utimesSync(path.join(root, 'agenthub-repo'), new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    expect(await cleanupStaleAgentHubTempDirs({ tmpDir: root, now })).toEqual([]);
    expect(fs.existsSync(path.join(repo, '.git', 'hooks'))).toBe(true);
  });
});
