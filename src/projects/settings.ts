import { z } from 'zod';

/**
 * Per-project behaviour switches, stored as JSON in `projects.settings`.
 *
 * Every section has defaults that reproduce the hub's behaviour before the setting existed, so a
 * project without settings (or with an older, partial JSON) behaves exactly as before. Features
 * read settings only through `projectSettings()`, never by parsing the column themselves.
 */

const ReferenceSchema = z.object({
  /** Short id used in prompts and env vars (AGENTHUB_REF_<NAME>). */
  name: z.string().min(1).max(40).regex(/^[a-zA-Z0-9_-]+$/),
  /** Absolute path to a directory or repo the worker may read but must not modify. */
  path: z.string().min(1),
  /** Inline a small text file (conventions, glossary) into the worker context instead of only listing it. */
  inject: z.boolean().default(false),
});

export const ProjectSettingsSchema = z.object({
  brain: z.object({
    /**
     * Who coordinates this project:
     * - inherit: follow the global `brain.mode`
     * - off / suggest / auto: the hub's resident brain for this project, as for the global modes
     * - external: an outside Claude (e.g. VS Code via MCP) owns planning and review; the hub's brain
     *   ignores this project's events and only notifies.
     */
    mode: z.enum(['inherit', 'off', 'suggest', 'auto', 'external']).default('inherit'),
    permissions: z.enum(['inherit', 'standard', 'trusted', 'full']).default('inherit'),
    /** Overrides the global limits for this project's brain; unset = global value. */
    dailyTokenBudget: z.number().int().min(0).optional(),
    maxTurnsPerHour: z.number().int().positive().optional(),
  }).default({}),
  worktree: z.object({
    /** auto: prepare node_modules when a lockfile exists (previous behaviour); skip: never install. */
    install: z.enum(['auto', 'skip']).default('auto'),
    /** run: git hooks (husky, commitlint…) run on worker commits; skip: workers commit with hooks disabled. */
    gitHooks: z.enum(['run', 'skip']).default('run'),
  }).default({}),
  integration: z.object({
    /** When enabled, approved tasks merge into a local integration branch the hub manages. */
    enabled: z.boolean().default(false),
    /** Local branch name, e.g. `agenthub/integration` or `anhdd/kb-portal-locale`. */
    branch: z.string().min(1).max(200).optional(),
    /** Branch/ref the integration branch starts from; defaults to the project's defaultBranch. */
    baseRef: z.string().min(1).max(200).optional(),
  }).default({}),
  /** Read-only material workers may consult (another repo, shared data, glossary). */
  references: z.array(ReferenceSchema).max(20).default([]),
  notifications: z.object({
    /** full: task titles and summaries in Telegram; minimal: only counts and links, no content. */
    telegramContent: z.enum(['full', 'minimal']).default('full'),
  }).default({}),
});

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** Input accepted by the API: every section and field optional; merged over the stored settings. */
export const ProjectSettingsInputSchema = z.object({
  brain: ProjectSettingsSchema.shape.brain.removeDefault().partial().optional(),
  worktree: ProjectSettingsSchema.shape.worktree.removeDefault().partial().optional(),
  integration: ProjectSettingsSchema.shape.integration.removeDefault().partial().optional(),
  references: z.array(ReferenceSchema).max(20).optional(),
  notifications: ProjectSettingsSchema.shape.notifications.removeDefault().partial().optional(),
});

export type ProjectSettingsInput = z.infer<typeof ProjectSettingsInputSchema>;

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = ProjectSettingsSchema.parse({});

/** Parse the stored column. Invalid or missing JSON yields defaults (never throws). */
export function parseProjectSettings(raw: string | null | undefined): ProjectSettings {
  if (!raw) return ProjectSettingsSchema.parse({});
  try {
    const result = ProjectSettingsSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : ProjectSettingsSchema.parse({});
  } catch {
    return ProjectSettingsSchema.parse({});
  }
}

/** Settings of a project row (or defaults when the row has none). */
export function projectSettings(project: { settings?: string | null } | null | undefined): ProjectSettings {
  return parseProjectSettings(project?.settings);
}

/** Merge a partial update over current settings, section by section; arrays are replaced. */
export function mergeProjectSettings(current: ProjectSettings, input: ProjectSettingsInput): ProjectSettings {
  return ProjectSettingsSchema.parse({
    brain: { ...current.brain, ...input.brain },
    worktree: { ...current.worktree, ...input.worktree },
    integration: { ...current.integration, ...input.integration },
    references: input.references ?? current.references,
    notifications: { ...current.notifications, ...input.notifications },
  });
}
