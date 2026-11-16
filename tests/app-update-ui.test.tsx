import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppUpdateSettings } from '../src/AppUpdateSettings';
import { Modal } from '../src/ui';
import App from '../src/App';
import type { DesktopAPI, DesktopEvent } from '../src/platform';
import type { AppUpdate } from '../src/app-update';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function client(stage: AppUpdate['stage'] = 'idle') {
  let listener: (event: DesktopEvent) => void = () => {};
  const state: AppUpdate = {
    currentVersion: '1.5.2',
    stage,
    received: 0,
    speed: 0,
    ...(stage === 'ready'
      ? {
          release: {
            version: '1.5.3',
            notes: '<script>test</script>',
            publishedAt: '',
            size: 1024,
          },
        }
      : {}),
  };
  const api = {
    updateState: vi.fn().mockResolvedValue(state),
    checkUpdate: vi.fn().mockResolvedValue({ ...state, stage: 'current' }),
    downloadUpdate: vi.fn().mockResolvedValue({ ...state, stage: 'ready' }),
    cancelUpdate: vi.fn().mockResolvedValue(undefined),
    installUpdate: vi.fn().mockResolvedValue({ ...state, stage: 'installing' }),
    onEvent: vi.fn((fn: (event: DesktopEvent) => void) => {
      listener = fn;
      return () => {};
    }),
  };
  return {
    api: api as unknown as DesktopAPI,
    mocks: api,
    emit: (update: AppUpdate) => listener({ kind: 'update', update }),
    state,
  };
}
it('手动检查，下载和安装独立，订阅进度并安全显示更新说明', async () => {
  const f = client();
  render(<AppUpdateSettings api={f.api} version="1.5.2" active={false} />);
  await waitFor(() => expect(f.mocks.updateState).toHaveBeenCalled());
  expect(f.mocks.checkUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '检查更新' }));
  await waitFor(() => expect(screen.getByText('当前已是最新版本。')).toBeTruthy());
  act(() =>
    f.emit({
      ...f.state,
      stage: 'available',
      release: { version: '1.5.3', notes: '<script>不执行</script>', publishedAt: '', size: 100 },
    }),
  );
  expect(screen.getByRole('button', { name: '下载更新' })).toBeTruthy();
  expect(document.querySelector('script')).toBeNull();
  expect(f.mocks.installUpdate).not.toHaveBeenCalled();
  act(() =>
    f.emit({
      ...f.state,
      stage: 'downloading',
      received: 50,
      speed: 10,
      release: { version: '1.5.3', notes: '', publishedAt: '', size: 100 },
    }),
  );
  expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50');
  fireEvent.click(screen.getByRole('button', { name: '取消下载' }));
  await waitFor(() => expect(f.mocks.cancelUpdate).toHaveBeenCalled());
});
it('安装必须确认，活动任务禁止安装，后端拒绝时留在应用并显示原因', async () => {
  const f = client('ready');
  const view = render(<AppUpdateSettings api={f.api} version="1.5.2" active />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '退出并安装' }).hasAttribute('disabled')).toBe(true),
  );
  view.rerender(<AppUpdateSettings api={f.api} version="1.5.2" active={false} />);
  fireEvent.click(screen.getByRole('button', { name: '退出并安装' }));
  expect(screen.getByRole('dialog', { name: '确认安装更新' })).toBeTruthy();
  expect(f.mocks.installUpdate).not.toHaveBeenCalled();
  f.mocks.installUpdate.mockRejectedValueOnce(new Error('请先核实未结束的任务'));
  fireEvent.click(screen.getByRole('button', { name: '确认退出并安装' }));
  await waitFor(() =>
    expect(screen.getAllByRole('alert').some((e) => e.textContent?.includes('核实'))).toBe(true),
  );
  expect(screen.getByRole('dialog')).toBeTruthy();
});
it('移除页面快捷键和说明，Ctrl Enter 不再提交；Esc 和 Tab 仍可用', async () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /^设置$/ }));
  fireEvent.keyDown(window, { altKey: true, key: '1' });
  expect(screen.getByRole('heading', { name: /^设置$/ })).toBeTruthy();
  expect(screen.queryByText('快捷键', { exact: true })).toBeNull();
  const close = vi.fn(),
    submit = vi.fn();
  render(
    <Modal title="测试确认" onClose={close}>
      <button data-confirm onClick={submit}>
        提交
      </button>
    </Modal>,
  );
  fireEvent.keyDown(document, { ctrlKey: true, key: 'Enter' });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
});

it('Markdown 更新说明渲染标题、列表、代码和表格，阻止 HTML、远程图片及非项目链接', async () => {
  const f = client('ready');
  f.state.release!.notes =
    '# 版本优化\n\n## 修复项目\n\n- **缓存恢复** 与 `setup.exe`\n\n> 保留原数据\n\n| 项目 | 状态 |\n| --- | --- |\n| 缓存 | 完成 |\n\n[版本页面](https://github.com/liwl1995/DeployCenter/releases)\n\n[恶意](javascript:alert(1)) [其他站点](https://example.com)\n\n![远端图片](https://example.com/track.png)\n\n<script>window.bad=1</script><iframe src="https://example.com"></iframe>';
  const open = vi.fn().mockResolvedValue(undefined);
  f.api.openUpdateLink = open;
  render(<AppUpdateSettings api={f.api} version="1.5.6" active={false} />);
  await waitFor(() => expect(screen.getByRole('heading', { name: '版本优化' })).toBeTruthy());
  expect(screen.getByRole('heading', { name: '修复项目' })).toBeTruthy();
  expect(document.querySelector('.update-notes strong')?.textContent).toBe('缓存恢复');
  expect(document.querySelector('.update-notes code')?.textContent).toBe('setup.exe');
  expect(screen.getByRole('table')).toBeTruthy();
  expect(
    document.querySelector('.update-notes script,.update-notes iframe,.update-notes img'),
  ).toBeNull();
  expect(screen.queryByRole('link', { name: '恶意' })).toBeNull();
  expect(screen.queryByRole('link', { name: '其他站点' })).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: '版本页面' }));
  await waitFor(() =>
    expect(open).toHaveBeenCalledWith('https://github.com/liwl1995/DeployCenter/releases'),
  );
});
it('缓存位置单独展示，旧版缓存先检查再复用，错误移除 IPC 包装并使用失败提示', async () => {
  const f = client('idle');
  f.state.stage = 'cached';
  f.state.cacheDirectory = 'D:\\自定义 数据\\Updates';
  f.state.installerPath = 'D:\\自定义 数据\\Updates\\update-abc\\setup.exe';
  const open = vi.fn().mockResolvedValue(undefined);
  f.api.openUpdateCache = open;
  render(<AppUpdateSettings api={f.api} version="1.5.6" active={false} />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '检查并复用安装包' })).toBeTruthy(),
  );
  expect(screen.getByText(f.state.installerPath)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '打开下载位置' }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  f.mocks.checkUpdate.mockRejectedValueOnce(
    new Error("Error invoking remote method 'deploy:check-update': Error: 无法访问更新服务器"),
  );
  fireEvent.click(screen.getByRole('button', { name: '检查并复用安装包' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('无法访问更新服务器'));
  expect(screen.getByRole('alert').classList.contains('update-error')).toBe(true);
});
