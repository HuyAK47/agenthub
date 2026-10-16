/** Parse API timestamps, including legacy SQLite UTC strings without a suffix. */
export function parseApiTime(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/);
  return Date.parse(match ? `${match[1]}T${match[2]}Z` : value);
}

export function formatTimeAgo(value: string | number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - parseApiTime(value)) / 1000));
  if (seconds < 60) return `${seconds} giây trước`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  return `${Math.floor(hours / 24)} ngày trước`;
}
