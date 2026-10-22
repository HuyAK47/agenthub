import fs from 'node:fs';
import path from 'node:path';

export interface BrandingConfig {
  name: string;
  shortName: string;
  logo?: string;
  accentColor?: string;
  tagline?: string;
}

export const DEFAULT_BRANDING: BrandingConfig = {
  name: 'AgentHub',
  shortName: 'AH',
};

const NAME_MAX = 80;
const TAGLINE_MAX = 160;
const SHORT_NAME_MAX = 12;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function parseBranding(raw: unknown): BrandingConfig {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, NAME_MAX)
    : DEFAULT_BRANDING.name;
  const shortName = typeof value.shortName === 'string' && value.shortName.trim()
    ? value.shortName.trim().slice(0, SHORT_NAME_MAX)
    : (name === DEFAULT_BRANDING.name ? DEFAULT_BRANDING.shortName : name.slice(0, 2).toUpperCase());
  const accentColor = typeof value.accentColor === 'string' && HEX_COLOR.test(value.accentColor)
    ? value.accentColor
    : undefined;
  const tagline = typeof value.tagline === 'string' && value.tagline.trim()
    ? value.tagline.trim().slice(0, TAGLINE_MAX)
    : undefined;
  const logo = typeof value.logo === 'string' && value.logo.trim() ? value.logo.trim() : undefined;
  return { name, shortName, ...(logo ? { logo } : {}), ...(accentColor ? { accentColor } : {}), ...(tagline ? { tagline } : {}) };
}

export function brandingDir(hubHome: string): string {
  return path.join(hubHome, 'branding');
}

export function brandingLogoPath(hubHome: string): string | null {
  const dir = brandingDir(hubHome);
  for (const extension of ['.svg', '.png']) {
    const candidate = path.join(dir, `logo${extension}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function sanitizeSvg(input: string): string {
  if (/<\s*script\b|\bon[a-z]+\s*=|javascript\s*:/i.test(input)) {
    throw new Error('SVG chứa script hoặc thuộc tính không an toàn');
  }
  return input
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\s+xmlns:xlink\s*=\s*(["'])http:\/\/www\.w3\.org\/1999\/xlink\1/gi, '')
    .trim();
}

export function saveBrandingLogo(hubHome: string, mimeType: string, data: Buffer): string {
  if (data.length === 0 || data.length > 256 * 1024) throw new Error('Logo phải có kích thước từ 1 đến 256KB');
  let extension: '.svg' | '.png';
  let output = data;
  if (mimeType === 'image/svg+xml') {
    output = Buffer.from(sanitizeSvg(data.toString('utf8')), 'utf8');
    extension = '.svg';
  } else if (mimeType === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    extension = '.png';
  } else {
    throw new Error('Logo chỉ hỗ trợ PNG hoặc SVG');
  }
  const dir = brandingDir(hubHome);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const other of ['.svg', '.png'] as const) {
    if (other !== extension) fs.rmSync(path.join(dir, `logo${other}`), { force: true });
  }
  fs.writeFileSync(path.join(dir, `logo${extension}`), output, { mode: 0o600 });
  return `logo${extension}`;
}
