import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HeaderActions } from '../src/HeaderActions';
import App from '../src/App';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
it('外观和设置在全局操作区，菜单标明当前选项并保留全部三种主题', async () => {
  const user = userEvent.setup(),
    theme = vi.fn(),
    settings = vi.fn();
  render(
    <HeaderActions theme="dark" settingsActive={false} onTheme={theme} onSettings={settings} />,
  );
  const group = screen.getByRole('group', { name: '外观与设置' });
  const trigger = within(group).getByRole('button', { name: '切换外观（当前：深色）' });
  expect(trigger.getAttribute('title')).toContain('深色');
  await user.click(trigger);
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(3);
  const selected = screen.getByRole('menuitemradio', { name: '深色' });
  expect(selected.getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(selected);
  expect(screen.getByRole('menuitemradio', { name: '浅色' }).getAttribute('aria-checked')).toBe(
    'false',
  );
  await user.click(screen.getByRole('menuitemradio', { name: '跟随系统' }));
  expect(theme).toHaveBeenCalledWith('system');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.click(within(group).getByRole('button', { name: '设置' }));
  expect(settings).toHaveBeenCalledOnce();
});
it('键盘打开、方向键选择、Esc 和 Tab 退出保持焦点顺序', async () => {
  const user = userEvent.setup(),
    theme = vi.fn();
  render(
    <HeaderActions theme="system" settingsActive={false} onTheme={theme} onSettings={() => {}} />,
  );
  const trigger = screen.getByRole('button', { name: /切换外观/ });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: '跟随系统' }));
  await user.keyboard('{ArrowDown}{Enter}');
  expect(theme).toHaveBeenCalledWith('light');
  trigger.focus();
  await user.keyboard('{Enter}{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.keyboard('{Enter}');
  await user.tab();
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '设置' }));
});
it('点击外部和调整窗口关闭菜单，不改变主题；设置有当前页面状态', async () => {
  const theme = vi.fn();
  render(<HeaderActions theme="light" settingsActive onTheme={theme} onSettings={() => {}} />);
  expect(screen.getByRole('button', { name: '设置' }).getAttribute('aria-current')).toBe('page');
  fireEvent.click(screen.getByRole('button', { name: /切换外观/ }));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /切换外观/ }));
  fireEvent(window, new Event('resize'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(theme).not.toHaveBeenCalled();
});
it('从侧栏进入外观设置，主题通过已有存储保存并在重新打开时恢复', async () => {
  const user = userEvent.setup();
  let view = render(<App />);
  await user.click(screen.getByRole('button', { name: '设置' }));
  const themeButton = (name: string) =>
    within(screen.getByRole('group', { name: '界面主题' })).getByRole('button', { name });
  await user.click(themeButton('深色'));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(JSON.parse(localStorage.getItem('deploy-center-v2')!).settings.theme).toBe('dark');
  expect(themeButton('深色').getAttribute('aria-pressed')).toBe('true');
  await user.click(themeButton('浅色'));
  view.unmount();
  view = render(<App />);
  expect(document.documentElement.dataset.theme).toBe('light');
  await user.click(screen.getByRole('button', { name: '设置' }));
  expect(themeButton('浅色').getAttribute('aria-pressed')).toBe('true');
  view.unmount();
});
