import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { seed } from '../src/model';
beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
describe('组件交互', () => {
  it('勾选目标不会丢失原生焦点', async () => {
    const user = userEvent.setup();
    render(<App />);
    const checkbox = screen.getByRole('checkbox', { name: '选择测试环境' });
    await user.click(checkbox);
    expect(document.activeElement).toBe(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });
  it('正式环境确认自动聚焦并需要准确输入 DEPLOY', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('checkbox', { name: '选择正式环境' }));
    await user.click(screen.getByRole('button', { name: '部署' }));
    const dialog = screen.getByRole('dialog');
    const input = within(dialog).getByPlaceholderText('DEPLOY');
    expect(document.activeElement).toBe(input);
    expect(
      (within(dialog).getByRole('button', { name: '部署' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.type(input, 'DEPLOY');
    expect(
      (within(dialog).getByRole('button', { name: '部署' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it('弹窗焦点陷阱与关闭后的焦点恢复', async () => {
    const user = userEvent.setup();
    render(<App />);
    const button = screen.getByRole('button', { name: '编辑配置' });
    await user.click(button);
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: '关闭弹窗' });
    const save = within(dialog).getByRole('button', { name: '保存配置' });
    save.focus();
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
  it('部署目标有独立远程文件名与健康检查配置', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /^部署目标/ }));
    await user.click(screen.getByRole('button', { name: '查看部署目标备用环境 · 新增示例详情' }));
    await user.click(screen.getByRole('button', { name: '编辑目标' }));
    const dialog = screen.getByRole('dialog');
    const remote = within(dialog).getByRole('textbox', { name: '远程 JAR 文件名' });
    expect((remote as HTMLInputElement).value).toBe('crm.jar');
    await user.click(within(dialog).getByRole('tab', { name: '健康检查' }));
    expect(within(dialog).getByLabelText('检查方式')).toBeTruthy();
  });
  it('用户配置中的 HTML 被当成文本渲染', async () => {
    const db = seed();
    db.servers[0].name = '<img src=x onerror=alert(1)>';
    localStorage.setItem('deploy-center-v2', JSON.stringify(db));
    const user = userEvent.setup();
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '服务器' }));
    await user.click(screen.getByRole('button', { name: '查看服务器<img src=x onerror=alert(1)>详情' }));
    expect(screen.getByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeTruthy();
    expect(container.querySelector('img[src="x"], [onerror]')).toBeNull();
  });
  it('没有备份的历史记录不允许回滚', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: '部署历史' }));
    await user.click(screen.getAllByRole('button', { name: '详情' })[1]);
    expect(
      (
        within(screen.getByRole('dialog')).getByRole('button', {
          name: '回滚到此备份',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it('任务完成后进入历史，日志节点不会被定时替换', async () => {
    vi.useFakeTimers();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '部署' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '部署' }));
    const logs = screen.getByLabelText('任务日志');
    await act(async () => {
      vi.advanceTimersByTime(850);
    });
    expect(screen.getByLabelText('任务日志')).toBe(logs);
    for (let i = 0; i < 18; i++)
      await act(async () => {
        vi.advanceTimersByTime(850);
      });
    fireEvent.click(screen.getByRole('button', { name: '部署历史' }));
    expect(localStorage.getItem('deploy-center-v2')).toContain('DC-');
    expect(screen.getAllByRole('button', { name: '详情' }).length).toBeGreaterThan(2);
  });
});
