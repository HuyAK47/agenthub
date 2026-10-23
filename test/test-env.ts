import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterAll, inject } from 'vitest';

// globalSetup provides one root for the complete test run. Keep a fallback for
// direct setup-file use, and place every test-created mkdtemp below that root.
const injectedTestTmpRoot = inject('agenthubTestTmpRoot' as never) as string | undefined;
const ownsTestTmpRoot = !injectedTestTmpRoot;
const testTmpRoot = injectedTestTmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-worker-'));
afterAll(() => {
  if (ownsTestTmpRoot) fs.rmSync(testTmpRoot, { recursive: true, force: true });
});
process.env.TMPDIR = testTmpRoot;
const fallbackSafeHome = fs.mkdtempSync(path.join(testTmpRoot, 'agenthub-fallback-home-'));
const fallbackAgyHomes = path.join(fallbackSafeHome, 'agy-homes');
const fallbackXdgConfig = path.join(fallbackSafeHome, 'config');
const fallbackAgenthubHome = path.join(fallbackSafeHome, '.agenthub');
fs.mkdirSync(fallbackAgyHomes, { recursive: true });
fs.mkdirSync(fallbackXdgConfig, { recursive: true });
fs.mkdirSync(fallbackAgenthubHome, { recursive: true });

// Tests must never control the host's services, including when a platform
// branch is mocked to macOS. Put fail-fast shims first in PATH for every worker
// and every child process it starts.
const serviceShimDir = fs.mkdtempSync(path.join(testTmpRoot, 'agenthub-service-shims-'));
for (const command of ['systemctl', 'launchctl']) {
  const shim = path.join(serviceShimDir, command);
  fs.writeFileSync(shim, '#!/bin/sh\necho "blocked test service command: ' + command + ' $*" >&2\nexit 1\n', { mode: 0o755 });
}
process.env.PATH = `${serviceShimDir}${path.delimiter}${process.env.PATH || ''}`;

// Every test worker and every child it starts gets a private home/config tree.
// Do not inherit the developer's HOME even when the test runner was launched
// from the real hub account.
process.env.HOME = fallbackSafeHome;
process.env.XDG_CONFIG_HOME = fallbackXdgConfig;
process.env.AGENTHUB_HOME = fallbackAgenthubHome;
// Keep tests safe even when an individual test temporarily clears the explicit
// agy-homes override while constructing a fresh config.
process.env.AGENTHUB_TEST_MODE = '1';
// The test runner itself is not an AgentHub worker. Individual tests that
// exercise worker behavior set this flag explicitly and restore it afterwards.
delete process.env.AGENTHUB_WORKER;
delete process.env.AGENTHUB_ALLOW_SERVICE_WRITE;
if (!process.env.AGENTHUB_AGY_HOMES) {
  process.env.AGENTHUB_AGY_HOMES = fallbackAgyHomes;
}
if (!process.env.AGENTHUB_DEFAULT_LOG_DIR) {
  process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
}
if (!process.env.AGENTHUB_AGY_BIN) {
  process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
}

// Fake agents/CLIs spawned by tests exit on their own once this test process is gone
// (see test/fixtures/orphan-guard.mjs).
process.env.AGENTHUB_TEST_OWNER_PID = String(process.pid);
