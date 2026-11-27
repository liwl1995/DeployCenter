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
import type { ReleaseSchedule } from '../src/schedules';
import { expectViewport } from './window-size';
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
  const trayDispatch = info.title.startsWith('关闭到托盘');
  const credentialAdjustment = info.title.startsWith('改期读取');
  if (info.title.startsWith('创建计划通过') || trayDispatch || credentialAdjustment) {
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
  if (credentialAdjustment) target.production = true;
  const reprepare = info.title.startsWith('计划页面在三个尺寸');
  if (reprepare) {
    target.appLogPath = '/tmp/fixture-only.log';
    target.observation = { enabled: false, duration: 60 };
  }
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
  if (reprepare) task.targets[0].target.observation = { enabled: true, duration: 120 };
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
      scheduledAt: Date.now() + (trayDispatch ? 25_000 : 3600000),
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

test('关闭到托盘后调度继续运行，显式退出仍确认待发布计划', async () => {
  test.setTimeout(65_000);
  const page = await app.firstWindow();
  await page.evaluate(() => window.deployCenter!.saveDesktopPreferences({ closeToTray: true }));
  await app.evaluate(({ app, BrowserWindow, dialog }) => {
    const showMessageBox = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = ((parent, options) => {
      if (options?.message === '仍有待发布计划') {
        (globalThis as unknown as { quitPrompt: boolean }).quitPrompt = true;
        return Promise.resolve({ response: 0, checkboxChecked: false });
      }
      return showMessageBox(parent, options);
    }) as typeof dialog.showMessageBox;
    BrowserWindow.getAllWindows()[0].close();
    app.quit();
  });
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  expect(await app.evaluate(() => (globalThis as unknown as { quitPrompt: boolean }).quitPrompt)).toBe(true);
  // 缺少本机凭据使调度停在连接之前，本用例无须连接任何服务器。
  await expect.poll(async () => (await page.evaluate(() => window.deployCenter!.listSchedules()))[0]?.reason, {
    timeout: 32_000,
  }).toContain('无法启动计划');
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
  await page.getByRole('button', { name: '确认改期', exact: true }).click();
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
  await expect(page.getByText('已取消', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '已结束', exact: true }).click();
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
  await page.getByRole('menuitem', { name: '重新准备' }).click();
  await expect(page.getByRole('heading', { name: '重新准备发布计划', exact: true })).toBeVisible();
  await expect(page.getByText('日志观察：健康未验证时观察 120 秒')).toBeVisible();
  await page.getByRole('button', { name: '返回检查' }).click();
  expect(await page.evaluate(() => window.deployCenter!.listTasks())).toEqual([]);
  expect(await page.evaluate(async () => (await window.deployCenter!.load()).database.targets[0].observation)).toEqual({
    enabled: false,
    duration: 60,
  });
});

test('改期读取已保存的 Windows 凭据，正式环境仍需确认', async () => {
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const theme = async (label: string, value: string) => {
    await button('设置').click();
    await page.getByRole('group', { name: '界面主题' }).getByRole('button', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', value);
    await button('返回应用').click();
  };
  const openPlans = () => button('发布计划').click();
  const fixtureSecret = 'schedule-adjustment-fixture';
  const plans = () => page.evaluate(() => window.deployCenter!.listSchedules());
  const save = () => page.evaluate((value) => window.deployCenter!.saveCredential('offline', value), fixtureSecret);
  const [original] = await plans();
  await theme('浅色', 'light');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(900, 600);
    window.webContents.setZoomFactor(1.5);
  });
  await expectViewport(page, 600, 400);
  await openPlans();
  await expect(page.getByText(/尚未保存登录密码/)).toBeVisible();
  await expect(button('调整时间')).toHaveCount(0);

  await save();
  await theme('深色', 'dark');
  await openPlans();
  await expectViewport(page, 600, 400);
  await expect(button('调整时间')).toBeInViewport({ ratio: 1 });
  await button('调整时间').press('Enter');
  const dialog = page.getByRole('dialog', { name: '调整发布时间' });
  const submit = dialog.getByRole('button', { name: '确认改期' });
  await expect(dialog.locator('input[type=password]')).toHaveCount(0);
  await expect(dialog.getByText(/Windows 已保存的凭据/)).toBeVisible();
  await expect(submit).toBeDisabled();
  await dialog.getByLabel('输入环境名称：验收环境').fill('验收环境');
  const date = new Date(Date.now() + 7_200_000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await dialog.getByLabel('发布时间', { exact: true }).fill(local);
  await page.evaluate(() => window.deployCenter!.deleteCredential('offline'));
  await submit.press('Enter');
  await expect(dialog.getByRole('alert')).toContainText('尚未保存登录密码');
  expect((await plans())[0].scheduledAt).toBe(original.scheduledAt);

  await save();
  await expect(submit).toBeInViewport({ ratio: 1 });
  await submit.press('Enter');
  await expect(dialog).toBeHidden();
  const [adjusted] = await plans();
  expect(adjusted.scheduledAt).toBe(new Date(local).getTime());
  expect(adjusted.preparationId).toBe(original.preparationId);
  expect(JSON.stringify(adjusted)).not.toContain(fixtureSecret);
  expect(await page.evaluate(() => window.deployCenter!.listTasks())).toEqual([]);
});

test('从计划返回恢复筛选、展开、滚动与焦点，后台任务独立更新', async () => {
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const setTheme = async (label: string, theme: string) => {
    await button('设置').click();
    await page.getByRole('group', { name: '界面主题' }).getByRole('button', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await button('返回应用').click();
    await button('发布计划').click();
  };
  const [fixture] = await page.evaluate(() => window.deployCenter!.listSchedules());
  const plans = Array.from({ length: 20 }, (_, index): ReleaseSchedule => ({
    ...fixture,
    id: 'SP-navigation-' + index,
    state: 'completed',
    createdAt: fixture.createdAt - index,
    preparationId: 'DC-navigation-prep-' + index,
    task: {
      ...fixture.task,
      id: 'DC-navigation-prep-' + index,
      service: { ...fixture.task.service, name: '历史计划 ' + index },
    },
  }));
  const selected = plans[plans.length - 1];
  selected.taskId = 'DC-navigation-deploy';
  const deployment = { ...selected.task, id: selected.taskId, preparation: false };
  const background = {
    ...deployment,
    id: 'DC-navigation-active',
    service: { ...deployment.service, name: '后台验收任务' },
    status: 'running' as const,
  };
  const active: ReleaseSchedule = {
    ...fixture,
    id: 'SP-navigation-active',
    state: 'executing',
    task: { ...fixture.task, service: background.service },
    taskId: background.id,
  };
  await app.evaluate(({ BrowserWindow, ipcMain }, data) => {
    ipcMain.removeHandler('deploy:list-schedules');
    ipcMain.handle('deploy:list-schedules', () => data.plans);
    ipcMain.removeHandler('deploy:read-task');
    ipcMain.handle('deploy:read-task', (_event, id) => {
      const task = data.tasks.find((entry) => entry.id === id);
      if (!task) throw new Error('验收任务不存在');
      return task;
    });
    BrowserWindow.getAllWindows()[0].webContents.send('deploy:event', {
      kind: 'schedules',
      schedules: data.plans,
    });
  }, { plans: [fixture, ...plans, active], tasks: [selected.task, deployment, background] });

  await setTheme('浅色', 'light');
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(900, 600);
    window.webContents.setZoomFactor(1.5);
  });
  await expectViewport(page, 600, 400);
  await button('已结束').click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: selected.task.service.name }) });
  const planMenu = button(selected.task.service.name + '发布计划操作');
  await card.getByText('产物与计划详情', { exact: true }).click();
  await expect(card.locator('details')).toHaveJSProperty('open', true);
  await planMenu.scrollIntoViewIfNeeded();
  const scrollTop = () => page.getByRole('main').evaluate((main) => main.scrollTop);
  const position = await scrollTop();
  expect(position).toBeGreaterThan(0);
  await planMenu.press('Enter');
  await page.getByRole('menuitem', { name: '准备日志', exact: true }).press('Enter');
  const back = button('返回发布计划');
  const taskHeading = page.locator('.task-page-header h1');
  await expect(back).toBeFocused();
  await expect(taskHeading).toContainText(selected.task.service.name);
  await expect(taskHeading).toContainText('定时发布准备');

  await app.evaluate(({ BrowserWindow }, task) => {
    BrowserWindow.getAllWindows()[0].webContents.send('deploy:event', { kind: 'task', task });
  }, background);
  await expect(button('当前任务')).toBeVisible();
  await expect(button('当前任务')).not.toHaveAttribute('aria-current', 'page');
  await expect(taskHeading).toContainText(selected.task.service.name);
  await back.press('Enter');
  await expect(button('已结束')).toHaveAttribute('aria-pressed', 'true');
  await expect(planMenu).toBeFocused();
  await expect(card.locator('details')).toHaveJSProperty('open', true);
  expect(Math.abs((await scrollTop()) - position)).toBeLessThanOrEqual(1);

  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '部署任务', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(taskHeading).toContainText(selected.task.service.name);
  await expect(taskHeading).not.toContainText('定时发布准备');
  await button('当前任务').press('Enter');
  await expect(taskHeading).toContainText(background.service.name);
  await expect(button('当前任务')).toHaveAttribute('aria-current', 'page');
  await back.press('Enter');
  await expect(planMenu).toBeFocused();

  await setTheme('深色', 'dark');
  await expectViewport(page, 600, 400);
  await button('执行中').click();
  await button(background.service.name + '发布计划操作').press('Enter');
  await page.getByRole('menuitem', { name: '部署任务', exact: true }).press('Enter');
  await expect(taskHeading).toContainText(background.service.name);
  await app.evaluate(({ BrowserWindow, ipcMain }, data) => {
    ipcMain.removeHandler('deploy:list-schedules');
    ipcMain.handle('deploy:list-schedules', () => data.plans);
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.send('deploy:event', { kind: 'schedules', schedules: data.plans });
    contents.send('deploy:event', { kind: 'task', task: data.task });
  }, { plans: [fixture, ...plans, { ...active, state: 'completed' }], task: { ...background, status: 'success' } });
  await expect(button('当前任务')).toHaveCount(0);
  await expect(page.getByText('已部署成功', { exact: true })).toBeVisible();
  await back.press('Enter');
  await expect(button('执行中')).toHaveAttribute('aria-pressed', 'true');
  await expect(button('执行中')).toBeFocused();
  await expect(page.getByText('当前状态下暂无发布计划')).toBeVisible();
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
