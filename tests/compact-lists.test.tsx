import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskHistory } from '../src/TaskHistory';
import { BuildEnvironment } from '../src/BuildEnvironment';
import { compactVersion, historyDay, historyState, shortReason } from '../src/compact-list';
import { seed } from '../src/model';
import { importedSummaries } from '../src/history-model';
import type { DesktopAPI, TaskSummary } from '../src/platform';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function row(change: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: 'DC-compact',
    service: '校园告警',
    operation: 'deploy',
    status: 'success',
    started: '2026-11-13T10:00:00',
    elapsed: 62,
    note: '优化告警查询',
    commit: 'a'.repeat(40),
    jarHash: 'b'.repeat(64),
    targets: [
      {
        id: 'target',
        name: '测试环境',
        serverId: 'host',
        server: '服务器',
        status: 'unverified',
        elapsed: 60,
      },
    ],
    ...change,
  };
}
const api = () =>
  ({
    cancelSearch: vi.fn().mockResolvedValue(undefined),
    searchHistory: vi.fn().mockResolvedValue({ hits: [], total: 0, warnings: [] }),
  }) as unknown as DesktopAPI;
it('日期分组使用本地日期，正确处理跨月昨天及未知时间；版本来自实际检测输出', () => {
  const now = new Date('2026-11-01T01:00:00');
  expect(historyDay('2026-11-01T00:30:00', now).label).toBe('今天 · 2026-11-01');
  expect(historyDay('2026-10-31T23:00:00', now).label).toBe('昨天 · 2026-10-31');
  expect(historyDay('无时间', now).label).toBe('时间未记录');
  expect(compactVersion('openjdk version "21.0.8" 2025-07-15\njavac 21.0.8', 'jdk')).toBe(
    'Java 21.0.8',
  );
  expect(compactVersion('\x1b[1mApache Maven 3.9.9\x1b[0m\nMaven home: C:/tools', 'maven')).toBe(
    'Maven 3.9.9',
  );
  expect(compactVersion('命令成功但没有版本', 'maven')).toBe('版本未识别');
  expect(
    shortReason(
      "Error: Error invoking remote method 'deploy:check-tool': Error: 找不到 JDK\n详细错误",
    ),
  ).toBe('找不到 JDK 详细错误');
});
it('摘要不把健康未验证或自动回滚显示为成功，保留试运行和记录异常含义', () => {
  expect(historyState(row())).toEqual({ label: '健康未验证', tone: 'warn' });
  expect(historyState(row({ dryRun: true })).label).toBe('检查通过');
  expect(
    historyState(
      row({ status: 'failed', targets: [{ ...row().targets![0], status: 'rolledback' }] }),
    ).label,
  ).toContain('已回滚');
  expect(historyState(row({ buildFailed: true, status: 'failed' })).label).toBe('构建失败');
  expect(historyState(row({ uncertain: true })).label).toBe('记录无法读取');
  expect(historyState(row({ status: 'cancelled' })).tone).toBe('neutral');
});
it('每次任务独立一行，默认不展开，整行及键盘打开；菜单和目标按钮不误触发打开', async () => {
  const open = vi.fn(),
    copy = vi.fn(),
    user = userEvent.setup();
  const db = seed();
  render(
    <TaskHistory
      rows={[row(), row({ id: 'DC-second', started: '2026-11-12T08:00:00' })]}
      db={db}
      api={api()}
      busy={false}
      onOpen={open}
      onCopy={copy}
      onHistory={() => {}}
    />,
  );
  expect(document.querySelectorAll('.history-task')).toHaveLength(2);
  expect(document.querySelectorAll('.compact-detail-row')).toHaveLength(0);
  const first = document.querySelector<HTMLElement>('.history-task')!;
  first.focus();
  fireEvent.keyDown(first, { key: 'Enter' });
  expect(open).toHaveBeenCalledWith('DC-compact', undefined);
  open.mockClear();
  await user.click(within(first).getByRole('button', { name: '展开目标' }));
  expect(open).not.toHaveBeenCalled();
  expect(screen.getAllByText('已启动 · 健康未验证')).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: '查看目标详情' }));
  expect(open).toHaveBeenCalledWith('DC-compact', 'target');
  open.mockClear();
  await user.click(within(first).getByRole('button', { name: '更多任务 DC-compact操作' }));
  await user.click(screen.getByRole('menuitem', { name: '复制 JAR 指纹' }));
  expect(copy).toHaveBeenCalledWith('b'.repeat(64));
  expect(open).not.toHaveBeenCalled();
});
it('导入历史仍打开历史快照，忙碌或损坏记录不能打开任务', async () => {
  const db = seed(),
    imported = importedSummaries(db, new Set())[0],
    history = vi.fn(),
    open = vi.fn();
  const view = render(
    <TaskHistory
      rows={[imported]}
      db={db}
      api={api()}
      busy={false}
      onOpen={open}
      onCopy={() => {}}
      onHistory={history}
    />,
  );
  fireEvent.click(document.querySelector('.history-task')!);
  expect(history).toHaveBeenCalled();
  expect(open).not.toHaveBeenCalled();
  view.rerender(
    <TaskHistory
      rows={[row({ uncertain: true })]}
      db={db}
      api={api()}
      busy={false}
      onOpen={open}
      onCopy={() => {}}
      onHistory={history}
    />,
  );
  fireEvent.click(document.querySelector('.history-task')!);
  expect(open).not.toHaveBeenCalled();
  view.rerender(
    <TaskHistory
      rows={[row()]}
      db={db}
      api={api()}
      busy
      onOpen={open}
      onCopy={() => {}}
      onHistory={history}
    />,
  );
  fireEvent.click(document.querySelector('.history-task')!);
  expect(open).not.toHaveBeenCalled();
});
it('构建摘要版本、路径和关联数可见，详情按需展开；切换标签不重复检测，编辑不展开行', async () => {
  const db = seed(),
    user = userEvent.setup(),
    edit = vi.fn();
  const client = {
    save: vi.fn().mockResolvedValue(undefined),
    checkTool: vi.fn().mockResolvedValue('openjdk version "21.0.8"\njavac 21.0.8'),
    toolInfo: vi.fn().mockImplementation((serviceId: string) =>
      Promise.resolve({
        serviceId,
        available: true,
        reason: '',
        tool: 'D:/项目 中文/mvnw.cmd',
        workDir: 'D:/项目 中文',
        javaVersion: 'openjdk version "21.0.8"',
        version: 'Apache Maven 3.9.9\nMaven home: fixture',
      }),
    ),
  };
  render(
    <BuildEnvironment
      api={client as unknown as DesktopAPI}
      db={db}
      onAdd={() => {}}
      onScan={() => {}}
      onEdit={edit}
      onDelete={() => {}}
      deletionReason={() => '仍被服务使用'}
    />,
  );
  await waitFor(() => expect(client.toolInfo).toHaveBeenCalledTimes(db.services.length));
  expect(document.querySelectorAll('.compact-detail-row')).toHaveLength(0);
  const jdk = screen.getByRole('row', { name: 'JDK ' + db.jdks[0].name });
  expect(within(jdk).getByText('Java 21.0.8')).toBeTruthy();
  fireEvent.keyDown(jdk, { key: 'Enter' });
  expect(document.querySelector('.tool-version')?.textContent).toContain('javac');
  await user.click(screen.getByRole('tab', { name: '服务构建工具' }));
  const panel = screen.getByRole('tabpanel', { name: '服务构建工具' });
  const service = within(panel).getByRole('row', { name: '构建工具 ' + db.services[0].name });
  expect(within(service).getByText('Wrapper')).toBeTruthy();
  expect(within(service).getByText('Maven 3.9.9')).toBeTruthy();
  await user.click(within(service).getByRole('button', { name: '编辑配置' }));
  expect(edit).toHaveBeenCalledWith(db.services[0]);
  expect(service.getAttribute('aria-expanded')).toBe('false');
  await user.click(service);
  expect(within(panel).getByText('Maven Profile')).toBeTruthy();
  await user.click(screen.getByRole('tab', { name: 'JDK 管理' }));
  expect(client.checkTool).toHaveBeenCalledTimes(db.jdks.length);
  await user.click(within(jdk).getByRole('button', { name: /更多 JDK/ }));
  expect(screen.getByRole('menuitem', { name: '删除 JDK 配置' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it('检测失败摘要给出原因，完整错误默认收起，尚未轮到的条目显示等待检测', async () => {
  const db = seed();
  let finish!: (v: string) => void;
  const client = {
    save: vi.fn().mockResolvedValue(undefined),
    checkTool: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      )
      .mockRejectedValue(new Error('路径不可用\n详细错误')),
    toolInfo: vi.fn().mockResolvedValue({
      available: false,
      reason: '找不到 Maven，请配置路径',
      tool: '',
      version: '',
      javaVersion: '',
      workDir: '',
    }),
  };
  render(
    <BuildEnvironment
      api={client as unknown as DesktopAPI}
      db={db}
      onAdd={() => {}}
      onScan={() => {}}
      onEdit={() => {}}
      onDelete={() => {}}
      deletionReason={() => ''}
    />,
  );
  await waitFor(() => expect(client.checkTool).toHaveBeenCalledOnce());
  expect(screen.getAllByText('等待检测').length).toBeGreaterThan(0);
  finish('java version "21"');
  await waitFor(() => expect(client.toolInfo).toHaveBeenCalledTimes(db.services.length));
  expect(document.querySelector('.tool-version')).toBeNull();
  expect(screen.getAllByText('不可用').length).toBeGreaterThan(0);
  await userEvent.setup().click(screen.getByRole('tab', { name: '服务构建工具' }));
  expect(screen.getAllByText('找不到 Maven，请配置路径').length).toBeGreaterThan(0);
});

it('窗口收窄时真正移除版本列，表头和展开内容列数保持一致，恢复宽屏后版本重新显示', () => {
  let wide = true;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return wide;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  const view = render(
    <TaskHistory
      rows={[row()]}
      db={seed()}
      api={api()}
      busy={false}
      onOpen={() => {}}
      onCopy={() => {}}
      onHistory={() => {}}
    />,
  );
  expect(document.querySelectorAll('thead th')).toHaveLength(7);
  act(() => {
    wide = false;
    listeners.forEach((fn) => fn());
  });
  expect(document.querySelectorAll('thead th')).toHaveLength(6);
  expect(document.querySelectorAll('.history-task td')).toHaveLength(6);
  fireEvent.click(screen.getByRole('button', { name: '展开目标' }));
  expect(document.querySelector('.compact-detail-row td')?.getAttribute('colspan')).toBe('6');
  act(() => {
    wide = true;
    listeners.forEach((fn) => fn());
  });
  expect(document.querySelectorAll('thead th')).toHaveLength(7);
  expect(document.querySelector('.compact-detail-row td')?.getAttribute('colspan')).toBe('7');
  view.unmount();
  expect(listeners.size).toBe(0);
});
