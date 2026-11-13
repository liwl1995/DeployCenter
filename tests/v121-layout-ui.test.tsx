import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EntityWorkspace, WorkspaceTabs } from '../src/WorkspaceLayout';
import { TrustDialog } from '../src/DesktopViews';
const bridge = vi.hoisted(() => ({ trust: vi.fn() }));
vi.mock('../src/platform', async (original) => ({
  ...(await original<typeof import('../src/platform')>()),
  desktop: bridge,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const items = [
  { id: 'a', name: '校园告警', host: '测试服务器' },
  { id: 'b', name: 'CRM', host: '生产服务器' },
];
it('配置默认显示卡片，进入详情后返回恢复搜索与焦点，删除后回到列表', async () => {
  const user = userEvent.setup();
  const view = (values = items) => (
    <EntityWorkspace label="服务" items={values} title={(s) => s.name} subtitle={(s) => s.host}>
      {(s) => <h2>{s.name}详情</h2>}
    </EntityWorkspace>
  );
  const rendered = render(view());
  expect(screen.queryByRole('heading', { name: '校园告警详情' })).toBeNull();
  await user.type(screen.getByRole('textbox', { name: '搜索服务' }), 'CRM');
  const card = screen.getByRole('button', { name: '查看服务CRM详情' });
  card.focus();
  await user.keyboard('{Enter}');
  expect(screen.getByRole('heading', { name: 'CRM详情' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  await user.click(screen.getByRole('button', { name: '返回列表' }));
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('CRM');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: '查看服务CRM详情' }));
  await user.click(screen.getByRole('button', { name: '查看服务CRM详情' }));
  rendered.rerender(view([items[0]]));
  expect(screen.queryByRole('heading', { name: 'CRM详情' })).toBeNull();
  expect(screen.getByText('没有匹配项，请调整搜索内容。')).toBeTruthy();
  await user.clear(screen.getByRole('textbox'));
  expect(screen.getByRole('button', { name: '查看服务校园告警详情' })).toBeTruthy();
});
it('添加配置后自动选择新项，空列表提供添加指引', async () => {
  const view = (values: typeof items) => (
    <EntityWorkspace label="服务器" items={values} title={(s) => s.name} subtitle={(s) => s.host}>
      {(s) => <h2>{s.name}详情</h2>}
    </EntityWorkspace>
  );
  const rendered = render(view([]));
  expect(screen.getByText('暂无配置，点击上方添加。')).toBeTruthy();
  rendered.rerender(view([items[0]]));
  rendered.rerender(view(items));
  expect(screen.getByRole('heading', { name: 'CRM详情' })).toBeTruthy();
});
it('分类面板切换保留输入值、支持键盘和正确的面板关联', async () => {
  const user = userEvent.setup();
  render(
    <WorkspaceTabs
      label="设置分类"
      sections={[
        { id: 'one', label: '外观', content: <input aria-label="保留输入" defaultValue="" /> },
        { id: 'two', label: '数据', content: <p>数据内容</p> },
      ]}
    />,
  );
  await user.type(screen.getByRole('textbox'), '中文目录');
  await user.click(screen.getByRole('tab', { name: '数据' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByRole('tabpanel').textContent).toBe('数据内容');
  await user.keyboard('{ArrowLeft}');
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('中文目录');
  const tab = screen.getByRole('tab', { name: '外观' });
  expect(document.activeElement).toBe(tab);
  expect(screen.getByRole('tabpanel').id).toBe(tab.getAttribute('aria-controls'));
});
it('变更指纹默认禁用，只有准确的 TRUST 才能提交，成功后关闭', async () => {
  const user = userEvent.setup(),
    close = vi.fn();
  bridge.trust.mockResolvedValue(undefined);
  render(
    <TrustDialog
      request={{
        id: 'changed',
        server: '服务器',
        endpoint: 'fixture:22',
        fingerprint: 'SHA256:new',
        changed: true,
      }}
      onClose={close}
    />,
  );
  const button = screen.getByRole('button', { name: '确认更新信任并继续' });
  expect(button.hasAttribute('disabled')).toBe(true);
  const input = screen.getByLabelText('输入 TRUST 更新信任');
  expect(document.activeElement).toBe(input);
  await user.type(input, 'trust');
  expect(button.hasAttribute('disabled')).toBe(true);
  await user.clear(input);
  await user.type(input, 'TRUST');
  await user.click(button);
  expect(bridge.trust).toHaveBeenCalledWith('changed', true, 'TRUST');
  expect(close).toHaveBeenCalledOnce();
});
it('拒绝变化指纹不要求确认词；首次连接没有更新输入框', async () => {
  const user = userEvent.setup(),
    close = vi.fn();
  bridge.trust.mockResolvedValue(undefined);
  const rendered = render(
    <TrustDialog
      request={{
        id: 'changed',
        server: '服务器',
        endpoint: 'fixture:22',
        fingerprint: 'SHA256:new',
        changed: true,
      }}
      onClose={close}
    />,
  );
  await user.click(screen.getByRole('button', { name: '拒绝连接' }));
  expect(bridge.trust).toHaveBeenCalledWith('changed', false, '');
  rendered.unmount();
  render(
    <TrustDialog
      request={{
        id: 'first',
        server: '服务器',
        endpoint: 'fixture:22',
        fingerprint: 'SHA256:first',
        changed: false,
      }}
      onClose={close}
    />,
  );
  expect(screen.queryByLabelText('输入 TRUST 更新信任')).toBeNull();
  expect(screen.getByRole('button', { name: '信任并继续' }).hasAttribute('disabled')).toBe(false);
});
it('指纹提交中不重复操作，失败显示错误并允许重试', async () => {
  const user = userEvent.setup(),
    close = vi.fn();
  let reject!: (error: Error) => void;
  bridge.trust.mockImplementation(
    () =>
      new Promise((_resolve, no) => {
        reject = no;
      }),
  );
  render(
    <TrustDialog
      request={{
        id: 'first',
        server: '服务器',
        endpoint: 'fixture:22',
        fingerprint: 'SHA256:first',
        changed: false,
      }}
      onClose={close}
    />,
  );
  await user.click(screen.getByRole('button', { name: '信任并继续' }));
  expect(screen.getByRole('button', { name: '拒绝连接' }).hasAttribute('disabled')).toBe(true);
  reject(new Error('保存失败'));
  expect((await screen.findByRole('alert')).textContent).toContain('保存失败');
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '信任并继续' }).hasAttribute('disabled')).toBe(false);
});

it('卡片摘要精简后仍可按关联信息搜索，删除最后一个匹配项后聚焦搜索框', async () => {
  const user = userEvent.setup();
  const view = (values = items) => (
    <EntityWorkspace
      label="部署目标"
      items={values}
      title={(item) => item.name}
      subtitle={() => '非正式环境'}
      searchText={(item) => item.host}
    >
      {(item) => <h2>{item.name}详情</h2>}
    </EntityWorkspace>
  );
  const rendered = render(view());
  await user.type(screen.getByLabelText('搜索部署目标'), '生产服务器');
  const card = screen.getByRole('button', { name: '查看部署目标CRM详情' });
  await user.click(card);
  rendered.rerender(view([items[0]]));
  expect(screen.getByText('没有匹配项，请调整搜索内容。')).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('搜索部署目标'));
});
