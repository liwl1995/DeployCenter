import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReleaseSchedules } from '../src/ReleaseSchedules';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import type { ReleaseScheduleView } from '../src/schedules';
afterEach(cleanup);
function plan(): ReleaseScheduleView {
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
    rescheduleBlock: null,
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
  expect(screen.getByText(/定时发布需保持开机/)).toBeTruthy();
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
it('未执行计划按发布时间从近到远，已结束计划从近到远回看', () => {
  const value = plan();
  const at = (id: string, name: string, offset: number, state: ReleaseScheduleView['state'] = 'ready') => ({
    ...value,
    id,
    state,
    scheduledAt: value.scheduledAt + offset,
    task: { ...value.task, service: { ...value.task.service, name } },
  });
  render(
    <ReleaseSchedules
      services={[]}
      plans={[
        at('SP-later', '较晚发布', 60000),
        at('SP-sooner', '即将发布', 0),
        { ...value, id: 'SP-executing', state: 'executing' },
        at('SP-completed', '较早结束', -120000, 'completed'),
        at('SP-cancelled', '最近结束', -60000, 'cancelled'),
      ]}
      busy={false}
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  const names = () => screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
  expect(screen.getByRole('button', { name: '未执行' }).getAttribute('aria-pressed')).toBe('true');
  expect(names()).toEqual(['即将发布', '较晚发布']);
  expect(screen.queryByText('已完成')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '执行中' }));
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.getAllByText('执行中')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: '已结束' }));
  expect(names()).toEqual(['最近结束', '较早结束']);
  fireEvent.click(screen.getByRole('button', { name: '全部' }));
  expect(screen.getAllByRole('article')).toHaveLength(5);
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
  await user.click(screen.getByRole('menuitem', { name: '重新准备' }));
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
      plans={[{ ...plan(), state: 'confirmation', rescheduleBlock: '线上基线需要重新核实，请重新准备。' }]}
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
    (screen.getByRole('menuitem', { name: '重新准备' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it('已经执行的失败或取消计划按主进程资格提示重新准备', async () => {
  const reason = '此计划已执行。再次发布请重新准备。';
  const user = userEvent.setup();
  render(
    <ReleaseSchedules
      services={[]}
      plans={[{ ...plan(), state: 'cancelled', taskId: 'DC-finished', rescheduleBlock: reason }]}
      busy={false}
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  await user.click(screen.getByRole('button', { name: '已结束' }));
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '调整时间' })).toBeNull();
  await user.click(screen.getByRole('button', { name: /发布计划操作/ }));
  expect((screen.getByRole('menuitem', { name: '重新准备' }) as HTMLButtonElement).disabled).toBe(false);
});
