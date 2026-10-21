import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pty from 'node-pty';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocket } from 'ws';
import { AppService, HttpError } from '../services/index.js';
import { findClaudeBin } from '../chat/claude.js';
import { CodexEngine } from '../engines/index.js';
import { accountKey, isProfileLoggedIn } from '../profiles/index.js';

interface PtySession {
  id: string;
  profileName: string;
  process: pty.IPty;
  sockets: Set<WebSocket>;
  timer: NodeJS.Timeout;
  recentBuffer: string;
  loginMenuAnswered?: boolean;
}

// eslint-disable-next-line no-control-regex -- strips terminal escape sequences
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/**
 * Newer agy versions ask for a login method before printing the OAuth link.
 * Return true when the menu is on screen so the hub can pick "Google OAuth".
 */
export function isAgyLoginMenu(buffer: string): boolean {
  return /Select login method/i.test(buffer.replace(ANSI_RE, '')) && /Google OAuth/i.test(buffer.replace(ANSI_RE, ''));
}

export class PtyManager {
  private sessions = new Map<string, PtySession>(); // sessionId -> PtySession
  private profileToSession = new Map<string, string>(); // profileName -> sessionId
  private emailRefreshTimers = new Set<NodeJS.Timeout>();
  private stopped = false;

  constructor(private service: AppService) {}

