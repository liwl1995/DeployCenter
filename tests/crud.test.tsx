import { it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import App from '../src/App';
afterEach(() => {
  cleanup();
  localStorage.clear();
});
it('删除服务时清理其目标配置，保留共享服务器、其他服务和历史快照', () => {
  localStorage.clear();
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: '服务管理' }));
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
