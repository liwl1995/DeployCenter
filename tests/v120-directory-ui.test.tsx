import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DirectorySettings } from '../src/DirectorySettings';
import type { DesktopAPI } from '../src/platform';
const api = () =>
  ({
    directoryInfo: vi.fn().mockResolvedValue({ path: 'E:\\原数据', bytes: 1024, files: 2 }),
    migrationState: vi.fn().mockResolvedValue({
      state: 'idle',
      total: 0,
      copied: 0,
      files: 0,
      totalFiles: 0,
      message: '',
    }),
    onEvent: vi.fn(() => () => {}),
    previewCleanup: vi.fn().mockResolvedValue({
      bytes: 100,
      files: 1,
      tasks: [],
      warnings: [],
      protected: 0,
      token: 'fixture',
    }),
    inspectDirectory: vi.fn().mockResolvedValue({
      path: 'E:\\新数据',
      valid: true,
      errors: [],
      available: 10000000,
      required: 2048,
      empty: true,
      writable: true,
    }),
    migrateDirectory: vi.fn().mockResolvedValue({
      state: 'pending',
      total: 1024,
      copied: 1024,
      files: 2,
      totalFiles: 2,
      message: '请重启',
      target: 'E:\\新数据',
    }),
    keepOldData: vi.fn().mockResolvedValue(undefined),
    removeOldData: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
  }) as unknown as DesktopAPI;
afterEach(cleanup);
it('迁移前建议先清理，可选择保持现状；只有再次确认才开始迁移', async () => {
  const client = api(),
    onManage = vi.fn(),
    user = userEvent.setup();
  render(<DirectorySettings api={client} onManage={onManage} />);
  await screen.findByDisplayValue('E:\\原数据');
  await user.click(screen.getByRole('button', { name: '更换数据目录' }));
  await user.type(screen.getByLabelText('选择上级目录'), 'E:\\新数据');
  await user.click(screen.getByRole('button', { name: '检查并准备迁移' }));
  expect(screen.getByRole('dialog', { name: '迁移前可以先减少数据占用' }).textContent).toContain(
    '减少数据占用',
  );
  expect(client.migrateDirectory).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保持现状，继续检查目录' }));
  await screen.findByText('目录检查通过');
  expect(client.migrateDirectory).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog').textContent).toContain('原目录默认保留');
  await user.click(screen.getByRole('button', { name: '开始迁移' }));
  await waitFor(() => expect(client.migrateDirectory).toHaveBeenCalledWith('E:\\新数据'));
});
it('有中断任务时迁移按钮禁用并说明原因', async () => {
  render(
    <DirectorySettings api={api()} blocked="存在中断任务，请先核实结果" onManage={() => {}} />,
  );
  expect(screen.getByRole('button', { name: '更换数据目录' }).hasAttribute('disabled')).toBe(true);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toContain('中断任务');
});
it('旧副本默认保留，删除必须输入完整路径', async () => {
  const client = api(),
    user = userEvent.setup();
  vi.mocked(client.directoryInfo).mockResolvedValue({
    path: 'E:\\新数据',
    bytes: 1024,
    files: 2,
    previous: 'E:\\原数据',
  });
  render(<DirectorySettings api={client} onManage={() => {}} />);
  await screen.findByText('原数据副本仍保留');
  expect(client.removeOldData).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '查看旧目录清理确认' }));
  const d = within(screen.getByRole('dialog'));
  expect(d.getByRole('button', { name: '删除已核对的旧副本' }).hasAttribute('disabled')).toBe(true);
  await user.type(d.getByLabelText('输入完整旧目录路径确认'), 'E:\\原数据');
  await user.click(d.getByRole('button', { name: '删除已核对的旧副本' }));
  await waitFor(() => expect(client.removeOldData).toHaveBeenCalledWith('E:\\原数据'));
});
