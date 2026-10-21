import { describe, expect, it } from 'vitest';
import { compareSemver } from '../src/update.js';

describe('compareSemver', () => {
  it('compares release versions numerically', () => {
    expect(compareSemver('1.0.0', '0.9.9')).toBe(1);
    expect(compareSemver('v1.2.0', '1.10.0')).toBe(-1);
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
  });

  it('ranks a release above its pre-releases so rc installs see the final update', () => {
    expect(compareSemver('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '0.9.0')).toBe(1);
  });

  it('orders pre-releases by their identifiers', () => {
    expect(compareSemver('1.0.0-rc.2', '1.0.0-rc.1')).toBe(1);
    expect(compareSemver('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(compareSemver('1.0.0-beta.1', '1.0.0-rc.1')).toBe(-1);
    expect(compareSemver('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });
});
