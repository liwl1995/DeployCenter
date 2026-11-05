import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Field, Modal } from '../src/ui';
import { TargetForm } from '../src/forms';
import { seed } from '../src/model';
import App from '../src/App';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('复杂字段提供独立可聚焦问号，简单字段无问号，输入框标签保持准确', async () => {
  const user = userEvent.setup();
  render(
    <>
      <Field label="服务名称">
        <input />
      </Field>
      <Field label="产物目录">
        <input />
      </Field>
    </>,
  );
  expect(screen.queryByRole('button', { name: '服务名称说明' })).toBeNull();
  const help = screen.getByRole('button', { name: '产物目录说明' });
  await user.click(help);
  expect(document.activeElement).toBe(help);
  expect(screen.getByRole('tooltip').textContent).toContain('项目根目录');
  await user.click(screen.getByLabelText('产物目录'));
  expect(document.activeElement).toBe(screen.getByLabelText('产物目录'));
});
it('健康检查可保存启动等待和分钟级窗口，原配置编辑时使用兼容窗口', async () => {
  const db = seed(),
    onSave = vi.fn();
  const user = userEvent.setup();
  render(<TargetForm initial={db.targets[3]} db={db} onSave={onSave} onClose={() => {}} />);
  await user.click(screen.getByRole('tab', { name: '健康检查' }));
  await user.selectOptions(screen.getByLabelText('检查方式'), 'http');
  await user.type(screen.getByLabelText('HTTP 健康地址'), 'http://127.0.0.1:8080/health');
  await user.clear(screen.getByLabelText('启动等待（秒）'));
  await user.type(screen.getByLabelText('启动等待（秒）'), '30');
  await user.clear(screen.getByLabelText('最长等待窗口（秒）'));
  await user.type(screen.getByLabelText('最长等待窗口（秒）'), '600');
  await user.click(screen.getByRole('button', { name: '下一步' }));
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  expect(onSave).toHaveBeenCalledOnce();
  expect(onSave.mock.calls[0][0].health).toMatchObject({ startDelay: 30, maxWait: 600 });
});
it('任务页与历史详情都有可用的返回入口', async () => {
  localStorage.clear();
  const user = userEvent.setup();
  render(<App />);
  await user.click(screen.getByRole('button', { name: '部署' }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '部署' }));
  await user.click(screen.getByRole('button', { name: '返回部署' }));
  expect(screen.getByRole('heading', { name: '准备好，发布下一版本' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: '部署历史' }));
  await user.click(screen.getAllByRole('button', { name: '详情' })[0]);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '返回' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('问号浮层按 Escape 先关闭说明，保留弹窗；再次 Escape 沿用弹窗关闭行为', async () => {
  const user = userEvent.setup();
  const close = vi.fn();
  render(
    <Modal title="帮助键盘验收" onClose={close}>
      <Field label="产物目录">
        <input />
      </Field>
    </Modal>,
  );
  await user.click(screen.getByRole('button', { name: '产物目录说明' }));
  expect(screen.getByRole('tooltip')).toBeTruthy();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(close).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(close).toHaveBeenCalledOnce();
});
