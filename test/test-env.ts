import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Fallback environment isolation before any test runs in worker
const fallbackSafeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fallback-home-'));
const fallbackAgyHomes = path.join(fallbackSafeHome, 'agy-homes');
fs.mkdirSync(fallbackAgyHomes, { recursive: true });

if (!process.env.AGENTHUB_HOME) {
  process.env.AGENTHUB_HOME = fallbackSafeHome;
}
if (!process.env.AGENTHUB_AGY_HOMES) {
  process.env.AGENTHUB_AGY_HOMES = fallbackAgyHomes;
}
if (!process.env.AGENTHUB_DEFAULT_LOG_DIR) {
  process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
}
if (!process.env.AGENTHUB_AGY_BIN) {
  process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
}
