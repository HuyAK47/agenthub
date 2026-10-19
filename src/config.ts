import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_LOAD_CONFIG, LoadConfig } from './load.js';

export interface ChatConfig {
  claudeBin?: string;
  disableToolSearch: boolean;
  allowFullMode: boolean;
  maxConcurrent: number;
  idleTimeoutSec: number;
  model: string;
}

export interface ClaudeSessionsConfig {
  dir: string;
  maxAgeDays: number;
  include: string[];
  weights: { cacheCreation: number; cacheRead: number };
}

export interface SavingsConfig {
  bucketTokens: {
    gemini: number;
    claude: number;
  };
  claudeFactor: number;
  claudeOverheadPerTask: number;
}

export const DEFAULT_SAVINGS_CONFIG: SavingsConfig = {
  bucketTokens: {
    gemini: 5_000_000,
    claude: 5_000_000,
  },
  claudeFactor: 0.9,
  claudeOverheadPerTask: 40_000,
};

export type DeepPartialSavingsConfig = {
  bucketTokens?: Partial<SavingsConfig['bucketTokens']>;
  claudeFactor?: number;
  claudeOverheadPerTask?: number;
};

export interface AgentHubConfig {
  hubHome: string;
  agyHomesDir: string;
  dbPath: string;
  logsDir: string;
  worktreesDir: string;
  tokenPath: string;
  configFilePath: string;
  port: number;
  defaultModelChains: {
    hard: string[];
    easy: string[];
  };
  defaultTimeout: number;
  slotsPerAgyProfile: number;
  slotsPerCodexProfile: number;
  watchdog: {
    stallMinutes: number;
    waitingMinutes: number;
  };
  defaultLogDir: string;
  autoFixOnFail: boolean;
  chat: ChatConfig;
  claudeSessions: ClaudeSessionsConfig;
  reviewer: {
    enabled: boolean;
    model: string;
    timeoutSec: number;
    failoverSec: number;
    maxChangesRequested: number;
  };
  notifications: {
    desktop: boolean;
  };
  disk: {
    minFreeGB: number;
  };
  cleanup: {
    nodeModulesOnDone: boolean;
    worktreeOnDoneAfterHours: number;
  };
  cacheDir: string;
  savings: SavingsConfig;
  load: LoadConfig;
}

const DEFAULT_MODEL_CHAINS = {
  hard: ['codex:gpt-5.6-luna', 'gemini-3.8-flash-high'],
  easy: ['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna'],
};

