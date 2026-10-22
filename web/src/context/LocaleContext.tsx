import React, { createContext, useContext, useEffect, useState } from 'react';
import { Locale, Translations, translations, translate, TranslationKey } from '../locales';

interface LocaleContextType {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
  t: (key: TranslationKey | string, params?: Record<string, string | number | undefined | null>) => string;
  dict: Translations;
}

const defaultContext: LocaleContextType = {
  locale: 'vi',
  setLocale: () => {},
  toggleLocale: () => {},
  t: (key: string, params?: Record<string, string | number | undefined | null>) => translate('vi', key, params),
  dict: translations.vi,
};

const LocaleContext = createContext<LocaleContextType>(defaultContext);

export const LocaleProvider: React.FC<{
  children: React.ReactNode;
  initialLocale?: Locale;
  appName?: string;
}> = ({ children, initialLocale, appName = 'AgentHub' }) => {
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('agenthub_locale') as Locale | null;
        if (saved === 'vi' || saved === 'en') return saved;
      } catch {
        // Storage may be unavailable in privacy-restricted browsers.
      }
    }
    return 'vi';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('agenthub_locale', locale);
      } catch {
        // The UI still works when storage is unavailable.
      }
      document.documentElement.lang = locale;
    }
  }, [locale]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
  };

  const toggleLocale = () => {
    setLocaleState((prev) => (prev === 'vi' ? 'en' : 'vi'));
  };

  const t = (key: TranslationKey | string, params?: Record<string, string | number | undefined | null>) => {
    return translate(locale, key, { appName, ...params });
  };

  const dict = translations[locale] || translations.vi;

  return (
    <LocaleContext.Provider value={{ locale, setLocale, toggleLocale, t, dict }}>
      {children}
    </LocaleContext.Provider>
  );
};

export function useLocale(): LocaleContextType {
  return useContext(LocaleContext);
}
