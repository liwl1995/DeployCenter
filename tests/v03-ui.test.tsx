import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '../src/App';
import { seed, safeConfigJson } from '../src/model';
import { CredentialSession } from '../src/credentials';
import * as ui from '../src/ui';

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function showConfirmation() {
  fireEvent.click(screen.getByRole('button', { name: '部署' }));
  return screen.getByRole('dialog');
}
function start() {
  const modal = showConfirmation();
  fireEvent.click(within(modal).getByRole('button', { name: '部署' }));
}
async function advance(count: number) {
  for (let i = 0; i < count; i++)
    await act(async () => {
      vi.advanceTimersByTime(850);
    });
}

describe('v0.3 组件回归', () => {
  it('A3 原始配置备份提示和下载入口可见，确认前绝不覆盖原键', async () => {
    const raw = '{invalid:原始配置';
    localStorage.setItem('deploy-center-v2', raw);
    render(<App />);
    expect(screen.getByText('配置无法读取，已备份原始数据。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '下载原始数据' })).toBeTruthy();
    const key = Object.keys(localStorage).find((k) => k.startsWith('deploy-center-v2.backup-'))!;
    expect(localStorage.getItem(key)).toBe(raw);
    expect(localStorage.getItem('deploy-center-v2')).toBe(raw);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('switch', { name: '演示模式' }));
    expect(localStorage.getItem('deploy-center-v2')).toBe(raw);
    fireEvent.click(screen.getByRole('button', { name: '确认使用示例配置并保存' }));
    expect(JSON.parse(localStorage.getItem('deploy-center-v2')!).schema).toBe(3);
    expect(localStorage.getItem(key)).toBe(raw);
  });
  it('A5 本次覆盖不会改全局默认，恢复默认能撤销覆盖', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.selectOptions(screen.getByRole('combobox', { name: '某个目标失败后' }), 'continue');
    expect(screen.getByText('本次覆盖', { exact: true })).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('deploy-center-v2')!).settings.failurePolicy).toBe(
      'stop',
    );
    const modal = showConfirmation();
    expect(modal.textContent).toContain('继续其他目标');
    fireEvent.click(within(modal).getByRole('button', { name: '返回检查' }));
    await user.click(screen.getByRole('button', { name: '设置' }));
    expect(
      (screen.getByRole('combobox', { name: '某个目标失败后' }) as HTMLSelectElement).value,
    ).toBe('stop');
    await user.click(screen.getByRole('button', { name: '一键部署' }));
    await user.click(screen.getByRole('button', { name: '恢复默认' }));
    expect(screen.queryByText('本次覆盖', { exact: true })).toBeNull();
  });
  it('A4/B7 步骤和上传显示真实耗时，历史拆开构建日志与目标日志', async () => {
    vi.useFakeTimers();
    render(<App />);
    start();
    await advance(6);
    expect(screen.getByRole('progressbar', { name: '文件上传进度' }).closest('.task-upload')?.textContent).toMatch(/33%.*MB\/s/);
    expect(screen.getAllByText(/0.8 秒|0.9 秒/).length).toBeGreaterThan(0);
    await advance(14);
    fireEvent.click(screen.getByRole('button', { name: '部署历史' }));
    fireEvent.click(screen.getAllByRole('button', { name: '详情' })[0]);
    const modal = screen.getByRole('dialog');
    expect(within(modal).getByRole('heading', { name: '构建日志' })).toBeTruthy();
    expect(within(modal).getByRole('heading', { name: '目标日志' })).toBeTruthy();
    expect(within(modal).getByRole('heading', { name: '目标步骤耗时' })).toBeTruthy();
    expect(within(modal).getAllByRole('columnheader', { name: '开始时间' })).toHaveLength(2);
  });
  it('A5 本次覆盖在任务启动后清除，不带入下一次任务准备', () => {
    render(<App />);
    fireEvent.change(screen.getByRole('combobox', { name: '某个目标失败后' }), {
      target: { value: 'continue' },
    });
    start();
    fireEvent.click(screen.getByRole('button', { name: '一键部署' }));
    expect(
      (screen.getByRole('combobox', { name: '某个目标失败后' }) as HTMLSelectElement).value,
    ).toBe('stop');
    expect(screen.queryByText('本次覆盖', { exact: true })).toBeNull();
  });
  it('B7 设置保留条数立即清理最旧历史与孤立任务日志', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: /历史保留条数/ }), {
      target: { value: '1' },
    });
    const db = JSON.parse(localStorage.getItem('deploy-center-v2')!);
    expect(db.history).toHaveLength(1);
    expect(Object.keys(db.taskHistory)).toHaveLength(1);
  });
  it('B8 密码在确认中询问、同一服务器只问一次，任务结束清除且从不导出', async () => {
    vi.useFakeTimers();
    const db = seed();
    db.servers[0].auth = 'password';
    db.servers[0].host = 'example.test';
    db.servers[0].user = 'deploy';
    db.targets[2].serverId = 's19';
    localStorage.setItem('deploy-center-v2', safeConfigJson(db));
    const exportSpy = vi.spyOn(ui, 'download').mockImplementation(() => {}),
      setSpy = vi.spyOn(CredentialSession.prototype, 'set'),
      clearSpy = vi.spyOn(CredentialSession.prototype, 'clear');
    render(<App />);
    fireEvent.click(screen.getByRole('checkbox', { name: '选择备用环境 · 新增示例' }));
    const modal = showConfirmation(),
      inputs = within(modal).getAllByLabelText(/登录密码 · CRM 测试服务器/);
    expect(inputs).toHaveLength(1);
    expect(document.activeElement).toBe(inputs[0]);
    expect(
      (within(modal).getByRole('button', { name: '部署' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(inputs[0], { target: { value: 'only-in-memory-credential' } });
    fireEvent.click(within(modal).getByRole('button', { name: '部署' }));
    expect(setSpy).toHaveBeenCalledWith({ s19: 'only-in-memory-credential' });
    expect(localStorage.getItem('deploy-center-v2')).not.toContain('only-in-memory-credential');
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('button', { name: '导出配置' }));
    expect(exportSpy.mock.calls[0][1]).not.toContain('only-in-memory-credential');
    const clearCount = clearSpy.mock.calls.length;
    await advance(32);
    expect(clearSpy.mock.calls.length).toBeGreaterThan(clearCount);
    const memory = setSpy.mock.contexts[0] as CredentialSession;
    expect(memory.get('s19')).toBeUndefined();
  });
  it('B8 私钥口令及 Windows 保存选项明确是正式版能力', () => {
    const db = seed();
    db.servers[0].auth = 'key';
    db.servers[0].credentialMode = 'windows';
    localStorage.setItem('deploy-center-v2', safeConfigJson(db));
    render(<App />);
    const modal = showConfirmation();
    expect(modal.textContent).toContain('Windows 凭据管理器是正式版能力');
    expect(within(modal).getByLabelText(/私钥口令/)).toBeTruthy();
    fireEvent.click(within(modal).getByRole('button', { name: '返回检查' }));
    fireEvent.click(screen.getByRole('button', { name: '服务器' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑服务器CRM 测试服务器' }));
    expect(within(screen.getByRole('dialog')).getByLabelText('凭据保存方式')).toBeTruthy();
  });
  it('E11 关闭演示模式隐藏产物、首次部署和故障注入控件', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '使用现有 JAR' }));
    expect(
      screen.getByRole('button', { name: '使用示例产物' }).closest('[aria-label="演示控件"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    fireEvent.click(screen.getByRole('switch', { name: '演示模式' }));
    fireEvent.click(screen.getByRole('button', { name: '一键部署' }));
    expect(screen.queryByRole('button', { name: '使用示例产物' })).toBeNull();
    expect(screen.queryByRole('button', { name: '查看旧产物提醒' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '展开测试环境详情' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑测试环境' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('tab', { name: '备份与安全' }));
    expect(screen.queryByRole('switch', { name: '模拟首次部署（无旧 JAR）' })).toBeNull();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消' }));
    start();
    expect(screen.queryByRole('button', { name: /模拟当前目标/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '模拟容器内哈希不一致' })).toBeNull();
  });
  it('E12 重新构建确认包含工具、命令、Profile、工作目录、JDK 和预期产物', () => {
    const db = seed();
    db.services[0].profiles = 'release';
    db.services[0].workDir = 'backend';
    localStorage.setItem('deploy-center-v2', safeConfigJson(db));
    render(<App />);
    const modal = showConfirmation();
    const details = within(modal).getByText('构建、产物与 Git 详情', { exact: true });
    expect(details.closest('details')?.open).toBe(false);
    fireEvent.click(details);
    expect(details.closest('details')?.open).toBe(true);
    expect(modal.textContent).toContain('mvnw.cmd');
    expect(modal.textContent).toContain('-Prelease');
    expect(modal.textContent).toContain('E:\\projects\\CordysCRM\\backend');
    expect(modal.textContent).toContain('JDK 21');
    expect(modal.textContent).toContain('E:\\dev\\jdk\\jdk21');
    expect(modal.textContent).toContain('backend\\app\\target\\cordys-crm.jar');
  });
  it('E12/E14 现有 JAR 显示元信息、旧提交提醒和桌面选择器限制', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '使用现有 JAR' }));
    expect(screen.getByText(/桌面版将使用系统文件对话框并检查 JAR 有效性/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看旧产物提醒' }));
    const modal = showConfirmation();
    const details = within(modal).getByText('产物与 Git 详情', { exact: true });
    expect(details.closest('details')?.open).toBe(false);
    expect(within(modal).getByText(/JAR 早于当前 Git 提交/).closest('details')).toBeNull();
    fireEvent.click(details);
    expect(modal.textContent).toContain('80.3 MB');
    expect(modal.textContent).toContain('2026-11-01');
    expect(modal.textContent).toContain('JAR 早于当前 Git 提交');
    expect(modal.textContent).toContain('E:\\projects\\CordysCRM');
    expect(within(modal).queryByRole('heading', { name: '构建配置' })).toBeNull();
  });
});
