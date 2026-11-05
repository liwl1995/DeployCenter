import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DateRangeFilter } from '../src/DateRangeFilter';
import { recentDates, withinDateRange } from '../src/date-range';
import { DirectorySettings } from '../src/DirectorySettings';
import { TargetConfiguration } from '../src/TargetConfiguration';
import { migrationPercent } from '../src/migration-view';
import { readExpandedTargets, saveExpandedTargets } from '../src/layout-state';
import { seed } from '../src/model';
import type { DesktopAPI, DesktopEvent } from '../src/platform';
import App from '../src/App';
import { createTask } from '../src/engine';
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function client() {
  let listener: (event: DesktopEvent) => void = () => {};
  const api = {
    directoryInfo: vi.fn().mockResolvedValue({ path: 'E:\\旧位置', bytes: 1024, files: 2 }),
    migrationState: vi.fn().mockResolvedValue({
      state: 'idle',
      copied: 0,
      total: 0,
      files: 0,
      totalFiles: 0,
      message: '',
    }),
    onEvent: vi.fn((fn: (event: DesktopEvent) => void) => {
      listener = fn;
      return () => {};
    }),
    openDataDir: vi.fn().mockResolvedValue(undefined),
    previewCleanup: vi.fn().mockResolvedValue({ bytes: 0 }),
    inspectDirectory: vi.fn().mockResolvedValue({
      path: 'D:\\AppData\\DeployCenter',
      valid: true,
      errors: [],
      empty: true,
      writable: true,
      available: 100000,
      required: 100,
    }),
    migrateDirectory: vi.fn().mockResolvedValue({
      state: 'pending',
      copied: 1024,
      total: 1024,
      files: 2,
      totalFiles: 2,
      message: '完成',
      target: 'D:\\AppData\\DeployCenter',
    }),
    cancelMigration: vi.fn().mockResolvedValue(undefined),
    keepOldData: vi.fn().mockResolvedValue(undefined),
    removeOldData: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn().mockResolvedValue(undefined),
  };
  return { api: api as unknown as DesktopAPI, emit: (event: DesktopEvent) => listener(event) };
}
it('快捷范围包含今天，跨月及闰年正确，自定义比较不使用模糊日期解析', () => {
  expect(recentDates(7, new Date(2024, 2, 1))).toEqual({ from: '2024-02-24', to: '2024-03-01' });
  expect(withinDateRange('2024-02-29', { from: '2024-02-24', to: '2024-03-01' })).toBe(true);
  expect(withinDateRange('2024-03-02', { from: '2024-02-24', to: '2024-03-01' })).toBe(false);
  expect(withinDateRange('未知日期', { from: '2024-02-24', to: '2024-03-01' })).toBe(false);
});
it('自定义日期范围使用主题日历，倒置范围禁用，取消不更改筛选', async () => {
  const user = userEvent.setup(),
    change = vi.fn();
  const { container } = render(
    <DateRangeFilter value={{ from: '2026-02-02', to: '2026-02-05' }} onChange={change} />,
  );
  expect(container.querySelector('input[type="date"]')).toBeNull();
  await user.click(screen.getByRole('button', { name: '近 7 天' }));
  expect(change).toHaveBeenLastCalledWith(recentDates(7));
  change.mockClear();
  await user.click(screen.getByRole('button', { name: '自定义' }));
  await user.click(screen.getByRole('button', { name: '开始日期' }));
  await user.click(screen.getByRole('button', { name: '2026-02-06' }));
  expect(screen.getByRole('button', { name: '应用日期范围' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('不能晚于');
  await user.click(screen.getByRole('button', { name: '结束日期' }));
  await user.click(screen.getByRole('button', { name: '2026-02-08' }));
  await user.click(screen.getByRole('button', { name: '应用日期范围' }));
  expect(change).toHaveBeenLastCalledWith({ from: '2026-02-06', to: '2026-02-08' });
  change.mockClear();
  await user.click(screen.getByRole('button', { name: '自定义' }));
  await user.click(screen.getByRole('button', { name: '取消' }));
  expect(change).not.toHaveBeenCalled();
});
it('数据位置只提供当前目录和向导入口，选择上级目录后显示最终路径，再检查和确认迁移', async () => {
  const { api } = client(),
    user = userEvent.setup();
  render(<DirectorySettings api={api} onManage={() => {}} />);
  await screen.findByDisplayValue('E:\\旧位置');
  expect(screen.queryByLabelText('选择上级目录')).toBeNull();
  expect(screen.queryByRole('button', { name: '使用说明' })).toBeNull();
  expect(screen.queryByRole('button', { name: '关于' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '更换数据目录' }));
  await user.type(screen.getByLabelText('选择上级目录'), 'D:\\AppData');
  expect(screen.getByTestId('migration-final-path').textContent).toBe('D:\\AppData\\DeployCenter');
  await user.click(screen.getByRole('button', { name: '检查并准备迁移' }));
  await screen.findByText('目录检查通过');
  expect(api.inspectDirectory).toHaveBeenCalledWith('D:\\AppData');
  expect(api.migrateDirectory).not.toHaveBeenCalled();
  vi.mocked(api.migrationState).mockResolvedValue({
    state: 'pending',
    copied: 1024,
    total: 1024,
    files: 2,
    totalFiles: 2,
    message: '完成',
    target: 'D:\\AppData\\DeployCenter',
  });
  await user.click(screen.getByRole('button', { name: '开始迁移' }));
  await waitFor(() => expect(api.migrateDirectory).toHaveBeenCalledWith('D:\\AppData'));
  expect(await screen.findByRole('button', { name: '重启并使用新目录' })).toBeTruthy();
});
it('等待配置保存期间取消后不再发起迁移；进度显示阶段、文件、速度并保留取消入口', async () => {
  const { api, emit } = client(),
    user = userEvent.setup();
  let release!: () => void;
  const before = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  render(<DirectorySettings api={api} beforeMigrate={before} onManage={() => {}} />);
  await user.click(screen.getByRole('button', { name: '更换数据目录' }));
  await user.type(screen.getByLabelText('选择上级目录'), 'D:\\AppData');
  await user.click(screen.getByRole('button', { name: '检查并准备迁移' }));
  await user.click(await screen.findByRole('button', { name: '开始迁移' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '取消迁移，保留原目录' }));
  expect(screen.getByRole('button', { name: '关闭弹窗' }).hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: '取消迁移，保留原目录' }));
  await act(async () => release());
  expect(api.migrateDirectory).not.toHaveBeenCalled();
  expect(screen.getAllByText(/迁移已取消/).length).toBeGreaterThan(0);
  act(() =>
    emit({
      kind: 'migration',
      progress: {
        state: 'copying',
        copied: 1024,
        total: 4096,
        files: 1,
        totalFiles: 4,
        message: '正在复制',
        currentFile: '日志\\完整.log',
        bytesPerSecond: 1024,
        remainingSeconds: 3,
      },
    }),
  );
  expect(screen.getByRole('button', { name: '取消迁移，保留原目录' })).toBeTruthy();
  expect(screen.getByText(/当前文件：日志/)).toBeTruthy();
  expect(screen.getByText(/预计剩余：3 秒/)).toBeTruthy();
  expect(
    migrationPercent({
      state: 'copying',
      copied: 1024,
      total: 4096,
      files: 1,
      totalFiles: 4,
      message: '',
    }),
  ).toBe(20);
});
it('目标信息按连接运行保护分组，高级项折叠；Docker 与普通 JAR 展示各自字段', () => {
  const db = seed(),
    target = db.targets[0];
  const view = render(<TargetConfiguration target={target} server={db.servers[0]} />);
  for (const name of ['连接', '运行', '保护'])
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  expect(view.container.querySelectorAll('.configuration-grid').length).toBeGreaterThanOrEqual(3);
  expect(view.container.querySelector('details')?.open).toBe(false);
  expect(screen.getByText(target.container)).toBeTruthy();
  expect(screen.queryByText('停止命令')).toBeNull();
  view.rerender(
    <TargetConfiguration
      target={{ ...target, mode: 'jar', start: './app.jar start', stop: './app.jar stop' }}
    />,
  );
  expect(screen.getByText('./app.jar stop')).toBeTruthy();
  expect(screen.queryByText(target.container)).toBeNull();
});
it('展开偏好按数据位置隔离，无效偏好不影响配置；快速前往入口和按键已移除', async () => {
  saveExpandedTargets('A', ['one']);
  expect(readExpandedTargets('A')).toEqual(['one']);
  expect(readExpandedTargets('B')).toEqual([]);
  localStorage.setItem('yotoo-ui-expanded-targets:B', '非法');
  expect(readExpandedTargets('B')).toEqual([]);
  render(<App />);
  expect(screen.queryByRole('button', { name: /快速前往/ })).toBeNull();
  fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('contentinfo', { name: '应用状态' })).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: '部署历史' }));
  expect(document.querySelector('input[type="date"]')).toBeNull();
});

