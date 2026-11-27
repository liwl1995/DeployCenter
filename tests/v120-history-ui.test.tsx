import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskHistory } from '../src/TaskHistory';
import { DiagnosticPanel, FailureActions } from '../src/TaskExtras';
import { summarizeTask, importedSummaries } from '../src/history-model';
import { createTask } from '../src/engine';
import { seed } from '../src/model';
import type { DesktopAPI, TaskSummary } from '../src/platform';
afterEach(cleanup);
const api = () =>
  ({
    searchHistory: vi
      .fn()
      .mockResolvedValue({
        taskIds: ['DC-build-fail'],
        hits: [{ taskId: 'DC-build-fail', section: '构建日志', line: 42, text: '唯一日志命中' }],
        total: 1,
        warnings: [],
      }),
    cancelSearch: vi.fn().mockResolvedValue(undefined),
    diagnose: vi
      .fn()
      .mockResolvedValue({
        kind: 'disk',
        command: 'df -Pk -- /fixture',
        output: 'available fixture',
        ok: true,
        time: new Date().toISOString(),
      }),
  }) as unknown as DesktopAPI;
function rows() {
  const db = seed(),
    t = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  t.id = 'DC-check';
  t.status = 'success';
  t.dryRun = true;
  t.targets[0].status = 'success';
  t.note = '只读验收';
  const a = summarizeTask(t);
  t.id = 'DC-build-fail';
  t.status = 'failed';
  t.dryRun = false;
  t.targets = [];
  t.buildSteps[0].status = 'failed';
  t.note = '构建内容';
  return { db, rows: [a, summarizeTask(t)] as TaskSummary[] };
}
it('单个任务一行，试运行明确标注检查通过，构建失败无目标也可打开', async () => {
  const { db, rows: list } = rows(),
    open = vi.fn(),
    user = userEvent.setup();
  render(
    <TaskHistory
      api={api()}
      rows={list}
      db={db}
      busy={false}
      onOpen={open}
      onHistory={() => {}}
      onCopy={() => {}}
    />,
  );
  expect(document.querySelectorAll('.history-task')).toHaveLength(2);
  expect(screen.getByText('检查通过')).toBeTruthy();
  expect(screen.getByText('构建失败', { exact: true })).toBeTruthy();
  await user.click(screen.getByRole('row', { name: '查看任务：构建内容' }));
  expect(open).toHaveBeenCalledWith('DC-build-fail', undefined);
  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  await user.selectOptions(screen.getByLabelText('任务类型'), 'dry-run');
  await user.click(screen.getByRole('button', { name: '应用' }));
  expect(document.querySelectorAll('.history-task')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '展开目标' }));
  expect(screen.getByRole('button', { name: '查看目标详情' })).toBeTruthy();
});
it('自定义日期面板没有原生 date 输入，全文命中显示位置并能打开详情', async () => {
  const { db, rows: list } = rows(),
    open = vi.fn(),
    user = userEvent.setup(),
    client = api();
  const { container } = render(
    <TaskHistory
      api={client}
      rows={list}
      db={db}
      busy={false}
      onOpen={open}
      onHistory={() => {}}
      onCopy={() => {}}
    />,
  );
  expect(container.querySelector('input[type="date"]')).toBeNull();
  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  await user.click(screen.getByRole('button', { name: '自定义' }));
  await user.click(screen.getByRole('button', { name: '开始日期' }));
  expect(screen.getByRole('group', { name: '选择部署日期' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '清除日期筛选' }));
  await user.click(within(screen.getByRole('dialog', { name: '自定义日期范围' })).getByRole('button', { name: '取消' }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  await user.type(screen.getByLabelText('搜索完整历史'), '唯一日志命中');
  await waitFor(() => expect(screen.getByText('构建日志 · 第 42 行')).toBeTruthy());
  await user.click(screen.getByRole('button', { name: /构建日志 · 第 42 行/ }));
  expect(open).toHaveBeenCalledWith('DC-build-fail', undefined);
});
it('导入历史保留独立快照入口，实际任务不会重复显示', () => {
  const db = seed(),
    id = db.history[0].taskId;
  expect(importedSummaries(db, new Set([id])).some((r) => r.id === id)).toBe(false);
  expect(importedSummaries(db, new Set()).every((r) => r.imported)).toBe(true);
});

it('全文搜索先限定已应用的筛选，片段截断后仍显示所有命中任务', async () => {
  const { db, rows: list } = rows();
  const user = userEvent.setup();
  const client = api();
  const snippet = { taskId: 'DC-check', section: '构建日志', line: 1, text: '共享检索词' };
  vi.mocked(client.searchHistory)
    .mockResolvedValueOnce({
      taskIds: ['DC-check', 'DC-build-fail'], hits: [snippet], total: 201, warnings: [],
    })
    .mockResolvedValueOnce({ taskIds: [], hits: [], total: 0, warnings: [] });
  render(<TaskHistory api={client} rows={list} db={db} busy={false}
    onOpen={() => {}} onHistory={() => {}} onCopy={() => {}} />);
  await user.type(screen.getByLabelText('搜索完整历史'), ' 共享检索词 ');
  expect(await screen.findByText('命中 2 个任务，201 处匹配，展示前 1 处。')).toBeTruthy();
  expect(client.searchHistory).toHaveBeenNthCalledWith(1, '共享检索词', {
    taskIds: ['DC-build-fail', 'DC-check'],
  });
  expect(screen.getByRole('row', { name: '查看任务：构建内容' })).toBeTruthy();

  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  await user.selectOptions(screen.getByLabelText('任务结果'), 'failed');
  expect(client.searchHistory).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '应用' }));
  expect(screen.queryByText(/201 处匹配/)).toBeNull();
  expect(screen.getByText('正在搜索当前范围的完整日志…')).toBeTruthy();
  expect(await screen.findByText('无匹配记录，试试调整筛选或关键词。')).toBeTruthy();
  expect(client.searchHistory).toHaveBeenNthCalledWith(2, '共享检索词', {
    taskIds: ['DC-build-fail'],
  });
  expect(screen.getByText('命中 0 个任务，0 处匹配。')).toBeTruthy();
});

