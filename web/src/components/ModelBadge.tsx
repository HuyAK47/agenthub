import React from 'react';

export interface ModelBadgeProps {
  model?: string | null;
  engine?: string | null;
  className?: string;
}

export function formatModelName(model?: string | null, engine?: string | null): string {
  if (!model && !engine) return '';
  if (!model && engine) {
    if (engine.toLowerCase() === 'agy') return 'Gemini';
    if (engine.toLowerCase() === 'codex') return 'Codex';
    return engine;
  }

  const m = model!;
  if (m === 'gemini-3.8-flash-high') return 'Gemini Flash · high';
  if (m === 'gemini-3.8-flash-medium') return 'Gemini Flash · medium';
  if (m === 'gemini-3.8-flash-low') return 'Gemini Flash · low';
  if (m === 'codex:gpt-5.6-luna' || m === 'gpt-5.6-luna') return 'Codex Luna';

  // General regex for other gemini flash variants if present
  const flashMatch = m.match(/^gemini(?:-\d+\.\d+)?-flash-(high|medium|low)$/);
  if (flashMatch) {
    return `Gemini Flash · ${flashMatch[1]}`;
  }

  return m;
}

export function getModelEngineKey(model?: string | null, engine?: string | null): 'gemini' | 'codex' | 'claude' | 'other' {
  const normEngine = (engine || '').toLowerCase();
  const normModel = (model || '').toLowerCase();

  if (normEngine === 'codex' || normModel.startsWith('codex') || normModel.startsWith('gpt')) {
    return 'codex';
  }
  if (normModel.startsWith('gemini') || (normEngine === 'agy' && !normModel.startsWith('claude') && !normModel.startsWith('gpt'))) {
    return 'gemini';
  }
  if (normModel.startsWith('claude') || normEngine === 'claude') {
    return 'claude';
  }
  return 'other';
}

export const ModelBadge: React.FC<ModelBadgeProps> = ({ model, engine, className = '' }) => {
  const displayText = formatModelName(model, engine);
  if (!displayText) return null;

  const engineKey = getModelEngineKey(model, engine);
  const fullTitle = model || engine || '';

  const badgeClass =
    engineKey === 'gemini'
      ? 'badge-model-gemini'
      : engineKey === 'codex'
      ? 'badge-model-codex'
      : engineKey === 'claude'
      ? 'badge-model-claude'
      : 'badge-model-other';

  return (
    <span
      data-testid="model-badge"
      title={fullTitle}
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap select-none font-medium ${badgeClass} ${className}`}
    >
      {displayText}
    </span>
  );
};
