import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentHubConfig } from './config.js';
import type { CiRepo, CiRunRow, ProjectRepo, ProjectRow } from './db/index.js';
import { projectSettings } from './projects/settings.js';
import type { EventBus } from './scheduler/index.js';

const execFileAsync = promisify(execFile);

export interface GitHubRemoteInfo {
  owner: string;
  repo: string;
}

/**
 * Parses GitHub repository owner and repo name from remote URL.
 * Supports https, http, git@, and ssh://git@ formats.
 * Returns null if not a GitHub URL.
 */
export function parseGitHubRemote(url?: string | null): GitHubRemoteInfo | null {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  const match = trimmed.match(
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?$/,
  );
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

export async function defaultGetGitRemoteUrl(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath,
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

export interface GitHubJobAnnotation {
  path?: string;
  start_line?: number;
  end_line?: number;
  annotation_level?: string;
  message: string;
  title?: string;
  raw_details?: string;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string;
  annotations?: GitHubJobAnnotation[];
}

export interface GitHubRunItem {
  id: number;
  name: string;
  head_sha: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  updated_at: string;
  created_at: string;
}

export interface CiWatchServiceOptions {
  config: AgentHubConfig;
  projectRepo: ProjectRepo;
  ciRepo: CiRepo;
  eventBus: EventBus;
  fetchFn?: typeof fetch;
  getGitRemoteUrl?: (repoPath: string) => Promise<string | null>;
  now?: () => number;
  pollIntervalMs?: number; // check loop frequency, default 30s
}

export class CiWatchService {
  private config: AgentHubConfig;
  private projectRepo: ProjectRepo;
  private ciRepo: CiRepo;
  private eventBus: EventBus;
  private fetchFn: typeof fetch;
  private getGitRemoteUrl: (repoPath: string) => Promise<string | null>;
  private now: () => number;

  private pollLoopTimer?: NodeJS.Timeout;
  private started = false;

  private etagMap = new Map<string, string>();
  private lastPolledAt = new Map<string, number>();
  private activeRunsByProject = new Map<string, boolean>();
  private remoteCache = new Map<string, GitHubRemoteInfo | null>();
  private cachedRuns = new Map<string, GitHubRunItem[]>();

  // Rate limiting state
  private rateLimitRemaining = Infinity;
  private rateLimitReset = 0; // epoch seconds

  constructor(opts: CiWatchServiceOptions) {
    this.config = opts.config;
    this.projectRepo = opts.projectRepo;
    this.ciRepo = opts.ciRepo;
    this.eventBus = opts.eventBus;
    this.fetchFn = opts.fetchFn || globalThis.fetch;
    this.getGitRemoteUrl = opts.getGitRemoteUrl || defaultGetGitRemoteUrl;
    this.now = opts.now || (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    // Initial check
    this.checkAllProjects().catch(() => {});
    // Polling loop: every 30 seconds check which projects are due
    this.pollLoopTimer = setInterval(() => {
      this.checkAllProjects().catch(() => {});
    }, 30_000);
    this.pollLoopTimer.unref?.();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.pollLoopTimer) {
      clearInterval(this.pollLoopTimer);
      this.pollLoopTimer = undefined;
    }
  }

  getRateLimitState(): { remaining: number; resetAtSec: number } {
    return {
      remaining: this.rateLimitRemaining,
      resetAtSec: this.rateLimitReset,
    };
  }

  /**
   * Resolves whether CI is enabled for a project and what branch to check.
   */
  async getProjectCiConfig(project: ProjectRow): Promise<{
    enabled: boolean;
    branch: string;
    remote: GitHubRemoteInfo | null;
  }> {
    let remote = this.remoteCache.get(project.id);
    if (remote === undefined) {
      const url = await this.getGitRemoteUrl(project.path);
      remote = parseGitHubRemote(url);
      this.remoteCache.set(project.id, remote);
    }

    const settings = projectSettings(project);
    const isGitHub = remote !== null;
    const enabled = settings.ci?.enabled !== undefined ? settings.ci.enabled : isGitHub;
    const branch = settings.ci?.branch || project.defaultBranch || 'main';

    return { enabled: enabled && isGitHub, branch, remote };
  }

  /**
   * Checks all registered projects and polls if due.
   */
  async checkAllProjects(): Promise<void> {
    const projects = this.projectRepo.getAll();
    for (const project of projects) {
      try {
        await this.pollProjectIfDue(project);
      } catch {
        // Individual project polling errors shouldn't crash the loop
      }
    }
  }

  private isDue(projectId: string): boolean {
    const last = this.lastPolledAt.get(projectId) || 0;
    const hasActiveRun = this.activeRunsByProject.get(projectId) ?? false;
    const interval = hasActiveRun ? 3 * 60 * 1000 : 15 * 60 * 1000;
    return this.now() - last >= interval;
  }

  async pollProjectIfDue(project: ProjectRow): Promise<CiRunRow | null> {
    if (!this.isDue(project.id)) {
      return null;
    }
    return this.pollProject(project.id);
  }

  /**
   * Force poll a project by ID.
   */
  async pollProject(projectId: string): Promise<CiRunRow | null> {
    const project = this.projectRepo.get(projectId);
    if (!project) return null;

    const { enabled, branch, remote } = await this.getProjectCiConfig(project);
    if (!enabled || !remote) {
      return null;
    }

    // Check rate limit
    const nowSec = Math.floor(this.now() / 1000);
    if (this.rateLimitRemaining <= 0 && nowSec < this.rateLimitReset) {
      return null;
    }

    const token = this.getToken();
    const url = `https://api.github.com/repos/${remote.owner}/${remote.repo}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=5`;

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AgentHub-CI-Watch',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const cachedEtag = this.etagMap.get(url);
    if (cachedEtag) {
      headers['If-None-Match'] = cachedEtag;
    }

    this.lastPolledAt.set(projectId, this.now());

    let response: Response;
    try {
      response = await this.fetchFn(url, { headers });
    } catch {
      return null;
    }

    this.updateRateLimit(response.headers);

    let runs: GitHubRunItem[] = [];

    if (response.status === 304) {
      // Not modified; use cached runs if available
      runs = this.cachedRuns.get(url) || [];
    } else if (response.ok) {
      const etag = response.headers.get('etag');
      if (etag) {
        this.etagMap.set(url, etag);
      }
      try {
        const body = (await response.json()) as { workflow_runs?: GitHubRunItem[] };
        runs = body.workflow_runs || [];
        this.cachedRuns.set(url, runs);
      } catch {
        return null;
      }
    } else {
      return null;
    }

    // Determine if any run is currently active (in_progress, queued, requested, waiting)
    const hasActiveRun = runs.some((r) => r.status !== 'completed');
    this.activeRunsByProject.set(projectId, hasActiveRun);

    // Process completed runs (newest first)
    let latestSaved: CiRunRow | null = null;
    for (const run of runs) {
      if (run.status !== 'completed') {
        continue;
      }

      // Check if already processed
      const existing = this.ciRepo.get(projectId, run.id);
      if (existing) {
        continue;
      }

      const saved = await this.processCompletedRun(projectId, remote, run, token);
      if (!latestSaved) {
        latestSaved = saved;
      }
    }

    return latestSaved;
  }

  private async processCompletedRun(
    projectId: string,
    remote: GitHubRemoteInfo,
    run: GitHubRunItem,
    token: string | null,
  ): Promise<CiRunRow> {
    const previousLatest = this.ciRepo.getLatest(projectId);
    const wasPreviousFailed = previousLatest?.conclusion === 'failure';

    let failedJobsWithAnnotations: GitHubJob[] = [];
    const allFailureAnnotations: GitHubJobAnnotation[] = [];

    if (run.conclusion === 'failure') {
      failedJobsWithAnnotations = await this.fetchFailedJobsAndAnnotations(remote, run.id, token);
      for (const job of failedJobsWithAnnotations) {
        if (job.annotations) {
          allFailureAnnotations.push(...job.annotations);
        }
      }
    }

    const row = this.ciRepo.insert({
      projectId,
      runId: run.id,
      workflow: run.name || 'CI',
      sha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      jobs: JSON.stringify(failedJobsWithAnnotations),
      completedAt: run.updated_at || new Date(this.now()).toISOString(),
      url: run.html_url,
    });

    if (run.conclusion === 'failure') {
      // Emit ci.failed once
      this.eventBus.emit('ci.failed', projectId, {
        projectId,
        runId: run.id,
        workflow: run.name || 'CI',
        sha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
        jobs: failedJobsWithAnnotations,
        annotations: allFailureAnnotations.slice(0, 20),
        url: run.html_url,
      });
    } else if (run.conclusion === 'success') {
      this.eventBus.emit('ci.passed', projectId, {
        projectId,
        runId: run.id,
        workflow: run.name || 'CI',
        sha: run.head_sha,
        status: run.status,
        conclusion: run.conclusion,
        jobs: [],
        annotations: [],
        url: run.html_url,
        previousConclusion: previousLatest?.conclusion ?? null,
        recoveredFromFailure: wasPreviousFailed,
      });
    }

    return row;
  }

  private async fetchFailedJobsAndAnnotations(
    remote: GitHubRemoteInfo,
    runId: number,
    token: string | null,
  ): Promise<GitHubJob[]> {
    const jobsUrl = `https://api.github.com/repos/${remote.owner}/${remote.repo}/actions/runs/${runId}/jobs`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AgentHub-CI-Watch',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await this.fetchFn(jobsUrl, { headers });
      this.updateRateLimit(res.headers);
      if (!res.ok) return [];

      const body = (await res.json()) as { jobs?: GitHubJob[] };
      const jobs = body.jobs || [];
      const failed = jobs.filter((j) => j.conclusion === 'failure');

      const result: GitHubJob[] = [];
      for (const job of failed) {
        const annotations = await this.fetchJobAnnotations(remote, job.id, token);
        result.push({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          html_url: job.html_url,
          annotations,
        });
      }
      return result;
    } catch {
      return [];
    }
  }

  private async fetchJobAnnotations(
    remote: GitHubRemoteInfo,
    jobId: number,
    token: string | null,
  ): Promise<GitHubJobAnnotation[]> {
    const annUrl = `https://api.github.com/repos/${remote.owner}/${remote.repo}/check-runs/${jobId}/annotations`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'AgentHub-CI-Watch',
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const res = await this.fetchFn(annUrl, { headers });
      this.updateRateLimit(res.headers);
      if (!res.ok) return [];

      const list = (await res.json()) as GitHubJobAnnotation[];
      if (!Array.isArray(list)) return [];
      // Filter failure level
      return list.filter(
        (a) => a.annotation_level === 'failure' || (a as { level?: string }).level === 'failure',
      );
    } catch {
      return [];
    }
  }

  private updateRateLimit(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      const parsed = parseInt(remaining, 10);
      if (!isNaN(parsed)) {
        this.rateLimitRemaining = parsed;
      }
    }
    const reset = headers.get('x-ratelimit-reset');
    if (reset !== null) {
      const parsed = parseInt(reset, 10);
      if (!isNaN(parsed)) {
        this.rateLimitReset = parsed;
      }
    }
  }

  private getToken(): string | null {
    const token =
      process.env.GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      (this.config as unknown as { githubToken?: string }).githubToken;
    return token ? token.trim() : null;
  }
}
