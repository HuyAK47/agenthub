import { describe, expect, it } from 'vitest';
import { LoadGuard } from '../src/load.js';

describe('LoadGuard', () => {
  it('uses configured PSI thresholds for high and recovery states', () => {
    let pressure = { cpuSome: 21, memorySome: 0, ioSome: 0 };
    let now = 0;
    const guard = new LoadGuard({ enabled: true, high: 100, ok: 100, pressureHigh: 20, pressureOk: 10, minFreeMemGB: 1, recoverAfterSec: 100 }, {
      readLoad: () => 0,
      readFreeMemBytes: () => 4 * 1024 ** 3,
      readPressure: () => pressure,
      now: () => now,
    });
    expect(guard.update().overloaded).toBe(true);
    pressure = { cpuSome: 11, memorySome: 0, ioSome: 0 };
    now = 100_000;
    expect(guard.update().overloaded).toBe(true);
    pressure = { cpuSome: 9, memorySome: 0, ioSome: 0 };
    now = 200_000;
    expect(guard.update().overloaded).toBe(true);
    now = 300_000;
    expect(guard.update().overloaded).toBe(false);
  });

  it('ignores background I/O pressure below 40% when CPU and memory pressure are low', () => {
    const guard = new LoadGuard({ enabled: true, high: 100, ok: 100, minFreeMemGB: 1, recoverAfterSec: 100 }, {
      readLoad: () => 6,
      readFreeMemBytes: () => 6 * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0.1, memorySome: 0.3, ioSome: 22 }),
    });

    expect(guard.update().overloaded).toBe(false);
  });

  it('uses the I/O threshold only together with meaningful memory pressure', () => {
    const guard = new LoadGuard({ enabled: true, high: 100, ok: 100, minFreeMemGB: 1, recoverAfterSec: 100 }, {
      readLoad: () => 0,
      readFreeMemBytes: () => 6 * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0.1, memorySome: 10, ioSome: 45 }),
    });

    expect(guard.update().overloaded).toBe(true);
  });
  it('reduces effective parallelism without changing the configured value', () => {
    const load = 20;
    const memory = 4;
    const guard = new LoadGuard({ enabled: true, high: 16, ok: 11, minFreeMemGB: 1.5, recoverAfterSec: 300 }, {
      readLoad: () => load,
      readFreeMemBytes: () => memory * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0, memorySome: 0, ioSome: 0 }),
    });
    const project = { maxParallel: 4 };

    guard.update();
    expect(guard.effectiveParallel(project.maxParallel)).toBe(1);
    expect(project.maxParallel).toBe(4);
  });

  it('recovers only after the healthy period', () => {
    let now = 0;
    let load = 20;
    const guard = new LoadGuard({ enabled: true, high: 16, ok: 11, minFreeMemGB: 1.5, recoverAfterSec: 300 }, {
      readLoad: () => load,
      readFreeMemBytes: () => 4 * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0, memorySome: 0, ioSome: 0 }),
      now: () => now,
    });

    guard.update();
    load = 10;
    now = 0;
    guard.update();
    now = 299_000;
    expect(guard.update().overloaded).toBe(true);
    now = 300_000;
    expect(guard.update().overloaded).toBe(false);
  });

  it('resets recovery when the machine becomes unhealthy again', () => {
    let now = 0;
    let load = 20;
    const guard = new LoadGuard({ enabled: true, high: 16, ok: 11, minFreeMemGB: 1.5, recoverAfterSec: 300 }, {
      readLoad: () => load,
      readFreeMemBytes: () => 4 * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0, memorySome: 0, ioSome: 0 }),
      now: () => now,
    });

    guard.update();
    load = 10;
    now = 200_000;
    guard.update();
    load = 12;
    now = 400_000;
    guard.update();
    load = 10;
    now = 499_000;
    expect(guard.update().overloaded).toBe(true);
    now = 600_000;
    expect(guard.update().overloaded).toBe(true);
    now = 799_000;
    expect(guard.update().overloaded).toBe(false);
  });

  it('triggers autoPauseTriggered after high load persists for autoPauseThresholdSec (60s)', () => {
    let now = 100_000;
    let load = 20;
    const guard = new LoadGuard({
      enabled: true,
      high: 16,
      ok: 11,
      minFreeMemGB: 1.5,
      recoverAfterSec: 300,
      autoPauseThresholdSec: 60,
      pausePolicy: 'recent',
      maxAutoPaused: 2,
    }, {
      readLoad: () => load,
      readFreeMemBytes: () => 4 * 1024 ** 3,
      readPressure: () => ({ cpuSome: 0, memorySome: 0, ioSome: 0 }),
      now: () => now,
    });

    // Initial update enters overloaded & high state
    expect(guard.update().autoPauseTriggered).toBe(false);
    expect(guard.isAutoPauseTriggered()).toBe(false);

    // 30s later (under 60s threshold)
    now = 130_000;
    expect(guard.update().autoPauseTriggered).toBe(false);
    expect(guard.isAutoPauseTriggered()).toBe(false);

    // 60s later: triggered!
    now = 160_000;
    expect(guard.update().autoPauseTriggered).toBe(true);
    expect(guard.isAutoPauseTriggered()).toBe(true);

    // If load drops below high, highSince resets
    load = 14; // between ok (11) and high (16)
    guard.update();
    expect(guard.isAutoPauseTriggered()).toBe(false);
  });
});
