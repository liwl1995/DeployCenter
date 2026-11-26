import { it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from '../src/App';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('服务默认图标可直接配色，重开选择器能恢复颜色', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  const changeIcon = screen.getByRole('button', { name: '更换服务「Cordys CRM」的图标' });
  expect(screen.getByRole('button', { name: '更换服务「校园告警服务」的图标' })).toBeTruthy();
  fireEvent.click(changeIcon);
  fireEvent.click(screen.getByRole('radio', { name: '黄色' }));
  expect(changeIcon.querySelector('.lucide-boxes')?.getAttribute('stroke')).toBe('#eab308');
  fireEvent.click(screen.getByRole('button', { name: '关闭弹窗' }));
  fireEvent.click(changeIcon);
  expect((screen.getByRole('radio', { name: '黄色' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
  const db = JSON.parse(localStorage.getItem('deploy-center-v2')!);
  expect(db.services[0].icon).toBeUndefined();
});
it('删除服务时清理其目标配置，保留共享服务器、其他服务和历史快照', () => {
  localStorage.clear();
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
  fireEvent.click(screen.getByRole('button', { name: '查看服务Cordys CRM详情' }));
  fireEvent.click(screen.getByRole('button', { name: '更多服务Cordys CRM操作' }));
  fireEvent.click(screen.getByRole('menuitem', { name: '删除服务' }));
  fireEvent.change(screen.getByLabelText('输入名称确认删除'), { target: { value: 'Cordys CRM' } });
  fireEvent.click(screen.getByRole('button', { name: '删除配置' }));
  const db = JSON.parse(localStorage.getItem('deploy-center-v2')!);
  expect(db.services).toHaveLength(1);
  expect(db.services[0].name).toBe('校园告警服务');
  expect(db.targets.every((t: { serviceId: string }) => t.serviceId !== 'crm')).toBe(true);
  expect(db.servers).toHaveLength(3);
  expect(db.history).toHaveLength(2);
});
