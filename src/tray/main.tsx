import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, ChevronRight, ExternalLink, Power, Settings } from 'lucide-react';
import type { TrayAction, TraySnapshot } from '../../electron/tray-panel';
import './panel.css';

declare global {
  interface Window {
    deployTray: {
      snapshot(): Promise<TraySnapshot>;
      action(name: TrayAction | 'hide', id?: string): Promise<TraySnapshot | undefined>;
      refresh(callback: () => void): () => void;
    };
  }
}
const api = window.deployTray;
function TrayMenu() {
  const [state, setState] = useState<TraySnapshot>();
  const [section, setSection] = useState<'tasks' | 'services'>('tasks');
  useEffect(() => {
    const refresh = () => { void api.snapshot().then(setState); };
    const unsubscribe = api.refresh(refresh);
    refresh();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void api.action('hide');
    };
    window.addEventListener('keydown', escape);
    return () => {
      unsubscribe();
      window.removeEventListener('keydown', escape);
    };
  }, []);
  const open = (name: TrayAction, id?: string) => void api.action(name, id).then((value) => {
    if (value) setState(value);
  });
  return (
    <main className={state?.dark ? 'dark' : ''} aria-label="部署中心托盘">
      <header>
        <strong>YOTOO 部署中心</strong>
        <button onClick={() => open('settings')} aria-label="设置" title="设置"><Settings size={16} /></button>
      </header>
      <nav aria-label="托盘分类">
        <button aria-pressed={section === 'tasks'} onClick={() => setSection('tasks')}>任务</button>
        <button aria-pressed={section === 'services'} onClick={() => setSection('services')}>服务</button>
      </nav>
      <section className="items">
        {section === 'tasks' ? <>
          {state?.task ? <button className="entry" onClick={() => open('task')}>
            <span><strong>{state.task.name}</strong><small>当前任务 · {state.task.progress}%</small></span>
            <ChevronRight size={16} />
          </button> : <p>暂无运行中的任务</p>}
          {state?.schedule && <button className="entry" onClick={() => open('schedules')}>
            <span><strong>{state.schedule.name}</strong><small>下一条计划 · {new Date(state.schedule.at).toLocaleString('zh-CN', { hour12: false })}</small></span>
            <ChevronRight size={16} />
          </button>}
        </> : state?.services.length ? state.services.map((service) =>
          <button key={service.id} className="entry service" onClick={() => open('service', service.id)}>
            <Box size={16} /><span>{service.name}</span><ChevronRight size={16} />
          </button>
        ) : <p>暂无最近使用的服务</p>}
      </section>
      <footer>
        <button className="entry" role="switch" aria-checked={!!state?.closeToTray} onClick={() => open('toggle')}>
          关闭到托盘 <span className="switch" aria-hidden="true" />
        </button>
        <div>
          <button onClick={() => open('open')}><ExternalLink size={15} />打开主窗口</button>
          <button onClick={() => open('quit')}><Power size={15} />退出</button>
        </div>
      </footer>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<TrayMenu />);
