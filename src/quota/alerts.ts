/** Chuỗi ngắn cho cảnh báo quota.low, dùng chung cho desktop và Telegram. */
export function quotaLowText(p: Record<string, unknown>): string {
  const name = String(p.profile || 'Hồ sơ');
  const pct = typeof p.remainingPct === 'number' ? p.remainingPct : '?';
  const window = p.window === 'week' ? 'tuần' : '5 giờ';
  const group = p.group ? ` (${String(p.group)})` : '';
  const resetAt = typeof p.resetAt === 'number' && p.resetAt > 0 ? new Date(p.resetAt * 1000) : null;
  const reset = resetAt
    ? ` · reset ${String(resetAt.getHours()).padStart(2, '0')}:${String(resetAt.getMinutes()).padStart(2, '0')} ${resetAt.getDate()}/${resetAt.getMonth() + 1}`
    : '';
  return `Hồ sơ ${name} còn ${pct}% quota ${window}${group}${reset}`;
}
