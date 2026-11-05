import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DesktopAPI } from '../src/platform';
const bridge = vi.hoisted(() => ({
  sshAliases: vi.fn(),
  testDraft: vi.fn(),
  save: vi.fn(),
  checkTool: vi.fn(),
  toolInfo: vi.fn(),
}));
vi.mock('../src/platform', async (original) => ({
  ...(await original<typeof import('../src/platform')>()),
  desktop: bridge,
}));
import { ServerForm, TargetForm } from '../src/forms';
import { MoreMenu, DeleteEntity } from '../src/EntityActions';
import { BuildEnvironment } from '../src/BuildEnvironment';
import { seed } from '../src/model';
beforeEach(() => {
  vi.clearAllMocks();
  bridge.sshAliases.mockResolvedValue({
    hosts: ['campus', 'crm'],
    warnings: ['候选列表可能不完整，可手动输入。'],
  });
  bridge.testDraft.mockResolvedValue({
    ok: true,
    output: '连接可用',
    command: 'id',
    kind: 'server',
    time: '2026-11-04T00:00:00Z',
  });
  bridge.save.mockResolvedValue(undefined);
  bridge.checkTool.mockResolvedValue('Java 21 测试版本');
  bridge.toolInfo.mockImplementation(async (id: string) => ({
    serviceId: id,
    available: true,
    tool: 'E:/tools/apache-maven/bin/mvn.cmd',
    version: 'Apache Maven 测试版本',
    workDir: 'fixture',
    javaVersion: 'Java 21',
    reason: '',
  }));
});
afterEach(cleanup);
it('更多菜单有键盘退出及禁用原因；有历史删除必须输入正确名称', async () => {
  const user = userEvent.setup(),
    remove = vi.fn().mockResolvedValue(undefined);
  const menu = render(
    <MoreMenu
      label="更多服务器操作"
      actions={[
        { label: '删除服务器', onClick: () => {}, disabled: true, reason: '正在被目标使用' },
      ]}
    />,
  );
  await user.click(screen.getByRole('button', { name: '更多服务器操作' }));
  const item = screen.getByRole('menuitem', { name: '删除服务器' });
  expect(item.hasAttribute('disabled')).toBe(true);
  expect(item.parentElement?.getAttribute('title')).toBe('正在被目标使用');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  menu.unmount();
  render(
    <DeleteEntity
      kind="服务"
      name="验收服务"
      hasHistory={true}
      reason=""
      description="删除关联配置，保留历史。"
      onClose={() => {}}
      onDelete={remove}
    />,
  );
  expect(screen.getByRole('button', { name: '删除配置' }).hasAttribute('disabled')).toBe(true);
  await user.type(screen.getByLabelText('输入名称确认删除'), '验收服务');
  await user.click(screen.getByRole('button', { name: '删除配置' }));
  expect(remove).toHaveBeenCalledOnce();
});
it('服务器表单显示别名候选且标签关联输入；草稿测试不保存配置或口令', async () => {
  const user = userEvent.setup(),
    db = seed(),
    save = vi.fn(),
    tested = vi.fn(),
    initial = { ...db.servers[0], auth: 'alias' as const };
  const { container } = render(
    <ServerForm initial={initial} db={db} onSave={save} onClose={() => {}} onTestResult={tested} />,
  );
  await waitFor(() => expect(container.querySelectorAll('datalist option')).toHaveLength(2));
  expect(screen.getByLabelText('SSH Config 别名').tagName).toBe('INPUT');
  await user.selectOptions(screen.getByLabelText('认证方式'), 'password');
  await user.click(screen.getByText('测试当前表单的连接（无需先保存）'));
  await user.type(screen.getByLabelText('测试使用的密码'), 'not-for-storage');
  await user.click(screen.getByRole('button', { name: '测试当前表单连接' }));
  await screen.findByText('连接可用');
  expect(save).not.toHaveBeenCalled();
  expect(bridge.save).not.toHaveBeenCalled();
  expect(bridge.testDraft).toHaveBeenCalledOnce();
  expect(JSON.stringify(bridge.testDraft.mock.calls[0][0])).not.toContain('not-for-storage');
  expect((screen.getByLabelText('测试使用的密码') as HTMLInputElement).value).toBe('');
  expect(tested).toHaveBeenCalledOnce();
});
it('JDK自动检测展示版本和服务引用；Maven显示实际工具与版本，不只显示PATH', async () => {
  const db = seed();
  render(
    <BuildEnvironment
      api={bridge as unknown as DesktopAPI}
      db={db}
      onEdit={() => {}}
      onAdd={() => {}}
      onScan={() => {}}
      onDelete={() => {}}
      deletionReason={(name) => (db.services.some((s) => s.jdk === name) ? '服务仍在使用' : '')}
    />,
  );
  await waitFor(() => expect(bridge.checkTool).toHaveBeenCalledTimes(db.jdks.length));
  await waitFor(() => expect(bridge.toolInfo).toHaveBeenCalledTimes(db.services.length));
  expect(screen.getAllByText('Java 21 测试版本')).toHaveLength(db.jdks.length);
  expect(screen.getByRole('tab', { name: 'JDK 管理' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(/使用服务：Cordys CRM/)).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('tab', { name: '服务构建工具' }));
  expect(screen.getAllByText('Apache Maven 测试版本')).toHaveLength(db.services.length);
  expect(screen.getAllByText(/实际工具：E:\/tools/)).toHaveLength(db.services.length);
  await userEvent.setup().click(screen.getByRole('tab', { name: 'JDK 管理' }));
  expect(bridge.checkTool).toHaveBeenCalledTimes(db.jdks.length);
});
it('普通JAR自动观察必须配置日志路径，设置保存后不带口令', async () => {
  const db = seed(),
    initial = db.targets.find((t) => t.mode === 'jar')!,
    save = vi.fn(),
    user = userEvent.setup();
  render(<TargetForm initial={initial} db={db} onSave={save} onClose={() => {}} />);
  await user.click(screen.getByText('部署后日志观察'));
  await user.click(screen.getByRole('switch', { name: '健康未验证时自动观察日志' }));
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('应用日志绝对路径');
  await user.type(screen.getByLabelText('应用日志绝对路径'), '/var/log/应用.log');
  await user.clear(screen.getByLabelText('默认观察时间（秒）'));
  await user.type(screen.getByLabelText('默认观察时间（秒）'), '90');
  await user.click(screen.getByRole('button', { name: '保存配置' }));
  expect(save.mock.calls[0][0].observation).toEqual({ enabled: true, duration: 90 });
});
