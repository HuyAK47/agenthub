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

export type CursorValue = string | number;

export function encodeCursor(value: CursorValue, id: string): string {
  return Buffer.from(JSON.stringify({ value, id }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { value: CursorValue; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { value?: unknown; updatedAt?: unknown; id?: unknown };
    const value = typeof parsed.value === 'string' || typeof parsed.value === 'number' ? parsed.value : parsed.updatedAt;
    return (typeof value === 'string' || typeof value === 'number') && typeof parsed.id === 'string'
      ? { value, id: parsed.id }
      : null;
  } catch {
    return null;
  }
}

