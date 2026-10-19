export interface FormatNumberOptions {
  decimals?: number;
  locale?: string;
}

export interface FormatSignedOptions extends FormatNumberOptions {
  positivePrefix?: string;
  negativePrefix?: string;
}

/**
 * Rounds a number to the specified decimal places using symmetric round-half-away-from-zero.
 * If the rounded result is 0 or -0, standardizes to 0 (no sign).
 */
export function roundNumber(value: number, decimals: number = 0): number {
  if (value === 0 || Object.is(value, -0) || isNaN(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
  return rounded === 0 || Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Formats a number with standard rounding and locale formatting.
 * Rounds first; if the result is 0 or -0, returns '0' without sign.
 */
export function formatNumber(
  value: number | null | undefined,
  options?: FormatNumberOptions | string,
): string {
  if (value == null || isNaN(value)) {
    return '0';
  }
  const opts = typeof options === 'string' ? { locale: options } : (options ?? {});
  const decimals = opts.decimals ?? 0;
  const rounded = roundNumber(value, decimals);

  if (rounded === 0) {
    return '0';
  }

  const locale = opts.locale === 'vi' ? 'vi-VN' : opts.locale === 'en' ? 'en-US' : opts.locale;
  return rounded.toLocaleString(locale, {
    minimumFractionDigits: decimals > 0 ? decimals : 0,
    maximumFractionDigits: decimals,
  });
}

/**
 * Formats a signed number (e.g. +42, −7, or 0).
 * If the rounded result is 0, returns '0' without any sign.
 */
export function formatSigned(
  value: number | null | undefined,
  options?: FormatSignedOptions,
): string {
  if (value == null || isNaN(value)) {
    return '0';
  }
  const decimals = options?.decimals ?? 0;
  const rounded = roundNumber(value, decimals);
  if (rounded === 0) {
    return '0';
  }

  const formatted = formatNumber(Math.abs(rounded), options);
  if (rounded > 0) {
    const prefix = options?.positivePrefix ?? '+';
    return `${prefix}${formatted}`;
  }
  const prefix = options?.negativePrefix ?? '-';
  return `${prefix}${formatted}`;
}
