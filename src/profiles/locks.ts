import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { ProfileRow } from '../db/index.js';

const execFileAsync = promisify(execFile);

export interface ProfileSlots { slotsUsed: number; slotsTotal: number; busy: boolean; }

export interface SlotReservation {
  profileName: string;
  lockFile: string;
}

export class ProfileLockService {
  private cache = new Map<string, { at: number; value: ProfileSlots }>();
  private reservations = new Map<string, SlotReservation>();

  constructor(private stateDir: string, private agySlots = 2, private codexSlots = 2) { fs.mkdirSync(stateDir, { recursive: true }); }

  slotsTotal(profile: ProfileRow): number { return profile.engine === 'codex' ? this.codexSlots : this.agySlots; }
  lockPath(profile: ProfileRow, slot: number): string {
    if (profile.engine === 'codex' && profile.kind !== 'isolated') {
      return path.join(this.stateDir, `codex.lock${slot === 1 ? '' : slot}`);
    }
    return path.join(this.stateDir, `${profile.name}.lock${slot === 1 ? '' : slot}`);
  }

  private resKey(profileName: string, lockFile: string): string {
    return `${profileName}:${lockFile}`;
  }

  reserve(profile: ProfileRow | string, lockFile: string): void {
    const profileName = typeof profile === 'string' ? profile : profile.name;
    const key = this.resKey(profileName, lockFile);
    this.reservations.set(key, { profileName, lockFile });
    this.invalidate();
  }

  release(profile: ProfileRow | string, lockFile: string): void {
    const profileName = typeof profile === 'string' ? profile : profile.name;
    const key = this.resKey(profileName, lockFile);
    this.reservations.delete(key);
    this.invalidate();
  }

  isReserved(profile: ProfileRow | string, lockFile: string): boolean {
    const profileName = typeof profile === 'string' ? profile : profile.name;
    const key = this.resKey(profileName, lockFile);
    if (this.reservations.has(key)) return true;
    for (const r of this.reservations.values()) {
      if (r.lockFile === lockFile) return true;
    }
    return false;
  }

  getReservations(): SlotReservation[] {
    return Array.from(this.reservations.values());
  }

  clearReservations(): void {
    this.reservations.clear();
    this.invalidate();
  }

  async isLocked(file: string): Promise<boolean> {
    try { await execFileAsync('flock', ['-n', file, 'true']); return false; } catch { return true; }
  }
  isLockedSync(file: string): boolean {
    try { execFileSync('flock', ['-n', file, 'true'], { stdio: 'ignore' }); return false; } catch { return true; }
  }

  async isSlotBusy(profile: ProfileRow, slot: number): Promise<boolean> {
    const file = this.lockPath(profile, slot);
    if (this.isReserved(profile, file)) return true;
    return await this.isLocked(file);
  }

  isSlotBusySync(profile: ProfileRow, slot: number): boolean {
    const file = this.lockPath(profile, slot);
    if (this.isReserved(profile, file)) return true;
    return this.isLockedSync(file);
  }

  async getSlots(profile: ProfileRow): Promise<ProfileSlots> {
    const cached = this.cache.get(profile.name);
    if (cached && Date.now() - cached.at < 3000) return cached.value;
    const total = this.slotsTotal(profile);
    let slotsUsed = 0;
    for (let slot = 1; slot <= total; slot++) if (await this.isSlotBusy(profile, slot)) slotsUsed++;
    const value = { slotsUsed, slotsTotal: total, busy: slotsUsed >= total };
    this.cache.set(profile.name, { at: Date.now(), value });
    return value;
  }

  async findFreeSlot(profile: ProfileRow): Promise<number | null> {
    const total = this.slotsTotal(profile);
    for (let slot = 1; slot <= total; slot++) if (!(await this.isSlotBusy(profile, slot))) return slot;
    return null;
  }
  getSlotsSync(profile: ProfileRow): ProfileSlots {
    const cached = this.cache.get(profile.name);
    if (cached && Date.now() - cached.at < 3000) return cached.value;
    const total = this.slotsTotal(profile);
    let slotsUsed = 0;
    for (let slot = 1; slot <= total; slot++) if (this.isSlotBusySync(profile, slot)) slotsUsed++;
    const value = { slotsUsed, slotsTotal: total, busy: slotsUsed >= total };
    this.cache.set(profile.name, { at: Date.now(), value });
    return value;
  }
  findFreeSlotSync(profile: ProfileRow): number | null {
    const total = this.slotsTotal(profile);
    for (let slot = 1; slot <= total; slot++) if (!this.isSlotBusySync(profile, slot)) return slot;
    return null;
  }
  invalidate(profileName?: string): void { if (profileName) this.cache.delete(profileName); else this.cache.clear(); }
}
