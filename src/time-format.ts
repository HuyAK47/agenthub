export type TimeFormatLocale = 'vi' | 'en';
const TIME_ZONE = 'Asia/Ho_Chi_Minh';

function toMs(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e11 ? value : value * 1000;
}

function part(ms: number, locale: TimeFormatLocale) {
  const values = Object.fromEntries(new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'vi-VN', { timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)).map((item) => [item.type, item.value]));
  return values as Record<string, string>;
}

function absolute(ms: number, now: number, locale: TimeFormatLocale): string {
  const p = part(ms, locale);
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'vi-VN', { timeZone: TIME_ZONE, weekday: 'long' }).format(new Date(ms));
  const key = (value: number) => {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value)).map((item) => [item.type, item.value]));
    return Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
  };
  if (key(ms) === key(now)) return locale === 'en' ? `${p.hour}:${p.minute} today` : `${p.hour}:${p.minute} hôm nay`;
  if (key(ms) - key(now) === 86400000) return locale === 'en' ? `${p.hour}:${p.minute} tomorrow` : `${p.hour}:${p.minute} ngày mai`;
  return locale === 'en' ? `${date} ${p.month}/${p.day} ${p.hour}:${p.minute}` : `${date} ${p.day}/${p.month} ${p.hour}:${p.minute}`;
}

export function formatReset(value: number | null | undefined, now = Date.now(), locale: TimeFormatLocale = 'vi'): string {
  const ms = toMs(value);
  if (ms === null) return locale === 'en' ? 'reset time unknown' : 'chưa rõ thời điểm reset';
  const seconds = Math.floor((ms - now) / 1000);
  const p = part(ms, locale);
  if (seconds <= 0) return locale === 'en' ? `reset at ${p.hour}:${p.minute} · updating data` : `đã reset lúc ${p.hour}:${p.minute} · đang cập nhật số liệu`;
  if (seconds < 60) return `${locale === 'en' ? 'soon' : 'sắp reset'} · ${absolute(ms, now, locale)}`;
  const minutes = Math.floor(seconds / 60);
  let relative: string;
  if (seconds < 86400) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    relative = locale === 'en' ? `in ${hours ? `${hours} hour${hours === 1 ? '' : 's'}` : ''}${hours && rest ? ' ' : ''}${rest ? `${rest} minute${rest === 1 ? '' : 's'}` : ''}` : `còn ${hours ? `${hours} giờ` : ''}${hours && rest ? ' ' : ''}${rest ? `${rest} phút` : ''}`;
  } else {
    const days = Math.ceil(seconds / 86400);
    relative = locale === 'en' ? `in ${days} day${days === 1 ? '' : 's'}` : `còn ${days} ngày`;
  }
  return `${relative} · ${absolute(ms, now, locale)}`;
}

export function formatExpiry(value: number | null | undefined, now = Date.now(), locale: TimeFormatLocale = 'vi'): string {
  return formatReset(value, now, locale).replace(locale === 'en' ? 'reset time unknown' : 'chưa rõ thời điểm reset', locale === 'en' ? 'expiry time unknown' : 'chưa rõ thời điểm hết hạn').replace(locale === 'en' ? 'reset at' : 'đã reset lúc', locale === 'en' ? 'expired at' : 'đã hết hạn lúc').replace(locale === 'en' ? 'in ' : 'còn ', locale === 'en' ? 'expires in ' : 'hết hạn sau ');
}
