export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'checking'
  | 'review'
  | 'done'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'waiting_quota';

export type TaskLevel = 'easy' | 'hard';

export type EngineType = 'agy' | 'codex';

export type ProfileKind = 'keyring' | 'isolated' | 'codex';

export interface QuotaMark {
  profileName: string;
  family: string;
  until: number; // epoch seconds
  reason?: string;
}
export interface QuotaUsageItem { grp: string; window: '5h' | 'week'; remainingPct: number; resetAt: number; fetchedAt: number; }

export interface Profile {
  name: string;
  engine: EngineType;
  kind: ProfileKind;
  home?: string;
  email?: string | null;
  loggedIn?: boolean;
  enabled: boolean | number;
  createdAt?: string;
  quotaMarks?: QuotaMark[];
  busy?: boolean;
  isBusy?: boolean;
  duplicateWarning?: boolean;
  duplicateEmailWith?: string[];
  usage?: QuotaUsageItem[];
  slotsUsed?: number;
  slotsTotal?: number;
  authState?: 'ok' | 'not_logged_in' | 'needs_verification' | 'error' | null;
  authMessage?: string | null;
  verifyUrl?: string | null;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  envTemplate?: string | null;
  maxParallel: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | string | null;
  createdAt?: string;
}

export interface Run {
  id: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  pid?: number | null;
  startedAt: string;
  endedAt?: string | null;
  outcome?: 'done' | 'blocked' | 'quota' | 'crashed' | 'cancelled' | 'timeout' | 'stalled' | null;
  reason?: string | null;
  logPath?: string | null;
  resetAt?: number | null;
}

export interface Review {
  id: string;
  taskId: string;
  verdict: 'approved' | 'changes_requested';
  feedback?: string | null;
  createdAt: string;
}

export interface Task {
  id: string; // project~slug or project/slug
  projectId: string;
  slug: string;
  title: string;
  body?: string;
  level: TaskLevel;
  modelChain?: string | string[] | null;
  baseRef?: string;
  branch?: string;
  worktreePath?: string | null;
  status: TaskStatus;
  dependsOn: string | string[];
  attempt: number;
  resume: number;
  notBefore?: number | null;
  transientRetries?: number;
  slot?: number | null;
  reviewerChangesRequested?: number;
  reviewerEscalated?: number;
  reviewerEscalatedAt?: string | null;
  reviewerEscalationReason?: string | null;
  createdAt: string;
  updatedAt: string;
  currentRun?: { startedAt: string; lastOutputAt: string; lastActivityAt: string; activitySource: 'log' | 'conversation' | 'worktree' } | null;
  checks?: CheckResult[];
}

export interface CheckResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

export interface TaskDetail extends Task {
  runs: Run[];
  reviews: Review[];
  doneContent?: string | null;
  blockedContent?: string | null;
  commits?: string[] | null;
  gitCommits?: string[] | null;
}

export interface EventItem {
  id: number;
  ts: string;
  type: string;
  taskId?: string | null;
  payload?: any;
  summary?: string;
}

export interface RunningWorker {
  taskId: string;
  runId?: string;
  profileName: string;
  model: string;
  engine?: string;
  startedAt: string;
  elapsedMs?: number;
  lastActivityAt?: string;
  activitySource?: 'log' | 'conversation' | 'worktree';
  // UI helper fields
  projectId?: string;
  slug?: string;
  title?: string;
  worktreePath?: string | null;
}

export type BrainActivity =
  | 'planning'
  | 'dispatching'
  | 'reviewing'
  | 'merging'
  | 'deploying'
  | 'waiting'
  | 'idle'
  | 'talking';

export interface BrainStatus {
  activity: BrainActivity;
  detail: string;
  taskId?: string | null;
  updatedAt: string;
  stale: boolean;
}

export interface ClaudeQuota {
  status: string | null;
  resetsAt: number | null;
  rateLimitType: string | null;
  observedAt: string | null;
  limited?: boolean;
}

export interface HubStatus {
  tasks: Record<string, number>;
  profiles?: Profile[];
  running: RunningWorker[];
  brain?: BrainStatus;
  disk?: {
    freeGB: number;
    totalGB: number;
  };
  // Backwards compatibility aliases
  tasksByStatus?: Record<TaskStatus, number>;
  runningWorkers?: RunningWorker[];
  recentEvents?: EventItem[];
  tasksByProject?: Record<string, Record<string, number>>;
}

