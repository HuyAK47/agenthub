import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BRANDING, parseBranding, saveBrandingLogo, sanitizeSvg } from '../src/branding.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('branding', () => {
  it('keeps the AgentHub default when no branding is configured', () => {
    expect(parseBranding(undefined)).toEqual(DEFAULT_BRANDING);
  });

  it('normalizes optional values and rejects unsafe colors', () => {
    expect(parseBranding({ name: ' ABCD ', shortName: 'AB', accentColor: 'red', tagline: ' Hello ' })).toEqual({
      name: 'ABCD', shortName: 'AB', tagline: 'Hello',
    });
  });

  it('rejects active SVG content and stores safe SVG under branding', () => {
    expect(() => sanitizeSvg('<svg><script>alert(1)</script></svg>')).toThrow();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-branding-'));
    tempDirs.push(dir);
    const file = saveBrandingLogo(dir, 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><!-- x --><path/></svg>'));
    expect(file).toBe('logo.svg');
    expect(fs.readFileSync(path.join(dir, 'branding', file), 'utf8')).not.toContain('<!--');
  });
});
