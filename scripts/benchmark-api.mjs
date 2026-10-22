import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createContext } from '../src/daemon.ts';
import { createServer } from '../src/api/server.ts';
import { getOrCreateToken } from '../src/auth.ts';

const INDEXES = [
  'idx_tasks_project_created',
  'idx_tasks_status_created',
  'idx_tasks_project_status_created',
  'idx_task_deps_dependency',
  'idx_events_task_id',
  'idx_runs_outcome_task',
  'idx_check_results_task_run',
  'idx_chat_messages_session_created',
];
const taskCount = 5_000;
const eventCount = 50_000;
const messageCount = 50_000;
const samples = Number(process.env.AGENTHUB_BENCHMARK_SAMPLES || 25);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-api-perf-'));
const config = loadConfig(root);
fs.mkdirSync(config.worktreesDir, { recursive: true });
const context = createContext(config, new Map());
const token = getOrCreateToken(config.tokenPath);
const server = await createServer(context.service, config, { webDir: path.join(root, 'web') });
await server.ready();

const db = context.db;
db.exec('PRAGMA synchronous = OFF');
db.exec(`INSERT INTO projects (id, name, path, defaultBranch) VALUES ('perf', 'Performance', ?, 'main')`.replace('?', `'${root.replaceAll("'", "''")}'`));
db.exec("INSERT INTO profiles (name, engine, kind, enabled) VALUES ('perf-profile', 'agy', 'isolated', 1)");
db.exec("INSERT INTO chat_sessions (id, title, kind) VALUES ('perf-chat', 'Performance chat', 'chat')");

const insertTask = db.prepare(
  `INSERT INTO tasks (id, projectId, slug, title, body, status, createdAt, updatedAt)
   VALUES (?, 'perf', ?, ?, 'benchmark body', ?, datetime('now', ?), datetime('now', ?))`,
);
const insertEvent = db.prepare('INSERT INTO events (type, taskId, payload) VALUES (?, ?, ?)');
const insertMessage = db.prepare(
  `INSERT INTO chat_messages (id, sessionId, role, content, createdAt)
   VALUES (?, 'perf-chat', 'user', ?, datetime('now', ?))`,
);
const insertData = db.transaction(() => {
  for (let i = 0; i < taskCount; i += 1) {
    const age = `-${i % 31} seconds`;
    insertTask.run(`perf/task-${i}`, `task-${i}`, `Task ${i}`, i % 3 === 0 ? 'queued' : 'done', age, age);
  }
  for (let i = 0; i < eventCount; i += 1) {
    insertEvent.run('task.updated', `perf/task-${i % taskCount}`, JSON.stringify({ i }));
  }
  for (let i = 0; i < messageCount; i += 1) {
    insertMessage.run(`message-${i}`, `message ${i}`, `-${i % 31} seconds`);
  }
});
insertData();

const headers = { host: `127.0.0.1:${config.port}`, authorization: `Bearer ${token}` };
const routes = {
  'GET /api/tasks': '/api/tasks',
  'GET /api/tasks?project&status': '/api/tasks?project=perf&status=queued',
  'GET /api/status': '/api/status',
  'GET /api/savings': '/api/savings?project=perf',
  'GET /api/usage/daily': '/api/usage/daily?days=30',
  'GET /api/chat/sessions/:id/messages': '/api/chat/sessions/perf-chat/messages?limit=50',
};

async function measure(url) {
  const start = process.hrtime.bigint();
  const response = await server.inject({ method: 'GET', url, headers });
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  if (response.statusCode !== 200 && url.startsWith('/api/events') === false) {
    throw new Error(`${url} returned ${response.statusCode}: ${response.body.slice(0, 200)}`);
  }
  return elapsed;
}

async function benchmark() {
  const result = {};
  for (const [name, url] of Object.entries(routes)) {
    const values = [];
    for (let i = 0; i < samples + 3; i += 1) {
      const elapsed = await measure(url);
      if (i >= 3) values.push(elapsed);
    }
    values.sort((a, b) => a - b);
    result[name] = {
      p50Ms: Number(values[Math.floor(values.length * 0.5)].toFixed(2)),
      p95Ms: Number(values[Math.floor(values.length * 0.95)].toFixed(2)),
    };
  }
  return result;
}

for (const name of INDEXES) db.exec(`DROP INDEX IF EXISTS ${name}`);
const before = await benchmark();
for (const name of INDEXES) {
  const definitions = {
      idx_tasks_project_created: 'CREATE INDEX idx_tasks_project_created ON tasks(projectId, createdAt)',
      idx_tasks_status_created: 'CREATE INDEX idx_tasks_status_created ON tasks(status, createdAt)',
      idx_tasks_project_status_created: 'CREATE INDEX idx_tasks_project_status_created ON tasks(projectId, status, createdAt)',
      idx_task_deps_dependency: 'CREATE INDEX idx_task_deps_dependency ON task_deps(dependsOnId, taskId)',
      idx_events_task_id: 'CREATE INDEX idx_events_task_id ON events(taskId, id)',
      idx_runs_outcome_task: 'CREATE INDEX idx_runs_outcome_task ON runs(outcome, taskId)',
      idx_check_results_task_run: 'CREATE INDEX idx_check_results_task_run ON check_results(taskId, runId)',
      idx_chat_messages_session_created: 'CREATE INDEX idx_chat_messages_session_created ON chat_messages(sessionId, createdAt)',
  };
  db.exec(definitions[name]);
}
const after = await benchmark();

console.log(JSON.stringify({ fixture: { taskCount, eventCount, messageCount }, samples, before, after }, null, 2));
context.scheduler.stop();
await server.close();
db.close();
