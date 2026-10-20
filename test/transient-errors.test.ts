import { describe, expect, it } from 'vitest';
import { CodexEngine } from '../src/engines/index.js';

describe('lỗi tạm thời của engine', () => {
  const engine = new CodexEngine();

  it('coi model quá tải là lỗi tạm thời để thử lại', () => {
    expect(engine.detectTransientError('ERROR: Selected model is at capacity. Please try a different model.')).toBe(true);
    expect(engine.detectTransientError('upstream overloaded, retry later')).toBe(true);
  });

  it('coi lỗi mạng của agy là lỗi tạm thời', () => {
    expect(engine.detectTransientError('Error: There was a network issue connecting to the server, please try again.')).toBe(true);
    expect(engine.detectTransientError('AGY_ERROR: {"short_error":"net/http: TLS handshake timeout","retryable":true}')).toBe(true);
  });

  it('không coi lỗi code thường là lỗi tạm thời', () => {
    expect(engine.detectTransientError('TypeError: cannot read properties of undefined')).toBe(false);
  });
});
