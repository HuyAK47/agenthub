import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageJson.version);
const platform = process.platform === 'darwin' ? 'macos' : process.platform;
const archiveName = `agenthub-${version}-${platform}-${process.arch}.tar.gz`;
const outputDir = path.join(root, 'release');
const tmpRoot = process.env.AGENTHUB_TEST_TMP_ROOT || os.tmpdir();
const staging = fs.mkdtempSync(path.join(tmpRoot, 'agenthub-package-'));

const required = [
  'dist',
  'package.json',
  'package-lock.json',
  'bin',
  'README.md',
  'LICENSE',
  'docs/GETTING-STARTED.md',
  'docs/BRAIN-PLAYBOOK.md',
  'scripts/install.sh',
];

function copy(relative) {
  const source = path.join(root, relative);
  if (!fs.existsSync(source)) throw new Error(`Missing package input: ${relative}`);
  const target = path.join(staging, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true, dereference: false });
}

function prepareMacosNativeBinaries() {
  if (process.platform !== 'darwin') return;
  const nodePtyRoot = path.join(staging, 'node_modules', 'node-pty');
  if (fs.existsSync(nodePtyRoot)) {
    for (const helper of execFileSync('find', [nodePtyRoot, '-type', 'f', '-name', 'spawn-helper'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
      fs.chmodSync(helper, 0o755);
    }
  }
  // A downloaded release must not carry a Gatekeeper quarantine attribute into
  // the extracted helper. xattr is available on macOS, but older/custom
  // runners may not have it, so absence of the command is harmless.
  try {
    execFileSync('xattr', ['-dr', 'com.apple.quarantine', staging], { stdio: 'ignore' });
  } catch {
    // No quarantine attribute or no xattr command.
  }
}

try {
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:web'], { cwd: root, stdio: 'inherit' });
  for (const item of required) copy(item);
  // Release archives are self-contained and build native modules on the release runner.
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--prefix', staging], { stdio: 'inherit' });
  // Native modules (node-pty, better-sqlite3) only load on the Node major they were built for:
  // record it so install.sh can pick a matching Node and bin/agenthub always runs with it.
  prepareMacosNativeBinaries();
  fs.writeFileSync(path.join(staging, 'node-runtime'), `${process.versions.node.split('.')[0]}\n`);
  fs.mkdirSync(outputDir, { recursive: true });
  const archivePath = path.join(outputDir, archiveName);
  if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);

  execFileSync('tar', ['-czf', archivePath, '-C', staging, '.'], { stdio: 'inherit' });
  const listing = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  if (!listing.split('\n').some((entry) => entry === './node_modules/' || entry.startsWith('./node_modules/'))) {
    throw new Error('Release archive is missing production node_modules');
  }

  const digest = createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
  const sumsPath = path.join(outputDir, 'SHA256SUMS');
  const existing = fs.existsSync(sumsPath)
    ? fs.readFileSync(sumsPath, 'utf8').split('\n').filter((line) => line && !line.endsWith(`  ${archiveName}`))
    : [];
  fs.writeFileSync(sumsPath, [...existing, `${digest}  ${archiveName}`, ''].join('\n'));
  console.log(`Created ${path.relative(root, archivePath)}`);
  console.log(`SHA256SUMS: ${path.relative(root, sumsPath)}`);
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
