import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import { TaskView } from '../src/TaskView';
import App from '../src/App';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

function fixture() {
  const db = seed();
  const task = createTask(db, db.services[0], [db.targets[0]], {}, 'rebuild');
  task.status = 'success';
  task.buildSteps.forEach((step) => {
    step.status = 'success';
  });
  task.targets[0].status = 'success';
  task.targets[0].steps.forEach((step) => {
    step.status = 'success';
  });
  return task;
}
const actions = {
  inspected: 0,
  setInspected: vi.fn(),
  backLabel: '返回部署历史',
  onBack: vi.fn(),
  onCancel: vi.fn(),
  onFailure: vi.fn(),
  demoMode: false,
  onRetry: vi.fn().mockResolvedValue(undefined),
  onPrepareAgain: vi.fn(),
  onIdentity: vi.fn(),
  onCopy: vi.fn(),
  onLog: vi.fn(),
};
it('任务页成功结论在摘要中，步骤默认折叠，日志只保留级别和跟随', () => {
  const task = fixture();
  render(<TaskView {...actions} task={task} />);
  expect(screen.getByText('已部署成功')).toBeTruthy();
  expect(document.querySelector('.task-result-banner')).toBeNull();
  expect(screen.queryByRole('heading', { name: '构建详情' })).toBeNull();
  const viewer = document.querySelector('.log-viewer') as HTMLElement;
  expect(within(viewer).getByLabelText('日志级别')).toBeTruthy();
  expect(within(viewer).getByLabelText('跟随最新')).toBeTruthy();
  expect(within(viewer).queryByRole('textbox')).toBeNull();
  expect(within(viewer).queryByRole('button', { name: /复制|导出|上一处|下一处/ })).toBeNull();
  const stages = screen.getByRole('group', { name: '部署阶段' });
  fireEvent.click(within(stages).getByRole('button', { name: /构建/ }));
  expect(screen.getByRole('heading', { name: '构建详情' })).toBeTruthy();
  fireEvent.click(within(stages).getByRole('button', { name: /构建/ }));
  expect(screen.queryByRole('heading', { name: '构建详情' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更多任务操作' }));
  expect(screen.getByRole('menuitem', { name: '导出完整日志' })).toBeTruthy();
});
it('失败自动展开对应阶段，收起后仍可从失败提示重新定位', () => {
  const task = fixture();
  task.status = 'failed';
  task.buildSteps[1].status = 'failed';
  render(<TaskView {...actions} task={task} />);
  expect(screen.getByRole('heading', { name: '构建详情' })).toBeTruthy();
  const stages = screen.getByRole('group', { name: '部署阶段' });
  fireEvent.click(within(stages).getByRole('button', { name: /构建/ }));
  expect(screen.queryByRole('heading', { name: '构建详情' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '查看失败位置' }));
  expect(screen.getByRole('heading', { name: '构建详情' })).toBeTruthy();
});
it('删除首页与重复上次部署入口，品牌按钮返回一键部署', () => {
  render(<App />);
  expect(screen.queryByRole('button', { name: '首页总览' })).toBeNull();
  expect(screen.queryByRole('button', { name: '重复上次部署' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  const brand = screen.getByText('YOTOO 部署中心').closest('a')!;
  fireEvent.click(brand);
  expect(screen.getByRole('heading', { name: '准备好，发布下一版本' })).toBeTruthy();
});

it('多目标部分完成时，查看成功目标仍显示整个任务的部分完成状态', () => {
  const task = fixture();
  task.status = 'partial';
  task.targets.push(structuredClone(task.targets[0]));
  task.targets[1].target.id = 'another-target';
  task.targets[1].status = 'failed';
  render(<TaskView {...actions} task={task} />);
  expect(
    within(document.querySelector('.task-page-header') as HTMLElement).getByText('部分完成'),
  ).toBeTruthy();
});
