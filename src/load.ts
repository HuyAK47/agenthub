import os from 'node:os';
import fs from 'node:fs';
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
  pressure?: PressureSnapshot;
}
export interface PressureSnapshot { cpuSome: number | null; memorySome: number | null; ioSome: number | null; }

export interface LoadGuardOptions {
  readLoad?: () => number;
  readFreeMemBytes?: () => number;
  now?: () => number;
  readPressure?: () => PressureSnapshot;
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

function readPressure(): PressureSnapshot {
  const read = (name: string): number | null => {
    try { const match = fs.readFileSync(`/proc/pressure/${name}`, 'utf8').match(/some\s+avg10=([\d.]+)/); return match ? Number(match[1]) : null; } catch { return null; }
  };
  return { cpuSome: read('cpu'), memorySome: read('memory'), ioSome: read('io') };
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
    const pressure = (this.options.readPressure || readPressure)();
    // Linux PSI reports percentages (not fractions). An injected reader is also
    // honored when load/memory are mocked, which keeps pressure behavior testable.
    const pressureHigh = (!this.options.readLoad || Boolean(this.options.readPressure))
      && [pressure.cpuSome, pressure.memorySome, pressure.ioSome].some((value) => value !== null && value >= 20);
    const high = load1 > this.config.high || freeMemGB < this.config.minFreeMemGB || pressureHigh;
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
      pressure,
    };
    return this.snapshot;
  }

  getStatus(): LoadSnapshot { return this.snapshot; }
  isOverloaded(): boolean { return this.overloaded; }
  isAutoPauseTriggered(): boolean { return Boolean(this.snapshot.autoPauseTriggered); }
  effectiveParallel(maxParallel: number): number { return this.overloaded ? 1 : maxParallel; }
}
