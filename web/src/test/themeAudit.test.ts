import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(process.cwd(), 'src');
const PALETTE_CLASS =
  /(?:^|[\s'"`])(?:[a-z-]+:)*(?:bg|text|border|ring|divide|from|via|to|outline|decoration|placeholder)-(?:white|black|gray|slate|zinc|neutral|stone|amber|green|red|blue|yellow|orange|purple|indigo|pink|emerald|teal|cyan|lime|sky|violet|fuchsia|rose)(?:-\d+)?(?:\/[^\s'"`]*)?/g;
const DARK_VARIANT = /(?:^|[\s'"`])dark:(?:bg|text|border|ring|divide|from|via|to|outline|decoration|placeholder)-/g;
const RAW_COLOR = /#[0-9a-fA-F]{3,8}|\b(?:rgb|rgba)\s*\(/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'test' || name === 'mocks' || name === 'index.css') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('theme audit', () => {
  it('has no hard-coded palette, dark variant, or raw color in application source', () => {
    const violations: string[] = [];

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const content = readFileSync(file, 'utf8');
      for (const [kind, pattern] of [
        ['palette class', PALETTE_CLASS],
        ['dark variant', DARK_VARIANT],
        ['raw color', RAW_COLOR],
      ] as const) {
        for (const match of content.matchAll(pattern)) {
          const line = content.slice(0, match.index ?? 0).split('\n').length;
          violations.push(`${relative(SOURCE_ROOT, file)}:${line} ${kind}: ${match[0].trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
