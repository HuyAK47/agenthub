/** Parse a timestamp stored by SQLite or received from an API. */
export function parseDbTime(value: string | number): number {
  if (typeof value === 'number') return value;

  const sqliteUtc = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;
  const match = value.match(sqliteUtc);
  if (match) return Date.parse(`${match[1]}T${match[2]}Z`);

  return Date.parse(value);
}

export function toApiTime(value: string | null | undefined): string | null | undefined {
  if (value == null) return value;
  const epoch = parseDbTime(value);
  return Number.isNaN(epoch) ? value : new Date(epoch).toISOString();
}
