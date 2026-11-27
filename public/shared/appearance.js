(() => {
  const system = matchMedia('(prefers-color-scheme: dark)');
  const meta = document.querySelector('meta[name="theme-color"]');
  const lightThemeColor = meta?.content;
  function applyTheme() {
    let preferred;
    try { preferred = localStorage.getItem('stackforge.theme'); } catch {}
    const dark = preferred === 'dark' || preferred === 'system' && system.matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (meta) meta.content = dark ? '#151c1d' : lightThemeColor;
  }
  applyTheme();
  system.addEventListener('change', applyTheme);
  window.addEventListener('stackforge:theme', applyTheme);
  window.addEventListener('storage', event => {
    if (event.key === 'stackforge.theme' || event.key === null) applyTheme();
  });
})();
