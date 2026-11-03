import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
let app: ElectronApplication, dir: string;
test.beforeEach(async () => {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  dir = await fs.mkdtemp(path.join(root, 'smoke-'));
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: [
      ...(process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')]),
      ...(process.env.DEPLOY_CENTER_TEST_SCALE
        ? ['--force-device-scale-factor=' + process.env.DEPLOY_CENTER_TEST_SCALE]
        : []),
    ],
    env: env as Record<string, string>,
  });
});
test.afterEach(async () => {
  await app?.close();
  const base = path.resolve('.test-data');
  if (dir && path.resolve(dir).startsWith(base + path.sep))
    await fs.rm(dir, { recursive: true, force: true });
});
test('首次启动无示例服务器；安全选项和 IPC 工作', async () => {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'YOTOO 部署中心', exact: true })).toBeVisible();
  await expect(
    page.getByText('添加第一个服务，或导入已有配置。不会自动连接任何服务器。'),
  ).toBeVisible();
  expect(
    await page.evaluate(() => ({
      require: typeof (window as unknown as { require: unknown }).require,
      api: typeof window.deployCenter,
    })),
  ).toEqual({ require: 'undefined', api: 'object' });
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      sandbox: p.sandbox,
      contextIsolation: p.contextIsolation,
      nodeIntegration: p.nodeIntegration,
    };
  });
  expect(prefs).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  expect((await page.evaluate(() => window.deployCenter!.load())).database.servers).toHaveLength(0);
  await expect(page.getByText('模拟当前目标启动 / 健康检查失败')).toHaveCount(0);
});
test('通过界面保存第一个服务，重启后从 SQLite 恢复', async () => {
  const page = await app.firstWindow();
  await page.getByLabel('服务名称', { exact: true }).fill('本机验收服务');
  await page.getByLabel('服务标识', { exact: true }).fill('local-smoke');
  await page.getByLabel('项目根目录', { exact: true }).fill(dir);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('button', { name: '一键部署', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(page.getByText('cordys-19', { exact: false })).toHaveCount(0);
  const loaded = await page.evaluate(() => window.deployCenter!.load());
  expect(loaded.database.services[0].name).toBe('本机验收服务');
  expect(loaded.database.settings.allowMavenNonzero).toBe(true);
  expect(loaded.database.settings.demoMode).toBe(false);
  expect(await fs.stat(path.join(dir, 'deploy-center.sqlite'))).toBeTruthy();
  await app.close();
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: [
      ...(process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')]),
      ...(process.env.DEPLOY_CENTER_TEST_SCALE
        ? ['--force-device-scale-factor=' + process.env.DEPLOY_CENTER_TEST_SCALE]
        : []),
    ],
    env: env as Record<string, string>,
  });
  const restored = await app.firstWindow();
  await expect(restored.getByRole('button', { name: '一键部署', exact: true })).toBeVisible();
  expect(
    (await restored.evaluate(() => window.deployCenter!.load())).database.services[0].name,
  ).toBe('本机验收服务');
});
test('渲染进程不能检查未经选择的任意 JAR 或无效任务', async () => {
  const page = await app.firstWindow();
  const errors = await page.evaluate(async () => {
    const failures: string[] = [];
    try {
      await window.deployCenter!.inspectJar('C:\\Windows\\not-selected.jar');
    } catch (e) {
      failures.push(String(e));
    }
    try {
      await window.deployCenter!.cancel('../bad');
    } catch (e) {
      failures.push(String(e));
    }
    return failures;
  });
  expect(errors[0]).toContain('请选择');
  expect(errors).toHaveLength(2);
});
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import type { AddressInfo } from 'node:net';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';

test('utilityProcess 通过 IPC 执行只读试运行，完成首次指纹确认', async () => {
  const { private: key } = utils.generateKeyPairSync('ed25519');
  const commands: string[] = [];
  let sftpUsed = false;
  const server = new Server({ hostKeys: [key] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.password === 'fixture-only' ? ctx.accept() : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('sftp', (_accept, reject) => {
          sftpUsed = true;
          reject();
        });
        session.on('exec', (accept, _reject, info) => {
          commands.push(info.command);
          const channel = accept();
          channel.on('error', () => {});
          channel.on('data', () => {});
          channel.on('end', () => {
            channel.write('测试夹具：目录、权限和空间只读检查完成\n');
            channel.exit(0);
            channel.end();
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
    await fs.writeFile(
      path.join(dir, 'test.jar'),
      Buffer.from(await (await writer.close()).arrayBuffer()),
    );
    const db = emptyDatabase();
    const service = {
      ...newService(),
      id: 'smoke-service',
      name: '本机试运行验收',
      code: 'smoke',
      root: dir,
      jarDir: '.',
      jarName: 'test.jar',
    };
    const target = {
      ...newTargetTemplate(service.id, 'smoke-server'),
      id: 'smoke-target',
      name: '本机临时目标',
      directory: '/tmp/deploy-center-fixture',
      start: 'true',
    };
    db.services = [service];
    db.targets = [target];
    db.servers = [
      {
        id: 'smoke-server',
        name: '回环测试服务器',
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        user: 'fixture',
        auth: 'password',
        alias: '',
        keyPath: '',
        note: '',
        credentialMode: 'ask',
      },
    ];
    db.lastService = service.id;
    db.lastTargets = [target.id];
    const page = await app.firstWindow();
    await page.evaluate((value) => window.deployCenter!.save(value), db);
    await page.reload();
    await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
    await page.getByRole('button', { name: '试运行（远程只读）', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '确认试运行（远程只读）' })).toBeVisible();
    await dialog.getByLabel('登录密码 · 回环测试服务器').fill('fixture-only');
    await dialog.getByRole('button', { name: '开始试运行', exact: true }).click();
    await page.getByRole('button', { name: '信任并继续', exact: true }).click();
    await expect(page.getByText('任务完成', { exact: true })).toBeVisible({ timeout: 30000 });
    const result = await page.evaluate(() => window.deployCenter!.load());
    expect(result.task?.dryRun).toBe(true);
    expect(result.task?.status).toBe('success');
    expect(result.database.history).toHaveLength(0);
    expect(commands).toEqual(['bash -s']);
    expect(sftpUsed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-only');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
