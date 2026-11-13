import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
test.skip(process.platform !== 'win32', 'Windows 桌面及 .exe 验收仅在 Windows 运行');
let app: ElectronApplication, dir: string;
test.beforeEach(async () => {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  dir = await fs.mkdtemp(path.join(root, 'smoke-'));
  await launchApp();
});

async function launchApp() {
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
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
  if (process.env.DEPLOY_CENTER_TEST_SCALE) {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(
      Number(process.env.DEPLOY_CENTER_TEST_SCALE),
    );
  }
}
test.afterEach(async () => {
  await app?.close();
  const base = path.resolve('.test-data');
  if (dir && path.resolve(dir).startsWith(base + path.sep))
    await fs.rm(dir, { recursive: true, force: true });
});
test('首次启动无示例服务器；安全选项和 IPC 工作', async () => {
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '一键部署', exact: true })).toBeVisible();
  await expect(page.getByText('添加服务并配置部署目标，或导入已有配置。')).toBeVisible();
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
  await expect(page.getByRole('contentinfo', { name: '应用状态' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
});
test('通过界面保存第一个服务，重启后从 SQLite 恢复', async () => {
  const page = await app.firstWindow();
  await page.getByRole('navigation').getByRole('button', { name: '服务管理', exact: true }).click();
  await page.getByRole('button', { name: '添加服务', exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('本机验收服务');
  await page.getByLabel('服务标识', { exact: true }).fill('local-smoke');
  await page.getByLabel('项目根目录', { exact: true }).fill(dir);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(
    page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '一键部署', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '服务器', exact: true }).click();
  await expect(page.getByText('cordys-19', { exact: false })).toHaveCount(0);
  // 配置保存有防抖，重启验证前等待真实落库，不依赖界面操作恰好超过防抖时间。
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.deployCenter!.load())).database.services[0]?.name,
    )
    .toBe('本机验收服务');
  const loaded = await page.evaluate(() => window.deployCenter!.load());
  expect(loaded.database.services[0].name).toBe('本机验收服务');
  expect(loaded.database.settings.allowMavenNonzero).toBe(true);
  expect(loaded.database.settings.demoMode).toBe(false);
  expect(await fs.stat(path.join(dir, 'deploy-center.sqlite'))).toBeTruthy();
  await app.close();
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
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
  await expect(
    restored
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '一键部署', exact: true }),
  ).toBeVisible();
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
    await page
      .getByRole('navigation', { name: '主导航' })
      .getByRole('button', { name: '一键部署', exact: true })
      .click();
    await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
    await page.getByRole('button', { name: '试运行（远程只读）', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '确认试运行（远程只读）' })).toBeVisible();
    await dialog.getByLabel('登录密码 · 回环测试服务器').fill('fixture-only');
    await dialog.getByRole('button', { name: '开始试运行', exact: true }).click();
    await page.getByRole('button', { name: '信任并继续', exact: true }).click();
    await expect(page.locator('header').getByText('试运行通过', { exact: true })).toBeVisible({
      timeout: 30000,
    });
    const result = await page.evaluate(() => window.deployCenter!.load());
    expect(result.task?.dryRun).toBe(true);
    expect(result.task?.status).toBe('success');
    expect(result.database.history).toHaveLength(0);
    expect(commands).toEqual(['bash -s']);
    expect(sftpUsed).toBe(false);
    expect(JSON.stringify(result)).not.toContain('fixture-only');
    const search = await page.evaluate(
      (query) => window.deployCenter!.searchHistory(query),
      result.task!.targets[0].target.name,
    );
    expect(
      search.hits.some((hit) => hit.taskId === result.task!.id && hit.section === '环境'),
    ).toBe(true);
    const reportFile = path.join(dir, '隔离报告.md');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, reportFile);
    expect(
      await page.evaluate((id) => window.deployCenter!.exportReport(id), result.task!.id),
    ).toBe(true);
    const report = await fs.readFile(reportFile, 'utf8');
    expect(report).toContain('YOTOO 部署报告');
    expect(report).not.toContain('fixture-only');
    await expect(page.getByRole('combobox', { name: '日志目标', exact: true })).toHaveCount(0);
    await expect(page.locator('.task-layout')).toHaveCount(0);
    await expect(page.getByRole('group', { name: '选择任务目标' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '返回部署', exact: true }).click();
    await expect(page.getByRole('heading', { name: '准备好，发布下一版本' })).toBeVisible();
    await page.getByRole('button', { name: '部署历史', exact: true }).click();
    await page.locator('.history-task').first().click();
    await page.getByRole('button', { name: '返回部署历史', exact: true }).click();
    await expect(page.getByRole('heading', { name: '执行任务记录' })).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('1.1.0 自动读取 JAR/Git、刷新信息、字段提示及部署按钮间距', async () => {
  const { runProcess } = await import('../electron/process');
  const git = (args: string[]) =>
    runProcess(
      'git',
      ['-C', dir, '-c', 'core.hooksPath=' + path.join(dir, 'empty-hooks'), ...args],
      { timeout: 10000 },
    );
  await fs.writeFile(path.join(dir, '.gitignore'), '*.jar\n');
  await fs.writeFile(path.join(dir, 'readme.txt'), 'isolated metadata fixture');
  expect((await git(['init', '--initial-branch=metadata-v110'])).code).toBe(0);
  expect((await git(['add', '.gitignore', 'readme.txt'])).code).toBe(0);
  expect(
    (
      await git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--no-gpg-sign',
        '-m',
        'fixture',
      ])
    ).code,
  ).toBe(0);
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  const file = path.join(dir, 'metadata.jar');
  await fs.writeFile(file, Buffer.from(await (await writer.close()).arrayBuffer()));
  await fs.utimes(file, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const db = emptyDatabase();
  const service = {
    ...newService(),
    id: 'metadata-service',
    name: '元数据验收',
    code: 'metadata',
    root: dir,
    jarDir: '.',
    jarName: 'metadata.jar',
  };
  db.services = [service];
  db.targets = [
    {
      ...newTargetTemplate(service.id, 'metadata-server'),
      id: 'metadata-target',
      name: '仅配置不连接',
      directory: '/tmp/metadata-fixture',
      start: 'true',
    },
  ];
  db.servers = [
    {
      id: 'metadata-server',
      name: '不会连接的测试配置',
      host: '127.0.0.1',
      port: 1,
      user: 'fixture',
      auth: 'password',
      alias: '',
      keyPath: '',
      note: '',
      credentialMode: 'ask',
    },
  ];
  db.lastService = service.id;
  db.lastTargets = [db.targets[0].id];
  // 在启动前准备配置，避免空白页尚未结束的自动保存覆盖测试数据。
  await app.close();
  const { Storage } = await import('../electron/storage');
  const storage = new Storage(dir, {
    encrypt: async () => {
      throw new Error('此夹具不写入凭据');
    },
    decrypt: async () => {
      throw new Error('此夹具不读取凭据');
    },
  });
  storage.saveConfig(db);
  storage.close();
  await launchApp();
  const page = await app.firstWindow();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '一键部署', exact: true })
    .click();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  await page.locator('.build-details > summary').click();
  await expect(page.locator('.artifact')).toContainText('文件已读取');
  await expect(page.locator('.artifact')).toContainText('metadata.jar');
  await expect(page.locator('.artifact')).toContainText('2000');
  await expect(page.locator('.artifact')).toContainText('JAR 早于当前 Git 提交');
  await expect(page.locator('.branch')).toContainText('metadata-v110');
  await expect(page.locator('.branch code')).toHaveText(/[0-9a-f]{7}/);
  await expect(page.locator('.branch code')).toHaveAttribute('title', /[0-9a-f]{40}/);
  await expect(page.getByRole('button', { name: '部署', exact: true })).toBeEnabled();
  const deploy = await page.getByRole('button', { name: '部署', exact: true }).boundingBox();
  const dryRun = await page
    .getByRole('button', { name: '试运行（远程只读）', exact: true })
    .boundingBox();
  expect(dryRun!.y - (deploy!.y + deploy!.height)).toBeGreaterThanOrEqual(10);
  const help = page.getByRole('button', { name: '某个目标失败后说明' });
  await help.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expect(page.getByRole('tooltip')).toContainText('本次覆盖');
  await git(['checkout', '-b', 'metadata-refreshed']);
  await page.getByRole('button', { name: '刷新 JAR / Git 信息' }).click();
  await expect(page.locator('.branch')).toContainText('metadata-refreshed');
  await page.getByRole('button', { name: '编辑配置', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByLabel('服务名称', { exact: true })
    .fill('元数据验收（已编辑）');
  await page.getByRole('dialog').getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('.artifact')).toContainText('文件已读取');
  await expect(page.locator('.branch')).toContainText('metadata-refreshed');
  await page.screenshot({ path: test.info().outputPath('v110-deploy.png'), fullPage: true });
  const rejected = await page.evaluate(async () => {
    try {
      await window.deployCenter!.serviceInfo('metadata-service', 'C:\\Windows\\not-selected.jar');
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  await fs.unlink(file);
  await page.getByRole('button', { name: '刷新 JAR / Git 信息' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'JAR 文件不存在' }).first(),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '部署', exact: true })).toBeDisabled();
  await expect(page.locator('.artifact')).toContainText('文件不存在或无法读取');
  await page.getByRole('button', { name: '展开仅配置不连接详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑仅配置不连接', exact: true }).click();
  const targetForm = page.getByRole('dialog');
  await targetForm.getByRole('tab', { name: '健康检查' }).click();
  await targetForm.getByLabel('检查方式', { exact: true }).selectOption('http');
  await targetForm
    .getByLabel('HTTP 健康地址', { exact: true })
    .fill('http://127.0.0.1:8080/health');
  await targetForm.getByLabel('启动等待（秒）', { exact: true }).fill('30');
  await targetForm.getByLabel('最长等待窗口（秒）', { exact: true }).fill('600');
  await targetForm.getByRole('button', { name: '最长等待窗口（秒）说明' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('600');
  await page.screenshot({ path: test.info().outputPath('v110-health.png') });
  const tooltipBox = await page.getByRole('tooltip').boundingBox();
  const contentBox = await page.locator('.modal-content').boundingBox();
  expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(
    contentBox!.y + contentBox!.height,
  );
  await targetForm.getByRole('button', { name: '取消', exact: true }).click();
});
