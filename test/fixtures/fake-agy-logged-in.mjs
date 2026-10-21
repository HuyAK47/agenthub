#!/usr/bin/env node
// Giả lập agy đã đăng nhập: vào thẳng chat, ghi lại các lệnh nhận được.
// FAKE_AGY_LOGIN_NEEDS_LOGOUT=1: /login chỉ hiện link sau khi đã /logout.
import fs from 'node:fs';

const record = process.env.FAKE_AGY_COMMANDS_FILE;
const needsLogout = process.env.FAKE_AGY_LOGIN_NEEDS_LOGOUT === '1';
let loggedOut = false;
let line = '';

process.stdout.write('Antigravity CLI\n> \n? for shortcuts\n');
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  for (const ch of chunk.toString()) {
    if (ch !== '\r') { line += ch; continue; }
    if (record) fs.appendFileSync(record, `${line}\n`);
    if (line === '/logout') { loggedOut = true; process.stdout.write('Logged out.\n'); }
    if (line === '/login' && (!needsLogout || loggedOut)) {
      process.stdout.write('Copy and paste the URL: https://accounts.google.com/o/oauth2/auth?x=1\nauthorization code...\n');
    }
    line = '';
  }
});
setTimeout(() => process.exit(0), 20_000);
