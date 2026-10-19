import fs from 'node:fs';
import os from 'node:os';

export interface LoadConfig {
  enabled: boolean;
  high: number;
  ok: number;
  minFreeMemGB: number;
  recoverAfterSec: number;
}

export interface LoadSnapshot {
  load1: number;
  freeMemGB: number;
  overloaded: boolean;
  recoveringSince: number | null;
}

export interface LoadGuardOptions {
  readLoad?: () => number;
  readFreeMemBytes?: () => number;
  now?: () => number;
}

export const DEFAULT_LOAD_CONFIG: LoadConfig = {
  enabled: false,
  high: 16,
  ok: 11,
  minFreeMemGB: 1.5,
  recoverAfterSec: 300,
};

function readFreeMemBytes(): number {
  try {
    const line = fs.readFileSync('/proc/meminfo', 'utf8').split('\n').find((entry) => entry.startsWith('MemAvailable:'));
    const kilobytes = line ? Number.parseInt(line.replace(/[^0-9]/g, ''), 10) : Number.NaN;
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : os.freemem();
  } catch {
    return os.freemem();
  }
}

export class LoadGuard {
  private overloaded = false;
  private recoveringSince: number | null = null;
  private snapshot: LoadSnapshot = { load1: 0, freeMemGB: 0, overloaded: false, recoveringSince: null };

  constructor(private config: LoadConfig, private options: LoadGuardOptions = {}) {}

  setConfig(config: LoadConfig): void { this.config = config; }

  update(): LoadSnapshot {
    const now = (this.options.now || Date.now)();
    const load1 = (this.options.readLoad || (() => os.loadavg()[0]))();
    const freeMemGB = (this.options.readFreeMemBytes || readFreeMemBytes)() / (1024 ** 3);
    const high = load1 > this.config.high || freeMemGB < this.config.minFreeMemGB;
    const ok = load1 < this.config.ok && freeMemGB > this.config.minFreeMemGB;

    if (!this.config.enabled) {
      this.overloaded = false;
      this.recoveringSince = null;
    } else if (!this.overloaded && high) {
      this.overloaded = true;
      this.recoveringSince = null;
    } else if (this.overloaded) {
      if (!ok) {
        this.recoveringSince = null;
      } else if (this.recoveringSince === null) {
        this.recoveringSince = now;
      } else if (now - this.recoveringSince >= this.config.recoverAfterSec * 1000) {
        this.overloaded = false;
        this.recoveringSince = null;
      }
    }

    this.snapshot = { load1, freeMemGB, overloaded: this.overloaded, recoveringSince: this.recoveringSince };
    return this.snapshot;
  }

  getStatus(): LoadSnapshot { return this.snapshot; }
  isOverloaded(): boolean { return this.overloaded; }
  effectiveParallel(maxParallel: number): number { return this.overloaded ? 1 : maxParallel; }
}