it('失败建议给出具体操作；诊断只在明确点击后执行，结果含命令和时间', async () => {
  const user = userEvent.setup(),
    client = api(),
    db = seed(),
    diagnose = vi.fn();
  const view = render(
    <FailureActions
      error="磁盘空间不足"
      directory="/fixture"
      onDiagnose={diagnose}
      onLogs={() => {}}
      onIdentity={() => {}}
      onBuild={() => {}}
    />,
  );
  await user.click(screen.getByRole('button', { name: '查看磁盘剩余' }));
  expect(diagnose).toHaveBeenCalledWith('disk');
  view.unmount();
  render(
    <DiagnosticPanel
      api={client}
      server={db.servers[0]}
      target={db.targets[0]}
      saved={[]}
      initial="disk"
    />,
  );
  expect(client.diagnose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '执行只读诊断' }));
  expect(await screen.findByText('available fixture')).toBeTruthy();
  expect(screen.getByText('执行命令：df -Pk -- /fixture')).toBeTruthy();
});

it('筛选先编辑草稿，取消和重置不提前改变记录，应用后可逐项清除', async () => {
  const user = userEvent.setup();
  const { db, rows: list } = rows();
  render(<TaskHistory api={api()} rows={list} db={db} busy={false}
    onOpen={() => {}} onHistory={() => {}} onCopy={() => {}} />);
  expect(screen.queryByLabelText('任务类型')).toBeNull();
  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  await user.selectOptions(screen.getByLabelText('任务类型'), 'dry-run');
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(document.querySelectorAll('.history-task')).toHaveLength(2);
  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  expect((screen.getByLabelText('任务类型') as HTMLSelectElement).value).toBe('all');
  await user.selectOptions(screen.getByLabelText('任务类型'), 'dry-run');
  await user.selectOptions(screen.getByLabelText('任务结果'), 'success');
  await user.click(screen.getByRole('button', { name: '应用' }));
  expect(document.querySelectorAll('.history-task')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '移除类型：试运行' }));
  expect(screen.getByRole('button', { name: '移除结果：已完成 / 检查通过' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '筛选部署历史' }));
  await user.click(screen.getByRole('button', { name: '重置' }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(document.querySelectorAll('.history-task')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '全部清除' }));
  expect(document.querySelectorAll('.history-task')).toHaveLength(2);
});
