import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { seed, type Preset } from '../src/model';
import { emptyDatabase } from '../src/defaults';
import { FirstGuide, PresetShelf } from '../src/WorkspaceHome';
import { preparePreset, localComparison, guideSteps } from '../src/workspace-model';
import { RemoteBackups } from '../src/RemoteBackups';
import { Modal } from '../src/ui';
import type { DesktopAPI } from '../src/platform';
const preset = (): Preset => {
  const db = seed();
  return {
    id: 'preset',
    name: '常用发布',
    pinned: true,
    serviceId: db.services[0].id,
    targetIds: [db.targets[0].id],
    build: 'existing',
    overrides: { [db.targets[0].id]: db.targets[0].backup },
    failurePolicy: 'continue',
  };
};
afterEach(cleanup);
it('引导包含五步和配置跳转，全部完成后隐藏，空数据库不生成示例', async () => {
  const user = userEvent.setup(),
    onPage = vi.fn(),
    db = emptyDatabase();
  const view = render(<FirstGuide db={db} tasks={[]} onPage={onPage} onImport={() => {}} />);
  expect(guideSteps(db, []).filter((s) => s.done)).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: /配置 JDK/ }));
  expect(onPage).toHaveBeenCalledWith('tools');
  expect(db.services).toHaveLength(0);
  view.rerender(
    <FirstGuide
      db={seed()}
      tasks={[
        {
          id: 'DC-check',
          operation: 'deploy',
          dryRun: true,
          status: 'success',
          service: '测试',
          started: '',
          elapsed: 1,
        },
      ]}
      onPage={onPage}
      onImport={() => {}}
    />,
  );
  expect(screen.queryByText('开始使用')).toBeNull();
});
it('本机版本比较保留明确的未知状态', () => {
  expect(localComparison({ ahead: 3, behind: 0 })).toContain('新 3 个提交');
  expect(localComparison({ ahead: 2, behind: 1 })).toContain('分叉');
  expect(localComparison({})).toBe('无法判断');
  expect(localComparison({ sameJar: true })).toContain('相同');
});
it('预设进入既有准备与确认边界；保存不包含快照与口令，支持重命名和固定', async () => {
  const db = seed(),
    p = preset(),
    api = {
      save: vi.fn().mockResolvedValue(undefined),
      prepare: vi.fn().mockResolvedValue({ token: 'original-confirm-token' }),
      start: vi.fn(),
    } as unknown as DesktopAPI;
  expect(await preparePreset(api, db, p)).toEqual({ token: 'original-confirm-token' });
  expect(api.start).not.toHaveBeenCalled();
  expect(api.prepare).toHaveBeenCalledWith({
    serviceId: p.serviceId,
    targetIds: p.targetIds,
    build: 'existing',
    overrides: p.overrides,
    failurePolicy: 'continue',
  });
  await expect(preparePreset(api, { ...db, targets: [] }, p)).rejects.toThrow('目标已变化');
  const change = vi.fn(),
    user = userEvent.setup();
  render(
    <PresetShelf
      db={{ ...db, presets: [p] }}
      choice={{
        serviceId: p.serviceId,
        targetIds: p.targetIds,
        build: 'rebuild',
        overrides: {},
        failurePolicy: 'stop',
      }}
      onChange={change}
      onLoad={() => {}}
    />,
  );
  await user.click(screen.getByRole('button', { name: p.name + '预设操作' }));
  await user.click(screen.getByRole('menuitem', { name: '重命名' }));
  const input = screen.getByLabelText('预设名称');
  await user.clear(input);
  await user.type(input, '每日发布');
  await user.click(screen.getByRole('button', { name: '保存预设' }));
  expect(change.mock.calls[0][0][0].name).toBe('每日发布');
  expect(change.mock.calls[0][0][0].build).toBe('existing');
  expect(JSON.stringify(change.mock.calls[0][0])).not.toMatch(/credential|jarPath|snapshotId/);
});
it('远程清理先展示影响、大小、保护原因；正式环境准确名称后才提交', async () => {
  const db = seed(),
    target = db.targets[0],
    user = userEvent.setup();
  target.production = true;
  const plan = {
    token: 'fixture',
    targetId: target.id,
    environment: target.name,
    production: true,
    entries: [
      {
        id: 'old',
        path: '/safe/old.jar',
        size: 1048576,
        time: '2026-11-04T00:00:00Z',
        selected: true,
      },
      {
        id: 'protected',
        path: '/safe/latest.jar',
        size: 1,
        time: '',
        selected: false,
        protectedReason: '最近一次任务产生的备份，保留',
      },
    ],
    count: 2,
    bytes: 1048577,
    effects: ['逐个核对完整指纹'],
  };
  const api = {
    backupAudits: vi.fn().mockResolvedValue([]),
    previewBackups: vi.fn().mockResolvedValue(plan),
    applyBackups: vi
      .fn()
      .mockResolvedValue({
        id: 'DC-CLEAN-fixture',
        targetName: target.name,
        serverName: '测试',
        time: '',
        status: 'success',
        requested: [],
        deleted: [],
        message: '清理完成',
      }),
    cancelBackupPlan: vi.fn().mockResolvedValue(undefined),
  } as unknown as DesktopAPI;
  render(<RemoteBackups api={api} target={target} server={db.servers[0]} onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: '读取备份列表（只读）' }));
  await screen.findByText('逐个核对完整指纹');
  expect(api.applyBackups).not.toHaveBeenCalled();
  expect(screen.getByText('最近一次任务产生的备份，保留')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: /预览清理 1 个文件/ }));
  const confirm = screen.getByRole('dialog', { name: '确认清理远程备份' });
  expect(confirm.textContent).toContain('不能用于历史回滚');
  expect(within(confirm).getByRole('button', { name: '确认清理' }).hasAttribute('disabled')).toBe(
    true,
  );
  await user.type(within(confirm).getByLabelText('输入正式环境名称：' + target.name), target.name);
  await user.click(within(confirm).getByRole('button', { name: '确认清理' }));
  await waitFor(() =>
    expect(api.applyBackups).toHaveBeenCalledWith('fixture', ['old'], target.name),
  );
});
it('嵌套弹窗 Esc 只关闭最上层，Ctrl Enter 不能触发被禁用的确认', async () => {
  const user = userEvent.setup(),
    parent = vi.fn(),
    child = vi.fn(),
    submit = vi.fn();
  render(
    <Modal title="父窗口" onClose={parent}>
      <Modal title="子窗口" onClose={child}>
        <button data-confirm disabled onClick={submit}>
          确认
        </button>
      </Modal>
    </Modal>,
  );
  await user.keyboard('{Control>}{Enter}{/Control}');
  expect(submit).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(child).toHaveBeenCalledOnce();
  expect(parent).not.toHaveBeenCalled();
});
