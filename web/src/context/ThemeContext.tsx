import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
export type EffectiveTheme = 'dark' | 'light';

export interface ThemeContextType {
  mode: ThemeMode;
  effectiveTheme: EffectiveTheme;
  theme: EffectiveTheme; // for backwards compatibility
  setMode: (mode: ThemeMode) => void;
  setTheme: (theme: ThemeMode) => void; // for backwards compatibility
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = 'agenthub_theme';

export function resolveInitialTheme(saved: string | null, systemDark: boolean): EffectiveTheme {
  if (saved === 'light') return 'light';
  if (saved === 'system') return systemDark ? 'dark' : 'light';
  return 'dark';
}

function getStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  try {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeMode | null;
    if (saved === 'dark' || saved === 'light' || saved === 'system') {
      return saved;
    }
  } catch {
    // localStorage might fail in restricted sandboxes
  }
  // The head script has already selected the initial palette before React runs.
  // Keep the legacy dark default when no class was supplied (e.g. SSR/tests).
  return document.documentElement.classList.contains('dark') || document.documentElement.className === ''
    ? 'dark'
    : 'light';
}

function resolveEffectiveTheme(mode: ThemeMode): EffectiveTheme {
  if (mode === 'system' && typeof window !== 'undefined') {
    return resolveInitialTheme('system', Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  }
  return mode === 'light' ? 'light' : 'dark';
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode);
  const [effectiveTheme, setEffectiveTheme] = useState<EffectiveTheme>(() => resolveEffectiveTheme(mode));
  const isFirstThemeEffect = useRef(true);

  useEffect(() => {
    const updateTheme = () => {
      const resolved = resolveEffectiveTheme(mode);
      setEffectiveTheme(resolved);

      const root = document.documentElement;
      const shouldTransition = !isFirstThemeEffect.current
        && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (shouldTransition) root.classList.add('theme-transition');
      if (resolved === 'dark') {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
      if (shouldTransition) window.setTimeout(() => root.classList.remove('theme-transition'), 250);
      isFirstThemeEffect.current = false;
    };

    updateTheme();

    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // safe try/catch
    }

    if (mode === 'system' && typeof window !== 'undefined' && window.matchMedia) {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = () => updateTheme();
      if (mql.addEventListener) {
        mql.addEventListener('change', listener);
        return () => mql.removeEventListener('change', listener);
      } else if ((mql as any).addListener) {
        (mql as any).addListener(listener);
        return () => (mql as any).removeListener(listener);
      }
    }
  }, [mode]);

  const setMode = (m: ThemeMode) => {
    setModeState(m);
  };

  const setTheme = (m: ThemeMode) => {
    setModeState(m);
  };

  const toggleTheme = () => {
    setModeState((prev) => {
      if (prev === 'dark') return 'light';
      if (prev === 'light') return 'system';
      return 'dark';
    });
  };

  return (
    <ThemeContext.Provider
      value={{
        mode,
        effectiveTheme,
        theme: effectiveTheme,
        setMode,
        setTheme,
        toggleTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
};

export function useTheme(): ThemeContextType {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}

export function useOptionalTheme(): ThemeContextType | undefined {
  return useContext(ThemeContext);
}
