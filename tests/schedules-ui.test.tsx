import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
it('计划提供准备日志、改期、重新准备与取消，执行中只提供任务查看', async () => {
  const value = plan(),
    open = vi.fn(),
    cancel = vi.fn(),
    change = vi.fn(),
    prepare = vi.fn(),
    user = userEvent.setup();
  const view = render(
    <ReleaseSchedules
      plans={[value]}
      busy={false}
      onOpen={open}
      onCancel={cancel}
      onChange={change}
      onPrepare={prepare}
    />,
  );
  await user.click(screen.getByRole('button', { name: '准备日志' }));
  expect(open).toHaveBeenCalledWith(value.preparationId);
  await user.click(screen.getByRole('button', { name: '调整时间' }));
  expect(change).toHaveBeenCalledWith(value);
  await user.click(screen.getByRole('button', { name: '重新构建' }));
  expect(prepare).toHaveBeenCalledWith(value);
  await user.click(screen.getByRole('button', { name: '取消计划' }));
  expect(cancel).toHaveBeenCalledWith(value.id);
  view.rerender(
    <ReleaseSchedules
      plans={[{ ...value, state: 'executing', taskId: 'DC-task' }]}
      busy
      onOpen={open}
      onCancel={cancel}
      onChange={change}
      onPrepare={prepare}
    />,
  );
  expect(screen.queryByRole('button', { name: '取消计划' })).toBeNull();
  expect(screen.queryByRole('button', { name: '调整时间' })).toBeNull();
  await user.click(screen.getByRole('button', { name: '部署任务' }));
  expect(open).toHaveBeenCalledWith('DC-task');
});
it('需重新确认的计划不允许仅改时间绕过检查，忙时禁止重新准备', () => {
  render(
    <ReleaseSchedules
      plans={[{ ...plan(), state: 'confirmation' }]}
      busy
      onOpen={vi.fn()}
      onCancel={vi.fn()}
      onChange={vi.fn()}
      onPrepare={vi.fn()}
    />,
  );
  expect(screen.queryByRole('button', { name: '调整时间' })).toBeNull();
  expect(
    (screen.getByRole('button', { name: '重新构建' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
