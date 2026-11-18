import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js';
import { Storage } from '../electron/storage';
import { snapshotJar } from '../electron/files';
import { scheduleConfiguration, schedulePins } from '../electron/scheduler';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import { createTask } from '../src/engine';
test.skip(process.platform !== 'win32', 'Windows 桌面验收');
let app: ElectronApplication, dir: string;
test.beforeEach(async ({}, info) => {
  await fs.mkdir(path.resolve('.test-data'), { recursive: true });
  dir = await fs.mkdtemp(path.resolve('.test-data/schedule-desktop-'));
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await fs.writeFile(
    path.join(dir, 'test.jar'),
    Buffer.from(await (await zip.close()).arrayBuffer()),
  );
  const db = emptyDatabase(),
    service = newService();
  service.id = 'schedule-service';
  service.name = '定时验收服务';
  service.root = dir;
  service.jarDir = '.';
  service.jarName = 'test.jar';
  db.services = [service];
  db.servers = [
    {
      id: 'offline',
      name: '离线配置夹具',
      host: '',
      port: 22,
      user: '',
      auth: 'alias',
      alias: 'fixture-do-not-connect',
      keyPath: '',
      note: '',
      credentialMode: 'ask',
    },
  ];
  if (info.title.startsWith('创建计划通过')) {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    Object.assign(db.servers[0], {
      auth: 'password',
      host: '127.0.0.1',
      port,
      user: 'fixture',
      alias: '',
      credentialMode: 'windows',
    });
  }
  const target = newTargetTemplate(service.id, 'offline');
  target.id = 'test-target';
  target.name = '验收环境';
  target.directory = '/tmp/never-connect';
  target.start = 'true';
  db.targets = [target];
  db.lastService = service.id;
  db.lastTargets = [target.id];
  const store = new Storage(dir, {
    encrypt: async () => {
      throw new Error('不保存凭据');
    },
    decrypt: async () => {
      throw new Error('不读取凭据');
    },
  });
  store.saveConfig(db);
  const task = createTask(db, service, [target], {}, 'existing');
  task.artifact = await snapshotJar(path.join(dir, 'test.jar'), task.id, dir);
  task.preparation = true;
  task.status = 'success';
  task.scheduleBaselines = { [target.id]: 'absent' };
  task.buildLogs = [];
  task.buildPhase = 3;
  task.buildSteps.forEach((s) => {
    s.status = 'success';
  });
  task.targets[0].status = 'success';
  store.claimSchedule(
    {
      id: 'SP-desktop',
      createdAt: Date.now(),
      scheduledAt: Date.now() + 3600000,
      state: 'ready',
      reason: '等待发布时间',
      preparationId: task.id,
      task,
      approval: { productionWord: '', allowWeak: false, protectCurrent: true },
      configuration: scheduleConfiguration(db, task),
      pins: schedulePins(task, {}),
    },
    task,
  );
  store.close();
  const env = { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')],
    env: env as Record<string, string>,
  });
});
test.afterEach(async () => {
  if (app) {
    const page = await app.firstWindow();
    await page
      .evaluate(async () => {
        for (const plan of await window.deployCenter!.listSchedules())
          if (plan.state !== 'executing') await window.deployCenter!.cancelSchedule(plan.id);
      })
      .catch(() => {});
    await app.close();
  }
  if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试目录越界');
  await fs.rm(dir, { recursive: true, force: true });
});
test('定时发布入口、确认时间、计划改期取消与日志返回', async () => {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  await expect(page.getByRole('button', { name: '部署', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发布选项', exact: true }).click();
  await page.getByRole('menuitem', { name: '定时发布', exact: true }).click();
  await expect(page.getByRole('heading', { name: '确认定时发布', exact: true })).toBeVisible();
  await expect(page.getByLabel('发布时间', { exact: true })).toBeVisible();
  await expect(page.getByText(/退出或休眠错过时间不补发/)).toBeVisible();
  await page.getByRole('button', { name: '返回检查', exact: true }).click();
  await page.getByRole('navigation').getByRole('button', { name: '发布计划', exact: true }).click();
  await expect(page.getByText('就绪', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '调整时间' }).click();
  const date = new Date(Date.now() + 7200000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel('发布时间', { exact: true }).fill(local);
  await page.getByRole('button', { name: '确认计划', exact: true }).click();
  await page.getByText('产物与计划详情', { exact: true }).click();
  await expect(page.getByText('已重新确认发布时间', { exact: false })).toBeVisible();
  expect((await page.evaluate(() => window.deployCenter!.listSchedules()))[0].scheduledAt).toBe(
    new Date(local).getTime(),
  );
  await page.getByRole('button', { name: /发布计划操作/ }).click();
  await page.getByRole('menuitem', { name: '准备日志', exact: true }).click();
  await expect(page.getByText(/定时发布准备完成，尚未上传或修改远端/)).toBeVisible();
  await page.getByRole('button', { name: /返回发布计划/ }).click();
  await page.getByRole('button', { name: /发布计划操作/ }).click();
  await page.getByRole('menuitem', { name: '取消计划', exact: true }).click();
  await expect(page.getByText('已取消', { exact: true })).toBeVisible();
});
test('计划页面在三个尺寸下可用，重新准备仍需确认', async () => {
  const page = await app.firstWindow();
  await page.getByRole('navigation').getByRole('button', { name: '发布计划', exact: true }).click();
  for (const [width, height] of [
    [1000, 620],
    [1280, 800],
    [1600, 900],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
      [width, height],
    );
    const menu = page.getByRole('button', { name: /发布计划操作/ });
    await menu.click();
    await expect(page.getByRole('menuitem', { name: '准备日志', exact: true })).toBeInViewport();
    await page.keyboard.press('Escape');
    expect(
      await page.getByRole('main').evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeLessThanOrEqual(1);
  }
  await page.getByRole('button', { name: /发布计划操作/ }).click();
  await page.getByRole('menuitem', { name: '重新构建' }).click();
  await expect(page.getByRole('heading', { name: '确认定时发布', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '返回检查' }).click();
  expect(await page.evaluate(() => window.deployCenter!.listTasks())).toEqual([]);
});

test('创建计划通过真实 IPC 和 utilityProcess 准备，认证失败不上传且不产生部署历史', async () => {
  const page = await app.firstWindow();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  await expect(page.getByRole('button', { name: '部署', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '发布选项', exact: true }).click();
  await page.getByRole('menuitem', { name: '定时发布', exact: true }).click();
  await page
    .getByLabel('登录密码 · 离线配置夹具', { exact: true })
    .fill('schedule-isolated-fixture');
  await page.getByRole('button', { name: '确认计划', exact: true }).click();
  await expect(page.getByRole('heading', { name: '发布计划', exact: true })).toBeVisible();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.deployCenter!.listSchedules())).find(
          (p) => p.id !== 'SP-desktop',
        )?.state,
    )
    .toBe('failed');
  const plans = await page.evaluate(() => window.deployCenter!.listSchedules());
  expect(plans).toHaveLength(2);
  expect(JSON.stringify(plans)).not.toContain('schedule-isolated-fixture');
  const created = plans.find((p) => p.id !== 'SP-desktop')!;
  const task = await page.evaluate(
    (id) => window.deployCenter!.readTask(id),
    created.preparationId,
  );
  expect(task.preparation).toBe(true);
  expect(task.targets.every((r) => !r.remote)).toBe(true);
  expect((await page.evaluate(() => window.deployCenter!.load())).database.history).toEqual([]);
});
