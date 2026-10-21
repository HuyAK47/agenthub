import React, { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useTheme } from '../context/ThemeContext';
import { useLocale } from '../context/LocaleContext';
import { VersionBanner } from './VersionBanner';
import { subscribeConnectionState } from '../api/sse';
import {
  Activity,
  CheckSquare,
  Users,
  FolderGit2,
  Settings,
    Wrench,
  Sun,
  Moon,
  Monitor,
  Bot,
  MessageSquare,
  TrendingUp,
  Layers,
  Wifi,
  WifiOff,
} from 'lucide-react';

export const Layout: React.FC = () => {
  const { mode, setMode } = useTheme();
  const { t, toggleLocale, locale } = useLocale();
  const location = useLocation();
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [sseConnected, setSseConnected] = useState(true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    const unsub = subscribeConnectionState((connected) => {
      setSseConnected(connected);
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      unsub();
    };
  }, []);

  const connected = isOnline && sseConnected;

  const navItems = [
    { to: '/', label: t('common.dashboard'), icon: Activity },
    { to: '/chat', label: 'Chat', icon: MessageSquare },
    { to: '/plans', label: t('common.plans'), icon: Layers },
    { to: '/tasks', label: 'Task', icon: CheckSquare },
    { to: '/savings', label: t('extra.pageSavings'), icon: TrendingUp },
    { to: '/profiles', label: t('common.profiles'), icon: Users },
    { to: '/projects', label: t('common.projects'), icon: FolderGit2 },
    { to: '/settings', label: t('common.settings'), icon: Settings },
    { to: '/setup', label: 'Thiết lập', icon: Wrench },
  ];

  const getPageTitle = (pathname: string): string => {
    if (pathname === '/') return t('common.dashboard');
    if (pathname.startsWith('/chat')) return 'Chat';
    if (pathname.startsWith('/claude-sessions')) return t('extra.claudeSessions');
    if (pathname.startsWith('/plans')) return t('extra.pagePlans');
    if (pathname === '/tasks/new') return t('extra.pageTaskCreate');
    if (pathname.startsWith('/tasks/')) return t('extra.pageTaskDetail');
    if (pathname.startsWith('/tasks')) return t('common.tasks');
    if (pathname.startsWith('/profiles')) return t('common.profiles');
    if (pathname.startsWith('/projects')) return t('common.projects');
    if (pathname.startsWith('/savings')) return t('extra.pageSavings');
    if (pathname.startsWith('/settings')) return t('common.settings');
    return t('extra.pageAgentHub');
  };

  const pageTitle = getPageTitle(location.pathname);

  return (
    <div className="min-h-screen bg-[var(--t-bg)] text-[var(--t-text)] flex font-sans transition-colors duration-150">
      {/* Skip to main content link for keyboard users */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[var(--t-surface)] focus:text-[var(--t-accent)] focus:border focus:border-[var(--t-border)] focus:shadow-lg focus:font-medium focus:text-sm focus:outline-hidden focus:ring-2 focus:ring-[var(--t-accent)]"
      >
        {locale === 'en' ? 'Skip to content' : 'Bỏ qua tới nội dung'}
      </a>

      {/* Sidebar (240px wide on >=1100px, 68px icon-only on <1100px) */}
      <aside
        className="w-[240px] max-[1100px]:w-[68px] shrink-0 h-screen sticky top-0 flex flex-col bg-[var(--t-surface)] border-r border-[var(--t-border)] z-30 transition-[width] duration-200 select-none"
      >
        {/* Brand / Logo */}
        <div className="h-[56px] flex items-center px-4 max-[1100px]:px-0 max-[1100px]:justify-center border-b border-[var(--t-border)] gap-3 shrink-0">
          <NavLink
            to="/"
            end
            title="AgentHub"
            aria-label="AgentHub"
            className="flex items-center gap-3 overflow-hidden rounded-lg focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface)]"
          >
            <div className="w-8 h-8 rounded-lg bg-[var(--t-accent)] flex items-center justify-center text-white shrink-0 shadow-xs">
              <Bot size={18} />
            </div>
            <span className="font-bold text-base tracking-tight text-[var(--t-text)] max-[1100px]:hidden truncate">
              AgentHub
            </span>
          </NavLink>
        </div>

        {/* Navigation Items */}
        <nav aria-label={t('extra.sidebarAria')} className="flex-1 py-4 px-2 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                title={item.label}
                aria-label={item.label}
                className={({ isActive }) =>
                  `relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors max-[1100px]:justify-center max-[1100px]:px-0 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface)] ${
                    isActive
                      ? 'bg-[var(--t-selected)] text-[var(--t-accent)] font-semibold before:content-[\'\'] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[3px] before:bg-[var(--t-accent)] before:rounded-r'
                      : 'text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-hover)]'
                  }`
                }
              >
                <Icon size={18} className="shrink-0" />
                <span className="truncate max-[1100px]:hidden">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        <VersionBanner />

        {/* Header 56px */}
        <header className="h-[56px] sticky top-0 z-20 bg-[var(--t-surface)]/90 backdrop-blur border-b border-[var(--t-border)] px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-base font-semibold text-[var(--t-text)] truncate">{pageTitle}</h1>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {/* Connection Status Indicator */}
            <div
              title={connected ? t('extra.connected') : t('extra.disconnected')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                connected
                  ? 'bg-[var(--t-ok)]/12 text-[var(--t-ok)] border-[var(--t-ok)]/25'
                  : 'bg-[var(--t-warn)]/12 text-[var(--t-warn)] border-[var(--t-warn)]/25'
              }`}
            >
              {connected ? (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-ok)] animate-pulse" />
                  <Wifi size={12} className="hidden sm:inline" />
                  <span className="hidden sm:inline">{t('extra.connected')}</span>
                </>
              ) : (
                <>
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-warn)]" />
                  <WifiOff size={12} className="hidden sm:inline" />
                  <span className="hidden sm:inline">{t('extra.disconnected')}</span>
                </>
              )}
            </div>

            {/* Theme 3-Mode Switcher */}
            <div
              role="radiogroup"
              aria-label={t('extra.themeAria')}
              className="flex items-center rounded-lg p-0.5 bg-[var(--t-surface-2)] border border-[var(--t-border)] text-xs"
            >
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'dark'}
                aria-label={t('extra.dark')}
                onClick={() => setMode('dark')}
                title={`${t('extra.dark')} (${t('extra.default')})`}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface-2)] ${
                  mode === 'dark'
                    ? 'bg-[var(--t-surface)] text-[var(--t-accent)] shadow-xs font-semibold'
                    : 'text-[var(--t-text-3)] hover:text-[var(--t-text)]'
                }`}
              >
                <Moon size={14} className="text-[var(--t-accent)]" />
                <span className="hidden sm:inline">{t('extra.dark')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'light'}
                aria-label={t('extra.light')}
                onClick={() => setMode('light')}
                title={t('extra.light')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface-2)] ${
                  mode === 'light'
                    ? 'bg-[var(--t-surface)] text-[var(--t-accent)] shadow-xs font-semibold'
                    : 'text-[var(--t-text-3)] hover:text-[var(--t-text)]'
                }`}
              >
                <Sun size={14} className="text-[var(--t-warn)]" />
                <span className="hidden sm:inline">{t('extra.light')}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={mode === 'system'}
                aria-label={t('extra.system')}
                onClick={() => setMode('system')}
                title={t('extra.system')}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface-2)] ${
                  mode === 'system'
                    ? 'bg-[var(--t-surface)] text-[var(--t-text)] shadow-xs font-semibold'
                    : 'text-[var(--t-text-3)] hover:text-[var(--t-text)]'
                }`}
              >
                <Monitor size={14} />
                <span className="hidden sm:inline">{t('extra.system')}</span>
              </button>
            </div>
            <button
              type="button"
              onClick={toggleLocale}
              title={t('common.switchLanguage')}
              aria-label={t('common.language')}
              className="rounded-lg border border-[var(--t-border)] px-2.5 py-1.5 text-xs font-medium text-[var(--t-text-2)] hover:bg-[var(--t-hover)] hover:text-[var(--t-text)] cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface)]"
            >
              {locale === 'vi' ? 'EN' : 'VI'}
            </button>
          </div>
        </header>

        {/* Content (max-width: 1440px, padding: 24px = p-6) */}
        <main id="main-content" tabIndex={-1} className="flex-1 max-w-[1440px] w-full mx-auto p-6 min-w-0 focus:outline-hidden">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
