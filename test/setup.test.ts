import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { UpdateConfigSchema } from '../src/services/index.js';
import { SetupManager } from '../src/tools/setup.js';

describe('first-run setup', () => {
  it('does not accept installer commands or unsafe npm package names through config API', () => {
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { command: ['sh', '-c', 'touch /tmp/pwned'] } } } })).not.toThrow();
    const parsed = UpdateConfigSchema.parse({ tools: { installers: { claude: { package: '@scope/tool@latest', versionArgs: ['--version'] } } } });
    expect(parsed.tools?.installers.claude).toEqual({ package: '@scope/tool@latest', versionArgs: ['--version'] });
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { package: 'file:./evil' } } } })).toThrow();
    expect(() => UpdateConfigSchema.parse({ tools: { installers: { claude: { package: 'evil package' } } } })).toThrow();
  });

  it('installs from the managed prefix and detects the resulting binary', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-test-'));
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nwhile [ "$1" != "--prefix" ]; do shift; done\nprefix="$2"\nmkdir -p "$prefix/node_modules/.bin"\nprintf "#!/bin/sh\\necho fake-claude 1.0\\n" > "$prefix/node_modules/.bin/claude"\nchmod +x "$prefix/node_modules/.bin/claude"\n', { mode: 0o755 });
    const previous = { tools: process.env.AGENTHUB_TOOLS_DIR, path: process.env.PATH, worker: process.env.AGENTHUB_WORKER };
    delete process.env.AGENTHUB_TOOLS_DIR;
    delete process.env.AGENTHUB_WORKER;
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH || ''}`;
    try {
      const config = loadConfig(home);
      config.tools.installers.claude = { package: 'fake-claude', versionArgs: ['--version'] };
      const events: Array<{ type: string; payload: unknown }> = [];
      const manager = new SetupManager(config, { emit: (type, _taskId, payload) => { events.push({ type, payload }); return true; } });
      await manager.install('claude');
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (events.some((event) => event.type === 'setup.install_done')) return resolve();
          if (Date.now() > deadline) return reject(new Error('setup install timed out'));
          setTimeout(poll, 10);
        };
        poll();
      });
      expect((await manager.status()).find((tool) => tool.id === 'claude')?.installed).toBe(true);
      expect(events.map((event) => event.type)).toContain('setup.install_progress');
      expect(events.map((event) => event.type)).toContain('setup.install_done');
    } finally {
      if (previous.tools === undefined) delete process.env.AGENTHUB_TOOLS_DIR; else process.env.AGENTHUB_TOOLS_DIR = previous.tools;
      if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previous.worker;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the profile refresh callback only after a successful install', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-refresh-'));
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'installer'), '#!/bin/sh\nexit "$FAKE_INSTALL_EXIT"\n', { mode: 0o755 });
    const previous = { exit: process.env.FAKE_INSTALL_EXIT, worker: process.env.AGENTHUB_WORKER };
    const refreshed: string[] = [];
    try {
      const config = loadConfig(home);
      config.tools.installers.codex = { command: [path.join(fakeBin, 'installer')], versionArgs: ['--version'] };
      const manager = new SetupManager(config, undefined, (tool) => refreshed.push(tool));
      delete process.env.AGENTHUB_WORKER;
      process.env.FAKE_INSTALL_EXIT = '0';
      await manager.install('codex');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(refreshed).toEqual(['codex']);

      process.env.FAKE_INSTALL_EXIT = '1';
      await manager.install('codex');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(refreshed).toEqual(['codex']);
    } finally {
      if (previous.exit === undefined) delete process.env.FAKE_INSTALL_EXIT;
      else process.env.FAKE_INSTALL_EXIT = previous.exit;
      if (previous.worker === undefined) delete process.env.AGENTHUB_WORKER;
      else process.env.AGENTHUB_WORKER = previous.worker;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects unknown tools and worker-mode installs', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-guard-'));
    const config = loadConfig(home);
    const manager = new SetupManager(config);
    await expect(manager.install('shell')).rejects.toThrow('không nằm trong danh mục');
    process.env.AGENTHUB_WORKER = '1';
    try { await expect(manager.install('claude')).rejects.toThrow('worker'); }
    finally { delete process.env.AGENTHUB_WORKER; fs.rmSync(home, { recursive: true, force: true }); }
  });
});
