import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import os from 'node:os';

/**
 * Returns the default token path.
 */
export function getTokenPath(homeDir?: string): string {
  const base = homeDir || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');
  return path.join(base, 'token');
}

/**
 * Reads token from tokenPath without creating it if it doesn't exist.
 */
export function readExistingToken(tokenPath: string): string | null {
  if (!fs.existsSync(tokenPath)) return null;
  try {
    const content = fs.readFileSync(tokenPath, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

/**
 * Load or create the 32-byte secret token at tokenPath with mode 0600.
 */
export function getOrCreateToken(tokenPath: string): string {
  const dir = path.dirname(tokenPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  if (fs.existsSync(tokenPath)) {
    try {
      const content = fs.readFileSync(tokenPath, 'utf-8').trim();
      if (content.length > 0) {
        fs.chmodSync(tokenPath, 0o600);
        return content;
      }
    } catch {
      // Re-create if unreadable
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath, token, { mode: 0o600, encoding: 'utf-8' });
  fs.chmodSync(tokenPath, 0o600);
  return token;
}

/**
 * Constant-time token verification using crypto.timingSafeEqual.
 */
export function verifyToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const bufA = Buffer.from(provided);
  const bufB = Buffer.from(expected);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates Host header against allowlist: 127.0.0.1:<port> and localhost:<port>
 */
export function isValidHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const normalized = host.toLowerCase().trim();
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    '127.0.0.1',
    'localhost',
  ]);
  return allowed.has(normalized);
}

/**
 * Validates Origin header if present against allowlist.
 */
export function isValidOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true; // Origin is optional per PLAN 3.1
  try {
    const url = new URL(origin);
    const host = url.hostname.toLowerCase();
    const isLocal = host === '127.0.0.1' || host === 'localhost';
    if (!isLocal) return false;

    const originPort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return originPort === String(port) || url.port === String(port);
  } catch {
    return false;
  }
}

/**
 * Fastify hook to enforce DNS rebinding protection and token authentication.
 */
export function registerSecurityHooks(
  fastify: FastifyInstance,
  token: string,
  portOrGetter: number | (() => number),
): void {
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const port = typeof portOrGetter === 'function' ? portOrGetter() : portOrGetter;
    // 1. Host header validation
    const host = req.headers.host;
    if (!isValidHost(host, port)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Forbidden: invalid Host header' });
    }

    // 2. Origin header validation (if provided)
    const origin = req.headers.origin;
    if (!isValidOrigin(origin, port)) {
      return reply.status(403).send({ error: 'forbidden', message: 'Forbidden: invalid Origin header' });
    }

    // 3. URL path validation: reject encoded slashes/backslashes or path traversal segments
    const rawUrl = req.raw.url || req.url || '/';
    const rawPath = rawUrl.split('?')[0].split('#')[0];
    if (/%2[fF]|%5[cC]/.test(rawPath)) {
      return reply.status(400).send({ error: 'bad_request', message: 'Encoded slash or backslash not allowed' });
    }

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      return reply.status(400).send({ error: 'bad_request', message: 'Malformed URL encoding' });
    }

    const segments = decodedPath.split(/[/\\]/);
    if (segments.some((seg) => seg === '.' || seg === '..')) {
      return reply.status(400).send({ error: 'bad_request', message: 'Path traversal segments not allowed' });
    }
  });

  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const routePattern = req.routeOptions?.url;
    const rawUrl = req.raw.url || req.url || '/';
    const rawPath = rawUrl.split('?')[0].split('#')[0];
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(rawPath);
    } catch {
      decodedPath = rawPath;
    }
    const normalizedPath = decodedPath.replace(/\/+/g, '/').toLowerCase();

    // Health check is exempt
    if (routePattern === '/health' || normalizedPath === '/health') {
      return;
    }

    // Non-API routes (health check, static files, SPA fallback, or non-API 404s) are exempt
    const isApi =
      Boolean(routePattern && routePattern.startsWith('/api')) ||
      normalizedPath === '/api' ||
      normalizedPath.startsWith('/api/');

    if (!isApi) {
      return;
    }

    // Default-deny: token authentication required
    let providedToken: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      providedToken = authHeader.slice(7).trim();
    }

    // Allow token query parameter for SSE and WebSocket routes
    const isWsOrSse =
      routePattern === '/api/events' ||
      Boolean(routePattern && routePattern.startsWith('/api/pty/')) ||
      normalizedPath === '/api/events' ||
      normalizedPath.startsWith('/api/pty/');

    if (!providedToken && isWsOrSse) {
      const queryToken = (req.query as Record<string, string> | undefined)?.token;
      if (typeof queryToken === 'string' && queryToken) {
        providedToken = queryToken;
      } else {
        const qIndex = rawUrl.indexOf('?');
        if (qIndex !== -1) {
          const params = new URLSearchParams(rawUrl.slice(qIndex));
          const t = params.get('token');
          if (t) providedToken = t;
        }
      }
    }

    if (!providedToken) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Missing authentication token' });
    }

    if (!verifyToken(providedToken, token)) {
      return reply.status(401).send({ error: 'unauthorized', message: 'Invalid authentication token' });
    }
  });
}
