import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cmdUpdate } from '../src/update.js';
import { linuxPlatform } from '../src/platform/linux.js';

const installer = path.resolve('scripts/install.sh');

describe('safe installer and updater commands', () => {
  it('uninstalls only temporary paths and calls the injected systemctl', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-'));
    const bin = path.join(home, 'bin');
    const log = path.join(home, 'systemctl.log');
    const fakeSystemctl = path.join(bin, 'systemctl');
    const app = path.join(home, 'app');
    const data = path.join(home, 'data');
    const linkDir = path.join(home, 'links');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(app, 'sentinel'), 'app');
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
    expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-C', app, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);
    fs.writeFileSync(path.join(data, 'sentinel'), 'data');
    fs.symlinkSync(path.join(app, 'sentinel'), path.join(linkDir, 'agenthub'));
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENTHUB_FAKE_LOG"\n');
    fs.chmodSync(fakeSystemctl, 0o755);

    const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: data,
        AGENTHUB_LINK_DIR: linkDir,
        AGENTHUB_SYSTEMCTL: fakeSystemctl,
        AGENTHUB_FAKE_LOG: log,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(app)).toBe(false);
    expect(fs.existsSync(data)).toBe(true);
    expect(fs.existsSync(path.join(linkDir, 'agenthub'))).toBe(false);
    expect(fs.readFileSync(log, 'utf8')).toContain('--user stop agenthub');
    expect(fs.readFileSync(log, 'utf8')).toContain('--user disable agenthub');
    expect(fs.readFileSync(log, 'utf8')).toContain('--user daemon-reload');
  });

  it('does not delete an ordinary git directory without the installer marker', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-unmarked-'));
    const app = path.join(home, 'repo');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'sentinel'), 'keep');
    expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(app, 'sentinel'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua xoá thư mục ứng dụng');
  });

  it('refuses to delete HOME even when it has an installer marker', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-home-'));
    fs.writeFileSync(path.join(home, '.agenthub-app'), 'version=0.1.0\n');
    expect(spawnSync('git', ['-C', home, 'init'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-C', home, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: home,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(home, '.agenthub-app'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua xoá thư mục ứng dụng');
  });

  it('does not purge a data directory without AgentHub data markers', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-purge-'));
    const app = path.join(home, 'app');
    const data = path.join(home, 'data');
    const linkDir = path.join(home, 'links');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(linkDir, { recursive: true });
    fs.writeFileSync(path.join(data, 'unrelated'), 'keep');
    fs.writeFileSync(path.join(app, '.agenthub-app'), 'version=0.1.0\n');
    expect(spawnSync('git', ['-C', app, 'init'], { encoding: 'utf8' }).status).toBe(0);
    expect(spawnSync('git', ['-C', app, 'config', 'agenthub.installed', 'true'], { encoding: 'utf8' }).status).toBe(0);

    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--purge'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: data,
        AGENTHUB_LINK_DIR: linkDir,
        AGENTHUB_SYSTEMCTL: '/bin/false',
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(data, 'unrelated'))).toBe(true);
    expect(result.stdout).toContain('Bỏ qua purge');
  });

  it('dry-run never invokes the injected service command or changes paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-dry-'));
    const log = path.join(home, 'systemctl.log');
    const result = spawnSync('/bin/sh', [installer, '--uninstall', '--dry-run'], {
      env: {
        ...process.env,
        HOME: home,
        AGENTHUB_DIR: path.join(home, 'app'),
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'must-not-run'),
        AGENTHUB_FAKE_LOG: log,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run]');
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(path.join(home, 'app'))).toBe(false);
  });

  it('update uses the injected systemctl for the restart step', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-update-'));
    const projectRoot = path.join(home, 'repo');
    const log = path.join(home, 'systemctl.log');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.writeFileSync(fakeSystemctl, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    fs.chmodSync(fakeSystemctl, 0o755);
    const calls: string[] = [];

    const result = await cmdUpdate({}, [], {
      projectRoot,
      exec: (command, args) => {
        calls.push(`${command} ${args.join(' ')}`);
        if (args[0] === 'tag') return { stdout: 'v1.0.0\n', status: 0 };
        if (args[0] === 'status') return { stdout: '', status: 0 };
        return { stdout: '', status: 0 };
      },
      restartService: () => {
        const previous = process.env.AGENTHUB_SYSTEMCTL;
        process.env.AGENTHUB_SYSTEMCTL = fakeSystemctl;
        try {
          return linuxPlatform.restartService();
        } finally {
          if (previous === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
          else process.env.AGENTHUB_SYSTEMCTL = previous;
        }
      },
      log: () => undefined,
    });

    expect(result.success).toBe(true);
    expect(calls).toContain('git fetch --tags origin');
    expect(fs.readFileSync(log, 'utf8')).toContain('--user restart agenthub');
  });

  it('skips service installation when systemctl is unavailable', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-no-systemd-'));
    const previous = process.env.AGENTHUB_SYSTEMCTL;
    process.env.AGENTHUB_SYSTEMCTL = path.join(home, 'missing-systemctl');
    try {
      const result = linuxPlatform.installService({
        nodePath: process.execPath,
        cliPath: path.join(home, 'dist', 'cli.js'),
        currentPath: '/tmp/bin',
        homeDir: home,
        print: false,
      });
      expect(result.skipped).toBe(true);
      expect(result.message).toContain('chạy thủ công: agenthub daemon');
      expect(fs.existsSync(result.file)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
      else process.env.AGENTHUB_SYSTEMCTL = previous;
    }
  });

  it('reports a clear error when the release has no archive for the machine architecture', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-arch-'));
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(fakeBin);
    const fakeUname = path.join(fakeBin, 'uname');
    fs.writeFileSync(fakeUname, '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo riscv64 ;; esac\n');
    fs.chmodSync(fakeUname, 0o755);

    const result = spawnSync('/bin/sh', [installer, '--from-release', '1.2.3'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        AGENTHUB_DIR: path.join(home, 'app'),
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_BASE: path.join(home, 'releases'),
      },
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('không có archive AgentHub cho kiến trúc riscv64');
  });

  it('removes stale release staging directories while retaining two old releases', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-installer-cleanup-'));
    const app = path.join(home, 'app');
    const releaseBase = path.join(home, 'releases', 'releases', 'download', 'v1.2.3');
    const payload = path.join(home, 'payload');
    const fakeBin = path.join(home, 'bin');
    fs.mkdirSync(path.join(app, '0.9.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '0.8.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '0.7.0'), { recursive: true });
    fs.mkdirSync(path.join(app, '.0.6.0.tmp.123'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(payload, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'package.json'), '{}');
    fs.writeFileSync(path.join(payload, 'bin', 'agenthub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.mkdirSync(releaseBase, { recursive: true });
    expect(spawnSync('tar', ['-czf', path.join(releaseBase, 'agenthub-1.2.3-linux-x64.tar.gz'), '-C', payload, '.']).status).toBe(0);
    expect(spawnSync('sha256sum', ['agenthub-1.2.3-linux-x64.tar.gz'], { cwd: releaseBase, encoding: 'utf8' }).status).toBe(0);
    const checksum = spawnSync('sha256sum', ['agenthub-1.2.3-linux-x64.tar.gz'], { cwd: releaseBase, encoding: 'utf8' }).stdout;
    fs.writeFileSync(path.join(releaseBase, 'SHA256SUMS'), checksum);
    fs.mkdirSync(fakeBin);
    const fakeCurl = path.join(fakeBin, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nurl=""; out=""\nwhile [ "$#" -gt 0 ]; do case "$1" in file://*) url="$1" ;; -o) shift; out="$1" ;; esac; shift; done\ncp "${url#file://}" "$out"\n');
    fs.chmodSync(fakeCurl, 0o755);

    const result = spawnSync('/bin/sh', [installer, '--from-release', '1.2.3'], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        AGENTHUB_DIR: app,
        AGENTHUB_HOME: path.join(home, 'data'),
        AGENTHUB_RELEASE_BASE: path.join(home, 'releases'),
        AGENTHUB_LINK_DIR: path.join(home, 'links'),
        AGENTHUB_SYSTEMCTL: path.join(home, 'missing-systemctl'),
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(app, '.0.6.0.tmp.123'))).toBe(false);
    expect(fs.existsSync(path.join(app, '0.7.0'))).toBe(false);
    expect(fs.existsSync(path.join(app, '0.8.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '0.9.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '1.2.3'))).toBe(true);
  });
});
