export interface PageQuery {
  limit?: string | number;
  cursor?: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  nextCursor: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
export const PAGE_SIZES = [20, 50, 100] as const;

export function parsePageSize(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(100, Math.floor(parsed));
}

export function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { updatedAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown };
    return typeof parsed.updatedAt === 'string' && typeof parsed.id === 'string'
      ? { updatedAt: parsed.updatedAt, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

