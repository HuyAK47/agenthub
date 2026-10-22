#!/usr/bin/env node
/* Read-only notification audit. It models the notification gates and never
 * starts the daemon or calls notify-send, Telegram, or browser APIs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';

// Reuse production policy helpers without starting the daemon or invoking a
// notification transport.
register();
const [{ isQuietHours, areAllProfilesQuotaExhausted }, { NotificationDeduper }] = await Promise.all([
  import('../src/brain/digest.ts'),
  import('../src/notification-dedupe.ts'),
]);

const args = process.argv.slice(2);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = valueAfter('--db') || path.join(process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'), 'hub.db');
const configPath = valueAfter('--config') || path.join(path.dirname(dbPath), 'config.json');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${path.basename(dbPath)}`);
  process.exitCode = 1;
} else {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare(`
      SELECT id, ts, type, taskId, payload FROM events
      WHERE (typeof(ts) = 'integer' AND ts >= unixepoch('now', '-1 hour'))
         OR (typeof(ts) != 'integer' AND julianday(ts) >= julianday('now', '-1 hour'))
      ORDER BY id
    `).all();
    const profiles = db.prepare('SELECT name, engine, enabled FROM profiles WHERE deletedAt IS NULL AND enabled = 1').all();
    const marks = db.prepare('SELECT profileName, family, until FROM quota_marks').all();
    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* optional for exported databases */ }
    const notifications = config.notifications && typeof config.notifications === 'object' ? config.notifications : {};
    const desktopEnabled = notifications.desktop !== false;
    const desktopLevel = ['all', 'important', 'critical', 'off'].includes(notifications.desktopLevel) ? notifications.desktopLevel : 'important';
    const telegram = config.telegram && typeof config.telegram === 'object' ? config.telegram : {};
    const telegramEnabled = telegram.enabled === true && Array.isArray(telegram.allowedChatIds) && telegram.allowedChatIds.length > 0;
    const telegramNotify = { reviewReady: true, failed: true, blocked: true, quota: true, fallback: true, ...(telegram.notify || {}) };
    const byName = new Map(profiles.map((p) => [p.name, p]));
    const important = new Set(['brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed']);
    const notificationEvents = new Set([...important, 'batch.created', 'task.paused', 'load.task_paused', 'load.high', 'task.resumed', 'load.task_resumed', 'disk.ok', 'claude.fallback_changed', 'claude.auto_resumed', 'profile.auth_expired', 'ci.passed']);
    const counts = new Map();
    const desktopSeen = new Map();
    const desktopImportantSeen = new Map();
    const webSeen = new Map();
    const diskSeen = new Map();
    const telegramDiskSeen = new Map();
    let auditNow = 0;
    const productionDeduper = new NotificationDeduper({ now: () => auditNow });
    let loadSummaryAt = 0;
    const payloadOf = (row) => { try { return row.payload ? JSON.parse(row.payload) : {}; } catch { return {}; } };
    const timeOf = (row) => { const n = Number(row.ts); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(row.ts); };
    const inQuietHours = (at) => {
      const q = notifications.quietHours;
      return isQuietHours(q, new Date(at));
    };
    const quotaAllForEngine = (payload, at) => {
      const profile = byName.get(payload.profile || payload.profileName || payload.worker);
      const family = payload.family || payload.model;
      const engine = payload.engine || profile?.engine;
      if (!family || !engine) return payload.allExhausted === true;
      return areAllProfilesQuotaExhausted(
        { getAll: () => profiles },
        { getActive: () => marks },
        at,
        family,
        engine,
      );
    };
    const incident = (type, payload, at) => payload.level === 'incident' || payload.urgency === 'critical' || payload.critical === true
      || ['disk.low', 'disk.docker_low', 'claude.quota_exhausted', 'hub.restart_failed', 'system.error'].includes(type)
      || (type === 'quota.exhausted' && quotaAllForEngine(payload, at));
    const eventKey = (row, payload) => {
      const task = row.taskId || payload.taskId || '';
      const title = payload.title || task || 'Task';
      switch (row.type) {
        case 'brain.notify': return `${row.type}:${payload.level || 'info'}:${payload.text || ''}`;
        case 'task.review_ready': return `${row.type}:${title}:${payload.checksPassed === undefined ? '' : payload.checksPassed}`;
        case 'task.failed': return `${row.type}:${title}`;
        case 'task.blocked': return `${row.type}:${title}`;
        case 'quota.exhausted': return payload.allExhausted === true
          ? `${row.type}:all:${payload.engine || 'unknown'}:${payload.family || payload.model || 'unknown'}`
          : `${row.type}:${payload.profile || payload.profileName || payload.worker || ''}:${payload.family || payload.model || ''}`;
        case 'disk.low': return `${row.type}:${payload.freeGB || 0}:${payload.minFreeGB || 0}:${payload.cacheDir || ''}:${payload.largestCacheEntry || ''}`;
        case 'disk.ok': return `${row.type}:${payload.freeGB || 0}`;
        case 'ci.failed': return `${row.type}:${payload.projectId || task}:${payload.workflow || 'CI'}:${String(payload.sha || '').slice(0, 7)}`;
        default: return `${row.type}:${task}`;
      }
    };
    const record = (row, field, value) => {
      const item = counts.get(row.type) || { events: 0, desktopAll: 0, desktopImportant: 0, telegram: 0, web: 0 };
      item[field] += value ? 1 : 0;
      counts.set(row.type, item);
    };

    for (const row of rows) {
      const payload = payloadOf(row);
      const at = timeOf(row);
      auditNow = at;
      const eventCount = counts.get(row.type) || { events: 0, desktopAll: 0, desktopImportant: 0, telegram: 0, web: 0 };
      eventCount.events++;
      counts.set(row.type, eventCount);
      const key = eventKey(row, payload);
      const quotaAll = row.type === 'quota.exhausted' && quotaAllForEngine(payload, at);
      let desktopAll = desktopEnabled && desktopLevel !== 'off' && notificationEvents.has(row.type) && row.type !== 'task.overlap' && (row.type !== 'quota.exhausted' || quotaAll);
      let desktopImportant = desktopEnabled && desktopLevel === 'important' && important.has(row.type) && (row.type !== 'quota.exhausted' || quotaAll);
      if (desktopLevel === 'critical') desktopAll = desktopEnabled && ['task.failed', 'disk.docker_low', 'quota.exhausted'].includes(row.type) && (row.type !== 'quota.exhausted' || quotaAll);
      if (inQuietHours(at) && !incident(row.type, payload, at)) desktopAll = desktopImportant = false;
      if (row.type === 'disk.ok') {
        const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : NaN;
        const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : NaN;
        if (!Number.isFinite(freeGB) || !Number.isFinite(minFreeGB) || freeGB < minFreeGB + 1) {
          desktopAll = desktopImportant = false;
        }
      }
      if (row.type === 'disk.low' || row.type === 'disk.ok') {
        const previous = diskSeen.get(row.type) || 0;
        desktopAll = desktopAll && at - previous >= 60 * 60_000;
        desktopImportant = desktopImportant && at - previous >= 60 * 60_000;
        if (desktopAll) diskSeen.set(row.type, at);
      }
      if (row.type === 'task.paused' || row.type === 'load.task_paused' || row.type === 'load.high') {
        desktopAll = desktopAll && at - loadSummaryAt >= 15 * 60_000;
        desktopImportant = false;
        if (desktopAll) loadSummaryAt = at;
      }
      if (desktopAll) {
        desktopAll = productionDeduper.shouldSend(row.type, row.taskId || payload.taskId, payload);
      }
      if (desktopAll) {
        const previous = desktopSeen.get(key) || 0;
        desktopAll = at - previous >= 30 * 60_000;
        if (desktopAll) desktopSeen.set(key, at);
      }
      if (desktopImportant) {
        const previous = desktopImportantSeen.get(key) || 0;
        desktopImportant = at - previous >= 30 * 60_000;
        if (desktopImportant) desktopImportantSeen.set(key, at);
      }
      const telegramTypeAllowed = (row.type === 'task.review_ready' && telegramNotify.reviewReady)
        || (row.type === 'task.failed' && telegramNotify.failed)
        || (row.type === 'task.blocked' && telegramNotify.blocked)
        || (row.type === 'quota.exhausted' && telegramNotify.quota)
        || ((row.type === 'disk.low' || row.type === 'disk.ok') && telegramNotify.fallback)
        || row.type === 'brain.notify';
      const telegramCandidate = telegramEnabled && telegramTypeAllowed && (row.type !== 'quota.exhausted' || quotaAll)
        && (!inQuietHours(at) || incident(row.type, payload, at));
      const telegramKey = `telegram:${key}`;
      const telegramPrevious = desktopSeen.get(telegramKey) || 0;
      let telegram = telegramCandidate && at - telegramPrevious >= 30 * 60_000;
      if (telegram && (row.type === 'disk.low' || row.type === 'disk.ok')) {
        const previousDisk = telegramDiskSeen.get(row.type) || 0;
        telegram = at - previousDisk >= 60 * 60_000;
        if (telegram) telegramDiskSeen.set(row.type, at);
      }
      if (telegram) desktopSeen.set(telegramKey, at);
      const webAllowed = desktopEnabled && desktopLevel !== 'off' && notificationEvents.has(row.type)
        && (desktopLevel !== 'important' || important.has(row.type))
        && (desktopLevel !== 'critical' ? true : ['task.failed', 'disk.docker_low', 'quota.exhausted'].includes(row.type))
        && (row.type !== 'quota.exhausted' || quotaAll)
        && (!inQuietHours(at) || incident(row.type, payload, at));
      const webKey = row.type === 'quota.exhausted' && quotaAll
        ? `quota:${payload.engine || 'unknown'}:${payload.family || payload.model || 'unknown'}`
        : row.type === 'task.paused' || row.type === 'load.task_paused' || row.type === 'load.high'
        ? 'load:summary'
        : key;
      const webPrevious = webSeen.get(webKey) || 0;
      const webWindow = row.type === 'disk.low' || row.type === 'disk.ok' ? 60 * 60_000 : row.type.startsWith('load.') || row.type === 'task.paused' ? 15 * 60_000 : 30 * 60_000;
      const web = webAllowed && at - webPrevious >= webWindow;
      if (web) webSeen.set(webKey, at);
      record(row, 'desktopAll', desktopAll);
      record(row, 'desktopImportant', desktopImportant);
      record(row, 'telegram', telegram);
      record(row, 'web', web);
    }

    const esc = (value) => String(value).replaceAll('|', '\\|');
    console.log('# Notification audit (last 60 minutes)\n');
    console.log(`Read-only database: ${path.basename(dbPath)}; events: ${rows.length}.\n`);
    console.log('| Event type | Events | Desktop (all) | Desktop (important) | Telegram sent | Browser notification |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const [type, item] of [...counts].sort((a, b) => b[1].events - a[1].events)) {
      console.log(`| ${esc(type)} | ${item.events} | ${item.desktopAll} | ${item.desktopImportant} | ${item.telegram} | ${item.web} |`);
    }
    console.log('\n## Interpretation\n');
    console.log('- Counts execute event gates, content dedupe, disk one-hour throttle, load 15-minute summary, and engine-wide quota checks.');
    console.log('- `run.output`, `deploy.restart_waiting`, `claude.quota_available`, `brain.updated`, and overlap events are not notification events.');
    console.log('- The database is opened readonly and no external notification command or service is invoked.');
  } finally {
    db.close();
  }
}
