import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataSettings, LegacyArtifactReview } from '../src/DataSettings';
import type { DesktopAPI } from '../src/platform';
import type { CleanupPlan, DataUsage } from '../src/features';
const usage: DataUsage = {
  database: 1024,
  logs: 2048,
  artifacts: 1048576,
  temporary: 1024,
  backups: 4096,
  other: 0,
  total: 1056768,
  legacy: {
    pending: true,
    bytes: 1048576,
    successBytes: 524288,
    warnings: ['元数据缺失的文件已保留'],
  },
};
const plan: CleanupPlan = {
  token: 'fixture',
  kind: 'artifacts',
  files: 1,
  bytes: 524288,
  tasks: ['DC-old'],
  protected: 2,
  warnings: [],
};
const api = () =>
  ({
    dataUsage: vi.fn().mockResolvedValue(usage),
    previewCleanup: vi.fn().mockResolvedValue(plan),
    applyCleanup: vi.fn().mockResolvedValue({ files: 1, bytes: 524288, warnings: [] }),
  }) as unknown as DesktopAPI;
afterEach(cleanup);
it('分类展示数据占用，手动清理先显示释放空间、影响和受保护任务；取消不执行', async () => {
  const client = api(),
    user = userEvent.setup();
  render(<DataSettings api={client} onPolicy={() => {}} />);
  expect(await screen.findByText('产物快照')).toBeTruthy();
  expect(screen.getByText('数据库')).toBeTruthy();
  expect(screen.getByText('总计')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '清理产物快照' }));
  const dialog = screen.getByRole('dialog');
  expect(dialog.textContent).toContain('512.0 KB');
  expect(dialog.textContent).toContain('DC-old');
  expect(dialog.textContent).toContain('重新构建');
  expect(dialog.textContent).toContain('不会删除');
  expect(client.applyCleanup).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: '清理产物快照' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认应用' }));
  await waitFor(() => expect(client.applyCleanup).toHaveBeenCalledWith('fixture', true));
});
it('策略选择不直接改配置；预览确认后才保存，保留天数可配置', async () => {
  const client = api(),
    onPolicy = vi.fn(),
    user = userEvent.setup();
  const policy = { mode: 'count' as const, maxCount: 3, maxGB: 1, failedDays: 10 };
  vi.mocked(client.previewCleanup).mockResolvedValue({ ...plan, kind: 'policy', policy });
  vi.mocked(client.applyCleanup).mockResolvedValue({ bytes: 0, files: 0, warnings: [], policy });
  render(<DataSettings api={client} onPolicy={onPolicy} />);
  await user.selectOptions(screen.getByLabelText('产物保留方式'), 'count');
  await user.clear(screen.getByLabelText('保留不同 JAR 的数量'));
  await user.type(screen.getByLabelText('保留不同 JAR 的数量'), '3');
  await user.clear(screen.getByLabelText('失败或取消任务产物保留天数'));
  await user.type(screen.getByLabelText('失败或取消任务产物保留天数'), '10');
  expect(onPolicy).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '预览并应用保留策略' }));
  expect(client.previewCleanup).toHaveBeenCalledWith('policy', policy);
  expect(onPolicy).not.toHaveBeenCalled();
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认应用' }));
  await waitFor(() => expect(onPolicy).toHaveBeenCalledWith(policy));
});
it('旧版首次提示默认保留，必须先预览、再明确确认才能清理', async () => {
  const client = api(),
    onClose = vi.fn(),
    user = userEvent.setup();
  render(<LegacyArtifactReview api={client} usage={usage} onClose={onClose} />);
  expect(screen.getByRole('dialog').textContent).toContain('未经确认不会删除');
  expect(client.applyCleanup).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '查看建议清理范围' }));
  expect(client.previewCleanup).toHaveBeenCalledWith('legacy-success');
  expect(client.applyCleanup).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '确认清理成功任务产物' }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(client.applyCleanup).toHaveBeenCalledWith('fixture', true);
});
