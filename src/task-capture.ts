import crypto from 'node:crypto';

export interface FileLocation {
  file: string;
  line: number;
  column?: number;
}

// Covers the formats emitted by Node, TypeScript, Vitest and Jest stack traces.
const LOCATION = /(?:\(|\s|^)([^\s()\x5B\x5D]+\.(?:[cm]?[jt]sx?|json)):(\d+)(?::(\d+))?(?:\)|\s|$)/gm;

export function extractFileLocations(output: string): FileLocation[] {
  const locations: FileLocation[] = [];
  const seen = new Set<string>();
  for (const match of output.matchAll(LOCATION)) {
    const file = match[1].replace(/^file:\/\//, '');
    const line = Number(match[2]);
    const column = match[3] ? Number(match[3]) : undefined;
    const key = `${file}:${line}:${column || ''}`;
    if (!Number.isInteger(line) || line < 1 || seen.has(key)) continue;
    seen.add(key);
    locations.push({ file, line, ...(column ? { column } : {}) });
  }
  return locations;
}

export function truncateExcerpt(value: string, maxLines = 200): string {
  const lines = value.split(/\r?\n/);
  return lines.slice(0, maxLines).join('\n');
}

export function excerptHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function toMarkdownCodeBlock(value: string): string {
  return '```text\n' + truncateExcerpt(value) + '\n```';
}
