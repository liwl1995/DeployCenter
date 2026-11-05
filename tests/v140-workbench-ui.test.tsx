import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WorkbenchReview } from '../src/features';

const bridge = vi.hoisted(() => ({
  resolveWorkbench: vi.fn(),
  cancelWorkbenchReview: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/platform', async (original) => ({
  ...(await original<typeof import('../src/platform')>()),
  desktop: bridge,
}));
import { WorkbenchReviewPanel } from '../src/WorkbenchReview';

afterEach(cleanup);
const review: WorkbenchReview = {
  token: 'token',
  target: 'CRM 正式环境',
  directory: '/srv/crm',
  owner: 'DC-TEST-demo-target',
  state: 'RUNNING',
  evidence: ['线上 JAR SHA-256：测试指纹', '容器状态：运行中', '备份：旧 JAR 存在'],
  unknown: [],
  legacy: [],
  message: '远端结果待核实',
  action: 'discard',
};
it('证据清楚可读，丢弃现场必须完整输入环境名称', async () => {
  const user = userEvent.setup();
  const done = vi.fn();
  bridge.resolveWorkbench.mockResolvedValue('已丢弃，结果仍未知');
  render(<WorkbenchReviewPanel review={review} onDone={done} />);
  expect(screen.getByText('容器状态：运行中')).toBeTruthy();
  const button = screen.getByRole('button', { name: '核实并丢弃现场' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  const confirmation = screen.getByLabelText('输入目标的完整环境名称确认');
  await user.type(confirmation, '正式环境');
  expect(button.disabled).toBe(true);
  await user.clear(confirmation);
  await user.type(confirmation, review.target);
  await user.click(button);
  expect(bridge.resolveWorkbench).toHaveBeenCalledWith(review.token, review.target);
  expect(done).toHaveBeenCalledWith('已丢弃，结果仍未知');
});
it('非预期文件列出名称，没有删除入口', () => {
  render(
    <WorkbenchReviewPanel
      review={{ ...review, token: '', action: undefined, unknown: ['keep.txt'] }}
      onDone={() => {}}
    />,
  );
  expect(screen.getByText('keep.txt')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '核实并丢弃现场' })).toBeNull();
});