export function saveConfig(
  hubHome: string,
  patch: Partial<{
    modelChainHard: string[];
    modelChainEasy: string[];
    defaultTimeout: number;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    port: number;
    autoFixOnFail?: boolean;
    chat: Partial<ChatConfig>;
    reviewer: Partial<AgentHubConfig['reviewer']>;
    notifications: {
      desktop: boolean;
    };
    disk?: { minFreeGB?: number };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
  }>,
): void {
  const configFilePath = path.join(hubHome, 'config.json');
  let current: Record<string, unknown> = {};
  if (fs.existsSync(configFilePath)) {
    try {
      current = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch {
      // ignore
    }
  }
  const updated = {
    ...current,
    ...patch,
    ...(patch.chat && typeof patch.chat === 'object'
      ? { chat: { ...((current.chat as Record<string, unknown>) || {}), ...patch.chat } }
      : {}),
    ...(patch.reviewer && typeof patch.reviewer === 'object'
      ? { reviewer: { ...((current.reviewer as Record<string, unknown>) || {}), ...patch.reviewer } }
      : {}),
    ...(patch.disk ? { disk: { ...((current.disk as Record<string, unknown>) || {}), ...patch.disk } } : {}),
    ...(patch.cleanup ? { cleanup: { ...((current.cleanup as Record<string, unknown>) || {}), ...patch.cleanup } } : {}),
    ...(patch.load ? { load: { ...((current.load as Record<string, unknown>) || {}), ...patch.load } } : {}),
    ...(patch.savings
      ? {
          savings: {
            ...((current.savings as Record<string, unknown>) || {}),
            ...patch.savings,
            ...(patch.savings.bucketTokens
              ? {
                  bucketTokens: {
                    ...(((current.savings as Record<string, unknown>)?.bucketTokens as Record<string, unknown>) || {}),
                    ...patch.savings.bucketTokens,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  fs.writeFileSync(configFilePath, JSON.stringify(updated, null, 2), 'utf-8');
}

export function updateConfigInMemory(
  config: AgentHubConfig,
  patch: Partial<{
    modelChainHard: string[];
    modelChainEasy: string[];
    defaultTimeout: number;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    autoFixOnFail: boolean;
    chat: Partial<ChatConfig>;
    reviewer: Partial<AgentHubConfig['reviewer']>;
    notifications: {
      desktop: boolean;
    };
    disk?: { minFreeGB?: number };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
  }>,
): void {
  if (patch.modelChainHard) {
    config.defaultModelChains.hard = [...patch.modelChainHard];
  }
  if (patch.modelChainEasy) {
    config.defaultModelChains.easy = [...patch.modelChainEasy];
  }
  if (patch.defaultTimeout !== undefined) {
    config.defaultTimeout = patch.defaultTimeout;
  }
  if (patch.slotsPerAgyProfile !== undefined) {
    config.slotsPerAgyProfile = patch.slotsPerAgyProfile;
  }
  if (patch.slotsPerCodexProfile !== undefined) {
    config.slotsPerCodexProfile = patch.slotsPerCodexProfile;
  }
  if (patch.watchdog) {
    config.watchdog = { ...config.watchdog, ...patch.watchdog };
  }
  if (patch.autoFixOnFail !== undefined) config.autoFixOnFail = patch.autoFixOnFail;
  if (patch.chat) {
    if (patch.chat.claudeBin !== undefined) {
      config.chat.claudeBin = patch.chat.claudeBin;
    }
    if (patch.chat.disableToolSearch !== undefined) {
      config.chat.disableToolSearch = patch.chat.disableToolSearch;
    }
    if (patch.chat.allowFullMode !== undefined) {
      config.chat.allowFullMode = patch.chat.allowFullMode;
    }
    if (patch.chat.maxConcurrent !== undefined) {
      config.chat.maxConcurrent = patch.chat.maxConcurrent;
    }
    if (patch.chat.idleTimeoutSec !== undefined) config.chat.idleTimeoutSec = patch.chat.idleTimeoutSec;
    if (patch.chat.model !== undefined) config.chat.model = patch.chat.model;
  }
  if (patch.reviewer) config.reviewer = { ...config.reviewer, ...patch.reviewer };
  if (patch.notifications) {
    config.notifications = {
      ...config.notifications,
      ...patch.notifications,
    };
  }
  if (patch.disk?.minFreeGB !== undefined) {
    config.disk.minFreeGB = patch.disk.minFreeGB;
  }
  if (patch.cleanup?.nodeModulesOnDone !== undefined) {
    config.cleanup.nodeModulesOnDone = patch.cleanup.nodeModulesOnDone;
  }
  if (patch.cleanup?.worktreeOnDoneAfterHours !== undefined) {
    config.cleanup.worktreeOnDoneAfterHours = patch.cleanup.worktreeOnDoneAfterHours;
  }
  if (patch.cacheDir !== undefined) {
    config.cacheDir = patch.cacheDir;
  }
  if (patch.savings) {
    if (patch.savings.bucketTokens) {
      config.savings.bucketTokens = {
        ...config.savings.bucketTokens,
        ...patch.savings.bucketTokens,
      };
    }
    if (patch.savings.claudeFactor !== undefined) {
      config.savings.claudeFactor = patch.savings.claudeFactor;
    }
    if (patch.savings.claudeOverheadPerTask !== undefined) {
      config.savings.claudeOverheadPerTask = patch.savings.claudeOverheadPerTask;
    }
  }
  if (patch.load) config.load = { ...config.load, ...patch.load };
}

export function loadConfig(overrideHome?: string): AgentHubConfig {
  const hubHome = overrideHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');

  // Ensure directory exists with proper permissions
  if (!fs.existsSync(hubHome)) {
    fs.mkdirSync(hubHome, { recursive: true, mode: 0o700 });
  }

  const configFilePath = path.join(hubHome, 'config.json');
  let userConfig: Record<string, unknown> = {};
  if (fs.existsSync(configFilePath)) {
    try {
      userConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch {
      // ignore invalid config
    }
  }

  const logsDir = path.join(hubHome, 'logs');
  const worktreesDir = path.join(hubHome, 'worktrees');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  if (!fs.existsSync(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true });

  const agyHomesDir =
    (userConfig.agyHomesDir as string) ||
    process.env.AGENTHUB_AGY_HOMES ||
    path.join(os.homedir(), '.agy-homes');

  const defaultLogDir =
    (userConfig.defaultLogDir as string) ||
    process.env.AGENTHUB_DEFAULT_LOG_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');

  const envPort = process.env.AGENTHUB_PORT ? parseInt(process.env.AGENTHUB_PORT, 10) : undefined;
  const port = (envPort && !isNaN(envPort)) ? envPort : ((userConfig.port as number) || 7700);

  const chatRaw = (userConfig.chat as Record<string, unknown>) || {};
  const chat: ChatConfig = {
    claudeBin:
      (chatRaw.claudeBin as string) ||
      (userConfig.claudeBin as string) ||
      process.env.AGENTHUB_CLAUDE_BIN ||
      undefined,
    allowFullMode: chatRaw.allowFullMode === true || userConfig.allowFullMode === true,
    disableToolSearch: chatRaw.disableToolSearch !== false,
    maxConcurrent:
      typeof chatRaw.maxConcurrent === 'number'
        ? chatRaw.maxConcurrent
        : typeof userConfig.maxConcurrent === 'number'
        ? userConfig.maxConcurrent
        : 2,
    idleTimeoutSec: typeof chatRaw.idleTimeoutSec === 'number' ? chatRaw.idleTimeoutSec : 600,
    model: typeof chatRaw.model === 'string' ? chatRaw.model : 'sonnet',
  };
  const reviewerRaw = (userConfig.reviewer as Record<string, unknown>) || {};

  const userDisk = (userConfig.disk as { minFreeGB?: number } | undefined);
  const userCleanup = (userConfig.cleanup as { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number } | undefined);

  const disk = {
    minFreeGB: typeof userDisk?.minFreeGB === 'number' ? userDisk.minFreeGB : 3,
  };

  const cleanup = {
    nodeModulesOnDone: typeof userCleanup?.nodeModulesOnDone === 'boolean' ? userCleanup.nodeModulesOnDone : true,
    worktreeOnDoneAfterHours: typeof userCleanup?.worktreeOnDoneAfterHours === 'number' ? userCleanup.worktreeOnDoneAfterHours : 24,
  };

  const cacheDir =
    (userConfig.cacheDir as string) ||
    process.env.AGENTHUB_CACHE_DIR ||
    path.join(hubHome, 'cache', 'node_modules');
  if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

  const rawSavings = (userConfig.savings as Record<string, unknown>) || {};
  const rawLoad = (userConfig.load as Record<string, unknown>) || {};
  const rawClaudeSessions = (userConfig.claudeSessions as Record<string, unknown>) || {};
  const rawClaudeWeights = (rawClaudeSessions.weights as Record<string, unknown>) || {};
  const rawClaudeInclude = Array.isArray(rawClaudeSessions.include)
    ? rawClaudeSessions.include.filter((value): value is string => typeof value === 'string')
    : [];
  const rawBucketTokens = (rawSavings.bucketTokens as Record<string, unknown>) || {};
  const savings: SavingsConfig = {
    bucketTokens: {
      gemini: typeof rawBucketTokens.gemini === 'number' ? rawBucketTokens.gemini : DEFAULT_SAVINGS_CONFIG.bucketTokens.gemini,
      claude: typeof rawBucketTokens.claude === 'number' ? rawBucketTokens.claude : DEFAULT_SAVINGS_CONFIG.bucketTokens.claude,
    },
    claudeFactor: typeof rawSavings.claudeFactor === 'number' ? rawSavings.claudeFactor : DEFAULT_SAVINGS_CONFIG.claudeFactor,
    claudeOverheadPerTask: typeof rawSavings.claudeOverheadPerTask === 'number' ? rawSavings.claudeOverheadPerTask : DEFAULT_SAVINGS_CONFIG.claudeOverheadPerTask,
  };

  return {
    hubHome,
    agyHomesDir,
    dbPath: path.join(hubHome, 'hub.db'),
    logsDir,
    worktreesDir,
    tokenPath: path.join(hubHome, 'token'),
    configFilePath,
    port,
    defaultModelChains: {
      hard: (userConfig as Record<string, unknown>).modelChainHard as string[] || [...DEFAULT_MODEL_CHAINS.hard],
      easy: (userConfig as Record<string, unknown>).modelChainEasy as string[] || [...DEFAULT_MODEL_CHAINS.easy],
    },
    defaultTimeout: (userConfig.defaultTimeout as number) || 3 * 60 * 60,
    slotsPerAgyProfile: (userConfig.slotsPerAgyProfile as number) || 2,
    slotsPerCodexProfile: (userConfig.slotsPerCodexProfile as number) || 2,
    watchdog: {
      stallMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.stallMinutes as number) || 20,
      waitingMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.waitingMinutes as number) || 15,
    },
    defaultLogDir,
    autoFixOnFail: userConfig.autoFixOnFail === true,
    chat,
    claudeSessions: {
      dir: typeof rawClaudeSessions.dir === 'string' ? rawClaudeSessions.dir : path.join(os.homedir(), '.claude', 'projects'),
      maxAgeDays: typeof rawClaudeSessions.maxAgeDays === 'number' ? rawClaudeSessions.maxAgeDays : 14,
      include: rawClaudeInclude,
      weights: {
        cacheCreation: typeof rawClaudeWeights.cacheCreation === 'number' ? rawClaudeWeights.cacheCreation : 1.25,
        cacheRead: typeof rawClaudeWeights.cacheRead === 'number' ? rawClaudeWeights.cacheRead : 0.1,
      },
    },
    reviewer: {
      enabled: reviewerRaw.enabled !== false,
      model: typeof reviewerRaw.model === 'string' ? reviewerRaw.model : 'codex:gpt-5.6-luna',
      timeoutSec: typeof reviewerRaw.timeoutSec === 'number' ? reviewerRaw.timeoutSec : 900,
      failoverSec: typeof reviewerRaw.failoverSec === 'number' ? reviewerRaw.failoverSec : 5 * 60 * 60,
      maxChangesRequested: typeof reviewerRaw.maxChangesRequested === 'number' ? reviewerRaw.maxChangesRequested : 2,
    },
    notifications: {
      desktop: typeof (userConfig.notifications as { desktop?: boolean } | undefined)?.desktop === 'boolean'
        ? (userConfig.notifications as { desktop: boolean }).desktop
        : true,
    },
    disk,
    cleanup,
    cacheDir,
    savings,
    load: {
      enabled: typeof rawLoad.enabled === 'boolean' ? rawLoad.enabled : DEFAULT_LOAD_CONFIG.enabled,
      high: typeof rawLoad.high === 'number' ? rawLoad.high : DEFAULT_LOAD_CONFIG.high,
      ok: typeof rawLoad.ok === 'number' ? rawLoad.ok : DEFAULT_LOAD_CONFIG.ok,
      minFreeMemGB: typeof rawLoad.minFreeMemGB === 'number' ? rawLoad.minFreeMemGB : DEFAULT_LOAD_CONFIG.minFreeMemGB,
      recoverAfterSec: typeof rawLoad.recoverAfterSec === 'number' ? rawLoad.recoverAfterSec : DEFAULT_LOAD_CONFIG.recoverAfterSec,
    },
  };
}
