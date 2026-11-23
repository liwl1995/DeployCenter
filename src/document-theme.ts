export function applyDocumentTheme(theme: 'light' | 'dark' | 'system', nativeDark?: boolean) {
  const root = document.documentElement;
  const dark = theme === 'dark' ||
    (theme === 'system' && (nativeDark ?? window.matchMedia?.('(prefers-color-scheme: dark)').matches));
  root.dataset.theme = theme;
  root.classList.toggle('dark', !!dark);
}
