import type { BrainConfig } from '../config.js';
import { projectSettings } from '../projects/settings.js';

export type BrainEngine = 'claude' | 'codex';

export function effectiveBrainEngine(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'engine'>,
): BrainEngine {
  const configured = projectSettings(project).brain.engine;
  return configured === 'inherit' ? (global.engine || 'claude') : configured;
}

export function effectiveBrainCodexProfile(
  project: { settings?: string | null } | null | undefined,
  global: Pick<BrainConfig, 'codexProfile'>,
): string | undefined {
  return projectSettings(project).brain.codexProfile || global.codexProfile;
}
