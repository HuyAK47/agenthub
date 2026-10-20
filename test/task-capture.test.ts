import { describe, expect, it } from 'vitest';
import { excerptHash, extractFileLocations, truncateExcerpt } from '../src/task-capture.js';

describe('task error capture', () => {
  it('extracts TypeScript, Node, Vitest and Jest file locations', () => {
    const output = [
      'Error: boom',
      '    at handler (src/api/server.ts:42:7)',
      '    at file:///tmp/project/test/example.test.ts:8:3',
      '      at Object.<anonymous> (tests/unit.spec.js:12:11)',
    ].join('\n');
    expect(extractFileLocations(output)).toEqual([
      { file: 'src/api/server.ts', line: 42, column: 7 },
      { file: '/tmp/project/test/example.test.ts', line: 8, column: 3 },
      { file: 'tests/unit.spec.js', line: 12, column: 11 },
    ]);
  });

  it('limits excerpts to 200 lines and hashes the exact captured text', () => {
    const value = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n');
    const excerpt = truncateExcerpt(value);
    expect(excerpt.split('\n')).toHaveLength(200);
    expect(excerptHash(excerpt)).toHaveLength(64);
    expect(excerptHash(excerpt)).not.toBe(excerptHash(`${excerpt}\n`));
  });
});
