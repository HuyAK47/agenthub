import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { findProcessesInDir, reap } from '../src/reaper.js';
import { isDeletableWorktreePath } from '../src/worktrees/index.js';

const children: ChildProcess[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForPid(dir: string, options: { worktreesDir: string }): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const pid = findProcessesInDir(dir, options).find((candidate) => candidate !== process.pid);
    if (pid) return pid;
    await wait(20);
  }
  throw new Error('spawned process did not appear in /proc');
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
});

describe('reaper', () => {
  it('terminates a detached process in a worktree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-reaper-'));
    const worktreesDir = path.join(root, 'worktrees');
    const worktree = path.join(worktreesDir, 'project', 'task');
    fs.mkdirSync(worktree, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
    children.push(child);
    const pid = await waitForPid(worktree, { worktreesDir });

    const cleaned = await reap(worktree, { worktreesDir, graceMs: 100 });
    expect(cleaned).toContain(pid);
    await wait(50);
    expect(isAlive(pid)).toBe(false);
  });

  it('does not touch a process outside the worktrees directory or the project root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-reaper-'));
    const worktreesDir = path.join(root, 'worktrees');
    const projectRoot = path.join(root, 'project');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: outside, detached: true, stdio: 'ignore' });
    children.push(child);
    const pid = await waitForPid(outside, { worktreesDir: root });

    expect(await reap(outside, { worktreesDir, graceMs: 20 })).toEqual([]);
    expect(isAlive(pid)).toBe(true);
    expect(isDeletableWorktreePath(worktreesDir, projectRoot, [projectRoot])).toBe(false);
  });

  it('returns immediately when scheduling escalation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-reaper-'));
    const worktreesDir = path.join(root, 'worktrees');
    const worktree = path.join(worktreesDir, 'project', 'task');
    fs.mkdirSync(worktree, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: worktree, detached: true, stdio: 'ignore' });
    children.push(child);
    const pid = await waitForPid(worktree, { worktreesDir });

    const started = Date.now();
    const pending = reap(worktree, { worktreesDir, graceMs: 500 });
    expect(Date.now() - started).toBeLessThan(400);
    await pending;
    expect(isAlive(pid)).toBe(false);
  });
});
