import type Database from 'better-sqlite3';
import { parseDbTime } from './db/time.js';
import { calculateAgyTokens } from './savings.js';
import { getModelFamily } from './quota/index.js';
import { AgentHubConfig } from './config.js';
import {
  ProfileRepo,
  QuotaMarkRepo,
  QuotaUsageRepo,
  QuotaUsageRow,
  ProfileRow,
} from './db/index.js';
import { Scheduler } from './scheduler/index.js';

export const DAILY_USAGE_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Formats a timestamp (epoch ms, Date, or SQLite UTC string) into YYYY-MM-DD
 * in Asia/Ho_Chi_Minh timezone.
 */
export function formatHoChiMinhDate(dateOrEpoch: Date | number | string): string {
  const date =
    typeof dateOrEpoch === 'number' || dateOrEpoch instanceof Date
      ? new Date(dateOrEpoch)
      : new Date(parseDbTime(dateOrEpoch));

  if (Number.isNaN(date.getTime())) return '';

  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DAILY_USAGE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Returns an array of dates [today, yesterday, ..., daysAgo] formatted as YYYY-MM-DD
 * in Asia/Ho_Chi_Minh timezone.
 * When days = 7, returns today + 7 past days = 8 dates in total.
 */
export function getDailyDateList(days = 7, now: Date | number = new Date()): string[] {
  const count = typeof days === 'number' && days > 0 ? days : 7;
  const nowDate = typeof now === 'number' ? new Date(now) : now;
  const todayStr = formatHoChiMinhDate(nowDate);

  if (!todayStr) return [];

  const [yearStr, monthStr, dayStr] = todayStr.split('-');
  const y = parseInt(yearStr, 10);
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);

  const dates: string[] = [];
  for (let i = 0; i <= count; i++) {
    // Generate each calendar day via UTC date to avoid any local DST or offset quirks
    const utcDate = new Date(Date.UTC(y, m - 1, d - i, 12, 0, 0));
    dates.push(formatHoChiMinhDate(utcDate));
  }

  return dates;
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
  quotaUsage: QuotaUsageRow[];
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

export interface DailyUsageOptions {
  days?: number;
  db: Database.Database;
  profileRepo?: ProfileRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  usageRepo?: QuotaUsageRepo;
  scheduler?: Scheduler;
  config?: AgentHubConfig;
  now?: Date | number;
}

interface RunRowWithMetrics {
  runId: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  tokensUsed: number | null;
  usageBefore: number | null;
  usageAfter: number | null;
  metricDurationMs: number | null;
}

/**
 * Extracts structured quota remaining percentages from raw quota usage rows.
 */
export function extractProfileQuota(usageRows: QuotaUsageRow[]): ProfileQuotaInfo {
  let gemini5h: number | null = null;
  let geminiWeek: number | null = null;
  let claude5h: number | null = null;
  let claudeWeek: number | null = null;

  for (const row of usageRows) {
    const grpLower = row.grp.toLowerCase();
    const isGemini = grpLower.includes('gemini');
    const isClaudeOrGpt = grpLower.includes('claude') || grpLower.includes('gpt');

    if (isGemini) {
      if (row.window === '5h') gemini5h = row.remainingPct;
      if (row.window === 'week') geminiWeek = row.remainingPct;
    } else if (isClaudeOrGpt) {
      if (row.window === '5h') claude5h = row.remainingPct;
      if (row.window === 'week') claudeWeek = row.remainingPct;
    }
  }

  return { gemini5h, geminiWeek, claude5h, claudeWeek };
}

/**
 * Determines whether a profile is considered "idle" (đang rảnh)
 * based on high quota and low workload today.
 */
export function isProfileSuggestedIdle(params: {
  profile: ProfileRow;
  quota: ProfileQuotaInfo;
  hasQuotaMarks: boolean;
  isBusy: boolean;
  todayRuns: number;
  todayTokens: number;
}): { isIdle: boolean; reason?: string } {
  const { profile, quota, hasQuotaMarks, isBusy, todayRuns } = params;

  if (!profile.enabled) {
    return { isIdle: false, reason: 'Tài khoản đang bị tắt' };
  }
  if (hasQuotaMarks) {
    return { isIdle: false, reason: 'Đang bị khóa quota' };
  }
  if (isBusy) {
    return { isIdle: false, reason: 'Đang chạy tác vụ' };
  }

  // Workload check: todayRuns <= 1 is considered low workload
  const isLowWorkload = todayRuns <= 1;
  if (!isLowWorkload) {
    return { isIdle: false, reason: 'Hôm nay đã chạy nhiều tác vụ' };
  }

  // Quota check
  if (profile.engine === 'codex') {
    // Codex does not have quota_usage table; if not locked and not busy with low runs, it is idle
    return { isIdle: true, reason: 'Codex sẵn sàng, ít việc hôm nay' };
  }

  // For agy:
  const hasUsageData =
    quota.gemini5h != null ||
    quota.geminiWeek != null ||
    quota.claude5h != null ||
    quota.claudeWeek != null;

  if (!hasUsageData) {
    // No quota recorded yet -> assume fresh/idle
    return { isIdle: true, reason: 'Chưa dùng quota, ít việc hôm nay' };
  }

  // Plenty of quota if either Gemini 5h >= 50% or Claude 5h >= 50%
  const geminiAvailable = quota.gemini5h == null || quota.gemini5h >= 50;
  const claudeAvailable = quota.claude5h == null || quota.claude5h >= 50;

  if (geminiAvailable || claudeAvailable) {
    const reasons: string[] = [];
    if (quota.gemini5h != null) reasons.push(`Gemini ${quota.gemini5h}%`);
    if (quota.claude5h != null) reasons.push(`Claude ${quota.claude5h}%`);
    const qStr = reasons.length > 0 ? reasons.join(', ') : 'Quota dồi dào';
    return { isIdle: true, reason: `${qStr} · ${todayRuns} run hôm nay` };
  }

  return { isIdle: false, reason: 'Quota còn lại dưới 50%' };
}

/**
 * Computes the daily usage report across the requested days for all profiles.
 */
export function getDailyUsageReport(options: DailyUsageOptions): DailyUsageReport {
  const { db, days = 7, config, scheduler, now = new Date() } = options;
  const dates = getDailyDateList(days, now);
  const datesSet = new Set(dates);
  const todayDate = dates[0] || formatHoChiMinhDate(now);

  // 1. Fetch all profiles
  const profileRepo = options.profileRepo ?? new ProfileRepo(db);
  const profiles: ProfileRow[] = profileRepo.getAll();

  // 2. Fetch quota marks (active locks)
  const quotaMarkRepo = options.quotaMarkRepo ?? new QuotaMarkRepo(db);
  const quotaMarks = quotaMarkRepo.getActive();

  const activeMarksMap = new Map<string, Array<{ profileName: string; family: string }>>();
  for (const mark of quotaMarks) {
    if (!activeMarksMap.has(mark.profileName)) {
      activeMarksMap.set(mark.profileName, []);
    }
    activeMarksMap.get(mark.profileName)!.push(mark);
  }

  // 3. Fetch all quota usage rows
  const usageRepo = options.usageRepo ?? new QuotaUsageRepo(db);
  const allUsageRows: QuotaUsageRow[] = usageRepo.getAll();

  const usageByProfile = new Map<string, QuotaUsageRow[]>();
  for (const row of allUsageRows) {
    if (!usageByProfile.has(row.profileName)) {
      usageByProfile.set(row.profileName, []);
    }
    usageByProfile.get(row.profileName)!.push(row);
  }

  // 4. Check currently running slots from scheduler
  const runningMap = scheduler?.getRunning();
  const busyProfiles = new Set<string>();
  if (runningMap) {
    for (const r of runningMap.values()) {
      busyProfiles.add(r.profileName);
    }
  }

  // 5. Query runs joined with run_metrics
  const runsWithMetrics = db
    .prepare(
      `SELECT
        r.id as runId,
        r.taskId,
        r.engine,
        r.model,
        r.profileName,
        r.startedAt,
        r.endedAt,
        r.outcome,
        m.tokensUsed,
        m.usageBefore,
        m.usageAfter,
        m.durationMs as metricDurationMs
      FROM runs r
      LEFT JOIN run_metrics m ON r.id = m.runId
      ORDER BY r.startedAt ASC`,
    )
    .all() as RunRowWithMetrics[];

  // Profile -> Date -> DayMetric
  const profileDailyMetrics = new Map<string, Map<string, DayMetric>>();
  for (const p of profiles) {
    const dayMap = new Map<string, DayMetric>();
    for (const d of dates) {
      dayMap.set(d, { runs: 0, durationMs: 0, tokens: 0 });
    }
    profileDailyMetrics.set(p.name, dayMap);
  }

  const bucketTokensGemini = config?.savings?.bucketTokens?.gemini ?? 5_000_000;
  const bucketTokensClaude = config?.savings?.bucketTokens?.claude ?? 5_000_000;

  for (const row of runsWithMetrics) {
    const timestampStr = row.endedAt || row.startedAt;
    if (!timestampStr) continue;

    const dateStr = formatHoChiMinhDate(timestampStr);
    if (!datesSet.has(dateStr)) continue;

    let dayMap = profileDailyMetrics.get(row.profileName);
    if (!dayMap) {
      dayMap = new Map<string, DayMetric>();
      for (const d of dates) {
        dayMap.set(d, { runs: 0, durationMs: 0, tokens: 0 });
      }
      profileDailyMetrics.set(row.profileName, dayMap);
    }

    let metric = dayMap.get(dateStr);
    if (!metric) {
      metric = { runs: 0, durationMs: 0, tokens: 0 };
      dayMap.set(dateStr, metric);
    }

    metric.runs += 1;

    // Calculate duration
    let dur = 0;
    if (row.metricDurationMs != null && row.metricDurationMs >= 0) {
      dur = row.metricDurationMs;
    } else if (row.startedAt && row.endedAt) {
      dur = Math.max(0, parseDbTime(row.endedAt) - parseDbTime(row.startedAt));
    }
    metric.durationMs += dur;

    // Calculate tokens
    let runTokens = 0;
    if (row.tokensUsed != null && row.tokensUsed >= 0) {
      runTokens = row.tokensUsed;
    } else if (row.usageBefore != null && row.usageAfter != null) {
      const family = getModelFamily(row.model);
      const bucket = family === 'gemini' ? bucketTokensGemini : bucketTokensClaude;
      const agyCalc = calculateAgyTokens({
        usageBefore: row.usageBefore,
        usageAfter: row.usageAfter,
        bucketTokens: bucket,
      });
      runTokens = agyCalc.tokens;
    }
    metric.tokens += runTokens;
  }

  // 6. Build DailyProfileSummary list
  const profileSummaries: DailyProfileSummary[] = profiles.map((p) => {
    const usageRows = usageByProfile.get(p.name) || [];
    const quota = extractProfileQuota(usageRows);
    const hasQuotaMarks = (activeMarksMap.get(p.name) || []).length > 0;
    const isBusy = busyProfiles.has(p.name);

    const dayMap = profileDailyMetrics.get(p.name)!;
    const dailyRecord: Record<string, DayMetric> = {};

    let totalRuns = 0;
    let totalDurationMs = 0;
    let totalTokens = 0;

    for (const d of dates) {
      const m = dayMap.get(d) || { runs: 0, durationMs: 0, tokens: 0 };
      dailyRecord[d] = { ...m };
      totalRuns += m.runs;
      totalDurationMs += m.durationMs;
      totalTokens += m.tokens;
    }

    const todayMetric = dailyRecord[todayDate] || { runs: 0, durationMs: 0, tokens: 0 };

    const idleInfo = isProfileSuggestedIdle({
      profile: p,
      quota,
      hasQuotaMarks,
      isBusy,
      todayRuns: todayMetric.runs,
      todayTokens: todayMetric.tokens,
    });

    return {
      name: p.name,
      engine: (p.engine === 'codex' ? 'codex' : 'agy') as 'agy' | 'codex',
      enabled: Boolean(p.enabled),
      isIdle: idleInfo.isIdle,
      idleReason: idleInfo.reason,
      quota,
      quotaUsage: usageRows,
      today: todayMetric,
      totals: {
        runs: totalRuns,
        durationMs: totalDurationMs,
        tokens: totalTokens,
      },
      daily: dailyRecord,
    };
  });

  // 7. Build byDay view
  const byDay: DailyUsageDay[] = dates.map((dateStr) => {
    let dayTotalRuns = 0;
    let dayTotalDurationMs = 0;
    let dayTotalTokens = 0;

    const dayProfiles: DailyUsageDayProfile[] = profileSummaries.map((ps) => {
      const metric = ps.daily[dateStr] || { runs: 0, durationMs: 0, tokens: 0 };
      dayTotalRuns += metric.runs;
      dayTotalDurationMs += metric.durationMs;
      dayTotalTokens += metric.tokens;

      return {
        profileName: ps.name,
        engine: ps.engine,
        runs: metric.runs,
        durationMs: metric.durationMs,
        tokens: metric.tokens,
        isIdle: ps.isIdle,
        quota: ps.quota,
      };
    });

    return {
      date: dateStr,
      isToday: dateStr === todayDate,
      totalRuns: dayTotalRuns,
      totalDurationMs: dayTotalDurationMs,
      totalTokens: dayTotalTokens,
      profiles: dayProfiles,
    };
  });

  return {
    days: dates.length - 1, // e.g. 7
    timezone: DAILY_USAGE_TIMEZONE,
    dates,
    profiles: profileSummaries,
    byDay,
  };
}
