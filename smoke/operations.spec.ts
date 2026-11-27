import { expect, test, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import ssh2 from 'ssh2';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import { Storage } from '../electron/storage';
import { expectViewport } from './window-size';

test.skip(process.platform !== 'win32', '在 Windows Electron 中验收运维及全屏日志');

test('运维状态、生产重启确认、完成后翻阅与固定目标日志', async () => {
  test.setTimeout(45_000);
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const data = await fs.mkdtemp(path.join(root, 'ops-e2e-'));
  const password = 'only-for-isolated-ops-e2e';
  const requests: string[] = [];
  const clients = new Set<ssh2.Connection>();
  const ssh = new ssh2.Server({ hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private] }, (client) => {
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.on('error', () => {});
    client.on('authentication', (request) =>
      request.method === 'password' && request.password === password ? request.accept() : request.reject());
    client.on('ready', () => client.on('session', (accept) => {
      accept().on('exec', (open, reject, info) => {
        if (info.command !== 'bash -s') { reject(); return; }
        const stream = open();
        let input = '';
        stream.on('data', (value: Buffer) => input += value.toString());
        stream.on('end', () => {
          requests.push(input);
          if (input.trimEnd().endsWith('status_result')) {
            stream.write('running\t0\t\t\t0\thealthy\t2026-01-01T00:00:00Z\n');
            stream.exit(0); stream.end(); return;
          }
          if (input.includes("--request GET") && input.includes("'http://localhost:8080/health'")) {
            stream.write('204'); stream.exit(0); stream.end(); return;
          }
          const owner = input.match(/MARKER='([^']+)'/)?.[1];
          if (!owner || !input.includes("ACTION='restart'")) { stream.exit(1); stream.end(); return; }
          stream.write('回环运维输出 ' + password + '\n');
          stream.write(Array.from({ length: 180 }, (_, index) => '验收日志行 ' + index).join('\n') + '\n');
          setTimeout(() => {
            stream.write(owner + '\tsuccess\t容器运行稳定\n');
            stream.exit(0); stream.end();
          }, 350);
        });
      });
    }));
  });
  let app: ElectronApplication | undefined;
  try {
    await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
    const store = new Storage(data, { encrypt: async (text) => Buffer.from(text), decrypt: async (bytes) => bytes.toString() });
    try {
      const service = { ...newService(), id: 'ops-service', name: '验收服务', code: 'ops-service', root: data };
      const target = { ...newTargetTemplate(service.id, 'ops-server'), id: 'ops-target', name: '正式运维目标', production: true,
        directory: '/opt/isolated', mode: 'docker' as const, container: 'fixture' };
      target.health = { ...target.health, type: 'http', value: 'http://localhost:8080/health', location: 'remote' };
      store.saveConfig({
        ...emptyDatabase(), services: [service], targets: [target, { ...target, id: 'other', name: '第二目标', directory: '/opt/other' }],
        lastService: service.id,
        servers: [{ id: 'ops-server', name: '回环服务器', auth: 'password', host: '127.0.0.1', user: 'fixture',
          port: (ssh.address() as AddressInfo).port, alias: '', keyPath: '', note: '', credentialMode: 'ask' }],
      });
    } finally { store.close(); }
    const exe = process.env.DEPLOY_CENTER_TEST_EXE;
    app = await electron.launch({
      executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
      args: exe ? [] : [path.resolve('.')],
      env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: data },
    });
    const page = await app.firstWindow();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 620));
    await page.getByRole('tab', { name: '运维', exact: true }).click();
    await button('刷新状态').click();
    await page.getByRole('dialog', { name: '连接服务器检查运行状态' }).locator('input[type=password]').fill(password);
    await button('连接').click();
    await button('信任并继续').click();
    await expect(page.getByText('运行中', { exact: true })).toBeVisible();
    await expect(page.getByText('通过 · HTTP 204', { exact: true })).toBeVisible();
    await expect(button('启动')).toBeDisabled();
    await button('重启').click();
    await expect(page.getByRole('dialog')).toContainText('docker stop --time 30');
    await expect(button('确认重启')).toBeDisabled();
    await page.getByLabel('输入目标名称确认 · 正式运维目标').fill('正式运维目标');
    await page.getByLabel('登录密码', { exact: true }).fill(password);
    await button('确认重启').click();
    await expect(page.getByText('容器运行稳定', { exact: true })).toBeVisible();
    expect(requests.filter((input) => input.includes("ACTION='restart'"))).toHaveLength(1);
    await button('返回运维').click();
    await button('运维日志').click();
    const log = page.getByRole('log', { name: '运维执行日志' });
    await expect(log.getByText('验收日志行 179', { exact: true })).toBeInViewport();
    await log.hover();
    await page.mouse.wheel(0, -10000);
    const firstOutput = log.getByText(/回环运维输出/);
    await expect(firstOutput).toBeInViewport();
    await expect(firstOutput).not.toContainText(password);
    await page.getByRole('textbox', { name: '搜索日志' }).fill('验收日志行 126');
    await button('下一处').press('Enter');
    await expect(log.getByText('验收日志行 126', { exact: true })).toBeInViewport();
    await button('返回运维').click();
    await button('查看线上日志').click();
    await expect(page.getByRole('region', { name: '线上应用日志' })).toBeVisible();
    await expect(button('连接日志')).toBeVisible();
    await expect(page.getByRole('combobox', { name: '日志目标' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: '运维目标' })).toHaveCount(0);
    expect(await page.locator('main').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await button('返回运维').click();
    await expect(page.getByRole('combobox', { name: '运维目标' })).toHaveValue('ops-target');
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(900, 600);
      window.webContents.setZoomFactor(1.5);
    });
    await expectViewport(page, 600, 400);
    await expect(button('查看线上日志')).toBeVisible();
    expect(await page.locator('main').evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await button('运维日志').press('Enter');
    await log.scrollIntoViewIfNeeded();
    await expect(log.getByText('验收日志行 179', { exact: true })).toBeInViewport();
    await button('返回运维').click();
    await button('部署目标').click();
    await expect(page.locator('.entity-list').getByText('运行中', { exact: true })).toBeVisible();
  } finally {
    await app?.close().catch(() => {});
    for (const client of clients) client.end();
    ssh.close();
    if (path.dirname(data) === root) await fs.rm(data, { recursive: true, force: true });
  }
});