  createSession(profileName: string): string {
    this.stopped = false;
    let profile = this.service.profileRepo.get(profileName);
    if (!profile) {
      // Create isolated profile if not yet created
      profile = this.service.createProfile({ name: profileName });
    }

    // Enforce max 1 session per profile
    const existingSessionId = this.profileToSession.get(profileName);
    if (existingSessionId) {
      this.closeSession(existingSessionId);
    }

    const sessionId = crypto.randomUUID();
    const home = profile.home || path.join(this.service.config.agyHomesDir, profile.name);

    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (profile.engine === 'claude' && profile.kind !== 'system' && profile.home) {
      env.CLAUDE_CONFIG_DIR = profile.home;
    } else if (profile.kind === 'isolated') {
      env.HOME = home;
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/agy-no-keyring';
    }

    let args: string[] = [];
    let command: string | null | undefined;
    if (profile.engine === 'claude') {
      command = findClaudeBin(this.service.config.chat.claudeBin) || process.env.AGENTHUB_CLAUDE_BIN;
    } else if (profile.engine === 'codex') {
      // Device-code login works from the dashboard: the CLI prints a URL and a one-time code.
      command = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
      args = ['login', '--device-auth'];
      if (profile.kind === 'isolated' && profile.home) env.CODEX_HOME = profile.home;
    } else {
      command = process.env.AGENTHUB_AGY_BIN || path.join(os.homedir(), '.gemini', 'bin', 'agy');
    }
    if (!command) throw new HttpError(404, 'not_found', `Không tìm thấy lệnh ${profile.engine}`);

    const ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: fs.existsSync(home) ? home : os.homedir(),
      env,
    });

    // Auto-close session after 15 minutes (PLAN 4)
    const timer = setTimeout(() => {
      this.closeSession(sessionId);
    }, 15 * 60 * 1000);

    const session: PtySession = {
      id: sessionId,
      profileName,
      process: ptyProcess,
      sockets: new Set(),
      timer,
      recentBuffer: '',
    };

    ptyProcess.onData((data: string) => {
      // Keep last 16KB for new connections
      session.recentBuffer = (session.recentBuffer + data).slice(-16384);
      if (profile.engine === 'agy' && !session.loginMenuAnswered && isAgyLoginMenu(session.recentBuffer)) {
        session.loginMenuAnswered = true;
        // Option 1 (Google OAuth) is preselected; Enter confirms it.
        setTimeout(() => {
          try { ptyProcess.write('\r'); } catch { /* process may have exited */ }
        }, 300);
      }
      for (const socket of session.sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(data);
        }
      }
    });

    ptyProcess.onExit(() => {
      this.handleProcessExit(sessionId, profileName, home);
    });

    this.sessions.set(sessionId, session);
    this.profileToSession.set(profileName, sessionId);

    if (profile.engine === 'claude') {
      setTimeout(() => {
        try { ptyProcess.write('/login\r'); } catch { /* process may have exited */ }
      }, 250);
    }

    return sessionId;
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.emailRefreshTimers) {
      clearTimeout(timer);
    }
    this.emailRefreshTimers.clear();
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId, 1001, 'Going Away');
    }
  }

  getSession(sessionId: string): PtySession | undefined {
    return this.sessions.get(sessionId);
  }

  private scheduleEmailRefresh(profileName: string): void {
    if (this.stopped) return;
    const profile = this.service.profileRepo.get(profileName);
    if (profile && profile.authState === 'not_logged_in' && isProfileLoggedIn(profile)) {
      this.service.profileRepo.updateAuthState(profileName, 'ok', null, null);
    }
    this.service.refreshProfileEmail(profileName);

    const timer = setTimeout(() => {
      this.emailRefreshTimers.delete(timer);
      this.service.refreshProfileEmail(profileName);
    }, 2000);
    timer.unref?.();
    this.emailRefreshTimers.add(timer);
  }

  closeSession(sessionId: string, closeCode = 1000, closeReason = 'Session closed'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    clearTimeout(session.timer);
    try {
      session.process.kill();
    } catch {
      // ignore
    }

    for (const socket of session.sockets) {
      try {
        socket.close(closeCode, closeReason);
      } catch {
        // ignore
      }
    }
    session.sockets.clear();

    const profileName = session.profileName;
    this.sessions.delete(sessionId);
    this.profileToSession.delete(profileName);

    this.scheduleEmailRefresh(profileName);
  }

  private handleProcessExit(sessionId: string, profileName: string, _home: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      clearTimeout(session.timer);
      for (const socket of session.sockets) {
        try {
          socket.close(1000, 'Process exited');
        } catch {
          // ignore
        }
      }
      this.sessions.delete(sessionId);
      this.profileToSession.delete(profileName);
    }

    this.scheduleEmailRefresh(profileName);

    const profile = this.service.profileRepo.get(profileName);
    const dupes = this.service.coreProfileService.getDuplicateEmails();
    const duplicateWarning = profile ? dupes.has(accountKey(profile) || '') : false;

    this.service.scheduler.getEventBus().emit('profile.updated', undefined, {
      name: profileName,
      email: profile?.email || null,
      duplicateWarning,
    });

    // Move waiting_quota tasks to queued
    this.service.scheduler.wakeWaitingQuotaTasks('profile_login');
  }

  attachSocket(sessionId: string, socket: WebSocket): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      socket.close(1008, 'Session not found');
      return;
    }

    session.sockets.add(socket);

    // Send recent buffer to client
    if (session.recentBuffer.length > 0) {
      socket.send(session.recentBuffer);
    }

    socket.on('message', (raw: Buffer | string) => {
      try {
        const text = raw.toString();
        const parsed = JSON.parse(text);
        if (parsed.type === 'input' && typeof parsed.data === 'string') {
          session.process.write(parsed.data);
        } else if (
          parsed.type === 'resize' &&
          typeof parsed.cols === 'number' &&
          typeof parsed.rows === 'number'
        ) {
          session.process.resize(parsed.cols, parsed.rows);
        } else {
          session.process.write(text);
        }
      } catch {
        session.process.write(raw.toString());
      }
    });

    socket.on('close', () => {
      session.sockets.delete(socket);
      this.scheduleEmailRefresh(session.profileName);
    });
  }
}

export function registerPtyRoutes(
  fastify: FastifyInstance,
  service: AppService,
  ptyManager: PtyManager,
): void {
  fastify.addHook('onClose', async () => {
    ptyManager.stop();
  });

  // Start login session
  fastify.post('/api/profiles/:name/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { name } = req.params as { name: string };
    try {
      const sessionId = ptyManager.createSession(name);
      return { sessionId };
    } catch (err: unknown) {
      if (err instanceof HttpError) {
        return reply.status(err.statusCode).send({ error: err.error, message: err.message });
      }
      return reply.status(500).send({
        error: 'internal_server_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // WebSocket for PTY session
  fastify.get(
    '/api/pty/:sessionId',
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      let sessionId = (req.params as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) {
        const rawUrl = req.raw.url || req.url;
        const match = rawUrl?.match(/\/api\/pty\/([^?#/]+)/);
        if (match) sessionId = match[1];
      }
      if (sessionId) {
        ptyManager.attachSocket(sessionId, socket);
      } else {
        socket.close(1008, 'Missing session ID');
      }
    },
  );
}
