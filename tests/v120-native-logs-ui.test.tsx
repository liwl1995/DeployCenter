import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NativeLogPanel } from '../src/NativeLogPanel';
import type { DesktopAPI, DesktopEvent } from '../src/platform';
afterEach(cleanup);
function bridge() {
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      build: ['[ERROR] 最近错误', ''],
      target: [],
      truncated: true,
      buildStart: 100,
      targetStart: 0,
      buildOffset: 130,
      targetOffset: 0,
      buildContexts: [{ offset: 100, end: 130, step: '完成构建' }],
    })
    .mockResolvedValue({
      build: ['[ERROR] 第一处错误', '较早构建输出', ''],
      target: [],
      truncated: false,
      buildStart: 0,
      targetStart: 0,
      buildOffset: 100,
      targetOffset: 0,
      buildContexts: [{ offset: 0, end: 100, step: '构建产物' }],
    });
  let event: (e: DesktopEvent) => void = () => {};
  const api = {
    readLogs: read,
    onEvent: vi.fn().mockImplementation((cb) => {
      event = cb;
      return () => {};
    }),
    exportLogs: vi.fn().mockResolvedValue(true),
  } as unknown as DesktopAPI;
  return { api, read, emit: (value: DesktopEvent) => event(value) };
}
it('分批加载较早日志保持顺序和原行，使用正确范围，支持完整导出', async () => {
  const { api, read } = bridge(),
    user = userEvent.setup();
  render(<NativeLogPanel api={api} taskId="DC-page" targetId="target" initial={[]} />);
  await screen.findByText('[ERROR] 最近错误');
  await user.click(screen.getByRole('button', { name: '加载更早日志' }));
  await screen.findByText('[ERROR] 第一处错误');
  expect(read).toHaveBeenLastCalledWith('DC-page', 'target', { build: 100, target: 0 });
  expect(screen.queryByRole('button', { name: '加载更早日志' })).toBeNull();
  expect(screen.getAllByText('[ERROR] 最近错误')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '导出完整日志' }));
  expect(api.exportLogs).toHaveBeenCalledWith('DC-page', 'target');
});
it('点击较早步骤会自动补页；第一处错误定位从原日志开头查找，不把末尾错误冒充第一处', async () => {
  const { api, read } = bridge();
  const view = render(
    <NativeLogPanel
      api={api}
      taskId="DC-page"
      targetId="target"
      initial={[]}
      focusStep={{ name: '构建产物', nonce: 1 }}
    />,
  );
  await screen.findByText('[ERROR] 第一处错误');
  expect(read).toHaveBeenCalledTimes(2);
  view.rerender(
    <NativeLogPanel api={api} taskId="DC-page" targetId="target" initial={[]} focusError={2} />,
  );
  await waitFor(() =>
    expect(document.querySelector('.log-match')?.textContent).toContain('第一处错误'),
  );
});

it('连续收到日志时合并刷新，保留全部分片并继续跟随', async () => {
  const { api, emit } = bridge();
  render(<NativeLogPanel api={api} taskId="DC-page" targetId="target" initial={[]} />);
  await screen.findByText('[ERROR] 最近错误');
  act(() => {
    for (let i = 0; i < 50; i++) {
      emit({ kind: 'log', taskId: 'DC-page', targetId: 'target', text: '构建输出 ' + i + '\n' });
    }
  });
  expect(screen.queryByText('构建输出 49')).toBeNull();
  await screen.findByText('构建输出 49');
  expect(screen.getByText(/共 51 行/)).toBeTruthy();
  expect((screen.getByLabelText('跟随最新') as HTMLInputElement).checked).toBe(true);
});
