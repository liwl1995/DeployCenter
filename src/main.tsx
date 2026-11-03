import { createRoot } from 'react-dom/client';
import App from './App';
import { desktop } from './platform';
async function mount() {
  try {
    if (typeof __PROTOTYPE__ !== 'undefined' && !__PROTOTYPE__ && !desktop)
      throw new Error('桌面接口未加载，请使用 Deploy Center.exe 启动');
    const boot = desktop ? await desktop.load() : undefined;
    createRoot(document.getElementById('root')!).render(<App boot={boot} />);
  } catch (error) {
    document.getElementById('root')!.textContent = '无法读取本地数据：' + String(error);
  }
}
void mount();
