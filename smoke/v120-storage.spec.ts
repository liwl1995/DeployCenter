import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import ssh2 from 'ssh2';
import type { AddressInfo } from 'node:net';
import { emptyDatabase, newService } from '../src/defaults';
test.skip(process.platform !== 'win32', 'Windows 桌面及 .exe 验收仅在 Windows 运行');
let app: ElectronApplication, root: string, source: string, target: string;
async function launch() {
  const env = {
    ...process.env,
    DEPLOY_CENTER_DATA_DIR: source,
    DEPLOY_CENTER_TESTING: '1',
    DEPLOY_CENTER_SETTINGS_DIR: path.join(root, 'settings'),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return electron.launch({
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
}
test.beforeEach(async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'v120-ui-'));
  source = path.join(root, '原数据');
  target = path.join(root, '迁移 后');
  app = await launch();
  if (process.env.DEPLOY_CENTER_TEST_SCALE) {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(
      Number(process.env.DEPLOY_CENTER_TEST_SCALE),
    );
  }
  const page = await app.firstWindow(),
    db = emptyDatabase(),
    service = newService();
  service.id = 'storage-smoke';
  service.name = '空间管理验收';
  service.root = root;
  db.services = [service];
  db.lastService = service.id;
  await page.evaluate((value) => window.deployCenter!.save(value), db);
  await page.reload();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据与存储', exact: true }).click();
});
test.afterEach(async () => {
  await app?.close();
  if (root && root.startsWith(path.resolve('.test-data') + path.sep))
    await fs.rm(root, { recursive: true, force: true });
});
test('1.2.0 空间策略实际 IPC、三个宽度无横向溢出', async () => {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '存储占用与清理' })).toBeVisible();
  for (const width of [1000, 1280, 1600]) {
    await app.evaluate(
      ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
      width,
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      )
      .toBe(true);
  }
  await page.getByLabel('产物保留方式', { exact: true }).selectOption('count');
  await page.getByLabel('保留不同 JAR 的数量').fill('2');
  await page.getByRole('button', { name: '预览并应用保留策略' }).click();
  await expect(page.getByRole('dialog')).toContainText('将删除 0 个文件');
  await page.getByRole('button', { name: '确认应用', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.deployCenter!.load())).database.settings.artifactPolicy
          ?.maxCount,
    )
    .toBe(2);
});
test('1.2.0 从设置迁移全部数据，重启激活且默认保留旧目录', async () => {
  let page = await app.firstWindow();
  await page.getByRole('button', {name:'更换数据目录'}).click();
  await page.getByLabel('选择上级目录', { exact: true }).fill(target);
  await expect(page.getByTestId('migration-final-path')).toHaveText(path.join(target,'DeployCenter'));
  await page.getByRole('button', { name: '检查并准备迁移' }).click();
  await expect(page.getByText('目录检查通过', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('原目录默认保留');
  await page.getByRole('button', { name: '开始迁移', exact: true }).click();
  await expect(page.getByRole('button', { name: '重启并使用新目录' })).toBeVisible();
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await expect
    .poll(async () => (await page.evaluate(() => window.deployCenter!.load())).dataDir)
    .toBe(path.join(target, 'DeployCenter'));
  expect((await page.evaluate(() => window.deployCenter!.load())).database.services[0].name).toBe(
    '空间管理验收',
  );
  expect((await fs.stat(path.join(source, 'deploy-center.sqlite'))).isFile()).toBe(true);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据与存储', exact: true }).click();
  await expect(page.getByText('原数据副本仍保留', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保留旧目录（默认）' })).toBeVisible();
  await page.getByRole('button', { name: '保留旧目录（默认）' }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.deployCenter!.load())).dataLocation?.previousKept,
    )
    .toBe(true);
});
test('迁移后实际解密Windows保存凭据并认证回环SSH；导出不含凭据', async () => {
  const { private: key } = ssh2.utils.generateKeyPairSync('ed25519'),
    secret = 'dpapi-migration-fixture-only';
  let authenticated = false;
  const ssh = new ssh2.Server({ hostKeys: [key] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === secret) {
        authenticated = true;
        ctx.accept();
      } else ctx.reject();
    });
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept) => {
          const channel = accept();
          channel.on('error', () => {});
          channel.on('data', () => {});
          channel.on('end', () => {
            channel.write('本机隔离 SSH 连接成功\n');
            channel.exit(0);
            channel.end();
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => ssh.listen(0, '127.0.0.1', resolve));
  try {
    let page = await app.firstWindow();
    const startup = await page.evaluate(() => window.deployCenter!.load());
    expect(startup.encryptionAvailable).toBe(true);
    // 使用真实表单写入，等待其防抖保存；不在界面背后改库而与旧自动保存竞争。
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '服务器', exact: true })
      .click();
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    const form = page.getByRole('dialog', { name: '服务器配置' });
    await form.getByLabel('服务器名称', { exact: true }).fill('仅回环认证夹具');
    await form.getByLabel('认证方式', { exact: true }).selectOption('password');
    await form.getByLabel('IP 地址或域名', { exact: true }).fill('127.0.0.1');
    await form
      .getByLabel('SSH 端口', { exact: true })
      .fill(String((ssh.address() as AddressInfo).port));
    await form.getByLabel('登录用户名', { exact: true }).fill('fixture');
    await form.getByLabel('凭据保存方式', { exact: true }).selectOption('windows');
    await form.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect
      .poll(async () =>
        (await page.evaluate(() => window.deployCenter!.load())).database.servers.some(
          (s) => s.name === '仅回环认证夹具',
        ),
      )
      .toBe(true);
    const serverId = (await page.evaluate(() => window.deployCenter!.load())).database.servers.find(
      (s) => s.name === '仅回环认证夹具',
    )!.id;
    await page.evaluate(({ id, secret }) => window.deployCenter!.saveCredential(id, secret), {
      id: serverId,
      secret,
    });
    expect((await page.evaluate(() => window.deployCenter!.load())).savedCredentials).toContain(
      serverId,
    );
    const result = await page.evaluate(
      (path) => window.deployCenter!.migrateDirectory(path),
      target,
    );
    expect(result.state).toBe('pending');
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole('heading', { name: '首页总览', exact: true }).waitFor();
    const connection = page.evaluate((id) => window.deployCenter!.testConnection(id), serverId);
    await page.getByRole('button', { name: '信任并继续', exact: true }).click();
    expect(await connection).toContain('SSH 连接成功');
    expect(authenticated).toBe(true);
    const output = path.join(root, '配置导出.json');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    expect(await page.evaluate(() => window.deployCenter!.exportConfig())).toBe(true);
    const raw = await fs.readFile(output, 'utf8');
    expect(raw).not.toContain(secret);
    expect(JSON.parse(raw).dataStorageNote).toContain('不能替代数据目录备份');
    expect(
      (await fs.readFile(path.join(target, 'DeployCenter', 'deploy-center.sqlite'))).includes(Buffer.from(secret)),
    ).toBe(false);
  } finally {
    await new Promise<void>((resolve) => ssh.close(() => resolve()));
  }
});
