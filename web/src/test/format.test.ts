import { describe, expect, it } from 'vitest';
import { formatNumber, formatSigned, roundNumber } from '../utils/format';

describe('format utils', () => {
  describe('roundNumber', () => {
    it('normalizes -0 to 0', () => {
      const res = roundNumber(-0);
      expect(res).toBe(0);
      expect(Object.is(res, -0)).toBe(false);
      expect(Object.is(res, 0)).toBe(true);
    });

    it('rounds small negative -0.004 to 0 (no sign)', () => {
      const res = roundNumber(-0.004, 0);
      expect(res).toBe(0);
      expect(Object.is(res, -0)).toBe(false);
    });

    it('rounds small positive 0.004 to 0', () => {
      const res = roundNumber(0.004, 0);
      expect(res).toBe(0);
    });

    it('preserves real negative numbers', () => {
      expect(roundNumber(-12, 0)).toBe(-12);
      expect(roundNumber(-5.6, 1)).toBe(-5.6);
      expect(roundNumber(-0.05, 1)).toBe(-0.1);
    });
  });

  describe('formatNumber', () => {
    it('formats -0 as 0 without negative sign', () => {
      expect(formatNumber(-0)).toBe('0');
    });

    it('formats -0.004 as 0 without negative sign', () => {
      expect(formatNumber(-0.004)).toBe('0');
      expect(formatNumber(-0.004, { decimals: 1 })).toBe('0');
      expect(formatNumber(-0.004, { decimals: 2 })).toBe('0');
    });

    it('formats 0.004 as 0', () => {
      expect(formatNumber(0.004)).toBe('0');
      expect(formatNumber(0.004, { decimals: 1 })).toBe('0');
      expect(formatNumber(0.004, { decimals: 2 })).toBe('0');
    });

    it('formats real negative numbers with negative sign', () => {
      expect(formatNumber(-12)).toBe('-12');
      expect(formatNumber(-42)).toBe('-42');
      expect(formatNumber(-5.6, { decimals: 1, locale: 'en' })).toBe('-5.6');
      expect(formatNumber(-0.05, { decimals: 1, locale: 'en' })).toBe('-0.1');
    });

    it('formats numbers with locale thousands separator', () => {
      expect(formatNumber(1234567, { locale: 'vi' })).toBe('1.234.567');
      expect(formatNumber(1234567, { locale: 'en' })).toBe('1,234,567');
    });

    it('handles null, undefined and NaN gracefully', () => {
      expect(formatNumber(null)).toBe('0');
      expect(formatNumber(undefined)).toBe('0');
      expect(formatNumber(NaN)).toBe('0');
    });
  });

  describe('formatSigned', () => {
    it('formats -0, -0.004, 0.004, and 0 as 0 without any prefix', () => {
      expect(formatSigned(-0)).toBe('0');
      expect(formatSigned(-0.004)).toBe('0');
      expect(formatSigned(0.004)).toBe('0');
      expect(formatSigned(0)).toBe('0');
      expect(formatSigned(0, { positivePrefix: '+', negativePrefix: '−' })).toBe('0');
    });

    it('formats positive numbers with positivePrefix', () => {
      expect(formatSigned(42, { positivePrefix: '+' })).toBe('+42');
    });

    it('formats real negative numbers with negativePrefix', () => {
      expect(formatSigned(-7, { negativePrefix: '−' })).toBe('−7');
      expect(formatSigned(-7, { negativePrefix: '-' })).toBe('-7');
    });
  });
});
