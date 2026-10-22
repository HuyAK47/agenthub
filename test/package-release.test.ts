import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { cmdRollback, cmdSetup } from '../src/cli.js';

const installer = path.resolve('scripts/install.sh');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(command, args, { env: { ...process.env, ...env }, encoding: 'utf8' });
}

// Same naming as scripts/package.mjs and install.sh, so the fixture matches the runner (CI also
// runs on linux-arm64 and macos).
const PLATFORM_ARCH = `${process.platform === 'darwin' ? 'macos' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

function makeRelease(base: string, version: string, checksum = true) {
  const releaseDir = path.join(base, 'releases', 'download', `v${version}`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-release-fixture-'));
  fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'agenthub', version }));
  fs.writeFileSync(path.join(staging, 'package-lock.json'), JSON.stringify({
    name: 'agenthub', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'agenthub', version } },
  }));
  fs.writeFileSync(path.join(staging, 'bin/agenthub'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // Real release archives ship prebuilt production node_modules, so install needs no compiler.
  fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
  fs.mkdirSync(releaseDir, { recursive: true });
  const archiveName = `agenthub-${version}-${PLATFORM_ARCH}.tar.gz`;
  expect(run('tar', ['-czf', path.join(releaseDir, archiveName), '-C', staging, '.']).status).toBe(0);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(releaseDir, archiveName))).digest('hex');
  fs.writeFileSync(path.join(releaseDir, 'SHA256SUMS'), `${checksum ? digest : '0'.repeat(64)}  ${archiveName}\n`);
  fs.rmSync(staging, { recursive: true, force: true });
}

describe('release packaging and installation', () => {
  it('creates a complete archive without development or local state files', () => {
    const dist = path.resolve('dist');
    const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-dist-backup-'));
    if (fs.existsSync(dist)) fs.cpSync(dist, path.join(backup, 'dist'), { recursive: true });
    try {
      const result = run('npm', ['run', 'package']);
      expect(result.status).toBe(0);
      const releaseDir = path.resolve('release');
      const archive = fs.readdirSync(releaseDir).find((name) => /^agenthub-.*\.tar\.gz$/.test(name));
      expect(archive).toBeDefined();
      const archivePath = path.join(releaseDir, archive!);
      const listing = run('tar', ['-tzf', archivePath]).stdout.split('\n').filter(Boolean);
      for (const entry of ['dist/', 'dist/web/', 'package.json', 'package-lock.json', 'bin/', 'README.md', 'LICENSE', 'docs/GETTING-STARTED.md', 'scripts/install.sh']) {
        expect(listing).toContain(`./${entry}`);
      }
      expect(listing.some((entry) => /(^|\/)(\.agenthub|\.env)(\/|$)/.test(entry))).toBe(false);
      expect(listing).toContain('./node_modules/');
      const expected = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'), 'utf8').split(/\s+/)[0];
      const actual = crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
      expect(expected).toBe(actual);
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
      if (fs.existsSync(path.join(backup, 'dist'))) fs.cpSync(path.join(backup, 'dist'), dist, { recursive: true });
      fs.rmSync(backup, { recursive: true, force: true });
    }
  });

  it('rejects a bad checksum without changing current and keeps two old releases', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-release-install-'));
    const base = path.join(home, 'fake-release');
    const app = path.join(home, 'app');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(home, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    makeRelease(base, '1.0.0');
    makeRelease(base, '2.0.0', false);
    const env = {
      HOME: home,
      AGENTHUB_DIR: app,
      AGENTHUB_HOME: path.join(home, 'data'),
      AGENTHUB_RELEASE_BASE: base,
      AGENTHUB_SYSTEMCTL: fakeSystemctl,
      AGENTHUB_LAUNCHCTL: fakeLaunchctl,
      AGENTHUB_NO_BROWSER: '1',
    };
    expect(run('/bin/sh', [installer, '--from-release', '1.0.0'], env).status).toBe(0);
    const before = fs.readlinkSync(path.join(app, 'current'));
    const bad = run('/bin/sh', [installer, '--from-release', '2.0.0'], env);
    expect(bad.status).not.toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe(before);

    makeRelease(base, '2.0.0');
    makeRelease(base, '3.0.0');
    expect(run('/bin/sh', [installer, '--from-release', '2.0.0'], env).status).toBe(0);
    expect(run('/bin/sh', [installer, '--from-release', '3.0.0'], env).status).toBe(0);
    expect(fs.readlinkSync(path.join(app, 'current'))).toBe('3.0.0');
    expect(fs.existsSync(path.join(app, '1.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '2.0.0'))).toBe(true);
    expect(fs.existsSync(path.join(app, '3.0.0'))).toBe(true);
  });

  it.each(['', '../x', '1.0;rm'])('rejects invalid release version %j before creating app paths', (version) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-release-invalid-'));
    const app = path.join(home, 'app');
    const result = run('/bin/sh', [installer, '--from-release', version], { HOME: home, AGENTHUB_DIR: app, AGENTHUB_HOME: path.join(home, 'data') });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(app)).toBe(false);
  });
});

describe('setup in worker mode', () => {
  it('creates the token but does not install a service', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-setup-'));
    const previous = { HOME: process.env.HOME, AGENTHUB_HOME: process.env.AGENTHUB_HOME, AGENTHUB_WORKER: process.env.AGENTHUB_WORKER };
    process.env.HOME = home;
    process.env.AGENTHUB_HOME = path.join(home, 'data');
    process.env.AGENTHUB_WORKER = '1';
    try {
      const config = loadConfig();
      await cmdSetup(config, ['--no-browser']);
      expect(fs.existsSync(path.join(home, 'data', 'token'))).toBe(true);
      expect(fs.existsSync(path.join(home, '.config', 'systemd', 'user', 'agenthub.service'))).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('release rollback', () => {
  it('switches current to a requested or previous release and rejects missing history', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rollback-'));
    const app = path.join(home, 'app');
    const fakeSystemctl = path.join(home, 'systemctl');
    fs.writeFileSync(fakeSystemctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fakeLaunchctl = path.join(home, 'launchctl');
    fs.writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
      fs.mkdirSync(path.join(app, version), { recursive: true });
      fs.writeFileSync(path.join(app, version, 'package.json'), JSON.stringify({ version }));
    }
    fs.symlinkSync('3.0.0', path.join(app, 'current'));
    const previous = {
      HOME: process.env.HOME,
      AGENTHUB_SYSTEMCTL: process.env.AGENTHUB_SYSTEMCTL,
      AGENTHUB_LAUNCHCTL: process.env.AGENTHUB_LAUNCHCTL,
    };
    process.env.HOME = home;
    process.env.AGENTHUB_SYSTEMCTL = fakeSystemctl;
    process.env.AGENTHUB_LAUNCHCTL = fakeLaunchctl;
    try {
      await cmdRollback(['1.0.0'], path.join(app, '3.0.0'));
      expect(fs.readlinkSync(path.join(app, 'current'))).toBe('1.0.0');
      fs.unlinkSync(path.join(app, 'current'));
      fs.symlinkSync('3.0.0', path.join(app, 'current'));
      await cmdRollback([], path.join(app, '3.0.0'));
      expect(fs.readlinkSync(path.join(app, 'current'))).toBe('2.0.0');
    } finally {
      if (previous.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = previous.HOME;
      if (previous.AGENTHUB_SYSTEMCTL === undefined) delete process.env.AGENTHUB_SYSTEMCTL;
      else process.env.AGENTHUB_SYSTEMCTL = previous.AGENTHUB_SYSTEMCTL;
      if (previous.AGENTHUB_LAUNCHCTL === undefined) delete process.env.AGENTHUB_LAUNCHCTL;
      else process.env.AGENTHUB_LAUNCHCTL = previous.AGENTHUB_LAUNCHCTL;
    }

    const onlyCurrent = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-rollback-empty-'));
    fs.mkdirSync(path.join(onlyCurrent, '1.0.0'), { recursive: true });
    fs.writeFileSync(path.join(onlyCurrent, '1.0.0', 'package.json'), JSON.stringify({ version: '1.0.0' }));
    fs.symlinkSync('1.0.0', path.join(onlyCurrent, 'current'));
    await expect(cmdRollback([], path.join(onlyCurrent, '1.0.0'))).rejects.toThrow('Không có bản release cũ');
    expect(fs.readlinkSync(path.join(onlyCurrent, 'current'))).toBe('1.0.0');
  });
});
