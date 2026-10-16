import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelBadge, formatModelName, getModelEngineKey } from '../components/ModelBadge';

describe('ModelBadge component and helpers', () => {
  describe('formatModelName', () => {
    it('formats gemini-3.8-flash-high to Gemini Flash · high', () => {
      expect(formatModelName('gemini-3.8-flash-high')).toBe('Gemini Flash · high');
    });

    it('formats gemini-3.8-flash-medium to Gemini Flash · medium', () => {
      expect(formatModelName('gemini-3.8-flash-medium')).toBe('Gemini Flash · medium');
    });

    it('formats gemini-3.8-flash-low to Gemini Flash · low', () => {
      expect(formatModelName('gemini-3.8-flash-low')).toBe('Gemini Flash · low');
    });

    it('formats codex:gpt-5.6-luna to Codex Luna', () => {
      expect(formatModelName('codex:gpt-5.6-luna')).toBe('Codex Luna');
    });

    it('formats gpt-5.6-luna to Codex Luna', () => {
      expect(formatModelName('gpt-5.6-luna')).toBe('Codex Luna');
    });

    it('keeps other model names unmodified', () => {
      expect(formatModelName('claude-opus-4-6-thinking')).toBe('claude-opus-4-6-thinking');
      expect(formatModelName('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
      expect(formatModelName('custom-model-v1')).toBe('custom-model-v1');
    });

    it('falls back to engine when model is not provided', () => {
      expect(formatModelName(null, 'agy')).toBe('Gemini');
      expect(formatModelName(undefined, 'codex')).toBe('Codex');
      expect(formatModelName('', 'custom')).toBe('custom');
    });
  });

  describe('getModelEngineKey', () => {
    it('detects gemini engine from model or engine name', () => {
      expect(getModelEngineKey('gemini-3.8-flash-high')).toBe('gemini');
      expect(getModelEngineKey('', 'agy')).toBe('gemini');
    });

    it('detects codex engine from model or engine name', () => {
      expect(getModelEngineKey('codex:gpt-5.6-luna')).toBe('codex');
      expect(getModelEngineKey('gpt-5.6-luna')).toBe('codex');
      expect(getModelEngineKey('', 'codex')).toBe('codex');
    });

    it('detects claude engine from model or engine name', () => {
      expect(getModelEngineKey('claude-opus-4-6-thinking')).toBe('claude');
      expect(getModelEngineKey('', 'claude')).toBe('claude');
    });

    it('falls back to other for unknown engines', () => {
      expect(getModelEngineKey('unknown-model', 'unknown')).toBe('other');
    });
  });

  describe('ModelBadge rendering', () => {
    it('renders compact text, full title tooltip, and whitespace-nowrap', () => {
      render(<ModelBadge model="gemini-3.8-flash-high" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('Gemini Flash · high');
      expect(badge).toHaveAttribute('title', 'gemini-3.8-flash-high');
      expect(badge).toHaveClass('whitespace-nowrap');
      expect(badge).toHaveClass('badge-model-gemini');
    });

    it('renders Codex Luna with codex badge style', () => {
      render(<ModelBadge model="codex:gpt-5.6-luna" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('Codex Luna');
      expect(badge).toHaveAttribute('title', 'codex:gpt-5.6-luna');
      expect(badge).toHaveClass('badge-model-codex');
    });

    it('renders unmodified name for other models', () => {
      render(<ModelBadge model="claude-sonnet-4-6" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('claude-sonnet-4-6');
      expect(badge).toHaveAttribute('title', 'claude-sonnet-4-6');
      expect(badge).toHaveClass('badge-model-claude');
    });

    it('renders fallback engine name if model is missing', () => {
      render(<ModelBadge engine="codex" />);
      const badge = screen.getByTestId('model-badge');

      expect(badge).toHaveTextContent('Codex');
      expect(badge).toHaveAttribute('title', 'codex');
      expect(badge).toHaveClass('badge-model-codex');
    });

    it('returns null if neither model nor engine is provided', () => {
      const { container } = render(<ModelBadge />);
      expect(container.firstChild).toBeNull();
    });
  });
});
