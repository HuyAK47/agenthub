import { describe, expect, it } from 'vitest';
import { CodexEngine } from '../src/engines/index.js';

describe('lỗi tạm thời của engine', () => {
  const engine = new CodexEngine();

  it('coi model quá tải là lỗi tạm thời để thử lại', () => {
    expect(engine.detectTransientError('ERROR: Selected model is at capacity. Please try a different model.')).toBe(true);
    expect(engine.detectTransientError('upstream overloaded, retry later')).toBe(true);
  });

  it('không coi lỗi code thường là lỗi tạm thời', () => {
    expect(engine.detectTransientError('TypeError: cannot read properties of undefined')).toBe(false);
  });
});
