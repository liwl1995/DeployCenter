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
