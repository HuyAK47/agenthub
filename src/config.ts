import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_LOAD_CONFIG, LoadConfig } from './load.js';
import type { ExtraDiskPath } from './disk.js';
import { normalizeFallbackSteps, ClaudeFallbackStep } from './chat/failover.js';

export interface ChatConfig {
  claudeBin?: string;
  disableToolSearch: boolean;
  allowFullMode: boolean;
  maxConcurrent: number;
  idleTimeoutSec: number;
  model: string;
  models: string[];
  permissionTimeoutSec: number;
  claudeProfile?: string;
  claudeProfileExplicit?: boolean;
  autoCompactPercent: number;
}

export interface BrainDigestConfig {
  enabled: boolean;
  time: string;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;
  end: string;
}

export interface NotificationsConfig {
  desktop: boolean;
  quietHours?: QuietHoursConfig;
}

export const DEFAULT_QUIET_HOURS_CONFIG: QuietHoursConfig = {
  enabled: false,
  start: '22:00',
  end: '07:00',
};

export const DEFAULT_BRAIN_DIGEST_CONFIG: BrainDigestConfig = {
  enabled: true,
  time: '18:00',
};

export interface BrainConfig {
  fallback: ClaudeFallbackStep[];
  policy: string[];
  claudeProfile: string;
  claudeProfileExplicit?: boolean;
  model: string;
  mode: 'off' | 'suggest' | 'auto';
  maxConcurrent: number;
  maxTurnsPerHour: number;
  dailyTokenBudget: number;
  turnTimeoutSec?: number;
  digest: BrainDigestConfig;
}

export interface ClaudeSessionsConfig {
  dir: string;
  maxAgeDays: number;
  activeWithinMin: number;
  include: string[];
  weights: { cacheCreation: number; cacheRead: number };
  autoResume: { enabled: boolean; prompt: string; allowFullMode: boolean };
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

export interface StallConfig {
  noCommitMin: number;
  loopThreshold: number;
}

export interface TelegramNotifyConfig {
  reviewReady: boolean;
  failed: boolean;
  blocked: boolean;
  quota: boolean;
  fallback: boolean;
  brainWaiting?: boolean;
}

export interface TelegramChat {
  id: number;
  name: string;
  username?: string;
}

export interface TelegramConfig {
  enabled: boolean;
  botTokenFile: string;
  allowedChatIds: number[];
  chats: TelegramChat[];
  notify: TelegramNotifyConfig;
}

export interface DeployPushConfig {
  remote: string;
  from: string;
  to: string;
  ffOnly: boolean;
}

export interface DeployProjectConfig {
  steps: string[][];
  timeoutSec: number;
  restartHub: boolean;
  push?: DeployPushConfig;
}

export const DEFAULT_TELEGRAM_NOTIFY: TelegramNotifyConfig = {
  reviewReady: true,
  failed: true,
  blocked: true,
  quota: true,
  fallback: true,
  brainWaiting: true,
};

export const DEFAULT_STALL_CONFIG: StallConfig = {
  noCommitMin: 45,
  loopThreshold: 6,
};

export interface ContextConfig {
  overlapCheckSec: number;
  depsMaxChars: number;
  knowledgeMaxChars: number;
  knowledgeFile?: string;
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  overlapCheckSec: 60,
  depsMaxChars: 16000,
  knowledgeMaxChars: 12000,
};

export interface PlanningConfig {
  /** Every task Claude creates starts as a draft that the user must dispatch. */
  requireApproval: boolean;
  /** Plans with at least this many tasks become a draft batch for the user to approve; 0 = never. */
  approvalMinTasks: number;
}

export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  requireApproval: false,
  approvalMinTasks: 0,
};

export type DeepPartialSavingsConfig = {
  bucketTokens?: Partial<SavingsConfig['bucketTokens']>;
  claudeFactor?: number;
  claudeOverheadPerTask?: number;
};

export interface UpdatesConfig {
  check: boolean;
  repo?: string;
}

