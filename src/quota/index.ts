import { QuotaMarkRepo, ProfileRepo } from '../db/index.js';

export class QuotaService {
  constructor(
    private quotaMarkRepo: QuotaMarkRepo,
    private profileRepo: ProfileRepo,
  ) {}

  /**
   * Mark a profile (and same-email profiles) as quota exhausted
   */
  mark(profileName: string, family: string, resetSeconds: number, reason?: string): void {
    const until = Math.floor(Date.now() / 1000) + resetSeconds;
    this.quotaMarkRepo.mark(profileName, family, until, reason);

    // Propagate to profiles with same email
    const profile = this.profileRepo.get(profileName);
    if (profile?.email) {
      const allProfiles = this.profileRepo.getAll();
      for (const p of allProfiles) {
        if (p.name !== profileName && p.email === profile.email) {
          this.quotaMarkRepo.mark(p.name, family, until, reason);
        }
      }
    }
  }

  /**
   * Clear a quota mark
   */
  clear(profileName: string, family: string): void {
    this.quotaMarkRepo.clear(profileName, family);

    const profile = this.profileRepo.get(profileName);
    if (profile?.email) {
      for (const other of this.profileRepo.getAll()) {
        if (other.name !== profileName && other.email === profile.email) {
          this.quotaMarkRepo.clear(other.name, family);
        }
      }
    }
  }

  /**
   * Get all active quota marks
   */
  getActive() {
    return this.quotaMarkRepo.getActive();
  }

  /**
   * Check if a profile is exhausted for a given family
   */
  isExhausted(profileName: string, family: string): boolean {
    return this.quotaMarkRepo.isExhausted(profileName, family);
  }

  /**
   * Get expired marks (for scheduler to re-queue waiting_quota tasks)
   */
  cleanupExpired(): { profileName: string; family: string }[] {
    const all = this.quotaMarkRepo.getAll();
    const now = Math.floor(Date.now() / 1000);
    const expired: { profileName: string; family: string }[] = [];
    for (const m of all) {
      if (m.until <= now) {
        expired.push({ profileName: m.profileName, family: m.family });
        this.quotaMarkRepo.clear(m.profileName, m.family);
      }
    }
    return expired;
  }
}

/**
 * Get model family from a model string.
 * "claude-opus-4-6-thinking" → "claude"
 * "gemini-3.8-flash-high" → "gemini"
 * "codex:gpt-5.6-luna" → "codex"
 * "gpt-oss-120b-medium" → "gpt"
 */
export function getModelFamily(model: string): string {
  if (model.startsWith('codex:')) return 'codex';
  const idx = model.indexOf('-');
  return idx > 0 ? model.substring(0, idx) : model;
}

/**
 * Get the engine id for a model string.
 * Models starting with "codex:" use codex engine, everything else uses agy.
 */
export function getModelEngine(model: string): 'agy' | 'codex' {
  return model.startsWith('codex:') ? 'codex' : 'agy';
}