it('多目标任务在顶部使用状态条并同步日志目标，单目标没有第二列或多余切换栏', async () => {
  const db = seed(),
    task = createTask(
      db,
      db.services[0],
      db.targets.filter((t) => t.serviceId === db.services[0].id).slice(0, 2),
      {},
      'existing',
    );
  task.status = 'success';
  task.buildPhase = 3;
  task.targets.forEach((run) => {
    run.status = 'success';
    run.phase = run.steps.length;
  });
  const boot = {
    database: db,
    task,
    unfinished: [],
    dataDir: 'UI隔离目录',
    savedCredentials: [],
    encryptionAvailable: false,
  };
  const user = userEvent.setup(),
    view = render(<App boot={boot} />);
  await user.click(screen.getByRole('button', { name: '当前任务' }));
  const strip = screen.getByRole('group', { name: '选择任务目标' });
  expect(strip.querySelectorAll('button')).toHaveLength(2);
  await user.click(within(strip).getAllByRole('button')[1]);
  await user.click(screen.getByRole('tab', { name: '执行日志' }));
  expect(screen.getByRole('group', { name: '选择任务目标' })).toBeTruthy();
  expect((screen.getByRole('combobox', { name: '日志目标' }) as HTMLSelectElement).value).toBe('1');
  expect(view.container.querySelector('.task-layout')).toBeNull();
  view.unmount();
  render(<App boot={{ ...boot, task: { ...task, targets: task.targets.slice(0, 1) } }} />);
  await user.click(screen.getByRole('button', { name: '当前任务' }));
  expect(screen.queryByRole('group', { name: '选择任务目标' })).toBeNull();
});

it('迁移失败显示本次原因并继续使用旧位置，不沿用旧任务的取消状态', async () => {
  const { api } = client(),
    user = userEvent.setup();
  render(<DirectorySettings api={api} onManage={() => {}} />);
  await user.click(screen.getByRole('button', { name: '更换数据目录' }));
  await user.type(screen.getByLabelText('选择上级目录'), 'D:\\AppData');
  await user.click(screen.getByRole('button', { name: '检查并准备迁移' }));
  await screen.findByText('目录检查通过');
  vi.mocked(api.migrateDirectory).mockRejectedValue(new Error('目标磁盘无法写入'));
  vi.mocked(api.migrationState).mockResolvedValue({
    state: 'cancelled',
    copied: 0,
    total: 0,
    files: 0,
    totalFiles: 0,
    message: '上次已取消',
  });
  await user.click(screen.getByRole('button', { name: '开始迁移' }));
  expect(await screen.findByRole('heading', { name: '迁移失败' })).toBeTruthy();
  expect(screen.getAllByText(/目标磁盘无法写入/).length).toBeGreaterThan(0);
  expect((screen.getByLabelText('当前目录') as HTMLInputElement).value).toBe('E:\\旧位置');
});
