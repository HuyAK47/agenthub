import type { BrainConfig } from '../config.js';
import { projectSettings, type ProjectSettings } from '../projects/settings.js';

export type EffectiveBrainMode = 'off' | 'suggest' | 'auto' | 'external';
export type BrainPermission = 'standard' | 'trusted' | 'full';

export function effectiveBrainPermission(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'permissions'>,
): BrainPermission {
  const permission = projectSettings(project).brain.permissions;
  return permission === 'inherit' ? global.permissions : permission;
}

/** Resolve a project's brain mode without ever parsing projects.settings at call sites. */
export function effectiveBrainMode(
  projectId: string | null,
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'mode'>,
): EffectiveBrainMode {
  if (projectId === null) return global.mode;
  const mode = projectSettings(project).brain.mode;
  return mode === 'inherit' ? global.mode : mode;
}

export function effectiveBrainModeFromSettings(settings: ProjectSettings, global: Pick<BrainConfig, 'mode'>): EffectiveBrainMode {
  return settings.brain.mode === 'inherit' ? global.mode : settings.brain.mode;
}
