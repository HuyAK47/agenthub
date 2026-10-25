(() => {
  const API_URL = 'https://api.github.com/repos/ducanh19020217/agenthub/releases?per_page=100';
  const CACHE_KEY = 'agenthub-download-stats-v1';
  const CACHE_TTL = 60 * 60 * 1000;
  const container = document.querySelector('#download-stats');
  if (!container) return;

  const readCache = () => {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
      return cached?.data && Number.isFinite(cached.savedAt) ? cached : null;
    } catch {
      return null;
    }
  };

  const saveCache = (data) => {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data, savedAt: Date.now() })); } catch {}
  };

  const format = (value) => {
    const locale = document.documentElement.lang === 'en' ? 'en-US' : 'vi-VN';
    if (value >= 1000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 1000)}K`;
    return new Intl.NumberFormat(locale).format(value);
  };

  const packagePattern = /^agenthub-(.+)-(linux|macos)-(x64|arm64)\.tar\.gz$/;
  const summarize = (releases) => {
    const valid = releases.filter((release) => !release.draft && Array.isArray(release.assets));
    const packages = valid.flatMap((release) => release.assets.flatMap((asset) => {
      const match = packagePattern.exec(asset.name);
      return match && Number.isFinite(asset.download_count) ? [{ ...asset, version: match[1], os: match[2], release }] : [];
    }));
    const latestRelease = valid.find((release) => packages.some((asset) => asset.release.id === release.id));
    const latest = packages.filter((asset) => asset.release.id === latestRelease?.id)
      .reduce((total, asset) => total + (Number.isFinite(asset.download_count) ? asset.download_count : 0), 0);
    return {
      total: packages.reduce((total, asset) => total + asset.download_count, 0),
      linux: packages.filter((asset) => asset.os === 'linux').reduce((total, asset) => total + asset.download_count, 0),
      macos: packages.filter((asset) => asset.os === 'macos').reduce((total, asset) => total + asset.download_count, 0),
      latest,
      latestTag: latestRelease?.tag_name ?? '',
      latestPrerelease: Boolean(latestRelease?.prerelease),
    };
  };

  const animate = (element, value) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { element.textContent = format(value); return; }
    const started = performance.now();
    const tick = (now) => {
      const progress = Math.min((now - started) / 650, 1);
      element.textContent = format(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  const render = (data) => {
    animate(container.querySelector('[data-stats-total]'), data.total);
    container.querySelector('[data-stats-linux]').textContent = `${document.documentElement.lang === 'en' ? 'Linux' : 'Linux'} ${format(data.linux)}`;
    container.querySelector('[data-stats-macos]').textContent = `${document.documentElement.lang === 'en' ? 'macOS' : 'macOS'} ${format(data.macos)}`;
    const latestLabel = document.documentElement.lang === 'en' ? 'Latest' : 'Mới nhất';
    const prerelease = data.latestPrerelease ? (document.documentElement.lang === 'en' ? ' (pre-release)' : ' (thử nghiệm)') : '';
    container.querySelector('[data-stats-latest]').textContent = `${latestLabel} ${format(data.latest)} · ${data.latestTag}${prerelease}`;
    container.hidden = false;
  };

  const refreshLocale = () => {
    const cache = readCache();
    if (cache?.data) render(cache.data);
  };
  window.addEventListener('agenthub:languagechange', refreshLocale);

  const cached = readCache();
  if (cached?.data && Date.now() - cached.savedAt < CACHE_TTL) render(cached.data);
  fetch(API_URL, { headers: { Accept: 'application/vnd.github+json' } })
    .then((response) => { if (!response.ok) throw new Error(`GitHub API ${response.status}`); return response.json(); })
    .then((releases) => { const data = summarize(releases); saveCache(data); render(data); })
    .catch(() => { if (cached?.data) render(cached.data); });
})();
