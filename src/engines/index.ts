import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileRow } from '../db/index.js';
import { LIMITED_TEST_ENV, lowPriority } from '../priority.js';
import { workerEnvironment } from '../worker-guard.js';
import { lockCommand } from '../profiles/locks.js';

export interface SpawnOpts {
  profile: ProfileRow;
  model: string;
  cwd: string;
  prompt: string;
  logPath: string;
  effort?: string;
  lockFile?: string;
  outputPath?: string;
  readOnly?: boolean;
  env?: Record<string, string>;
  hubHome?: string;
  gitHooks?: 'run' | 'skip';
  project?: { settings?: string | null };
  codexSandbox?: 'off' | 'workspace-write';
}

export interface QuotaDetection {
  exhausted: boolean;
  resetSeconds?: number;
}

export interface AuthDetection {
  expired: boolean;
}

export interface Engine {
  id: 'agy' | 'codex';
  family(model: string): string;
  spawn(opts: SpawnOpts): ChildProcess;
  detectQuota(logTail: string): QuotaDetection;
  detectAuthError(logTail: string): AuthDetection;
  detectTransientError(logTail: string): boolean;
}

/**
 * Parse reset time strings like "Resets in 4h54m26s" or "try again in 2h 3m"
 * Returns seconds, or default 18000 (5h) if unparsable.
 * Adds 60s buffer per PLAN 3.3.
 */
export function parseResetTime(text: string): number {
  // Try pattern: NhNmNs or N h N m N s (with optional spaces)
  const patterns = [
    /(\d+)\s*h\s*(\d+)\s*m\s*(\d+)\s*s/i,
    /(\d+)\s*h\s*(\d+)\s*m/i,
    /(\d+)\s*m\s*(\d+)\s*s/i,
    /(\d+)\s*h/i,
    /(\d+)\s*m/i,
  ];

  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      let seconds = 0;
      const full = m[0];
      const hm = full.match(/(\d+)\s*h/i);
      const mm = full.match(/(\d+)\s*m/i);
      const sm = full.match(/(\d+)\s*s/i);
      if (hm) seconds += parseInt(hm[1], 10) * 3600;
      if (mm) seconds += parseInt(mm[1], 10) * 60;
      if (sm) seconds += parseInt(sm[1], 10);
      if (seconds > 0) return seconds + 60; // add 60s buffer
    }
  }

  return 18000; // default 5 hours
}

/**
 * Get the last N lines from a string
 */
export function lastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}


// Transient error regex per PLAN 2.1
const TRANSIENT_ERROR_RE =
  /UNAVAILABLE \(code 503\)|code 50[0-4]|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|service is currently unavailable|Eligibility check failed|model is at capacity|overloaded|TLS handshake timeout|network issue connecting|"retryable":true/i;

export class AgyEngine implements Engine {
  id = 'agy' as const;

  private agyPath: string;

  constructor(agyPath?: string) {
    this.agyPath = agyPath || path.join(os.homedir(), '.gemini', 'bin', 'agy');
  }

  family(model: string): string {
    // codex:model → codex
    if (model.startsWith('codex:')) return 'codex';
    // Otherwise first part before '-'
    const idx = model.indexOf('-');
    return idx > 0 ? model.substring(0, idx) : model;
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const args = [
      '-p',
      opts.prompt,
      '--model',
      opts.model,
      '--dangerously-skip-permissions',
      '--print-timeout',
      '0',
    ];

    const env: Record<string, string> = { ...process.env as Record<string, string> };

    // Set up environment based on profile kind
    if (opts.profile.kind === 'isolated' && opts.profile.home) {
      env.HOME = opts.profile.home;
      env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/agy-no-keyring';
    }

    if (opts.env) {
      Object.assign(env, opts.env);
    }

    // Ensure log directory exists
    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    const logFd = fs.openSync(opts.logPath, 'a');

    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }

