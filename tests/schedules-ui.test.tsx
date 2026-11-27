import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseSchedules } from '../src/ReleaseSchedules';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import type { ReleaseSchedule } from '../src/schedules';
afterEach(cleanup);
function plan(): ReleaseSchedule {
  const db = seed(),
    task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  return {
    id: 'SP-ui',
    createdAt: 1,
    scheduledAt: Date.now() + 60000,
    state: 'ready',
    reason: '等待时间',
    preparationId: task.id,
    task,
    configuration: '',
    pins: '',
    approval: { productionWord: '', allowWeak: false, protectCurrent: true },
  };
}
it('空计划显示入口与桌面运行条件', () => {
  render(
    <ReleaseSchedules
      services={[]}
      plans={[]}
      busy={false}
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(screen.getByText('暂无发布计划')).toBeTruthy();
  expect(screen.getByText(/电脑须保持开机/)).toBeTruthy();
});
it('发布计划跟随当前服务图标，服务删除后使用计划快照', () => {
  const value = plan();
  value.task.service.icon = { name: 'Rocket' };
  const props = {
    plans: [value],
    busy: false,
    onOpen: vi.fn(),
    onCancel: vi.fn(),
    onChange: vi.fn(),
    onPrepare: vi.fn(),
  };
  const { container, rerender } = render(
    <ReleaseSchedules {...props} services={[{ ...value.task.service, icon: { name: 'Server' } }]} />,
  );
  expect(container.querySelector('.record-icon .lucide-server')).toBeTruthy();
  rerender(<ReleaseSchedules {...props} services={[{ ...value.task.service, icon: undefined }]} />);
  expect(container.querySelector('.record-icon .lucide-boxes')).toBeTruthy();
  rerender(<ReleaseSchedules {...props} services={[]} />);
  expect(container.querySelector('.record-icon .lucide-rocket')).toBeTruthy();
});
it('默认只显示未执行计划，可以筛出执行中和已结束计划', () => {
  const value = plan();
  render(
    <ReleaseSchedules
      services={[]}
      plans={[
        value,
        { ...value, id: 'SP-executing', state: 'executing' },
        { ...value, id: 'SP-completed', state: 'completed' },
        { ...value, id: 'SP-cancelled', state: 'cancelled' },
      ]}
      busy={false}
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: '未执行' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.queryByText('已完成')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '执行中' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getAllByText('执行中')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '已结束' }));
  expect(screen.getAllByRole('article')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(4);
});
it('计划提供准备日志、改期、重新准备与取消，执行中只提供任务查看', async () => {
  const value = plan(),
    open = vi.fn(),
    cancel = vi.fn(),
    change = vi.fn(),
    prepare = vi.fn(),
    user = userEvent.setup();
  const view = render(
    <ReleaseSchedules
      services={[]}
      plans={[value]}
      busy={false}
      onOpen={open}
      onCancel={cancel}
      onChange={change}
      onPrepare={prepare}
    />,
  );
  const menu = () => screen.getByRole('button', { name: /发布计划操作/ });
  await user.click(menu());
  await user.click(screen.getByRole('menuitem', { name: '准备日志' }));
  expect(open).toHaveBeenCalledWith(value.preparationId, value.id);
  await user.click(screen.getByRole('button', { name: '调整时间' }));
  expect(change).toHaveBeenCalledWith(value);
  await user.click(menu());
  await user.click(screen.getByRole('menuitem', { name: '重新构建' }));
  expect(prepare).toHaveBeenCalledWith(value);
  await user.click(menu());
  await user.click(screen.getByRole('menuitem', { name: '取消计划' }));
  expect(cancel).toHaveBeenCalledWith(value.id);
  view.rerender(
    <ReleaseSchedules
      services={[]}
      plans={[{ ...value, state: 'executing', taskId: 'DC-task' }]}
      busy
      onOpen={open}
      onCancel={cancel}
      onChange={change}
      onPrepare={prepare}
    />,
  );
  expect(screen.getByText('当前状态下暂无发布计划')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '执行中' }));
  await user.click(menu());
  expect(screen.queryByRole('menuitem', { name: '取消计划' })).toBeNull();
  expect(screen.queryByRole('button', { name: '调整时间' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: '部署任务' }));
  expect(open).toHaveBeenCalledWith('DC-task', value.id);
});
it('需重新确认的计划不允许仅改时间绕过检查，忙时禁止重新准备', () => {
  render(
    <ReleaseSchedules
      services={[]}
      plans={[{ ...plan(), state: 'confirmation' }]}
      busy
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: '调整时间' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /发布计划操作/ }));
  expect(
    (screen.getByRole('menuitem', { name: '重新构建' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
