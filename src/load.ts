import os from 'node:os';
import { getPlatform } from './platform/index.js';

export interface LoadConfig {
  enabled: boolean;
  high: number;
  ok: number;
  minFreeMemGB: number;
  recoverAfterSec: number;
  pausePolicy?: 'recent' | 'rss';
  maxAutoPaused?: number;
  autoPauseThresholdSec?: number;
}

export interface LoadSnapshot {
  load1: number;
  freeMemGB: number;
  overloaded: boolean;
  recoveringSince: number | null;
  highSince?: number | null;
  autoPauseTriggered?: boolean;
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
  pausePolicy: 'recent',
  maxAutoPaused: 2,
  autoPauseThresholdSec: 60,
};

function readFreeMemBytes(): number {
  return getPlatform().freeMemoryBytes();
}

export class LoadGuard {
  private overloaded = false;
  private recoveringSince: number | null = null;
  private highSince: number | null = null;
  private snapshot: LoadSnapshot = { load1: 0, freeMemGB: 0, overloaded: false, recoveringSince: null, highSince: null, autoPauseTriggered: false };

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
      this.highSince = null;
    } else if (!this.overloaded && high) {
      this.overloaded = true;
      this.recoveringSince = null;
      if (this.highSince === null) {
        this.highSince = now;
      }
    } else if (this.overloaded) {
      if (high) {
        if (this.highSince === null) {
          this.highSince = now;
        }
      } else {
        this.highSince = null;
      }

      if (!ok) {
        this.recoveringSince = null;
      } else if (this.recoveringSince === null) {
        this.recoveringSince = now;
      } else if (now - this.recoveringSince >= this.config.recoverAfterSec * 1000) {
        this.overloaded = false;
        this.recoveringSince = null;
      }
    }

    const autoPauseThresholdMs = (this.config.autoPauseThresholdSec ?? 60) * 1000;
    const autoPauseTriggered = Boolean(
      this.config.enabled && this.highSince !== null && now - this.highSince >= autoPauseThresholdMs,
    );

    this.snapshot = {
      load1,
      freeMemGB,
      overloaded: this.overloaded,
      recoveringSince: this.recoveringSince,
      highSince: this.highSince,
      autoPauseTriggered,
    };
    return this.snapshot;
  }

  getStatus(): LoadSnapshot { return this.snapshot; }
  isOverloaded(): boolean { return this.overloaded; }
  isAutoPauseTriggered(): boolean { return Boolean(this.snapshot.autoPauseTriggered); }
  effectiveParallel(maxParallel: number): number { return this.overloaded ? 1 : maxParallel; }
}