export interface ToolInstaller {
  package?: string;
  command?: string[];
  versionArgs?: string[];
  docsUrl?: string;
}

export interface ToolsConfig {
  installers: {
    claude: ToolInstaller;
    codex: ToolInstaller;
    agy: ToolInstaller;
  };
}

export type ToolInstallerPatch = Pick<ToolInstaller, 'package' | 'versionArgs' | 'docsUrl'>;

export const DEFAULT_UPDATES_CONFIG: UpdatesConfig = {
  check: true,
  repo: 'ducanh19020217/agenthub',
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
  multiplePerProvider: boolean;
  multiplePerProviderConfigured: boolean;
  slotsPerAgyProfile: number;
  slotsPerCodexProfile: number;
  watchdog: {
    stallMinutes: number;
    waitingMinutes: number;
  };
  defaultLogDir: string;
  autoFixOnFail: boolean;
  chat: ChatConfig;
  brain: BrainConfig;
  claudeSessions: ClaudeSessionsConfig;
  reviewer: {
    enabled: boolean;
    model: string;
    timeoutSec: number;
    failoverSec: number;
    maxChangesRequested: number;
  };
  notifications: NotificationsConfig;
  disk: {
    minFreeGB: number;
    extraPaths: ExtraDiskPath[];
  };
  cleanup: {
    nodeModulesOnDone: boolean;
    worktreeOnDoneAfterHours: number;
  };
  cacheDir: string;
  savings: SavingsConfig;
  load: LoadConfig;
  stall: StallConfig;
  context: ContextConfig;
  planning: PlanningConfig;
  telegram: TelegramConfig;
  updates: UpdatesConfig;
  tools: ToolsConfig;
  deploy: Record<string, DeployProjectConfig>;
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
    multiplePerProvider?: boolean;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    port: number;
    autoFixOnFail?: boolean;
    chat: Partial<ChatConfig>;
    brain?: Partial<BrainConfig>;
    reviewer: Partial<AgentHubConfig['reviewer']>;
    notifications?: Partial<{
      desktop: boolean;
      quietHours?: Partial<QuietHoursConfig>;
    }>;
    disk?: { minFreeGB?: number; extraPaths?: ExtraDiskPath[] };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
    stall?: Partial<StallConfig>;
    context?: Partial<ContextConfig>;
    planning?: Partial<PlanningConfig>;
    updates?: Partial<UpdatesConfig>;
    tools?: Partial<{ installers: Partial<Record<'claude' | 'codex' | 'agy', ToolInstallerPatch>> }>;
    telegram?: Partial<{
      enabled?: boolean;
      botTokenFile?: string;
      allowedChatIds?: number[];
      chats?: TelegramChat[];
      notify?: Partial<TelegramNotifyConfig>;
    }>;
  }>,
): void {
  const configFilePath = path.join(hubHome, 'config.json');
  const managedToolsDir = path.join(hubHome, 'tools');
  process.env.AGENTHUB_TOOLS_DIR ||= managedToolsDir;
  const managedBinDir = path.join(managedToolsDir, 'node_modules', '.bin');
  if (!(process.env.PATH || '').split(path.delimiter).includes(managedBinDir)) {
    process.env.PATH = `${managedBinDir}${path.delimiter}${process.env.PATH || ''}`;
  }
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
    ...(patch.brain && typeof patch.brain === 'object'
      ? {
          brain: {
            ...((current.brain as Record<string, unknown>) || {}),
            ...patch.brain,
            ...(patch.brain.digest && typeof patch.brain.digest === 'object'
              ? {
                  digest: {
                    ...((((current.brain as Record<string, unknown>) || {}).digest as Record<string, unknown>) || {}),
                    ...patch.brain.digest,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.notifications && typeof patch.notifications === 'object'
      ? {
          notifications: {
            ...((current.notifications as Record<string, unknown>) || {}),
            ...patch.notifications,
            ...(patch.notifications.quietHours && typeof patch.notifications.quietHours === 'object'
              ? {
                  quietHours: {
                    ...((((current.notifications as Record<string, unknown>) || {}).quietHours as Record<string, unknown>) || {}),
                    ...patch.notifications.quietHours,
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(patch.reviewer && typeof patch.reviewer === 'object'
      ? { reviewer: { ...((current.reviewer as Record<string, unknown>) || {}), ...patch.reviewer } }
      : {}),
    ...(patch.disk ? { disk: { ...((current.disk as Record<string, unknown>) || {}), ...patch.disk } } : {}),
    ...(patch.cleanup ? { cleanup: { ...((current.cleanup as Record<string, unknown>) || {}), ...patch.cleanup } } : {}),
    ...(patch.load ? { load: { ...((current.load as Record<string, unknown>) || {}), ...patch.load } } : {}),
    ...(patch.stall ? { stall: { ...((current.stall as Record<string, unknown>) || {}), ...patch.stall } } : {}),
    ...(patch.context ? { context: { ...((current.context as Record<string, unknown>) || {}), ...patch.context } } : {}),
    ...(patch.planning && typeof patch.planning === 'object'
      ? { planning: { ...((current.planning as Record<string, unknown>) || {}), ...patch.planning } }
      : {}),
    ...(patch.updates && typeof patch.updates === 'object'
      ? {
          updates: {
            ...((current.updates as Record<string, unknown>) || {}),
            ...patch.updates,
          },
        }
      : {}),
    ...(patch.tools ? { tools: { ...((current.tools as Record<string, unknown>) || {}), ...patch.tools, ...(patch.tools.installers ? { installers: { ...(((current.tools as Record<string, unknown>)?.installers as Record<string, unknown>) || {}), ...patch.tools.installers } } : {}) } } : {}),
    ...(patch.telegram && typeof patch.telegram === 'object'
      ? {
          telegram: {
            ...((current.telegram as Record<string, unknown>) || {}),
            ...patch.telegram,
            ...(patch.telegram.notify && typeof patch.telegram.notify === 'object'
              ? {
                  notify: {
                    ...(((current.telegram as Record<string, unknown>)?.notify as Record<string, unknown>) || {}),
                    ...patch.telegram.notify,
                  },
                }
              : {}),
          },
        }
      : {}),
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
    multiplePerProvider?: boolean;
    slotsPerAgyProfile: number;
    slotsPerCodexProfile: number;
    watchdog: { stallMinutes?: number; waitingMinutes?: number };
    autoFixOnFail: boolean;
    chat: Partial<ChatConfig>;
    brain?: Partial<BrainConfig>;
    reviewer: Partial<AgentHubConfig['reviewer']>;
    notifications?: Partial<{
      desktop: boolean;
      quietHours?: Partial<QuietHoursConfig>;
    }>;
    disk?: { minFreeGB?: number; extraPaths?: ExtraDiskPath[] };
    cleanup?: { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number };
    cacheDir?: string;
    savings: DeepPartialSavingsConfig;
    load?: Partial<LoadConfig>;
    stall?: Partial<StallConfig>;
    context?: Partial<ContextConfig>;
    planning?: Partial<PlanningConfig>;
    updates?: Partial<UpdatesConfig>;
    tools?: Partial<{ installers: Partial<Record<'claude' | 'codex' | 'agy', ToolInstallerPatch>> }>;
    telegram?: Partial<{
      enabled?: boolean;
      botTokenFile?: string;
      allowedChatIds?: number[];
      chats?: TelegramChat[];
      notify?: Partial<TelegramNotifyConfig>;
    }>;
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
  if (patch.multiplePerProvider !== undefined) {
    config.multiplePerProvider = patch.multiplePerProvider;
    config.multiplePerProviderConfigured = true;
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
    if (patch.chat.models !== undefined) config.chat.models = [...patch.chat.models];
    if (patch.chat.permissionTimeoutSec !== undefined) config.chat.permissionTimeoutSec = patch.chat.permissionTimeoutSec;
    if (patch.chat.claudeProfile !== undefined) config.chat.claudeProfile = patch.chat.claudeProfile;
    if (patch.chat.autoCompactPercent !== undefined) config.chat.autoCompactPercent = patch.chat.autoCompactPercent;
  }
  if (patch.brain) {
    if (patch.brain.fallback) config.brain.fallback = normalizeFallbackSteps(patch.brain.fallback);
    if (patch.brain.policy) config.brain.policy = [...patch.brain.policy];
    if (patch.brain.claudeProfile !== undefined) config.brain.claudeProfile = patch.brain.claudeProfile;
    if (patch.brain.model !== undefined) config.brain.model = patch.brain.model;
    if (patch.brain.mode !== undefined) config.brain.mode = patch.brain.mode;
    if (patch.brain.maxTurnsPerHour !== undefined) config.brain.maxTurnsPerHour = patch.brain.maxTurnsPerHour;
    if (patch.brain.dailyTokenBudget !== undefined) config.brain.dailyTokenBudget = patch.brain.dailyTokenBudget;
    if (patch.brain.turnTimeoutSec !== undefined) config.brain.turnTimeoutSec = patch.brain.turnTimeoutSec;
    if (patch.brain.maxConcurrent !== undefined) config.brain.maxConcurrent = patch.brain.maxConcurrent;
    if (patch.brain.digest) {
      config.brain.digest = {
        ...config.brain.digest,
        ...patch.brain.digest,
      };
    }
  }
  if (patch.reviewer) config.reviewer = { ...config.reviewer, ...patch.reviewer };
  if (patch.notifications) {
    if (patch.notifications.desktop !== undefined) {
      config.notifications.desktop = patch.notifications.desktop;
    }
    if (patch.notifications.quietHours) {
      config.notifications.quietHours = {
        enabled: patch.notifications.quietHours.enabled ?? config.notifications.quietHours?.enabled ?? DEFAULT_QUIET_HOURS_CONFIG.enabled,
        start: patch.notifications.quietHours.start ?? config.notifications.quietHours?.start ?? DEFAULT_QUIET_HOURS_CONFIG.start,
        end: patch.notifications.quietHours.end ?? config.notifications.quietHours?.end ?? DEFAULT_QUIET_HOURS_CONFIG.end,
      };
    }
  }
  if (patch.disk?.minFreeGB !== undefined) {
    config.disk.minFreeGB = patch.disk.minFreeGB;
  }
  if (patch.disk?.extraPaths !== undefined) {
    config.disk.extraPaths = [...patch.disk.extraPaths];
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
  if (patch.stall) config.stall = { ...config.stall, ...patch.stall };
  if (patch.context) {
    if (patch.context.overlapCheckSec !== undefined) {
      config.context.overlapCheckSec = patch.context.overlapCheckSec;
    }
    if (patch.context.depsMaxChars !== undefined) {
      config.context.depsMaxChars = patch.context.depsMaxChars;
    }
    if (patch.context.knowledgeMaxChars !== undefined) {
      config.context.knowledgeMaxChars = patch.context.knowledgeMaxChars;
    }
    if (patch.context.knowledgeFile !== undefined) {
      config.context.knowledgeFile = patch.context.knowledgeFile;
    }
  }
  if (patch.planning) {
    if (patch.planning.requireApproval !== undefined) {
      config.planning.requireApproval = patch.planning.requireApproval;
    }
    if (patch.planning.approvalMinTasks !== undefined) {
      config.planning.approvalMinTasks = Math.max(0, Math.floor(patch.planning.approvalMinTasks));
    }
  }
  if (patch.telegram) {
    config.telegram = {
      ...config.telegram,
      ...patch.telegram,
      allowedChatIds:
        patch.telegram.allowedChatIds !== undefined
          ? [...patch.telegram.allowedChatIds]
          : config.telegram.allowedChatIds,
      chats: patch.telegram.chats !== undefined ? [...patch.telegram.chats] : config.telegram.chats,
      notify: {
        ...config.telegram.notify,
        ...(patch.telegram.notify || {}),
      },
    };
  }
  if (patch.updates) {
    config.updates = { ...config.updates, ...patch.updates };
  }
  if (patch.tools?.installers) {
    for (const [name, value] of Object.entries(patch.tools.installers) as Array<[keyof ToolsConfig['installers'], ToolInstallerPatch | undefined]>) {
      if (!value) continue;
      config.tools.installers[name] = {
        ...config.tools.installers[name],
        ...(value.package !== undefined ? { package: value.package } : {}),
        ...(value.versionArgs !== undefined ? { versionArgs: [...value.versionArgs] } : {}),
        ...(value.docsUrl !== undefined ? { docsUrl: value.docsUrl } : {}),
      };
    }
  }
}

export function loadConfig(overrideHome?: string): AgentHubConfig {
  const hubHome = overrideHome || process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub');

  // Ensure directory exists with proper permissions
  if (!fs.existsSync(hubHome)) {
    fs.mkdirSync(hubHome, { recursive: true, mode: 0o700 });
  }

  const configFilePath = path.join(hubHome, 'config.json');
  const managedToolsDir = path.join(hubHome, 'tools');
  process.env.AGENTHUB_TOOLS_DIR ||= managedToolsDir;
  const managedBinDir = path.join(managedToolsDir, 'node_modules', '.bin');
  if (!(process.env.PATH || '').split(path.delimiter).includes(managedBinDir)) {
    process.env.PATH = `${managedBinDir}${path.delimiter}${process.env.PATH || ''}`;
  }
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
    idleTimeoutSec: typeof chatRaw.idleTimeoutSec === 'number' ? chatRaw.idleTimeoutSec : 300,
    model: typeof chatRaw.model === 'string' ? chatRaw.model : 'sonnet',
    models: Array.isArray(chatRaw.models) && chatRaw.models.every((model): model is string => typeof model === 'string' && model.trim().length > 0)
      ? [...chatRaw.models]
      : ['opus', 'sonnet', 'haiku'],
    permissionTimeoutSec: typeof chatRaw.permissionTimeoutSec === 'number' ? chatRaw.permissionTimeoutSec : 600,
    claudeProfile: typeof chatRaw.claudeProfile === 'string' ? chatRaw.claudeProfile : 'claude-default',
    claudeProfileExplicit: typeof chatRaw.claudeProfile === 'string' && chatRaw.claudeProfile.trim().length > 0,
    autoCompactPercent: typeof chatRaw.autoCompactPercent === 'number' ? chatRaw.autoCompactPercent : 85,
  };
  const reviewerRaw = (userConfig.reviewer as Record<string, unknown>) || {};
  const brainRaw = (userConfig.brain as Record<string, unknown>) || {};

  const userDisk = (userConfig.disk as { minFreeGB?: number; extraPaths?: unknown } | undefined);
  const userCleanup = (userConfig.cleanup as { nodeModulesOnDone?: boolean; worktreeOnDoneAfterHours?: number } | undefined);

  const disk = {
    minFreeGB: typeof userDisk?.minFreeGB === 'number' ? userDisk.minFreeGB : 3,
    extraPaths: Array.isArray(userDisk?.extraPaths)
      ? userDisk.extraPaths.filter((entry): entry is ExtraDiskPath => {
          if (!entry || typeof entry !== 'object') return false;
          const value = entry as Record<string, unknown>;
          return typeof value.path === 'string' && typeof value.minFreeGB === 'number' && typeof value.label === 'string';
        })
      : [],
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

  const rawStall = (userConfig.stall as Record<string, unknown>) || {};
  const stall: StallConfig = {
    noCommitMin: typeof rawStall.noCommitMin === 'number' ? rawStall.noCommitMin : DEFAULT_STALL_CONFIG.noCommitMin,
    loopThreshold: typeof rawStall.loopThreshold === 'number' ? rawStall.loopThreshold : DEFAULT_STALL_CONFIG.loopThreshold,
  };

  const rawContext = (userConfig.context as Record<string, unknown>) || {};
  const context = {
    depsMaxChars: typeof rawContext.depsMaxChars === 'number' && rawContext.depsMaxChars > 0
      ? Math.floor(rawContext.depsMaxChars)
      : 16000,
    knowledgeMaxChars: typeof rawContext.knowledgeMaxChars === 'number' && rawContext.knowledgeMaxChars > 0
      ? Math.floor(rawContext.knowledgeMaxChars)
      : DEFAULT_CONTEXT_CONFIG.knowledgeMaxChars,
    knowledgeFile: typeof rawContext.knowledgeFile === 'string' && rawContext.knowledgeFile.trim()
      ? rawContext.knowledgeFile.trim()
      : undefined,
  };

  const defaultBotTokenFile = path.join(hubHome, 'secrets', 'telegram.token');
  const rawPlanning = (userConfig.planning as Record<string, unknown>) || {};
  const planning: PlanningConfig = {
    requireApproval: rawPlanning.requireApproval === true,
    approvalMinTasks: typeof rawPlanning.approvalMinTasks === 'number' && rawPlanning.approvalMinTasks >= 0
      ? Math.floor(rawPlanning.approvalMinTasks)
      : DEFAULT_PLANNING_CONFIG.approvalMinTasks,
  };
  const rawTelegram = (userConfig.telegram as Record<string, unknown>) || {};
  const rawTelegramNotify = (rawTelegram.notify as Record<string, unknown>) || {};
  const telegram: TelegramConfig = {
    enabled: rawTelegram.enabled === true,
    botTokenFile:
      typeof rawTelegram.botTokenFile === 'string' && rawTelegram.botTokenFile.trim()
        ? rawTelegram.botTokenFile.trim()
        : defaultBotTokenFile,
    allowedChatIds: Array.isArray(rawTelegram.allowedChatIds)
      ? rawTelegram.allowedChatIds.filter((id): id is number => typeof id === 'number')
      : [],
    chats: Array.isArray(rawTelegram.chats)
      ? rawTelegram.chats.filter((chat): chat is TelegramChat =>
          Boolean(chat && typeof chat === 'object' && typeof (chat as TelegramChat).id === 'number' && typeof (chat as TelegramChat).name === 'string'),
        )
      : [],
    notify: {
      reviewReady: rawTelegramNotify.reviewReady !== false,
      failed: rawTelegramNotify.failed !== false,
      blocked: rawTelegramNotify.blocked !== false,
      quota: rawTelegramNotify.quota !== false,
      fallback: rawTelegramNotify.fallback !== false,
      brainWaiting: rawTelegramNotify.brainWaiting !== false,
    },
  };

  const rawUpdates = (userConfig.updates as Record<string, unknown>) || {};
  const updates: UpdatesConfig = {
    check: rawUpdates.check !== false,
    repo: typeof rawUpdates.repo === 'string' && rawUpdates.repo.trim()
      ? rawUpdates.repo.trim()
      : DEFAULT_UPDATES_CONFIG.repo,
  };
  const rawTools = (userConfig.tools as Record<string, unknown>) || {};
  const rawDeploy = (userConfig.deploy as Record<string, unknown>) || {};
  const rawProjectsConfig = (userConfig.projects as Record<string, unknown>) || {};
  for (const [projectId, rawProject] of Object.entries(rawProjectsConfig)) {
    if (rawProject && typeof rawProject === 'object' && (rawProject as Record<string, unknown>).afterMerge) {
      rawDeploy[projectId] = (rawProject as Record<string, unknown>).afterMerge;
    }
  }
  const deploy: Record<string, DeployProjectConfig> = {};
  for (const [projectId, raw] of Object.entries(rawDeploy)) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Record<string, unknown>;
    const steps = Array.isArray(value.steps)
      ? value.steps.filter((step): step is string[] => Array.isArray(step) && step.length > 0 && step.every((arg) => typeof arg === 'string'))
      : [];
    if (steps.length === 0) continue;
    const pushRaw = value.push as Record<string, unknown> | undefined;
    const push = pushRaw && typeof pushRaw.remote === 'string' && typeof pushRaw.from === 'string' && typeof pushRaw.to === 'string'
      ? { remote: pushRaw.remote, from: pushRaw.from, to: pushRaw.to, ffOnly: pushRaw.ffOnly !== false }
      : undefined;
    deploy[projectId] = {
      steps,
      timeoutSec: typeof value.timeoutSec === 'number' && value.timeoutSec > 0 ? Math.floor(value.timeoutSec) : 900,
      restartHub: value.restartHub === true,
      ...(push ? { push } : {}),
    };
  }
  const rawInstallers = (rawTools.installers as Record<string, unknown>) || {};
  const installer = (name: string, fallback: ToolInstaller): ToolInstaller => {
    const value = rawInstallers[name];
    return value && typeof value === 'object' ? { ...fallback, ...(value as ToolInstaller) } : fallback;
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
    multiplePerProvider: userConfig.multiplePerProvider === true,
    multiplePerProviderConfigured: Object.prototype.hasOwnProperty.call(userConfig, 'multiplePerProvider'),
    slotsPerAgyProfile: (userConfig.slotsPerAgyProfile as number) || 2,
    slotsPerCodexProfile: (userConfig.slotsPerCodexProfile as number) || 2,
    watchdog: {
      stallMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.stallMinutes as number) || 20,
      waitingMinutes: ((userConfig.watchdog as Record<string, unknown> | undefined)?.waitingMinutes as number) || 15,
    },
    defaultLogDir,
    autoFixOnFail: userConfig.autoFixOnFail === true,
    chat,
    brain: {
      fallback: normalizeFallbackSteps(brainRaw.fallback),
      policy: Array.isArray(brainRaw.policy)
        ? brainRaw.policy.filter((pattern): pattern is string => typeof pattern === 'string' && pattern.length > 0)
        : [],
      claudeProfile: typeof brainRaw.claudeProfile === 'string' && brainRaw.claudeProfile.trim()
        ? brainRaw.claudeProfile.trim()
        : chat.claudeProfile || 'claude-default',
      claudeProfileExplicit:
        (typeof brainRaw.claudeProfile === 'string' && brainRaw.claudeProfile.trim().length > 0) ||
        chat.claudeProfileExplicit === true,
      model: typeof brainRaw.model === 'string' && brainRaw.model
        ? brainRaw.model
        : (chat.models.includes('opus') ? 'opus' : 'sonnet'),
      mode: brainRaw.mode === 'off' || brainRaw.mode === 'auto' ? brainRaw.mode : 'suggest',
      maxConcurrent: typeof brainRaw.maxConcurrent === 'number' && brainRaw.maxConcurrent > 0
        ? Math.floor(brainRaw.maxConcurrent)
        : 2,
      maxTurnsPerHour: typeof brainRaw.maxTurnsPerHour === 'number' && brainRaw.maxTurnsPerHour > 0
        ? Math.floor(brainRaw.maxTurnsPerHour)
        : 20,
      dailyTokenBudget: typeof brainRaw.dailyTokenBudget === 'number' && brainRaw.dailyTokenBudget >= 0
        ? Math.floor(brainRaw.dailyTokenBudget)
        : 0,
      turnTimeoutSec: typeof brainRaw.turnTimeoutSec === 'number' && brainRaw.turnTimeoutSec > 0
        ? Math.floor(brainRaw.turnTimeoutSec)
        : 20 * 60,
      digest: typeof brainRaw.digest === 'string'
        ? { enabled: true, time: brainRaw.digest }
        : typeof brainRaw.digest === 'object' && brainRaw.digest !== null
        ? {
            enabled: (brainRaw.digest as { enabled?: boolean }).enabled !== false,
            time: typeof (brainRaw.digest as { time?: string }).time === 'string' && (brainRaw.digest as { time: string }).time.trim()
              ? (brainRaw.digest as { time: string }).time.trim()
              : DEFAULT_BRAIN_DIGEST_CONFIG.time,
          }
        : { ...DEFAULT_BRAIN_DIGEST_CONFIG },
    },
    claudeSessions: {
      dir: typeof rawClaudeSessions.dir === 'string' ? rawClaudeSessions.dir : path.join(os.homedir(), '.claude', 'projects'),
      maxAgeDays: typeof rawClaudeSessions.maxAgeDays === 'number' ? rawClaudeSessions.maxAgeDays : 14,
      activeWithinMin: typeof rawClaudeSessions.activeWithinMin === 'number' ? rawClaudeSessions.activeWithinMin : 10,
      include: rawClaudeInclude,
      weights: {
        cacheCreation: typeof rawClaudeWeights.cacheCreation === 'number' ? rawClaudeWeights.cacheCreation : 1.25,
        cacheRead: typeof rawClaudeWeights.cacheRead === 'number' ? rawClaudeWeights.cacheRead : 0.1,
      },
      autoResume: {
        enabled: (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.enabled === true,
        prompt: typeof (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.prompt === 'string'
          ? (rawClaudeSessions.autoResume as Record<string, unknown>).prompt as string
          : 'Giới hạn 5 giờ đã reset. Tiếp tục công việc đang dở từ chỗ đã dừng; nếu đã xong thì tóm tắt trạng thái.',
        allowFullMode: (rawClaudeSessions.autoResume as Record<string, unknown> | undefined)?.allowFullMode === true,
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
      ...(userConfig.notifications && typeof userConfig.notifications === 'object' && 'quietHours' in userConfig.notifications
        ? {
            quietHours: (() => {
              const raw = (userConfig.notifications as { quietHours?: unknown }).quietHours;
              if (typeof raw === 'string') {
                const parts = raw.split('-');
                if (parts.length === 2) {
                  return { enabled: true, start: parts[0].trim(), end: parts[1].trim() };
                }
              } else if (raw && typeof raw === 'object') {
                const obj = raw as Record<string, unknown>;
                return {
                  enabled: obj.enabled === true,
                  start: typeof obj.start === 'string' && obj.start.trim() ? obj.start.trim() : DEFAULT_QUIET_HOURS_CONFIG.start,
                  end: typeof obj.end === 'string' && obj.end.trim() ? obj.end.trim() : DEFAULT_QUIET_HOURS_CONFIG.end,
                };
              }
              return { ...DEFAULT_QUIET_HOURS_CONFIG };
            })(),
          }
        : {}),
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
      pausePolicy: rawLoad.pausePolicy === 'rss' || rawLoad.pausePolicy === 'recent' ? rawLoad.pausePolicy : DEFAULT_LOAD_CONFIG.pausePolicy,
      maxAutoPaused: typeof rawLoad.maxAutoPaused === 'number' ? rawLoad.maxAutoPaused : DEFAULT_LOAD_CONFIG.maxAutoPaused,
      autoPauseThresholdSec: typeof rawLoad.autoPauseThresholdSec === 'number' ? rawLoad.autoPauseThresholdSec : DEFAULT_LOAD_CONFIG.autoPauseThresholdSec,
    },
    stall,
    context: {
      overlapCheckSec: typeof rawContext.overlapCheckSec === 'number'
        ? rawContext.overlapCheckSec
        : DEFAULT_CONTEXT_CONFIG.overlapCheckSec,
      depsMaxChars: context.depsMaxChars,
      knowledgeMaxChars: context.knowledgeMaxChars,
      knowledgeFile: context.knowledgeFile,
    },
    planning,
    telegram,
    updates,
    tools: {
      installers: {
        claude: installer('claude', { package: '@anthropic-ai/claude-code', versionArgs: ['--version'] }),
        codex: installer('codex', { package: '@openai/codex', versionArgs: ['--version'] }),
        agy: installer('agy', { docsUrl: 'https://antigravity.google/' }),
      },
    },
    deploy,
  };
}
