#!/usr/bin/env node
/* Read-only notification audit. It executes production notification pipelines
 * and never starts the daemon or calls external services. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { register } from 'tsx/esm/api';

register();
const [
  { ProfileRepo, QuotaMarkRepo, TaskRepo, ProjectRepo, CiRepo },
  { NotificationService },
  { TelegramBotService },
  { notifyBrowserEvent },
] = await Promise.all([
  import('../src/db/index.ts'),
  import('../src/notify.ts'),
  import('../src/telegram.ts'),
  import('../web/src/notifications.ts'),
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
         OR (typeof(ts) = 'integer' AND ts >= unixepoch('now', '-1 hour') * 1000)
         OR (typeof(ts) = 'text' AND CAST(ts AS INTEGER) > 1e9 AND CAST(ts AS INTEGER) >= unixepoch('now', '-1 hour'))
         OR (typeof(ts) = 'text' AND CAST(ts AS INTEGER) > 1e12 AND CAST(ts AS INTEGER) >= unixepoch('now', '-1 hour') * 1000)
         OR (julianday(ts) IS NOT NULL AND julianday(ts) >= julianday('now', '-1 hour'))
      ORDER BY id
    `).all();
    const profiles = db.prepare('SELECT name, engine, enabled FROM profiles WHERE enabled = 1').all();
    const marks = db.prepare('SELECT profileName, family, until FROM quota_marks').all();

    let config = {};
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { /* optional */ }

    const notifications = config.notifications && typeof config.notifications === 'object' ? config.notifications : {};
    const desktopEnabled = notifications.desktop !== false;
    const desktopLevel = ['all', 'important', 'critical', 'off'].includes(notifications.desktopLevel) ? notifications.desktopLevel : 'important';
    const telegram = config.telegram && typeof config.telegram === 'object' ? config.telegram : {};
    const telegramEnabled = telegram.enabled === true && Array.isArray(telegram.allowedChatIds) && telegram.allowedChatIds.length > 0;
    const telegramNotify = { reviewReady: true, failed: true, blocked: true, quota: true, fallback: true, ...(telegram.notify || {}) };

    const profileRepo = new ProfileRepo(db);
    const quotaMarkRepo = new QuotaMarkRepo(db);
    const taskRepo = new TaskRepo(db);
    const projectRepo = new ProjectRepo(db);
    let ciRepo;
    try { ciRepo = new CiRepo(db); } catch { /* optional */ }

    let auditNow = 0;

    const makeDesktopService = (level) => {
      const auditConfig = {
        ...config,
        notifications: { desktop: desktopEnabled, desktopLevel: level, quietHours: notifications.quietHours },
        brain: config.brain || { mode: 'manual' },
        branding: config.branding || { name: 'AgentHub' },
      };
      let sent = 0;
      const service = new NotificationService({
        eventBus: { on() {}, off() {}, emit() {} },
        config: auditConfig,
        taskRepo,
        profileRepo,
        quotaMarkRepo,
        projectRepo,
        ciRepo,
        now: () => auditNow,
        exec: () => { sent++; },
      });
      return { service, sent: () => sent };
    };

    const desktopAllService = makeDesktopService('all');
    const desktopImportantService = makeDesktopService('important');

    let telegramSent = 0;
    const telegramAuditConfig = {
      ...config,
      hubHome: path.dirname(dbPath),
      brain: config.brain || { mode: 'manual' },
      branding: config.branding || { name: 'AgentHub' },
      notifications: {
        desktop: desktopEnabled,
        desktopLevel,
        quietHours: notifications.quietHours,
      },
      telegram: {
        enabled: telegramEnabled,
        allowedChatIds: telegram.allowedChatIds && telegram.allowedChatIds.length > 0 ? telegram.allowedChatIds : [1],
        notify: telegramNotify,
      },
    };
    const telegramService = new TelegramBotService({
      config: telegramAuditConfig,
      tokenOverride: 'audit-token',
      service: {
        getBatch: () => null,
        getStatus: () => ({ brain: {} }),
      },
      eventBus: { on() {}, off() {}, emit() {} },
      taskRepo,
      projectRepo,
      profileRepo,
      quotaMarkRepo,
      ciRepo,
      now: () => auditNow,
      fetch: async () => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    });
    const origBroadcast = telegramService.broadcastMessage.bind(telegramService);
    telegramService.broadcastMessage = (text, replyMarkup) => {
      const now = auditNow;
      const last = telegramService.lastBroadcast.get(text);
      if (last !== undefined && now - last < 30 * 60 * 1000) return;
      telegramSent++;
      origBroadcast(text, replyMarkup);
    };

    const mockStorage = new Map();
    globalThis.localStorage = {
      getItem: (k) => mockStorage.get(k) || null,
      setItem: (k, v) => mockStorage.set(k, String(v)),
      removeItem: (k) => mockStorage.delete(k),
      clear: () => mockStorage.clear(),
      get length() { return mockStorage.size; },
    };
    let webSent = 0;
    globalThis.Notification = class MockNotification {
      static permission = 'granted';
      constructor() {
        webSent++;
      }
    };
    globalThis.window = {
      Notification: globalThis.Notification,
      localStorage: globalThis.localStorage,
    };

    const webProfiles = profiles.map((p) => ({
      name: p.name,
      engine: p.engine,
      enabled: p.enabled,
      quotaMarks: marks.filter((m) => m.profileName === p.name).map((m) => ({ family: m.family, until: m.until })),
    }));

    const origDateNow = Date.now;
    Date.now = () => auditNow;

    const counts = new Map();
    const payloadOf = (row) => { try { return row.payload ? JSON.parse(row.payload) : {}; } catch { return {}; } };
    const timeOf = (row) => { const n = Number(row.ts); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(row.ts); };

    const record = (row, field, value) => {
      const item = counts.get(row.type) || { events: 0, desktopAll: 0, desktopImportant: 0, telegram: 0, web: 0 };
      item[field] += value ? 1 : 0;
      counts.set(row.type, item);
    };

    try {
      for (const row of rows) {
        const payload = payloadOf(row);
        const at = timeOf(row);
        auditNow = at;

        const eventCount = counts.get(row.type) || { events: 0, desktopAll: 0, desktopImportant: 0, telegram: 0, web: 0 };
        eventCount.events++;
        counts.set(row.type, eventCount);

        const allBefore = desktopAllService.sent();
        desktopAllService.service.handleEvent(row.type, row.taskId || undefined, payload);
        const desktopAll = desktopAllService.sent() > allBefore;

        const importantBefore = desktopImportantService.sent();
        desktopImportantService.service.handleEvent(row.type, row.taskId || undefined, payload);
        const desktopImportant = desktopImportantService.sent() > importantBefore;

        const telegramBefore = telegramSent;
        telegramService.handleEvent(row.type, row.taskId || undefined, payload);
        const telegram = telegramSent > telegramBefore;

        const webBefore = webSent;
        notifyBrowserEvent(
          { id: row.id, ts: row.ts, type: row.type, taskId: row.taskId || null, payload },
          desktopLevel,
          webProfiles,
        );
        const web = webSent > webBefore;

        record(row, 'desktopAll', desktopAll);
        record(row, 'desktopImportant', desktopImportant);
        record(row, 'telegram', telegram);
        record(row, 'web', web);
      }
    } finally {
      Date.now = origDateNow;
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