export interface SavingsConfig {
  bucketTokens: {
    gemini: number;
    claude: number;
  };
  claudeFactor: number;
  claudeOverheadPerTask: number;
}

export interface SavingsSummary {
  totalWorkerTokens: number;
  claudeSavedTokens: number;
  claudeCostTokens: number;
  savingsRatio: number;
  totalLinesAdded: number;
  totalLinesDeleted: number;
  totalLinesChanged: number;
  tasksApprovedCount: number;
  avgReviewRounds: number;
}

export interface SavingsDailyItem {
  date: string;
  geminiTokens: number;
  codexTokens: number;
  totalTokens: number;
}

export interface SavingsTaskItem {
  taskId: string;
  slug: string;
  title: string;
  projectId: string;
  status: string;
  model: string;
  engine: string;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  tokens: number;
  estimated: boolean;
  reviewRounds: number;
  durationMs: number;
  completedAt: string | null;
  claudeCostSource?: 'measured' | 'estimated';
  claudeEffectiveTokens?: number;
}

export interface SavingsReport {
  summary: SavingsSummary;
  byEngine: Record<string, { tokens: number; taskCount: number }>;
  byModel: Record<string, { tokens: number; taskCount: number }>;
  byDay: SavingsDailyItem[];
  tasks: SavingsTaskItem[];
}

export interface SystemConfig {
  modelChainHard: string[];
  modelChainEasy: string[];
  defaultTimeout: number;
  slotsPerAgyProfile?: number;
  slotsPerCodexProfile?: number;
  watchdog?: { stallMinutes: number; waitingMinutes: number };
  savings?: SavingsConfig;
  // Backwards compatibility alias for DEC-001 if needed
  modelChains?: {
    hard: string[];
    easy: string[];
  };
  runTimeoutHours?: number;
  chat?: ChatConfig;
  notifications?: {
    desktop: boolean;
  };
}

export type ChatMode = 'safe' | 'full';

export interface ChatSession {
  id: string;
  projectId?: string | null;
  title: string;
  mode: ChatMode;
  busy: boolean;
  model?: string;
  updatedAt: string;
  lastMessage?: string | null;
}

export type ChatMessageRole = 'user' | 'assistant' | 'tool' | 'error';

export interface ChatMessageMeta {
  name?: string;
  summary?: string;
  durationMs?: number;
  costUsd?: number;
  numTurns?: number;
  error?: string;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  content: string;
  meta?: ChatMessageMeta | null;
  createdAt: string;
}

export interface CreateChatSessionInput {
  projectId?: string | null;
  title?: string;
  mode?: ChatMode;
  model?: string;
}

export interface UpdateChatSessionInput {
  title: string;
}

export interface SendMessageResponse {
  userMessageId: string;
  assistantMessageId: string;
}

export interface ChatConfig {
  allowFullMode?: boolean;
  disableToolSearch?: boolean;
  claudeBin?: string;
  resolvedClaudeBin?: string | null;
  claudeVersion?: string | null;
  maxConcurrent?: number;
  idleTimeoutSec?: number;
  model?: '' | 'sonnet' | 'haiku';
}

export interface CreateProjectInput {
  name: string;
  path: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
}

export interface UpdateProjectInput {
  name?: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
}

export interface CreateProfileInput {
  name: string;
}

export interface VersionResponse {
  version: string;
  webBuildId?: string;
}

export interface LoginSessionResponse {
  sessionId: string;
}

export interface CheckProfileResponse {
  started?: boolean;
  ok?: boolean;
  message?: string;
  output?: string;
  email?: string | null;
  durationMs?: number;
  model?: string;
  error?: string;
}

export interface CreateTaskInput {
  project: string;
  slug: string;
  title: string;
  body?: string;
  level: TaskLevel;
  dependsOn?: string[];
  baseRef?: string;
  branch?: string;
  modelChain?: string[];
  start?: boolean;
}

export interface ReviewTaskInput {
  verdict: 'approved' | 'changes_requested';
  feedback?: string;
}

export interface RetryTaskInput {
  note?: string;
}

export interface UpdateTaskInput {
  modelChain?: string[];
  dependsOn?: string[];
  level?: TaskLevel;
  title?: string;
  body?: string;
  appendBody?: string;
}
