import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  cmdInstallService,
  cmdMcpInstall,
  cmdOpen,
  cmdLink,
  findProjectRoot,
} from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { getOrCreateToken } from '../src/auth.js';

describe('AgentHub CLI and Installation', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-home-'));
    process.env.AGENTHUB_HOME = path.join(tmpHome, '.agenthub');
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpHome, '.agy-homes');
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
  });

  it('findProjectRoot finds the root package directory', () => {
    const root = findProjectRoot();
    expect(fs.existsSync(path.join(root, 'package.json'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    expect(pkg.name).toBe('agenthub');
  });

  it('cmdOpen prints the web dashboard URL with secret token', async () => {
    const config = loadConfig();
    getOrCreateToken(config.tokenPath);

    const url = await cmdOpen(config, ['--no-browser']);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
  });

  it('cmdOpen invokes the platform browser command when browser is enabled', async () => {
    const config = loadConfig();
    getOrCreateToken(config.tokenPath);

    let calledCmd = '';
    let calledArgs: string[] = [];
    const mockOpen = (cmd: string, args: string[]) => {
      calledCmd = cmd;
      calledArgs = args;
    };

    const url = await cmdOpen(config, [], mockOpen);
    expect(calledCmd).toBe(process.platform === 'darwin' ? 'open' : 'xdg-open');
    expect(calledArgs).toEqual([url]);

    const cliSource = fs.readFileSync(path.resolve(findProjectRoot(), 'src', 'cli.ts'), 'utf-8');
    expect(cliSource).not.toMatch(/exec\s*\(\s*`(?:xdg-open|open)/);
  });

  it('cmdInstallService --print outputs the platform service content without writing files', async () => {
    const output = await cmdInstallService(['--print']);
    const root = findProjectRoot();
    const expectedCliPath = path.resolve(root, 'dist', 'cli.js');

    if (process.platform === 'darwin') {
      expect(output).toContain('<plist');
      expect(output).toContain('dev.agenthub');
      expect(output).toContain('LaunchAgents');
      return;
    }
    expect(output).toContain('[Unit]');
    expect(output).toContain('Description=AgentHub Daemon');
    expect(output).toContain(`ExecStart=${process.execPath} ${expectedCliPath} daemon`);
    expect(output).toContain('Restart=on-failure');
    expect(output).toContain('Environment=PATH=');
    expect(output).toContain('systemctl --user daemon-reload');
    expect(output).toContain('systemctl --user enable --now agenthub');
  });

  it('cmdMcpInstall --print outputs claude mcp add command', async () => {
    const command = await cmdMcpInstall(['--print']);
    const root = findProjectRoot();
    const expectedCliPath = path.resolve(root, 'dist', 'cli.js');

    // Lệnh dùng đường dẫn tuyệt đối của claude khi tìm thấy (Claude có thể nằm trong Node khác).
    expect(command).toMatch(/(^|\/)claude mcp add /);
    expect(command.endsWith(`mcp add --scope user agenthub -- ${process.execPath} ${expectedCliPath} mcp`)).toBe(true);
  });

  it('bin/agenthub wrapper script exists and is executable', () => {
    const root = findProjectRoot();
    const wrapper = path.join(root, 'bin', 'agenthub');
    expect(fs.existsSync(wrapper)).toBe(true);

    const stat = fs.statSync(wrapper);
    // Check executable bit
    expect((stat.mode & 0o111) !== 0).toBe(true);

    const content = fs.readFileSync(wrapper, 'utf-8');
    expect(content).toContain('nvm use 22');
    expect(content).toContain('CLI_PATH="$ROOT_DIR/dist/cli.js"');
  });

  it('cmdLink creates symlink to wrapper script', async () => {
    // Override homedir temporarily via spy or env
    const originalHomedir = os.homedir;
    try {
      os.homedir = () => tmpHome;
      const targetPath = await cmdLink();

      expect(fs.existsSync(targetPath)).toBe(true);
      expect(fs.lstatSync(targetPath).isSymbolicLink()).toBe(true);

      const target = fs.readlinkSync(targetPath);
      const root = findProjectRoot();
      expect(target).toBe(path.resolve(root, 'bin', 'agenthub'));
    } finally {
      os.homedir = originalHomedir;
    }
  });

  it('cmdBrain updates brain status directly in DB when daemon is offline', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-brain-'));
    try {
      const config = loadConfig(tmp);
      config.port = 65534;
      const { cmdBrain, BrainRepo } = await import('../src/brain.js');
      const { openDatabase } = await import('../src/db/index.js');

      const result = await cmdBrain(config, [
        'planning',
        'Lập kế hoạch task 2',
        '--task',
        'proj/t-2',
      ]);

      expect(result.activity).toBe('planning');
      expect(result.detail).toBe('Lập kế hoạch task 2');
      expect(result.taskId).toBe('proj/t-2');

      const db = openDatabase(config.dbPath);
      const repo = new BrainRepo(db);
      const row = repo.get();
      db.close();

      expect(row).toBeDefined();
      expect(row?.activity).toBe('planning');
      expect(row?.detail).toBe('Lập kế hoạch task 2');
      expect(row?.taskId).toBe('proj/t-2');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('cmdBrain validates arguments and activity enum', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cli-brain-val-'));
    try {
      const config = loadConfig(tmp);
      const { cmdBrain } = await import('../src/brain.js');

      await expect(cmdBrain(config, [])).rejects.toThrow('Thiếu tham số');
      await expect(cmdBrain(config, ['invalid_act', 'detail'])).rejects.toThrow();
      await expect(cmdBrain(config, ['idle', 'a'.repeat(301)])).rejects.toThrow('300');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
