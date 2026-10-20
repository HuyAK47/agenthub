import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ServerResponse } from 'node:http';
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import { AgentHubConfig } from '../config.js';
import { getOrCreateToken, registerSecurityHooks } from '../auth.js';
import { AppService, HttpError } from '../services/index.js';
import { registerSseRoute } from './sse.js';
import { PtyManager, registerPtyRoutes } from './pty.js';
import { registerBrainRoutes } from '../brain.js';
import { registerChatRoutes } from '../chat/service.js';

export function resolveWebDistDir(customDir?: string): string {
  return path.resolve(customDir || resolveWebDir(import.meta.url, process.env));
}

export function resolveWebDir(moduleUrl: string, env: NodeJS.ProcessEnv = {}): string {
  if (env.AGENTHUB_WEB_DIR) return path.resolve(env.AGENTHUB_WEB_DIR);
  if (moduleUrl.includes('/src/')) return fileURLToPath(new URL('../../dist/web', moduleUrl));
  if (moduleUrl.includes('/dist/api/')) return fileURLToPath(new URL('../web', moduleUrl));
  return fileURLToPath(new URL('./web', moduleUrl));
}

export async function createServer(
  service: AppService,
  config: AgentHubConfig,
  options?: { webDir?: string },
): Promise<FastifyInstance> {
  const fastify = Fastify({ logger: false, forceCloseConnections: true });

  // Track active SSE response streams to end them cleanly on close
  const sseClients = new Set<ServerResponse>();
  fastify.addHook('onRequest', async (req, reply) => {
    const rawPath = (req.raw.url || req.url || '').split('?')[0];
    if (rawPath === '/api/events') {
      sseClients.add(reply.raw);
      req.raw.on('close', () => {
        sseClients.delete(reply.raw);
      });
    }
  });

  // Close all WebSocket clients with code 1001 (Going Away) on shutdown
  const closeWebSockets = () => {
    if (fastify.websocketServer?.clients) {
      for (const client of fastify.websocketServer.clients) {
        try {
          if (client.readyState === 1 /* OPEN */) {
            client.close(1001, 'Going Away');
          } else if (client.readyState === 0 /* CONNECTING */) {
            client.terminate();
          }
        } catch {
          // ignore
        }
      }
    }
  };

  fastify.addHook('preClose', (done) => {
    closeWebSockets();
    done();
  });

  // Get or create authentication token
  const token = getOrCreateToken(config.tokenPath);

  // Register security hooks (Host check, Origin check, token auth)
  const getPort = (): number => {
    const addr = fastify.server.address();
    if (addr && typeof addr === 'object') return addr.port;
    return config.port;
  };
  registerSecurityHooks(fastify, token, getPort);

  // Register WebSocket support
  await fastify.register(fastifyWebsocket);

  // Global error handler
  fastify.setErrorHandler((error: Error & { statusCode?: number; error?: string }, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      });
    }
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.error,
        message: error.message,
      });
    }
    if (error.statusCode) {
      return reply.status(error.statusCode).send({
        error: error.error || 'error',
        message: error.message,
      });
    }
    return reply.status(500).send({
      error: 'internal_server_error',
      message: error.message || 'Internal server error',
    });
  });

  // Health check (no token required)
  fastify.get('/health', async () => {
    return { ok: true, version: '0.1.0' };
  });

  fastify.get('/api/version', async () => {
    const indexPath = path.join(resolveWebDistDir(options?.webDir), 'index.html');
    let webBuildId: number | null = null;
    try { webBuildId = fs.statSync(indexPath).mtimeMs; } catch { /* no web build */ }
    return { version: '0.1.0', webBuildId };
  });

  // --- Status API ---
  fastify.get('/api/status', async () => {
    return service.getStatus();
  });

  fastify.post('/api/scheduler/pause', async () => service.pauseScheduler());
  fastify.post('/api/scheduler/resume', async () => service.resumeScheduler());

  // --- Telegram API ---
  fastify.get('/api/telegram/pairing-code', async (req) => {
    const query = req.query as { refresh?: string } | undefined;
    const refresh = query?.refresh === '1' || query?.refresh === 'true';
    return service.getTelegramPairingCode(refresh);
  });
  fastify.post('/api/telegram/pairing-code/refresh', async () => {
    return service.getTelegramPairingCode(true);
  });
  fastify.get('/api/telegram/status', async () => {
    return {
      enabled: service.config.telegram?.enabled ?? false,
      allowedChatIds: service.config.telegram?.allowedChatIds ?? [],
      notify: service.config.telegram?.notify,
      hasToken: Boolean(service.telegramBotService?.hasValidToken()),
    };
  });

  fastify.get('/api/system/orphans', async () => service.getOrphans());
  fastify.post('/api/system/orphans/reap', async () => service.reapOrphans());

  // --- Brain API ---
  if (service.brainService) {
    registerBrainRoutes(fastify, service.brainService);
  }

  // --- Projects API ---
  fastify.get('/api/projects', async () => {
    return service.listProjects();
  });

  fastify.get('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getProject(id);
  });

  fastify.post('/api/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const project = service.createProject(req.body);
    return reply.status(201).send(project);
  });

  fastify.patch('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateProject(id, req.body);
  });

  fastify.delete('/api/projects/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.deleteProject(id);
  });

  fastify.get('/api/projects/:id/notes', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { since?: string; runningOnly?: string; taskId?: string };
    return service.getProjectNotes(id, query);
  });

  // --- Profiles API ---
  fastify.get('/api/profiles', async () => {
    return service.listProfiles();
  });

  fastify.post('/api/profiles/:name/usage/refresh', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.refreshUsage(name);
  });

  fastify.delete('/api/profiles/:name', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    const query = req.query as { purgeHome?: string | boolean };
    const purgeHome = query?.purgeHome === '1' || query?.purgeHome === 'true' || query?.purgeHome === true;
    return service.deleteProfile(name, purgeHome);
  });

  fastify.post('/api/profiles/:name/rename', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.renameProfile(name, req.body);
  });

  fastify.post('/api/profiles', async (req: FastifyRequest, reply: FastifyReply) => {
    const profile = service.createProfile(req.body);
    return reply.status(201).send(profile);
  });

  fastify.post('/api/profiles/:name/check', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = req.params as { name: string };
    return reply.status(202).send(service.startProfileCheck(name));
  });

  fastify.patch('/api/profiles/:name', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.updateProfile(name, req.body);
  });

  fastify.post('/api/profiles/:name/quota', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    return service.markQuota(name, req.body);
  });

  fastify.delete('/api/profiles/:name/quota', async (req: FastifyRequest) => {
    const { name } = req.params as { name: string };
    const query = req.query as { family?: string };
    const body = req.body as { family?: string } | undefined;
    const family = query?.family || body?.family;
    if (!family) {
      throw new HttpError(400, 'bad_request', 'Missing family parameter');
    }
    return service.clearQuota(name, family);
  });

  // --- Tasks API ---
  fastify.get('/api/tasks', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; status?: string };
    return service.listTasks(query);
  });

  fastify.post('/api/tasks', async (req: FastifyRequest, reply: FastifyReply) => {
    const task = service.createTask(req.body);
    return reply.status(201).send(task);
  });

  fastify.post('/api/tasks/from-error', async (req: FastifyRequest, reply: FastifyReply) => {
    const task = service.captureTask(req.body);
    return reply.status(201).send(task);
  });

  fastify.get('/api/tasks/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getTask(id);
  });

  fastify.patch('/api/tasks/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.updateTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/start', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.startTask(id);
  });

  fastify.post('/api/tasks/:id/cancel', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.cancelTask(id);
  });

  fastify.post('/api/tasks/:id/review', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.reviewTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/retry', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.retryTask(id, req.body);
  });

  fastify.post('/api/tasks/:id/review/retry-reviewer', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.retryReviewer(id);
  });

  fastify.delete('/api/tasks/:id/worktree', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.deleteWorktree(id);
  });

  fastify.get('/api/tasks/:id/log', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { run?: string; tail?: string };
    const log = service.getTaskLog(id, query);
    return reply.type('text/plain; charset=utf-8').send(log);
  });

  fastify.post('/api/tasks/:id/checks/rerun', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.rerunChecks(id);
  });

  fastify.post('/api/tasks/:id/notes', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const note = service.createTaskNote(id, req.body);
    return reply.status(201).send(note);
  });

  fastify.get('/api/tasks/:id/notes', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return service.getTaskNotes(id);
  });

  // --- Config API ---
  fastify.get('/api/config', async () => {
    return service.getConfig();
  });

  fastify.put('/api/config', async (req: FastifyRequest) => {
    return service.updateConfig(req.body);
  });

  // --- Savings API ---
  fastify.get('/api/savings', async (req: FastifyRequest) => {
    const query = req.query as { project?: string; since?: string };
    return service.getSavings(query);
  });

  // --- Daily Usage API ---
  fastify.get('/api/usage/daily', async (req: FastifyRequest) => {
    const query = req.query as { days?: string };
    const days = query?.days ? parseInt(query.days, 10) : 7;
    return service.getDailyUsage(Number.isNaN(days) ? 7 : days);
  });

  fastify.get('/api/claude/sessions', async (req: FastifyRequest) => service.listClaudeSessions(Number((req.query as { activeWithinMin?: string }).activeWithinMin || 5)));
  fastify.get('/api/claude/sessions/:id', async (req: FastifyRequest) => service.getClaudeSession((req.params as { id: string }).id));
  fastify.post('/api/claude/sessions/rescan', async () => service.rescanClaudeSessions());
  fastify.get('/api/claude/quota', async () => service.getClaudeQuota());
  fastify.get('/api/claude/failover', async () => service.getClaudeFailover());
  fastify.post('/api/claude/failover/clear', async () => service.clearClaudeFailover());
  fastify.get('/api/claude/usage/today', async () => service.getClaudeToday());

  // --- SSE Route ---
  registerSseRoute(fastify, service);

  // --- PTY Routes ---
  const ptyManager = new PtyManager(service);
  registerPtyRoutes(fastify, service, ptyManager);

  // --- Chat API ---
  if (service.chatService) {
    registerChatRoutes(fastify, service.chatService);
  }

  // --- Graceful Close Hook ---
  fastify.addHook('onClose', async () => {
    closeWebSockets();
    for (const res of sseClients) {
      try {
        if (!res.writableEnded) {
          res.end();
        }
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    ptyManager.stop();
  });

  // --- Web Static Files & Fallback ---
  const webDistDir = resolveWebDistDir(options?.webDir);

  try {
    if (!fs.existsSync(webDistDir)) {
      fs.mkdirSync(webDistDir, { recursive: true });
    }
  } catch {
    // ignore
  }

  await fastify.register(fastifyStatic, {
    root: webDistDir,
    wildcard: true,
    allowedPath(pathname) {
      // Prevent path traversal
      if (pathname.includes('..') || pathname.includes('\\')) {
        return false;
      }
      const resolved = path.resolve(webDistDir, '.' + pathname);
      if (!resolved.startsWith(webDistDir + path.sep) && resolved !== webDistDir) {
        return false;
      }

      // Do not serve anything under /api
      const cleanPath = pathname.replace(/\/+/g, '/').toLowerCase();
      if (cleanPath === '/api' || cleanPath.startsWith('/api/')) {
        return false;
      }

      return true;
    },
  });

  fastify.setNotFoundHandler((req, reply) => {
    const rawUrl = req.raw.url || req.url || '/';
    const rawPath = rawUrl.split('?')[0].split('#')[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }
    const normalizedPath = decodedPath.replace(/\/+/g, '/').toLowerCase();
    const isApi = normalizedPath === '/api' || normalizedPath.startsWith('/api/');

    if (isApi) {
      return reply.status(404).send({
        error: 'not_found',
        message: `Route ${req.method} ${decodedPath} không tồn tại`,
      });
    }

    const isRoot = decodedPath === '/' || decodedPath === '';
    const isGetOrHead = req.method === 'GET' || req.method === 'HEAD';
    const acceptHeader = req.headers.accept || '';
    const acceptsHtml = typeof acceptHeader === 'string' && acceptHeader.includes('text/html');

    if (isGetOrHead && (isRoot || acceptsHtml)) {
      const indexPath = path.join(webDistDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        return reply.sendFile('index.html');
      }
      return reply
        .status(200)
        .type('text/html; charset=utf-8')
        .send('<!DOCTYPE html><html><body>chưa build web</body></html>');
    }

    return reply.status(404).send({
      error: 'not_found',
      message: `Route ${req.method} ${decodedPath} không tồn tại`,
    });
  });

  return fastify;
}
