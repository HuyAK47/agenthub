#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dbPath = valueAfter('--db') || path.join(process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'), 'hub.db');
const since = Math.floor(Date.now() / 1000) - 60 * 60;
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${path.basename(dbPath)}`);
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT type, payload FROM events WHERE ts >= ? ORDER BY id').all(since);
    const important = new Set(['brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed']);
    const directDesktop = new Set(['brain.notify', 'batch.created', 'task.review_ready', 'task.failed', 'task.blocked', 'task.paused', 'load.task_paused', 'load.high', 'task.resumed', 'load.task_resumed', 'review.escalated', 'disk.low', 'disk.ok', 'disk.docker_low', 'quota.exhausted', 'claude.fallback_changed', 'claude.auto_resumed', 'profile.auth_expired', 'ci.failed', 'ci.passed']);
    const telegram = new Set(['task.review_ready', 'task.failed', 'task.blocked', 'quota.exhausted', 'disk.low', 'disk.ok', 'brain.notify']);
    const webStream = new Set(['quota.exhausted', 'brain.updated', 'task.failed', 'task.blocked', 'task.review_ready', 'profile.check']);
    const counts = new Map();
    for (const row of rows) {
      const item = counts.get(row.type) || { events: 0, desktopAll: 0, desktopImportant: 0, telegram: 0, webStream: 0 };
      item.events++;
      if (directDesktop.has(row.type)) item.desktopAll++;
      if (important.has(row.type)) item.desktopImportant++;
      if (telegram.has(row.type)) item.telegram++;
      if (webStream.has(row.type)) item.webStream++;
      counts.set(row.type, item);
    }
    const esc = (value) => String(value).replaceAll('|', '\\|');
    console.log('# Notification audit (last 60 minutes)\n');
    console.log(`Read-only database: ${path.basename(dbPath)}; events: ${rows.length}.\n`);
    console.log('| Event type | Events | Desktop (all) | Desktop (important) | Telegram candidates | Web SSE stream |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const [type, item] of [...counts].sort((a, b) => b[1].events - a[1].events)) {
      console.log(`| ${esc(type)} | ${item.events} | ${item.desktopAll} | ${item.desktopImportant} | ${item.telegram} | ${item.webStream} |`);
    }
    console.log('\n## Interpretation\n');
    console.log('- Desktop counts are event candidates before the service-level dedupe/throttle; `important` is the configured allow-list.');
    console.log('- `deploy.restart_waiting`, `claude.quota_available`, and `task.overlap` are intentionally absent from desktop candidates.');
    console.log('- Web currently uses SSE for cache invalidation and dashboard activity; it has no global Notification API/toast handler for these events.');
    console.log('- Telegram counts are candidates under the existing notification flags, before its dedupe/throttle.');
  } finally {
    db.close();
  }
}
