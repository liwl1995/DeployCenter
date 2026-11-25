import { createRoot } from 'react-dom/client';
import App from './App';
import { desktop } from './platform';
import { initializeInputModality } from './design/lib/inputModality';
import { applyDocumentTheme } from './document-theme';
initializeInputModality();
async function mount() {
  try {
    if (typeof __PROTOTYPE__ !== 'undefined' && !__PROTOTYPE__ && !desktop)
      throw new Error('桌面接口未加载，请使用 Deploy Center.exe 启动');
    let releaseNotice: string | undefined;
    if (desktop?.importLegacyRelease) {
      try {
        const key = 'deploy-center-release-v1';
        const legacy = localStorage.getItem(key);
        if (legacy) {
          await desktop.importLegacyRelease(legacy);
          localStorage.removeItem(key);
        }
      } catch {
        releaseNotice = '旧发布清单未能迁移，原记录已保留。';
      }
    }
    const [boot] = await Promise.all([desktop?.load(), window.deployStartup]);
    if (boot && releaseNotice) boot.dataNotice = [boot.dataNotice, releaseNotice].filter(Boolean).join('；');
    applyDocumentTheme(boot?.database.settings.theme ?? 'system', boot?.darkTheme);
    createRoot(document.getElementById('root')!).render(<App boot={boot} />);
  } catch (error) {
    const startupTheme = document.documentElement.dataset.startupTheme;
    if (startupTheme) applyDocumentTheme('system', startupTheme === 'dark');
    document.getElementById('root')!.textContent = '无法读取本地数据：' + String(error);
  }
}
void mount();