    Object.assign(env, LIMITED_TEST_ENV);
    Object.assign(
      env,
      workerEnvironment(
        opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
        env,
        { gitHooks: opts.gitHooks, project: opts.project, cwd: opts.cwd },
      ),
    );
    const [agyExe, agyArgs] = lowPriority(this.agyPath, args);
    const [executable, command] = opts.lockFile ? lockCommand(opts.lockFile, [agyExe, ...agyArgs]) : [agyExe, agyArgs];
    const child = spawn(executable, command, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    // Close the fd in this process since child inherited it
    child.on('spawn', () => {
      fs.closeSync(logFd);
    });
    child.on('error', () => {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    // Only look at last 8 lines per PLAN 3.3
    const tail = lastNLines(logTail, 8);

    // Check for quota exhaustion patterns
    if (
      /RESOURCE_EXHAUSTED.*429/i.test(tail) ||
      /exhausted your quota/i.test(tail)
    ) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Authentication required|authentication timed out|not signed in/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}

export class CodexEngine implements Engine {
  id = 'codex' as const;

  private codexPath: string | null;
  private codexSandbox: 'off' | 'workspace-write';

  constructor(codexPath?: string, codexSandbox: 'off' | 'workspace-write' = 'off') {
    this.codexPath = codexPath || null;
    this.codexSandbox = codexSandbox;
  }

  static findCodexPath(): string | null {
    try {
      const managed = process.env.AGENTHUB_TOOLS_DIR ? path.join(process.env.AGENTHUB_TOOLS_DIR, 'node_modules', '.bin', 'codex') : null;
      if (managed && fs.existsSync(managed)) return managed;
      const homeDir = os.homedir();
      const base = path.join(homeDir, '.vscode', 'extensions');
      if (!fs.existsSync(base)) return null;
      const entries = fs.readdirSync(base).filter((e) => e.startsWith('openai.chatgpt-'));
      if (entries.length === 0) return null;
      entries.sort();
      const latest = entries[entries.length - 1];
      const targets = process.platform === 'darwin'
        ? ['darwin-arm64', 'darwin-x64', 'macos-arm64', 'macos-x64']
        : process.platform === 'win32' ? ['win32-x64'] : ['linux-x86_64'];
      for (const target of targets) {
        const codexBin = path.join(base, latest, 'bin', target, 'codex');
        if (fs.existsSync(codexBin)) return codexBin;
      }
      return null;
    } catch {
      return null;
    }
  }

  family(_model: string): string {
    return 'codex';
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const codexPath = this.codexPath || CodexEngine.findCodexPath();
    if (!codexPath) {
      throw new Error('Codex CLI not found');
    }

    // Extract model name: "codex:gpt-5.6-luna" → "gpt-5.6-luna"
    let model = opts.model;
    if (model.startsWith('codex:')) {
      model = model.substring(6);
    }

    const args = [
      'exec',
      '--skip-git-repo-check',
      '-m',
      model,
      '-c',
      `model_reasoning_effort=${opts.effort || 'medium'}`,
      '-C',
      opts.cwd,
      opts.prompt,
    ];
    const sandboxMode = opts.codexSandbox ?? this.codexSandbox;
    if (opts.readOnly) {
      args.splice(2, 0, '--sandbox', 'read-only');
    } else if (sandboxMode === 'workspace-write') {
      args.splice(2, 0, '--sandbox', 'workspace-write');
    } else {
      args.splice(2, 0, '--dangerously-bypass-approvals-and-sandbox');
    }
    if (opts.outputPath) args.splice(-1, 0, '--output-last-message', opts.outputPath);

    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFd = fs.openSync(opts.logPath, 'a');

    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }

    const env: Record<string, string> = { ...(process.env as Record<string, string>), ...LIMITED_TEST_ENV };
    if (opts.profile.kind === 'isolated' && opts.profile.home) {
      env.CODEX_HOME = opts.profile.home;
    }
    if (opts.env) {
      Object.assign(env, opts.env);
    }
    Object.assign(
      env,
      workerEnvironment(
        opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
        env,
        { gitHooks: opts.gitHooks, project: opts.project, cwd: opts.cwd },
      ),
    );

    const [codexExe, codexArgs] = lowPriority(codexPath, args);
    const [executable, command] = opts.lockFile ? lockCommand(opts.lockFile, [codexExe, ...codexArgs]) : [codexExe, codexArgs];
    const child = spawn(executable, command, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    child.on('spawn', () => {
      fs.closeSync(logFd);
    });
    child.on('error', () => {
      try { fs.closeSync(logFd); } catch { /* ignore */ }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 8);
    if (/usage limit|rate limit|insufficient_quota|\b429\b/i.test(tail)) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Not logged in|\b401\b/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}

/**
 * Fake engine for testing. Runs `node test/fixtures/fake-agent.mjs`.
 * Behavior controlled via FAKE_MODE env var.
 */
export class FakeEngine implements Engine {
  id = 'agy' as const;
  private scriptPath: string;

  constructor(scriptPath?: string) {
    this.scriptPath =
      scriptPath || path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs');
  }

  family(model: string): string {
    if (model.startsWith('codex:')) return 'codex';
    const idx = model.indexOf('-');
    return idx > 0 ? model.substring(0, idx) : model;
  }

  spawn(opts: SpawnOpts): ChildProcess {
    const logDir = path.dirname(opts.logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFd = fs.openSync(opts.logPath, 'a');

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FAKE_CWD: opts.cwd,
      FAKE_PROMPT: opts.prompt,
      FAKE_MODEL: opts.model,
      FAKE_PROFILE: opts.profile.name,
      FAKE_OUTPUT_PATH: opts.outputPath || '',
      ...(opts.env || {}),
    };
    if (opts.hubHome || opts.project) {
      Object.assign(
        env,
        workerEnvironment(
          opts.hubHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
          env,
          { gitHooks: opts.gitHooks, project: opts.project },
        ),
      );
    }

    const command = process.env.FAKE_MODE === 'reviewer-error' ? '/definitely-missing-agenthub-fixture' : process.execPath;
    const args = command === process.execPath ? [this.scriptPath] : [];

    const useFlock = Boolean(opts.lockFile) && process.env.FAKE_MODE !== 'reviewer-error';
    if (opts.lockFile) {
      try { fs.mkdirSync(path.dirname(opts.lockFile), { recursive: true }); } catch { /* ignore */ }
    }
    const [executable, spawnArgs] = useFlock ? lockCommand(opts.lockFile!, [command, ...args]) : [command, args];

    const child = spawn(executable, spawnArgs, {
      cwd: opts.cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });

    child.on('spawn', () => {
      fs.closeSync(logFd);
    });
    child.on('error', () => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
    });

    return child;
  }

  detectQuota(logTail: string): QuotaDetection {
    const tail = lastNLines(logTail, 8);
    if (
      /RESOURCE_EXHAUSTED.*429/i.test(tail) ||
      /exhausted your quota/i.test(tail) ||
      /usage limit|rate limit|insufficient_quota|\b429\b/i.test(tail)
    ) {
      return {
        exhausted: true,
        resetSeconds: parseResetTime(tail),
      };
    }
    return { exhausted: false };
  }

  detectAuthError(logTail: string): AuthDetection {
    const tail = lastNLines(logTail, 8);
    return {
      expired: /UNAUTHENTICATED|code 401|"error_code"\s*:\s*401|Not logged in|\b401\b/i.test(tail),
    };
  }

  detectTransientError(logTail: string): boolean {
    const tail = lastNLines(logTail, 8);
    return TRANSIENT_ERROR_RE.test(tail);
  }
}
