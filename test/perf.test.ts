import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classify, createPerfSampler, PerfCollector } from '../src/perf.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('perf collector', () => {
  it('classifies executable names without matching arbitrary command text', () => {
    expect(classify('/usr/bin/codegen --check')).toBe('other');
    expect(classify('/opt/Visual Studio Code/code --no-sandbox')).toBe('VS Code');
    expect(classify('/usr/bin/node /repo/node_modules/vitest/vitest.mjs')).toBe('other');
    expect(classify('/usr/bin/vitest run')).toBe('test/vitest');
    expect(classify('/usr/bin/check-worker')).toBe('other');
  });

  it('uses ticks delta and keeps only latest top processes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-perf-')); dirs.push(root);
    fs.mkdirSync(path.join(root, '123'));
    fs.writeFileSync(path.join(root, 'uptime'), '10\n');
    const stat = (ticks: number) => `123 (node) S 0 0 0 0 0 0 0 0 0 0 0 ${ticks} 0 0 0 0 0 0 0 0 0 0 0 0 0`;
    fs.writeFileSync(path.join(root, '123', 'stat'), stat(10));
    fs.writeFileSync(path.join(root, '123', 'cmdline'), '/usr/bin/vitest\0run');
    const sample = createPerfSampler(root);
    sample();
    fs.writeFileSync(path.join(root, 'uptime'), '11\n');
    fs.writeFileSync(path.join(root, '123', 'stat'), stat(20));
    const second = sample();
    expect(second.groups['test/vitest'].cpuPercent).toBeGreaterThan(0);
    const collector = new PerfCollector(3, () => second);
    collector.sample(); collector.sample();
    expect(collector.getSamples()[0].processes).toEqual([]);
    expect(collector.getSamples()[1].processes.length).toBeLessThanOrEqual(10);
  });
});
