import { deploymentTime } from '../src/presentation';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createTask } from '../src/engine';
import { seed, type Task } from '../src/model';
import { useTaskClock } from '../src/task-clock';
import { UploadProgress } from '../src/UploadProgress';
import { EntityWorkspace } from '../src/WorkspaceLayout';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
function Clock({ task }: { task: Task }) {
  const value = useTaskClock(task);
  return (
    <output>
      {value.elapsed.toFixed(1)} / {value.buildSteps[0].elapsed?.toFixed(1)}
    </output>
  );
}
it('静默长步骤不依赖日志或后端快照，展示耗时连续推进且不修改原任务', () => {
  vi.useFakeTimers();
  const db = seed(),
    task = createTask(db, db.services[0], [db.targets[0]], {}, 'rebuild');
  task.status = 'running';
  task.elapsed = 5;
  task.buildSteps[0].status = 'running';
  task.buildSteps[0].elapsed = 3;
  const view = render(<Clock task={task} />);
  act(() => vi.advanceTimersByTime(30000));
  expect(screen.getByRole('status').textContent).toBe('35.0 / 33.0');
  expect(task.elapsed).toBe(5);
  expect(task.buildSteps[0].elapsed).toBe(3);
  view.rerender(<Clock task={{ ...task, elapsed: 9, status: 'success' }} />);
  act(() => vi.advanceTimersByTime(10000));
  expect(screen.getByRole('status').textContent).toBe('9.0 / 3.0');
});
it('上传进度是同一行原位更新，不新增日志卡片或速度记录', () => {
  const view = render(
    <UploadProgress
      upload={{ bytes: 50 * 1048576, total: 100 * 1048576, percent: 50, speed: 5 * 1048576 }}
    />,
  );
  const node = screen.getByRole('progressbar');
  expect(node.textContent).toContain('50.0 / 100.0 MB');
  expect(node.textContent).toContain('5.0 MB/s');
  expect(node.textContent).toContain('剩余 10 秒');
  view.rerender(
    <UploadProgress
      upload={{ bytes: 60 * 1048576, total: 100 * 1048576, percent: 60, speed: 5 * 1048576 }}
    />,
  );
  expect(screen.getByRole('progressbar')).toBe(node);
  expect(node.getAttribute('aria-valuenow')).toBe('60');
  expect(document.querySelector('.card')).toBeNull();
});
it('卡片直接编辑或部署，只有名称进入详情；保留状态点与底部信息', () => {
  const edit = vi.fn();
  render(
    <EntityWorkspace
      label="服务"
      items={[{ id: 'crm', name: 'crm' }]}
      title={(s) => s.name}
      subtitle={() => '客户管理'}
      cardState={() => ({ good: true, label: '已部署' })}
      cardMeta={() => <span>2 个目标</span>}
      cardActions={() => (
        <>
          <button onClick={edit}>编辑</button>
          <button>去部署</button>
        </>
      )}
    >
      {() => <p>详情正文</p>}
    </EntityWorkspace>,
  );
  fireEvent.click(screen.getByRole('button', { name: '编辑' }));
  expect(edit).toHaveBeenCalledOnce();
  expect(screen.queryByText('详情正文')).toBeNull();
  expect(screen.getByText('已部署')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '查看服务crm详情' }));
  expect(screen.getByText('详情正文')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看服务crm详情' }));
});

it('旧配置的未记录占位时间不显示为已部署，也不作为上次部署日期', () => {
  expect(deploymentTime('未记录')).toBeUndefined();
  expect(deploymentTime('')).toBeUndefined();
  expect(deploymentTime('2026-11-13T09:00:00.000Z')).toBe('2026-11-13T09:00:00.000Z');
});

it('迟到的快照不会令运行中的任务与步骤耗时倒退，结束仍以真实记录为准', () => {
  vi.useFakeTimers();
  const db = seed(),
    task = createTask(db, db.services[0], [db.targets[0]], {}, 'rebuild');
  task.status = 'running';
  task.elapsed = 5;
  task.buildSteps[0].status = 'running';
  task.buildSteps[0].elapsed = 3;
  const view = render(<Clock task={task} />);
  act(() => vi.advanceTimersByTime(2000));
  view.rerender(<Clock task={structuredClone(task)} />);
  expect(screen.getByRole('status').textContent).toBe('7.0 / 5.0');
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.getByRole('status').textContent).toBe('8.0 / 6.0');
});
