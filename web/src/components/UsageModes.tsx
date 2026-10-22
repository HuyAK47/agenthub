import React, { useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useLocale } from '../context/LocaleContext';
import { Button } from './ui/Button';

type UsageMode = 'hub' | 'mcp';

export const UsageModes: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t, locale } = useLocale();
  const [mode, setMode] = useState<UsageMode>('hub');
  const [copied, setCopied] = useState(false);
  const docsPath = locale === 'en' ? '/docs/en/USAGE-MODES.md' : '/docs/USAGE-MODES.md';

  const copyMcpCommand = async () => {
    try {
      await navigator.clipboard.writeText('agenthub mcp-install');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section data-testid="usage-modes" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-[var(--t-text)]">{t('usageModes.title')}</h2>
        <p className="mt-1 text-sm text-[var(--t-text-3)]">{t('usageModes.subtitle')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2" role="tablist" aria-label={t('usageModes.title')}>
        {(['hub', 'mcp'] as UsageMode[]).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={mode === item}
            onClick={() => setMode(item)}
            className={`rounded-xl border p-4 text-left transition-colors ${mode === item ? 'border-[var(--t-accent)] bg-[var(--t-accent)]/10' : 'border-[var(--t-border)] hover:bg-[var(--t-hover)]'}`}
          >
            <span className="block text-sm font-semibold text-[var(--t-text)]">{t(`usageModes.${item}.title`)}</span>
            <span className="mt-1 block text-xs text-[var(--t-text-3)]">{t(`usageModes.${item}.summary`)}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] p-4">
        <h3 className="font-semibold text-[var(--t-text)]">{t(`usageModes.${mode}.title`)}</h3>
        <p className="mt-1 text-sm text-[var(--t-text-3)]">{t(`usageModes.${mode}.when`)}</p>
        <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm text-[var(--t-text)]">
          {(compact ? ['step1', 'step2'] : ['step1', 'step2', 'step3']).map((step) => (
            <li key={step}>{t(`usageModes.${mode}.${step}`)}</li>
          ))}
        </ol>
        {mode === 'hub' ? (
          <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <Link to="/settings" className="inline-flex items-center gap-1 text-[var(--t-accent)] hover:underline">{t('usageModes.hub.brainLink')} <ExternalLink size={13} /></Link>
            <Link to="/settings" className="inline-flex items-center gap-1 text-[var(--t-accent)] hover:underline">{t('usageModes.hub.telegramLink')} <ExternalLink size={13} /></Link>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-[var(--t-border)] bg-[var(--t-surface)] px-2.5 py-1.5 text-xs">agenthub mcp-install</code>
              <Button size="sm" variant="secondary" onClick={copyMcpCommand} aria-label={t('usageModes.copyCommand')}>
                {copied ? <Check size={14} /> : <Copy size={14} />}
                <span>{copied ? t('usageModes.copied') : t('usageModes.copy')}</span>
              </Button>
            </div>
            <a href={docsPath} className="inline-flex items-center gap-1 text-sm text-[var(--t-accent)] hover:underline">{t('usageModes.docs')} <ExternalLink size={13} /></a>
          </div>
        )}
      </div>
      {mode === 'hub' && <a href={docsPath} className="inline-flex items-center gap-1 text-sm text-[var(--t-accent)] hover:underline">{t('usageModes.docs')} <ExternalLink size={13} /></a>}
    </section>
  );
};
