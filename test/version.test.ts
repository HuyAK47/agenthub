import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hubVersion } from '../src/version.js';

describe('hubVersion', () => {
  it('reports the version from package.json (used by /health and the MCP server)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string };
    expect(hubVersion()).toBe(pkg.version);
    expect(hubVersion()).not.toBe('0.1.0');
  });
});
