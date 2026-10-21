#!/usr/bin/env node
// Giả lập `agy -p /usage`: chỉ coi là đã đăng nhập khi file token có đúng cấu trúc agy tự ghi
// ({ token: { access_token, ... }, auth_method }); ngược lại in lỗi giống agy thật.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = process.env.HOME || os.homedir();
const tokenFile = path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
let loggedIn = false;
try {
  const saved = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
  loggedIn = typeof saved?.token?.access_token === 'string' && saved.token.access_token.length > 0 && typeof saved.auth_method === 'string';
} catch {
  loggedIn = false;
}

if (!loggedIn) {
  process.stderr.write('error getting token source: You are not logged into Antigravity.\n');
  process.exit(1);
}
const reset = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
const weekly = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
process.stdout.write([
  `Gemini Models\tFive Hour Limit Remaining\t100%\t${reset}`,
  `Gemini Models\tWeekly Limit Remaining\t99%\t${weekly}`,
  `Claude and GPT models\tFive Hour Limit Remaining\t100%\t${reset}`,
  `Claude and GPT models\tWeekly Limit Remaining\t100%\t${weekly}`,
  '',
].join('\n'));
