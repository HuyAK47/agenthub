(() => {
  const root = document.documentElement;
  const languageButton = document.querySelector('#language-toggle');
  const themeButton = document.querySelector('#theme-toggle');
  const copyButton = document.querySelector('#copy-install');
  const installCommand = document.querySelector('.command code')?.textContent.trim() ?? '';
  const english = {
    navFeatures:'Features',navHow:'How it works',navInstall:'Install',eyebrow:'AI orchestration for real projects',heroTitle:'One brain.<br><em>Many workers.</em><br>Ship with confidence.',heroLead:'AgentHub lets Claude coordinate Gravity/agy, Codex and Gemini — using quota across multiple accounts, running tasks in parallel and delivering checked code.',installCta:'Install for free →',heroNote:'Open source · AGPL-3.0 · Node.js 22+',builtFor:'BUILT FOR YOUR AI TOOLCHAIN',problemEyebrow:'The why',problemTitle:'You do not need<br><em>another terminal tab.</em>',problem1Title:'Many agents get messy',problem1Text:'Opening workers, watching logs, copying results and reviewing every branch quickly becomes the work itself.',problem2Title:'Quota is fragmented',problem2Text:'Accounts and models have separate quotas, but you have to remember when to switch to the next one.',solutionTitle:'AgentHub carries the hard part',solutionText:'One task queue, smart fallback, isolated worktrees and a reviewing brain — so you can focus on what to build.',seeHow:'See how it works →',featuresEyebrow:'Everything in one loop',featuresTitle:'One system for<br><em>the whole code lifecycle.</em>',featuresLead:'AgentHub connects brain, workers and repo in one observable workflow.',f1Title:'Project-aware brain',f1Text:'Claude keeps context, breaks down work and dispatches tasks through MCP tools.',f2Title:'Fallback chain',f2Text:'Move from harder to easier models, profiles or engines when quota runs out.',f3Title:'Multiple accounts',f3Text:'Rotate profiles and run multiple slots in parallel.',f4Title:'Isolated worktrees',f4Text:'Each task gets its own worktree and converges on the integration branch.',f5Title:'Check, then review',f5Text:'Lint, typecheck, tests and build run before review.',f6Title:'Control anywhere',f6Text:'Dashboard, Telegram or Claude Code in the terminal.',f7Title:'Self-deploy',f7Text:'Manage daemon, service and releases from the CLI.',f8Title:'Knowledge & performance',f8Text:'Knowledge, references, quota and savings help projects learn.',howEyebrow:'The loop',howTitle:'From idea to<br><em>a clean pull request.</em>',step1Title:'Delegate',step1Text:'Tell Claude what you want to build.',step2Title:'Worker executes',step2Text:'The task runs in an isolated worktree.',step3Title:'Self-check',step3Text:'Lint, typecheck, tests and build.',step4Title:'Review & merge',step4Text:'The brain reviews, then merges or deploys.',modesEyebrow:'Choose your interface',modesTitle:'Use it the way<br><em>that fits you.</em>',mode1Label:'STANDALONE',mode1Title:'Independent Hub',mode1Text:'A ready-made brain, dashboard for visibility and Telegram for remote control.',mode1a:'Integrated Claude orchestration',mode1b:'Web dashboard + Telegram',mode1c:'Made for continuous runs',mode2Label:'IN YOUR IDE',mode2Title:'Through MCP',mode2Text:'Use Claude Code in VS Code or the terminal and call hub_* tools directly.',mode2a:'Keep your familiar workflow',mode2b:'Clear MCP tools',mode2c:'Pair naturally with Claude',readDocs:'Read the docs →',installEyebrow:'Get started',installTitle:'Ready to<br><em>ship more?</em>',installText:'Linux glibc ≥ 2.31 is supported. macOS is experimental.',installHint:'Inspect the script before running it if you prefer.',uninstall:'Uninstallation guide →',faqTitle:'Frequently asked<br><em>questions.</em>',q1:'Does AgentHub call the Claude API directly?',a1:'No. The brain uses Claude Code installed on your machine; AgentHub coordinates processes and MCP.',q2:'Do I need multiple accounts?',a2:'No. Multiple profiles help use quota in parallel.',q3:'Does code leave my machine?',a3:'AgentHub runs locally. Model access and data handling follow the CLI/provider you configure.',q4:'Is AgentHub free?',a4:'The source is released under AGPL-3.0. Model costs depend on your accounts and providers.',footerText:'One brain for your AI engineering team.',docs:'Docs'
  };
  const nodes = [...document.querySelectorAll('[data-i18n]')];
  const vietnamese = Object.fromEntries(nodes.map((node) => [node.dataset.i18n, node.innerHTML]));
  const savedLanguage = (() => { try { return localStorage.getItem('agenthub-language'); } catch { return null; } })();
  let language = savedLanguage === 'en' || savedLanguage === 'vi' ? savedLanguage : (navigator.language?.toLowerCase().startsWith('vi') ? 'vi' : 'en');
  const applyLanguage = () => {
    document.documentElement.lang = language;
    nodes.forEach((node) => { node.innerHTML = (language === 'en' ? english[node.dataset.i18n] : vietnamese[node.dataset.i18n]) ?? vietnamese[node.dataset.i18n]; });
    languageButton.textContent = language === 'vi' ? 'EN' : 'VI';
    languageButton.setAttribute('aria-label', language === 'vi' ? 'Switch to English' : 'Chuyển sang tiếng Việt');
    try { localStorage.setItem('agenthub-language', language); } catch { /* storage may be disabled */ }
  };
  const applyTheme = (theme) => {
    if (theme === 'light' || theme === 'dark') root.dataset.theme = theme; else delete root.dataset.theme;
    const dark = theme === 'dark' || (!theme && matchMedia('(prefers-color-scheme: dark)').matches);
    themeButton.textContent = dark ? '☀' : '☾';
    themeButton.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  };
  const savedTheme = (() => { try { return localStorage.getItem('agenthub-theme'); } catch { return null; } })();
  const featureIcons = ['M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4','m13 2-8 12h6l-1 8 8-12h-6l1-8Z','M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M8 12h8M12 8v8','M6 4v16M18 4v16M6 8h12M6 16h12','M5 12l4 4L19 6','M4 12h16M12 4v16','M5 12a7 7 0 1 0 14 0 7 7 0 1 0-14 0Z M12 8v4l3 2','M5 5h14v14H5z M8 9h8M8 13h5'];
  document.querySelectorAll('.feature-grid article > b').forEach((icon, index) => {
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = `<svg viewBox="0 0 24 24" focusable="false"><path d="${featureIcons[index]}"/></svg>`;
  });
  languageButton.addEventListener('click', () => { language = language === 'vi' ? 'en' : 'vi'; applyLanguage(); });
  themeButton.addEventListener('click', () => { const next = root.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(next); try { localStorage.setItem('agenthub-theme', next); } catch { /* storage may be disabled */ } });
  copyButton.addEventListener('click', async () => { try { await navigator.clipboard.writeText(installCommand); copyButton.textContent = '✓'; setTimeout(() => { copyButton.textContent = '⧉'; }, 1400); } catch { copyButton.textContent = '—'; } });
  applyLanguage(); applyTheme(savedTheme);
})();
