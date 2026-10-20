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

export type EngineType = 'agy' | 'codex' | 'claude';

export type ProfileKind = 'keyring' | 'isolated' | 'codex' | 'system';

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
  claudePlan?: string;
}

export interface ProjectHooks {
  onWorktreeRemoved?: string[];
}

export interface ProjectMerge {
  enabled: boolean;
  worktrees: Record<string, string>;
  checks: string[];
  timeoutSec: number;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  envTemplate?: string | null;
  maxParallel: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | string | null;
  hooks?: ProjectHooks | string | null;
  merge?: ProjectMerge | string | null;
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

export type WaitReason = 'disk' | 'quota' | 'parallel' | 'profile_busy' | null;

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
  waitReason?: WaitReason;
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
  currentRun?: {
    startedAt: string;
    lastOutputAt: string;
    lastActivityAt: string;
    activitySource: 'log' | 'conversation' | 'worktree';
    noCommitMinutes?: number | null;
    isLooping?: boolean;
    loopingCommand?: string | null;
  } | null;
  checks?: CheckResult[];
  sourceRef?: { taskId: string; runId?: string | null; checkName?: string | null; excerptHash: string } | null;
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
  sourceRef?: { taskId: string; runId?: string | null; checkName?: string | null; excerptHash: string } | null;
  derivedTasks?: Task[];
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
  // Stall & looping detection
  noCommitMinutes?: number | null;
  isLooping?: boolean;
  loopingCommand?: string | null;
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

export interface TaskNote {
  id: number;
  projectId: string;
  taskId: string;
  kind: 'note' | 'overlap';
  content: string;
  createdAt: string;
}

export interface HubStatus {
  tasks: Record<string, number>;
  profiles?: Profile[];
  running: RunningWorker[];
  overlaps?: TaskNote[];
  brain?: BrainStatus;
  disk?: {
    freeGB: number;
    totalGB: number;
    minFreeGB?: number;
  };
  disks?: Array<{
    path: string;
    label: string;
    freeGB: number;
    totalGB: number;
    minFreeGB: number;
    low: boolean;
    source: 'worktrees' | 'extra';
  }>;
  load?: {
    load1: number;
    freeMemGB: number;
    overloaded: boolean;
    recoveringSince: number | null;
  };
  // Backwards compatibility aliases
  tasksByStatus?: Record<TaskStatus, number>;
  runningWorkers?: RunningWorker[];
  recentEvents?: EventItem[];
  tasksByProject?: Record<string, Record<string, number>>;
}

export interface OrphanProcess {
  pid: number;
  cwd: string;
  cpu: number;
  rss: number;
  task: { id: string; title: string; status: string } | null;
  active: boolean;
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

export interface ProfileQuotaInfo {
  gemini5h: number | null;
  geminiWeek: number | null;
  claude5h: number | null;
  claudeWeek: number | null;
}

export interface DayMetric {
  runs: number;
  durationMs: number;
  tokens: number;
}

export interface DailyProfileSummary {
  name: string;
  engine: 'agy' | 'codex';
  enabled: boolean;
  isIdle: boolean;
  idleReason?: string;
  quota: ProfileQuotaInfo;
  quotaUsage: QuotaUsageItem[];
  today: DayMetric;
  totals: DayMetric;
  daily: Record<string, DayMetric>;
}

export interface DailyUsageDayProfile extends DayMetric {
  profileName: string;
  engine: 'agy' | 'codex';
  isIdle: boolean;
  quota: ProfileQuotaInfo;
}

export interface DailyUsageDay {
  date: string;
  isToday: boolean;
  totalRuns: number;
  totalDurationMs: number;
  totalTokens: number;
  profiles: DailyUsageDayProfile[];
}

export interface DailyUsageReport {
  days: number;
  timezone: string;
  dates: string[];
  profiles: DailyProfileSummary[];
  byDay: DailyUsageDay[];
}

export interface SystemConfig {
  modelChainHard: string[];
  modelChainEasy: string[];
  defaultTimeout: number;
  slotsPerAgyProfile?: number;
  slotsPerCodexProfile?: number;
  watchdog?: { stallMinutes: number; waitingMinutes: number };
  stall?: { noCommitMin: number; loopThreshold: number };
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
  load?: {
    enabled: boolean;
    high: number;
    ok: number;
    minFreeMemGB: number;
    recoverAfterSec: number;
  };
}

export type ChatMode = 'safe' | 'full';

export interface ChatSession {
  id: string;
  projectId?: string | null;
  title: string;
  mode: ChatMode;
  busy: boolean;
  state?: 'idle' | 'running' | 'waiting_permission' | 'error';
  model?: string;
  profileName?: string | null;
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
  retryText?: string;
}

export interface ChatPermissionRequest {
  id: string;
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'allow' | 'deny' | 'allow_always';
  message?: string | null;
  createdAt: string;
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
  profileName?: string | null;
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
  claudeProfile?: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
  hooks?: ProjectHooks | null;
  merge?: ProjectMerge | null;
}

export interface UpdateProjectInput {
  name?: string;
  defaultBranch?: string;
  envTemplate?: string | null;
  maxParallel?: number;
  checks?: Array<{ name: string; cmd: string[]; timeoutSec?: number }> | null;
  hooks?: ProjectHooks | null;
  merge?: ProjectMerge | null;
}

export interface CreateProfileInput {
  name: string;
  engine?: 'agy' | 'claude';
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

export interface CaptureTaskInput {
  sourceTaskId: string;
  runId?: string;
  checkName?: string;
  excerpt: string;
  slug: string;
  title?: string;
  body?: string;
  level: TaskLevel;
  start?: boolean;
}

export interface ReviewTaskInput {
  verdict: 'approved' | 'changes_requested';
  feedback?: string;
  merge?: boolean;
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
