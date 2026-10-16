#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

console.log('Fake agy login session starting...');
console.log('Simulating interactive authentication...');

// Write authenticated log to $HOME/.gemini/antigravity-cli/log/
const homeDir = process.env.HOME || os.homedir();
const logDir = path.join(homeDir, '.gemini', 'antigravity-cli', 'log');

function writeLog() {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(
    path.join(logDir, 'agy.log'),
    'Starting agy...\nauthenticated successfully as test@example.com\nDone.\n',
    'utf-8',
  );
}

const delayMs = parseInt(process.env.FAKE_AGY_LOG_DELAY_MS || '0', 10);
if (delayMs > 0) {
  setTimeout(() => {
    writeLog();
  }, delayMs);
} else {
  writeLog();
}

console.log('authenticated successfully as test@example.com');
console.log('Mock login complete, exiting.');

// Exit after log has had a chance to be written
setTimeout(() => {
  process.exit(0);
}, delayMs > 0 ? delayMs + 500 : 100);

process.stdin.on('data', () => {
  if (delayMs > 0) {
    setTimeout(() => {
      process.exit(0);
    }, delayMs + 500);
  } else {
    process.exit(0);
  }
});
