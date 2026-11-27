import { expectViewport } from './window-size';
import Sqlite from 'better-sqlite3';
import { Storage } from '../electron/storage';
import { createTask } from '../src/engine';
import { recordTask } from '../src/records';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
test.skip(process.platform !== 'win32', 'Windows 桌面及 .exe 验收仅在 Windows 运行');
let app: ElectronApplication, dir: string;
test.beforeEach(async ({}, info) => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  dir = await fs.mkdtemp(path.join(base, 'v120-workspace-'));
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await fs.writeFile(
    path.join(dir, 'test.jar'),
    Buffer.from(await (await writer.close()).arrayBuffer()),
  );
  const localHash = createHash('sha256')
    .update(await fs.readFile(path.join(dir, 'test.jar')))
    .digest('hex');
  const db = emptyDatabase(),
    service = newService();
  service.id = 'workspace-smoke';
  service.name = '中文空格项目';
  service.root = dir;
  service.jarDir = '.';
  service.jarName = 'test.jar';
  db.services = Array.from({ length: 6 }, (_, i) => ({
    ...service,
    id: i ? service.id + '-' + i : service.id,
    name: service.name + i,
  }));
  db.lastService = service.id;
  db.servers = [
    {
      id: 'offline',
      name: '仅配置不连接',
      auth: 'alias',
      alias: 'fixture-do-not-connect',
      host: '',
      port: 22,
      user: '',
      keyPath: '',
      note: '本测试不连接服务器',
      credentialMode: 'ask',
    },
  ];
  db.servers = Array.from({ length: 6 }, (_, i) => ({
    ...db.servers[0],
    id: i ? 'offline-' + i : 'offline',
    name: '仅配置不连接' + i,
  }));
  db.targets = Array.from({ length: 6 }, (_, i) => ({
    ...newTargetTemplate(service.id, 'offline'),
    id: 'target-' + i,
    name: '环境' + i,
    production: i === 3,
    directory: '/fixture/中文 空格目录/' + i,
    start: './test.jar start',
    currentHash: localHash,
    currentCommit: 'b'.repeat(40),
    version: 'b'.repeat(40),
    healthState: '未配置健康检查',
  }));
  db.lastTargets = [db.targets[0].id];
  if (info.title.startsWith('串行发布清单')) {
    db.targets[1].serviceId = db.services[1].id;
    db.targets[1].production = true;
  }
  if (info.title.startsWith('部署统计')) db.targets[1].serverId = db.servers[1].id;
  if (info.title.startsWith('部署历史全文搜索')) db.targets[1].serviceId = db.services[1].id;
  const store = new Storage(dir, {
    encrypt: async () => {
      throw new Error('界面夹具不写入凭据');
    },
    decrypt: async () => {
      throw new Error('界面夹具不读取凭据');
    },
  });
  // 在应用启动前写入工具夹具，避免界面自动保存覆盖外部写入的数据。
  if (info.title.startsWith('历史与构建环境单行布局')) {
    db.jdks = Array.from({ length: 6 }, (_, i) => ({
      name: 'JDK 21-' + i,
      path: path.join(dir, '中文 空格 构建环境-' + i, 'jdk-21'),
    }));
    db.services.forEach((service, i) => {
      service.jdk = db.jdks[i].name;
      service.profiles = 'production';
      service.args = '-DskipTests';
    });
  }
  store.saveConfig(db);
  if (info.title.startsWith('串行发布清单')) {
    const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
    task.id = 'DC-unrelated-release-fixture';
    task.status = 'failed';
    task.targets[0].status = 'failed';
    task.note = '独立部署记录';
    store.saveTask(task);
  }
  if (info.title.startsWith('部署统计')) {
    for (let i = 0; i < 3; i++) {
      const task = createTask(db, db.services[0], db.targets.slice(0, 2), {}, 'existing');
      task.id = 'DC-stats-' + i;
      task.started = new Date(Date.now() - i * 86400_000).toISOString();
      task.status = 'partial';
      task.targets[0].status = i === 1 ? 'unverified' : 'success';
      task.targets[0].elapsed = 20;
      task.targets[1].status = 'failed';
      task.targets[1].elapsed = 40;
      task.targets[1].error = '健康检查未通过';
      store.complete(task, false);
    }
  }
  if (info.title.startsWith('历史快照')) {
    const task = createTask(db, db.services[0], db.targets.slice(0, 2), {}, 'existing');
    task.id = 'DC-legacy-history';
    task.note = '保留快照的历史部署';
    task.status = 'success';
    task.buildLogs = [];
    for (const target of task.targets) target.status = 'success';
    task.targets[0].logs = ['旧记录保留的日志'];
    store.importDatabase(recordTask(db, task, false), true);
  }
  if (info.title.startsWith('部署历史全文搜索')) {
    const quiet = createTask(db, db.services[0], [db.targets[0], db.targets[2]], {}, 'existing');
    quiet.id = 'DC-search-quiet';
    quiet.status = 'failed';
    quiet.note = '单条命中的部署';
    store.saveTask(quiet);
    store.appendLog(quiet.id, 'x'.repeat(700) + '跨服务检索词 稀有片段\n', db.targets[0].id);
    store.appendLog(quiet.id, '跨服务检索词 另一环境片段\n', db.targets[2].id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const noisy = createTask(db, db.services[1], [db.targets[1]], {}, 'existing');
    noisy.id = 'DC-search-noisy';
    noisy.status = 'failed';
    noisy.note = '高频命中的部署';
    store.saveTask(noisy);
    store.appendLog(noisy.id, '跨服务检索词 高频片段\n'.repeat(220));
  }
  store.close();
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
  const page = await app.firstWindow();
  await expect(page.getByRole('region', { name: '服务工作台' })).toBeVisible();
});
test.afterEach(async () => {
  await app?.close();
  if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('越界');
  await fs.rm(dir, { recursive: true, force: true });
});

const sizes = [
  [1000, 620],
  [1280, 800],
  [1600, 900],
];
const captures = path.resolve('release/ui-simplify');
async function size(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(w, h); window.show(); window.focus();
    },
    [width, height],
  );
  const page = await app.firstWindow();
  await expectViewport(page, width, height);
  // 等待视口调整对应的布局和滚动事件落定，避免新打开的菜单被上一帧事件关闭。
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function boundaries() {
  const page = await app.firstWindow();
  const main = page.getByRole('main');
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await expect(page.locator('.service-sidebar')).toBeInViewport({ ratio: 1 });
}
async function shot(name: string) {
  const page = await app.firstWindow();
  await fs.mkdir(captures, { recursive: true });
  await page.screenshot({ path: path.join(captures, name + '.png') });
}
test('启动直接部署，三个配置页列表与详情在三种尺寸下可用', async () => {
  const page = await app.firstWindow();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(page.getByRole('region', { name: '服务工作台' })).toBeVisible();
  await expect(nav.getByRole('button', { name: '首页总览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重复上次部署' })).toHaveCount(0);
  for (const [width, height] of sizes) {
    await size(width, height);
    for (const name of ['服务管理', '部署目标', '服务器']) {
      await page.getByRole('button', { name, exact: true }).click();
      const grid = page.locator('.entity-list');
      await expect(grid.locator('.entity-record')).toHaveCount(6);
      const firstRow = (await grid.locator('.entity-record').first().boundingBox())!;
      const secondRow = (await grid.locator('.entity-record').nth(1).boundingBox())!;
      expect(firstRow.x).toBe(secondRow.x);
      expect(secondRow.y).toBeGreaterThan(firstRow.y + firstRow.height);
      await expect(
        grid.locator('.entity-record').first().locator('.entity-actions button'),
      ).toHaveCount(3);

      await expect(page.locator('.entity-detail')).toHaveCount(0);
      const toolbar = page.locator('.entity-toolbar');
      const search = toolbar.getByRole('textbox');
      const add = toolbar.getByRole('button');
      expect((await search.boundingBox())!.y).toBeGreaterThanOrEqual(
        (await toolbar.boundingBox())!.y,
      );
      const addBox = (await add.boundingBox())!;
      const searchBox = (await search.boundingBox())!;
      expect(
        Math.abs(addBox.y + addBox.height / 2 - searchBox.y - searchBox.height / 2),
      ).toBeLessThanOrEqual(3);
      await boundaries();
      await shot(name + '-' + width + 'x' + height);
      const text = name === '服务管理' ? '中文' : name === '部署目标' ? '环境' : '仅配置';
      await search.fill(text);
      const card = grid.locator('.entity-record').last();
      await card.scrollIntoViewIfNeeded();
      const main = page.getByRole('main');
      const before = await main.evaluate((el) => el.scrollTop);
      const label = await card.locator('.entity-name').getAttribute('aria-label');
      await card.locator('.entity-name').click();
      await expect(page.locator('.entity-detail')).toBeVisible();
      await expect(page.getByRole('button', { name: '返回列表', exact: true })).toBeInViewport({
        ratio: 1,
      });
      await boundaries();
      await shot(name + '-详情-' + width + 'x' + height);
      await page.getByRole('button', { name: '返回列表', exact: true }).click();
      await expect(search).toHaveValue(text);
      await expect(page.getByRole('button', { name: label!, exact: true })).toBeFocused();
      expect(Math.abs((await main.evaluate((el) => el.scrollTop)) - before)).toBeLessThanOrEqual(2);
      await search.clear();
    }
  }
});
test('历史默认优先记录，筛选弹层支持应用取消与日期嵌套弹窗', async () => {
  const page = await app.firstWindow();
  const config = (await page.evaluate(() => window.deployCenter!.load())).database;
  const sqlite = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
  try {
    for (let i = 0; i < 12; i++) {
      const task = createTask(
        config,
        config.services[0],
        config.targets.slice(0, 1),
        {},
        'existing',
      );
      task.id = 'DC-layout-history-' + i;
      task.status = i % 2 ? 'failed' : 'success';
      task.targets[0].status = task.status;
      task.note = '界面验收记录 ' + i;
      sqlite
        .prepare('INSERT INTO tasks (id,json,updated,active) VALUES (?,?,?,0)')
        .run(task.id, JSON.stringify(task), Date.now() + i);
    }
  } finally {
    sqlite.close();
  }
  await page.reload();
  await page.getByRole('navigation').getByRole('button', { name: '部署历史', exact: true }).click();
  for (const [width, height] of sizes) {
    await size(width, height);
    await expect(page.getByLabel('任务类型', { exact: true })).toHaveCount(0);
    await expect(page.locator('.history-task')).toHaveCount(12);
    const first = (await page.locator('.history-task').first().boundingBox())!;
    expect(first.y).toBeLessThan(330);
    expect(first.height).toBeLessThanOrEqual(56);
    await boundaries();
    await shot('历史-' + width + 'x' + height);
    const trigger = page.getByRole('button', { name: '筛选部署历史', exact: true });
    await trigger.click();
    const modal = page.getByRole('dialog', { name: '筛选部署历史', exact: true });
    await modal.getByLabel('任务结果', { exact: true }).selectOption('failed');
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    await expect(trigger).toBeFocused();
    await expect(page.locator('.history-task')).toHaveCount(12);
    await trigger.click();
    await modal.getByLabel('任务结果', { exact: true }).selectOption('failed');
    await modal.getByRole('button', { name: '自定义', exact: true }).click();
    const dates = page.getByRole('dialog', { name: '自定义日期范围', exact: true });
    await dates.getByRole('button', { name: '开始日期', exact: true }).click();
    await expect(dates.getByRole('group', { name: '选择部署日期' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('button', { name: '应用', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await shot('历史筛选-' + width + 'x' + height);
    await modal.getByRole('button', { name: '应用', exact: true }).click();
    await expect(page.locator('.history-task')).toHaveCount(6);
    await page.getByRole('button', { name: '移除结果：失败 / 检查未通过', exact: true }).click();
    await expect(page.locator('.history-task')).toHaveCount(12);
  }
});
test('串行发布清单复用部署控件，确认后串行执行并进入完整任务页', async () => {
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const db = (await page.evaluate(() => window.deployCenter!.load())).database;
  await page.evaluate(({ service, target }) => {
    localStorage.setItem('deploy-center-release-v1', JSON.stringify({
      state: 'done', message: '旧清单结果', failurePolicy: 'stop',
      rows: [{
        name: service.name, targets: [target.name], state: 'success',
        request: { serviceId: service.id, targetIds: [target.id], build: 'existing', overrides: {}, failurePolicy: 'stop' },
      }],
    }));
  }, { service: db.services[0], target: db.targets[0] });
  await page.reload();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '发布清单', exact: true }).click();
  const manifest = page.getByRole('region', { name: '发布清单', exact: true });
  await expect(manifest.getByRole('status').getByText('旧清单结果')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('deploy-center-release-v1'))).toBeNull();
  await manifest.getByRole('button', { name: '返回清单配置' }).click();
  // 让 Electron 主进程走正式 IPC 与 SQLite，只替换会实际连接服务器的工作进程。
  await app.evaluate(({ utilityProcess }) => {
    const fork = utilityProcess.fork.bind(utilityProcess);
    const jobs = new Map<string, { input: any; emit: (kind: string, payload: unknown) => void }>();
    utilityProcess.fork = ((file, ...args) => {
      if (!file.endsWith('worker.cjs')) return fork(file, ...args);
      const listeners = new Map<string, (value: unknown) => void>();
      const emit = (kind: string, payload: unknown) => listeners.get(kind)?.(payload);
      return {
        on(kind: string, listener: (value: unknown) => void) { listeners.set(kind, listener); },
        postMessage(message: any) {
          if (message.kind === 'begin') {
            jobs.set(message.value.task.service.id, { input: message.value, emit });
            const task = structuredClone(message.value.task);
            const target = task.targets[0];
            target.status = 'running';
            target.steps.find((step: any) => step.key === 'upload').status = 'running';
            emit('message', { kind: 'snapshot', task });
          }
        },
        kill() {},
      } as unknown as Electron.UtilityProcess;
    }) as typeof utilityProcess.fork;
    Object.assign(globalThis, { finishReleaseFixture: (serviceId: string, committed: boolean) => {
      const job = jobs.get(serviceId);
      if (!job) throw new Error('服务没有任务');
      const task = structuredClone(job.input.task);
      task.status = 'success';
      task.targets.forEach((item: any) => { item.status = serviceId === 'workspace-smoke' ? 'unverified' : 'success'; });
      task.elapsed = 2;
      job.emit('message', { kind: committed ? 'done' : 'snapshot', task });
    }});
  });
  await size(900, 600);
  await manifest.getByRole('button', { name: '添加服务', exact: true }).click();
  const add = page.getByRole('dialog', { name: '添加服务' });
  await add.getByRole('checkbox', { name: db.services[0].name, exact: true }).check();
  await add.getByRole('checkbox', { name: db.services[1].name, exact: true }).check();
  await add.getByRole('button', { name: '加入清单' }).click();
  const production = manifest.getByRole('checkbox', { name: '选择' + db.targets[1].name });
  await expect(production).not.toBeChecked();
  await manifest.getByRole('checkbox', { name: '选择' + db.targets[0].name }).check();
  await production.check();
  for (const button of await manifest.getByRole('button', { name: '使用现有 JAR', exact: true }).all())
    await button.click();
  await expect(manifest.getByRole('button', { name: /查看线上日志|上移|下移/ })).toHaveCount(0);
  await manifest.getByRole('button', { name: '展开' + db.targets[0].name + '详情' }).click();
  await expect(manifest.getByRole('textbox', { name: '备份目录', exact: true })).toBeVisible();
  await manifest.getByRole('button', { name: '收起' + db.targets[0].name + '详情' }).click();
  const footer = manifest.getByLabel('发布清单操作');
  await expect(footer.getByRole('combobox', { name: '某个服务失败后' })).toBeVisible();
  await expect(footer.getByRole('button', { name: '下一步：确认' })).toBeInViewport({ ratio: 1 });
  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await page.getByRole('group', { name: '界面主题' }).getByRole('button', { name: theme === 'light' ? '浅色' : '深色' }).click();
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await nav.getByRole('button', { name: '发布清单', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    for (const zoom of [1.25, 1.5]) {
      await app.evaluate(({ BrowserWindow }, factor) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor), zoom);
      await expect(footer.getByRole('button', { name: '下一步：确认' })).toBeInViewport({ ratio: 1 });
      await boundaries();
      await expect.poll(() => manifest.locator('.release-board').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    }
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await expect(production).toBeChecked();
  await footer.getByRole('button', { name: '下一步：确认' }).click();
  const start = footer.getByRole('button', { name: '开始发布' });
  await expect(start).toBeDisabled();
  await expect(manifest.locator('.confirm-target').first()).toContainText('远程文件');
  await expect(manifest.locator('.confirm-target-details[open], .release-review details[open]')).toHaveCount(0);
  await expect(manifest.getByRole('checkbox', { name: /已核对/ })).toHaveCount(0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect.poll(() => manifest.locator('.release-board').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await manifest.getByPlaceholder(db.targets[1].name, { exact: true }).fill(db.targets[1].name);
  await expect(start).toBeEnabled();
  await expect(start).toBeInViewport({ ratio: 1 });
  await start.click();
  const firstLog = manifest.getByRole('button', { name: '查看 ' + db.services[0].name + ' 执行日志' });
  const secondLog = manifest.getByRole('button', { name: '查看 ' + db.services[1].name + ' 执行日志' });
  await expect(firstLog).toBeVisible();
  await expect(firstLog.getByText(/上传与校验/)).toBeVisible();
  await expect(secondLog).toHaveCount(0);
  await firstLog.click();
  await expect(page.getByRole('heading', { name: '执行日志' })).toBeVisible();
  const finish = (id: string, committed = true) => app.evaluate((_, args) =>
    (globalThis as typeof globalThis & { finishReleaseFixture: (serviceId: string, committed: boolean) => void })
      .finishReleaseFixture(args.id, args.committed), { id, committed });
  await finish(db.services[0].id, false);
  await expect(page.getByRole('heading', { name: new RegExp(db.services[0].name) })).toBeVisible();
  await page.getByRole('button', { name: '返回发布清单' }).click();
  await expect(secondLog).toHaveCount(0);
  await finish(db.services[0].id);
  await expect(secondLog).toBeVisible();
  await finish(db.services[1].id);
  await expect(manifest.getByRole('status').getByText('全部成功')).toBeVisible();
  await boundaries();
  await footer.getByRole('button', { name: '返回清单配置' }).click();
  await expect(production).not.toBeChecked();
  await page.reload();
  await nav.getByRole('button', { name: '发布清单', exact: true }).click();
  await expect(manifest.getByRole('status').getByText('全部成功')).toBeVisible();
  await expect(manifest.getByRole('status').getByText('1 个目标健康未验证')).toBeVisible();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  const openReleaseHistory = footer.getByRole('button', { name: '查看清单历史' });
  await expect(openReleaseHistory).toBeInViewport({ ratio: 1 });
  await openReleaseHistory.press('Enter');
  const tasks = page.locator('.history-task');
  await expect(tasks).toHaveCount(2);
  await expect(tasks.getByText('批量部署')).toHaveCount(2);
  await page.getByRole('button', { name: /移除清单/ }).click();
  await expect(tasks).toHaveCount(3);
  await tasks.filter({ hasText: '批量部署' }).first().getByRole('button', { name: /更多任务/ }).click();
  await page.getByRole('menuitem', { name: '筛选同清单' }).click();
  await expect(tasks).toHaveCount(2);
});

test('历史快照进入全页详情，保留日志并可切换目标', async () => {
  const page = await app.firstWindow();
  await size(900, 600);
  await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '部署历史', exact: true }).click();
  const row = page.getByRole('row', { name: '查看任务：保留快照的历史部署' });
  await row.press('Enter');
  await expect(page.getByRole('heading', { name: /环境0 · 历史记录/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '部署记录详情' })).toHaveCount(0);
  await expect(page.getByText('旧记录保留的日志', { exact: true })).toBeVisible();
  await expect(page.getByText(/完整日志未保存/)).toBeVisible();
  const exported = path.join(dir, 'history-snapshot.log');
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, exported);
  await page.getByRole('button', { name: '导出日志', exact: true }).click();
  await expect.poll(() => fs.readFile(exported, 'utf8').catch(() => '')).toContain('旧记录保留的日志');
  await page.getByRole('button', { name: '环境1', exact: true }).click();
  await expect(page.getByRole('heading', { name: /环境1 · 历史记录/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出日志', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '返回部署历史' }).click();
  await expect(row).toBeFocused();
  await boundaries();
});

test('部署历史全文搜索按服务和目标限定范围，保留超出片段上限的任务', async () => {
  const page = await app.firstWindow();
  const button = (name: string) => page.getByRole('button', { name, exact: true });
  const setTheme = async (name: string, theme: string) => {
    await button('设置').click();
    await page.getByRole('group', { name: '界面主题' }).getByRole('button', { name }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await button('返回应用').click();
  };
  await setTheme('浅色', 'light');
  await size(900, 600);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  await expectViewport(page, 600, 400);

  const search = page.getByLabel('搜索完整历史');
  const quietRow = page.getByRole('row', { name: '查看任务：单条命中的部署' });
  const noisyRow = page.getByRole('row', { name: '查看任务：高频命中的部署' });
  const rareHit = page.getByRole('button', { name: /目标日志 · 第 1 行.*稀有片段/ });
  await button('部署历史').click();
  await search.fill('跨服务检索词');
  await expect(page.getByText('命中 2 个任务，222 处匹配，展示前 200 处。')).toBeVisible();
  await expect(quietRow).toHaveCount(1);
  await expect(noisyRow).toHaveCount(1);
  await expect(rareHit).toHaveCount(0);

  await button('筛选部署历史').press('Enter');
  const filter = page.getByRole('dialog', { name: '筛选部署历史' });
  await filter.getByLabel('服务', { exact: true }).selectOption('workspace-smoke');
  await filter.getByLabel('环境', { exact: true }).selectOption('环境0');
  await filter.getByRole('button', { name: '应用' }).press('Enter');
  await expect(page.getByText('命中 1 个任务，1 处匹配。')).toBeVisible();
  await expect(noisyRow).toHaveCount(0);
  await rareHit.scrollIntoViewIfNeeded();
  await expect(rareHit).toBeInViewport({ ratio: 1 });
  await boundaries();
  await rareHit.press('Enter');
  await expect(page.getByRole('heading', { name: /中文空格项目0/ })).toBeVisible();
  await button('返回部署历史').press('Enter');
  await expect(search).toHaveValue('跨服务检索词');
  await expect(quietRow).toBeFocused();
  await expect(page.getByText('命中 1 个任务，1 处匹配。')).toBeVisible();

  await setTheme('深色', 'dark');
  await button('中文空格项目0').click();
  await page.getByRole('tab', { name: '发布记录', exact: true }).press('Enter');
  await expectViewport(page, 600, 400);
  await search.fill('跨服务检索词');
  await expect(page.getByText('命中 1 个任务，2 处匹配。')).toBeVisible();
  await rareHit.scrollIntoViewIfNeeded();
  await expect(rareHit).toBeInViewport({ ratio: 1 });
  await expect(noisyRow).toHaveCount(0);
  await boundaries();
});

test('部署统计共享筛选，键盘可切换，在两种主题与高缩放下保持可用', async () => {
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const openHistory = () => page.getByRole('navigation').getByRole('button', { name: '部署历史', exact: true }).click();
  await openHistory();
  const records = page.getByRole('tab', { name: '部署记录', exact: true });
  const stats = page.getByRole('tab', { name: '统计', exact: true });
  const panel = page.getByRole('tabpanel', { name: '统计', exact: true });
  await expect(records).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.history-task')).toHaveCount(3);
  await records.focus();
  await page.keyboard.press('ArrowRight');
  await expect(stats).toBeFocused();
  await expect(panel.getByText('3 / 6 个目标 · 含健康未验证')).toBeVisible();
  await expect(panel.getByText('平均目标耗时')).toBeVisible();
  await expect(panel.getByText('健康检查未通过')).toBeVisible();
  await expect(panel.getByRole('img', { name: '成功率趋势' })).toBeVisible();
  const trigger = page.getByRole('button', { name: '筛选部署历史', exact: true });
  const filter = page.getByRole('dialog', { name: '筛选部署历史', exact: true });
  await trigger.click();
  await expect(filter.getByLabel('任务结果')).toHaveCount(0);
  await filter.getByLabel('环境', { exact: true }).selectOption('环境1');
  await filter.getByRole('button', { name: '取消', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(panel.getByText('3 / 6 个目标 · 含健康未验证')).toBeVisible();
  await trigger.click();
  await filter.getByLabel('环境', { exact: true }).selectOption('环境1');
  await filter.getByRole('button', { name: '应用', exact: true }).click();
  await expect(panel.getByText('0 / 3 个目标 · 含健康未验证')).toBeVisible();
  await records.click();
  await expect(page.getByRole('button', { name: '移除环境：环境1' })).toBeVisible();
  await expect(page.locator('.history-task')).toHaveCount(3);
  await stats.click();
  await trigger.click();
  await filter.getByRole('button', { name: '今天', exact: true }).click();
  await filter.getByRole('button', { name: '应用', exact: true }).click();
  await expect(panel.getByText('0 / 1 个目标 · 含健康未验证')).toBeVisible();
  await page.getByRole('button', { name: '全部清除', exact: true }).click();
  await panel.getByRole('button', { name: '筛选服务：中文空格项目0' }).click();
  await expect(page.getByRole('button', { name: '移除服务：中文空格项目0' })).toBeVisible();
  await trigger.click();
  await filter.getByLabel('环境', { exact: true }).selectOption('环境1');
  await filter.getByRole('button', { name: '应用', exact: true }).click();
  await expect(panel.getByText('0 / 3 个目标 · 含健康未验证')).toBeVisible();
  await trigger.click();
  await filter.getByLabel('服务器', { exact: true }).selectOption('offline');
  await filter.getByRole('button', { name: '应用', exact: true }).click();
  await expect(panel.getByRole('heading', { name: '暂无可统计的部署记录' })).toBeVisible();
  await records.click();
  await expect(page.locator('.history-task')).toHaveCount(0);
  await stats.click();
  await page.getByRole('button', { name: '全部清除', exact: true }).click();

  for (const theme of ['light', 'dark']) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await page.getByRole('group', { name: '界面主题', exact: true })
      .getByRole('button', { name: theme === 'light' ? '浅色' : '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.getByRole('button', { name: '返回应用', exact: true }).click();
    await openHistory();
    await expect(stats).toHaveAttribute('aria-selected', 'true');
    for (const [width, height, zoom] of [[900, 600, 1], [900, 600, 1.5], [1000, 620, 1.25], [1280, 800, 1], [1600, 900, 1]]) {
      await app.evaluate(({ BrowserWindow }, [w, h, factor]) => {
        const win = BrowserWindow.getAllWindows()[0];
        win.setContentSize(w, h);
        win.webContents.setZoomFactor(factor);
        win.show();
      }, [width, height, zoom]);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(Math.round(width / zoom));
      await boundaries();
      await expect(trigger).toBeInViewport({ ratio: 1 });
      const pointOffset = await panel.getByRole('img', { name: '成功率趋势' }).evaluate((chart) => {
        const point = chart.parentElement!.querySelector('.deploy-stats-dot')!.getBoundingClientRect();
        return point.top + point.height / 2 - chart.getBoundingClientRect().top;
      });
      expect(pointOffset).toBeCloseTo(60, 0);
      await trigger.click();
      await expect(filter.getByRole('button', { name: '应用', exact: true })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      // 用 Electron 截取完整窗口，避免 Playwright 在页面缩放时只截取 CSS 视口大小。
      const png = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'),
      );
      await fs.mkdir(captures, { recursive: true });
      await fs.writeFile(path.join(captures, `部署统计-${theme}-${width}x${height}-${zoom}.png`), Buffer.from(png, 'base64'));
    }
  }
});
test('日志优先任务页的八种状态与连续输出在三个尺寸下可用', async () => {
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const config = await page.evaluate(async () => (await window.deployCenter!.load()).database);
  const db = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
  const matrix = [
    ['running', 'running', '', '取消部署'],
    ['success', 'success', '已部署成功', ''],
    ['unverified', 'unverified', '已部署，但无法确认应用可用', ''],
    ['rolledback', 'rolledback', '已自动恢复旧版本', '重试失败目标'],
    ['rollback-failed', 'failed', '自动回滚失败', '重试失败目标'],
    ['cancelled', 'cancelled', '任务已取消', ''],
    ['dry-run', 'success', '试运行通过', '正式部署'],
    ['mixed', 'failed', '失败', '重试失败目标'],
  ] as const;
  try {
    for (const [fixture, status, banner, primary] of matrix) {
      const multi = fixture === 'mixed';
      const task = createTask(
        config,
        config.services[0],
        config.targets.slice(0, multi ? 3 : 1),
        {},
        'existing',
      );
      task.status =
        status === 'running' || status === 'cancelled'
          ? status
          : multi
            ? 'partial'
            : status === 'failed' || status === 'rolledback'
              ? 'failed'
              : 'success';
      task.dryRun = fixture === 'dry-run';
      task.buildPhase = 3;
      task.elapsed = 12.4;
      task.artifact.sha256 = 'b'.repeat(64);
      task.deployedCommit = 'a'.repeat(40);
      task.buildSteps.forEach((step) => {
        step.status = step.key === 'build' ? 'skipped' : 'success';
      });
      task.targets.forEach((target, index) => {
        target.status = index === 1 ? 'success' : index === 2 ? 'skipped' : status;
        target.steps.forEach((step) => {
          step.status = index === 2 ? 'skipped' : 'success';
          step.elapsed = 1;
          if (status === 'running') step.status = step.key === 'upload' ? 'running' : 'pending';
          if (index === 0 && ['rolledback', 'failed'].includes(status) && step.key === 'start')
            step.status = 'failed';
          if (status === 'unverified' && step.key === 'health') step.status = 'skipped';
        });
        if (status === 'running') target.upload = { bytes: 20, total: 100, speed: 2, percent: 20 };
        if (fixture === 'rollback-failed')
          target.steps.push({ key: 'rollback', label: '恢复旧版本', status: 'failed' });
        if (status === 'rolledback')
          target.steps.push({ key: 'rollback', label: '恢复旧版本', status: 'success' });
      });
      db.prepare('INSERT INTO tasks (id,json,updated,active) VALUES (?,?,?,0)').run(
        task.id,
        JSON.stringify(task),
        Date.now(),
      );
      await fs.mkdir(path.join(dir, 'logs', task.id), { recursive: true });
      await fs.writeFile(
        path.join(dir, 'logs', task.id, 'build.log'),
        '已准备现有 JAR\n文件校验通过\n',
      );
      await fs.writeFile(
        path.join(dir, 'logs', task.id, task.targets[0].target.id + '.log'),
        '连接已建立\n' +
          (status === 'failed' || status === 'rolledback'
            ? '错误：启动服务未通过\n'
            : '远程执行日志\n'),
      );
      await page.reload();
      if (fixture === 'running') await page.getByRole('button', { name: '当前任务', exact: true }).click();
      else {
        await page.getByRole('button', { name: '部署历史', exact: true }).click();
        await page.locator('.history-task').first().click();
      }
      const taskPage = page.locator('.task-page');
      const sidebar = page.locator('.service-sidebar');
      await expect(taskPage.getByRole('heading', { level: 1 })).not.toContainText(task.id);
      await expect(taskPage.getByRole('heading', { name: '执行日志' })).toBeVisible();
      await expect(
        taskPage.getByRole('group', { name: '部署阶段' }).getByRole('button'),
      ).toHaveCount(5);
      await expect(taskPage.getByRole('group', { name: '选择任务目标' })).toHaveCount(
        multi ? 1 : 0,
      );
      if (multi)
        await expect(
          taskPage.getByRole('group', { name: '选择任务目标' }).getByRole('button'),
        ).toHaveCount(3);
      if (fixture === 'running') {
        await page.emulateMedia({ reducedMotion: 'no-preference' });
        await expect(taskPage.locator('.task-stage-panel')).toHaveCount(0);
        const upload = taskPage
          .getByRole('group', { name: '部署阶段' })
          .getByRole('button', { name: /上传与校验/ });
        await upload.click();
        const progress = taskPage.getByRole('progressbar', { name: '文件上传进度' });
        await expect(progress).toBeVisible();
        const spacing = await progress.evaluate((bar) => {
          const fields = Array.from(bar.children, (field) => field.getBoundingClientRect());
          return fields.slice(1).map((field, index) =>
            Math.abs(field.top - fields[index].top) < 1 ? field.left - fields[index].right : null,
          );
        });
        expect(spacing.length).toBeGreaterThanOrEqual(3);
        expect(spacing.filter((gap) => gap !== null).length).toBeGreaterThan(0);
        expect(spacing.every((gap) => gap === null || gap >= 4)).toBe(true);
        await expect(page.locator('.sidebar-task .spin, .task-step-row .spin')).toHaveCount(0);
        await expect(taskPage.locator('.task-stage .spin')).toHaveCount(1);
        await expect
          .poll(() => taskPage.locator('.task-stage .spin').evaluate((el) => el.getAnimations()[0]?.playState))
          .toBe('running');
        await upload.click();
        const viewport = taskPage.getByRole('log', { name: '任务日志' });
        const elapsed = await taskPage.locator('.task-duration').textContent();
        await expect.poll(() => taskPage.locator('.task-duration').textContent()).not.toBe(elapsed);
        await expect(taskPage.getByText('任务详情', { exact: true })).toHaveCount(0);
        await expect(taskPage.locator('.terminal-upload')).toHaveCount(1);

        for (const batch of [1, 2]) {
          await app.evaluate(
            ({ BrowserWindow }, { taskId, targetId, batch }) => {
              for (let i = 0; i < 150; i++)
                BrowserWindow.getAllWindows()[0].webContents.send('deploy:event', {
                  kind: 'log',
                  taskId,
                  targetId,
                  text:
                    '持续日志 ' + batch + '-' + i + ' ' + (i === 149 ? 'X'.repeat(500) : '') + '\n',
                });
            },
            { taskId: task.id, targetId: task.targets[0].target.id, batch },
          );
          await expect(viewport).toContainText('持续日志 ' + batch + '-149');
          await expect(taskPage.getByLabel('跟随最新')).toBeChecked();
          await expect
            .poll(() => viewport.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight))
            .toBeLessThanOrEqual(2);
          await expect.poll(() => viewport.evaluate((el) => {
            const row = el.querySelector('[data-log-line]:last-child') as HTMLElement | null;
            if (!row) return false;
            const box = el.getBoundingClientRect(), last = row.getBoundingClientRect();
            return last.top >= box.top && last.bottom <= box.top + el.clientHeight;
          })).toBe(true);
        }
      }
      if (fixture === 'unverified') {
        await taskPage.getByRole('button', { name: '去配置健康检查' }).click();
        await expect(page.getByRole('tab', { name: '健康检查', selected: true })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      for (const [width, height] of [
        [1000, 620],
        [1280, 800],
        [1600, 900],
      ]) {
        await app.evaluate(
          ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
          [width, height],
        );
        const main = page.locator('.workspace > main');
        await main.evaluate((el) => {
          el.scrollTop = 0;
        });
        await expectViewport(page, width, height);
        if (primary)
          await expect(taskPage.getByRole('button', { name: primary, exact: true })).toBeInViewport(
            { ratio: 1 },
          );
        if (banner && fixture !== 'success' && fixture !== 'dry-run') {
          await expect(taskPage.locator('.task-result-banner')).toContainText(banner);
          await expect(taskPage.locator('.task-result-banner')).toBeInViewport({ ratio: 1 });
        }
        expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        expect(
          await taskPage.evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeLessThanOrEqual(1);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
        ).toBeLessThanOrEqual(1);
        const log = taskPage.getByRole('log', { name: '任务日志' });
        const logBounds = (await log.boundingBox())!;
        const mainBounds = (await main.boundingBox())!;
        expect(logBounds.width).toBeGreaterThan(mainBounds.width * 0.85);
        expect(logBounds.height).toBeGreaterThan(
          ['running', 'success', 'dry-run'].includes(fixture)
            ? mainBounds.height * 0.42
            : ['cancelled', 'unverified'].includes(fixture)
              ? mainBounds.height * 0.3
              : 100,
        );
        await expect(taskPage.getByRole('textbox', { name: '搜索日志' })).toHaveCount(0);
        await expect(taskPage.getByRole('button', { name: '复制完整日志' })).toHaveCount(0);
        expect(logBounds.y + logBounds.height).toBeLessThanOrEqual(mainBounds.y + mainBounds.height + 1);
        await shot(fixture + '-' + width + 'x' + height);
        if (fixture === 'success') {
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
      document.documentElement.classList.toggle('dark', true);
          });
          await shot(fixture + '-dark-' + width + 'x' + height);
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'light';
      document.documentElement.classList.toggle('dark', false);
          });
        }
        const menu = taskPage.getByRole('button', { name: '更多任务操作' });
        if (await menu.count()) {
          await menu.click();
          const bounds = await page.getByRole('menu', { name: '更多任务操作' }).boundingBox();
          expect(bounds).toBeTruthy();
          expect(bounds!.x).toBeGreaterThanOrEqual(0);
          expect(bounds!.y).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
          await page.keyboard.press('Escape');
        }
        const footerBefore = await sidebar.boundingBox();
        await main.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        expect(await sidebar.boundingBox()).toEqual(footerBefore);
        await expect(taskPage.locator('.task-page-header')).toBeInViewport({ ratio: 1 });
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    }
  } finally {
    db.close();
  }
});

test('关于与帮助展示仓库并使用系统浏览器打开，其他外链继续拒绝', async () => {
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (destination: string) => {
      (globalThis as unknown as { repositoryOpened?: string }).repositoryOpened = destination;
    };
  });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '关于与帮助', exact: true }).click();
  const link = page.getByRole('link', {
    name: '查看版本与源码',
    exact: true,
  });
  await expect(link).toHaveAttribute('href', 'https://github.com/liwl1995/DeployCenter/releases');
  await page.evaluate(() => window.open('https://example.com'));
  expect(
    await app.evaluate(
      () => (globalThis as unknown as { repositoryOpened?: string }).repositoryOpened,
    ),
  ).toBeUndefined();
  await link.click();
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as unknown as { repositoryOpened?: string }).repositoryOpened),
    )
    .toBe('https://github.com/liwl1995/DeployCenter/releases');
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  for (const [width, height] of sizes) {
    await app.evaluate(({ BrowserWindow }, bounds) =>
      BrowserWindow.getAllWindows()[0].setContentSize(bounds.width, bounds.height), { width, height });
    expect(await page.locator('.help-resource-row').evaluateAll((elements) => {
      const bounds = elements.map((element) => element.getBoundingClientRect());
      return bounds.length === 3 && bounds.every((item, index) =>
        index === 0 || item.top >= bounds[index - 1].bottom - 1);
    })).toBe(true);
  }
  await boundaries();
  await shot('配置与帮助-仓库');
});

test('更新设置三种窗口下无溢出，按需下载、取消和校验，未安装版阻止安装', async () => {
  const page = await app.firstWindow();
  const installer = Buffer.concat([
    Buffer.from('MZ UI update fixture, never executed'),
    Buffer.alloc(256 * 1024, 0x61),
  ]);
  const digest = createHash('sha256').update(installer).digest('hex');
  const name = 'YOTOO-DeployCenter-99.0.0-Windows-x64-Setup.exe';
  let badRedirect = true;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url || '');
    if (request.url === '/latest') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          tag_name: 'v99.0.0',
          html_url: 'https://github.com/liwl1995/DeployCenter/releases/tag/v99.0.0',
          draft: false,
          prerelease: false,
          body: '# 测试更新说明\n\n## 本次修复\n\n- **复用已下载的安装包**\n- 支持 `Markdown`。\n\n| 功能 | 状态 |\n| --- | --- |\n| 缓存恢复 | 完成 |\n\n<script>不执行</script>\n\n仅用于原生网络验收。',
          published_at: '2026-11-13T01:00:00Z',
          assets: [
            {
              name,
              state: 'uploaded',
              size: installer.length,
              digest: 'sha256:' + digest,
              browser_download_url:
                'https://github.com/liwl1995/DeployCenter/releases/download/v99.0.0/' + name,
            },
          ],
        }),
      );
    } else if (request.url === '/redirect') {
      response.writeHead(302, {
        Location: badRedirect
          ? 'https://example.invalid/untrusted.exe'
          : 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture/setup.exe',
      });
      response.end();
    } else if (request.url === '/installer') {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': installer.length,
      });
      response.flushHeaders();
      const first = setTimeout(() => response.write(installer.subarray(0, 64 * 1024)), 300);
      // 首包可能与响应头一起到达；第二段跨过进度节流窗口，确保真实观察到部分下载。
      const middle = setTimeout(
        () => response.write(installer.subarray(64 * 1024, 128 * 1024)),
        800,
      );
      const timer = setTimeout(() => response.end(installer.subarray(128 * 1024)), 2000);
      response.on('close', () => {
        clearTimeout(first);
        clearTimeout(middle);
        clearTimeout(timer);
      });
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务未启动');
  await app.evaluate(({ net }, base) => {
    const original = net.request;
    (globalThis as unknown as { originalUpdateRequest: typeof net.request }).originalUpdateRequest =
      original;
    // 仅把已知测试地址映射到本机夹具；仍由真实 net.request 处理 302 和响应流。
    net.request = ((value) => {
      const options = typeof value === 'string' ? { url: value } : value;
      const url = options.url || '';
      const route =
        url === 'https://api.github.com/repos/liwl1995/DeployCenter/releases/latest'
          ? '/latest'
          : url.startsWith('https://github.com/liwl1995/DeployCenter/releases/download/v99.0.0/')
            ? '/redirect'
            : url ===
                'https://release-assets.githubusercontent.com/github-production-release-asset/fixture/setup.exe'
              ? '/installer'
              : undefined;
      if (!route) throw new Error('测试不允许未知网络请求');
      return original({ ...options, url: base + route });
    }) as typeof net.request;
  }, 'http://127.0.0.1:' + address.port);
  try {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '软件更新', exact: true }).click();
    await expect(page.getByRole('button', { name: '检查更新', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '快捷键', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(page.getByText('新版本 v99.0.0', { exact: true })).toBeVisible();
    const main = page.locator('main');
    for (const [width, height] of [
      [1000, 620],
      [1280, 800],
      [1600, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) =>
          BrowserWindow.getAllWindows()[0].setContentSize(bounds.width, bounds.height),
        { width, height },
      );
      await page.waitForTimeout(120);
      await boundaries();
      await expect(page.getByRole('button', { name: '下载更新', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await shot(`更新设置-${width}x${height}`);
    }
    await page.getByText('查看更新说明', { exact: true }).click();
    await expect(
      page.locator('.update-notes').getByRole('heading', { name: '本次修复' }),
    ).toBeVisible();
    await expect(page.locator('.update-notes script')).toHaveCount(0);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
      }, theme);
      for (const [width, height] of sizes) {
        await app.evaluate(
          ({ BrowserWindow }, bounds) =>
            BrowserWindow.getAllWindows()[0].setContentSize(bounds.width, bounds.height),
          { width, height },
        );
        await boundaries();
        await shot(`Markdown更新说明-${theme}-${width}x${height}`);
      }
    }
    await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('不受信任');
    expect(requests).not.toContain('/installer');
    badRedirect = false;
    await page.getByRole('button', { name: '重新下载', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: '安装包下载进度' })).toBeVisible();
    await expect
      .poll(async () =>
        Number(
          await page.getByRole('progressbar', { name: '安装包下载进度' }).getAttribute('value'),
        ),
      )
      .toBeGreaterThan(0);
    expect(
      Number(await page.getByRole('progressbar', { name: '安装包下载进度' }).getAttribute('value')),
    ).toBeLessThan(installer.length);
    await expect(
      page.evaluate((path) => window.deployCenter!.migrateDirectory(path), dir + '-不能迁移'),
    ).rejects.toThrow('正在检查或下载更新');
    await page.getByRole('button', { name: '取消下载', exact: true }).click();
    await expect(page.getByText('下载已取消或连接超时，可以重新下载。')).toBeVisible();
    await page.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect(page.getByRole('button', { name: '更新并重启', exact: true })).toBeEnabled();
    await boundaries();
    await shot('更新等待安装');
    const testExe = process.env.DEPLOY_CENTER_TEST_EXE;
    if (testExe && await fs.stat(path.join(path.dirname(testExe), 'Uninstall ' + path.basename(testExe))).then(() => true, () => false)) {
      // 只在隔离数据库添加中断任务，验证主进程阻止安装；夹具安装包绝不执行。
      const boot = await page.evaluate(() => window.deployCenter!.load());
      const db = boot.database;
      const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
      task.status = 'interrupted';
      const sqlite = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
      try {
        sqlite
          .prepare('INSERT INTO tasks (id,json,updated,active) VALUES (?,?,?,0)')
          .run(task.id, JSON.stringify(task), Date.now());
      } finally {
        sqlite.close();
      }
      await page.getByRole('button', { name: '更新并重启', exact: true }).click();
      await expect(page.locator('.app-update-settings').getByRole('alert')).toContainText('未结束');
    } else {
      await page.getByRole('button', { name: '更新并重启', exact: true }).click();
      await expect(page.locator('.app-update-settings').getByRole('alert')).toContainText('安装版');
    }
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await main.focus();
    await page.keyboard.press('Alt+1');
    await expect(page.getByRole('tab', { name: '软件更新', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect((await page.evaluate(() => window.deployCenter!.updateState())).stage).toBe('ready');
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const beforeRestart = requests.length;
    const before = await page.evaluate(() => window.deployCenter!.updateState());
    expect(before.installerPath?.startsWith(path.join(dir, 'Updates') + path.sep)).toBe(true);
    expect(await fs.readFile(before.installerPath!)).toEqual(installer);
    await app.close();
    const reopenedEnv = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
    delete reopenedEnv.ELECTRON_RUN_AS_NODE;
    app = await electron.launch({
      executablePath:
        process.env.DEPLOY_CENTER_TEST_EXE ||
        path.resolve('node_modules/electron/dist/electron.exe'),
      args: process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')],
      env: reopenedEnv,
    });
    const reopened = await app.firstWindow();
    await reopened.getByRole('button', { name: '设置', exact: true }).click();
    await reopened.getByRole('tab', { name: '软件更新', exact: true }).click();
    await expect(reopened.getByRole('button', { name: '更新并重启', exact: true })).toBeVisible();
    expect(requests.length).toBe(beforeRestart);
    expect((await reopened.evaluate(() => window.deployCenter!.updateState())).installerPath).toBe(
      before.installerPath,
    );
    await app.evaluate(({ shell }) => {
      shell.showItemInFolder = (file) => {
        (globalThis as unknown as { shownUpdateFile: string }).shownUpdateFile = file;
      };
    });
    await reopened.getByRole('button', { name: '打开下载位置', exact: true }).click();
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { shownUpdateFile: string }).shownUpdateFile,
      ),
    ).toBe(before.installerPath);
  } finally {
    await app.evaluate(({ net }) => {
      const original = (globalThis as unknown as { originalUpdateRequest?: typeof net.request })
        .originalUpdateRequest;
      if (original) net.request = original;
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
test('历史与构建环境单行布局在三个尺寸和两种主题下紧凑可用', async () => {
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const config = (await page.evaluate(() => window.deployCenter!.load())).database;
  expect(config.jdks).toHaveLength(6);
  await app.evaluate(
    ({ ipcMain }, fixture) => {
      ipcMain.removeHandler('deploy:check-tool');
      ipcMain.handle('deploy:check-tool', (_event, _kind, file: string) => {
        if (file.includes('环境-2'))
          throw new Error('测试夹具：JDK 路径不可用，展开可查看完整诊断。');
        return 'openjdk version "21.0.8" 2025-07-15\nOpenJDK Runtime Environment\njavac 21.0.8';
      });
      ipcMain.removeHandler('deploy:tool-info');
      ipcMain.handle('deploy:tool-info', (_event, serviceId: string) => ({
        serviceId,
        available: serviceId !== fixture.failed,
        tool: fixture.directory + '/带中文 和空格/很长的项目构建路径/mvnw.cmd',
        workDir: fixture.directory + '/构建工作目录',
        version:
          'Apache Maven 3.9.9\nMaven home: fixture\nJava version: 21.0.8\n此输出仅用于界面验收，不执行真实构建。',
        javaVersion: 'openjdk version "21.0.8"',
        reason: serviceId === fixture.failed ? '测试夹具：找不到 Maven，请检查工具路径。' : '',
      }));
    },
    { directory: dir, failed: config.services[2].id },
  );
  const sqlite = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
  try {
    for (let i = 0; i < 18; i++) {
      const task = createTask(
        config,
        config.services[0],
        config.targets.slice(0, i === 0 ? 3 : 1),
        {},
        'existing',
      );
      task.id = 'DC-compact-' + i;
      task.started = new Date(Date.now() - i * 2 * 3600_000).toISOString();
      task.note =
        i === 0
          ? '调整查询条件并优化列表加载速度，长备注在单行省略，悬停查看完整内容。'
          : '优化告警查询';
      task.status = i % 5 === 2 ? 'cancelled' : i % 5 === 3 ? 'failed' : 'success';
      task.dryRun = i % 6 === 0 && i !== 0;
      task.operation = i === 4 ? 'rollback' : 'deploy';
      task.elapsed = 66 + i;
      task.buildPhase = 3;
      task.deployedCommit = 'a'.repeat(40);
      task.artifact.sha256 = 'b'.repeat(64);
      task.targets.forEach((target) => {
        target.status =
          task.status === 'failed'
            ? 'rolledback'
            : task.status === 'cancelled'
              ? 'cancelled'
              : i % 5 === 1
                ? 'unverified'
                : 'success';
        target.elapsed = 32;
      });
      sqlite
        .prepare('INSERT INTO tasks (id,json,updated,active) VALUES (?,?,?,0)')
        .run(task.id, JSON.stringify(task), Date.now() - i * 1000);
    }
  } finally {
    sqlite.close();
  }
  await page.reload();
  const nav = page.getByRole('navigation');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.classList.toggle('dark', theme === 'dark');
    }, theme);
    for (const [width, height] of sizes) {
      await size(width, height);
      await nav.getByRole('button', { name: '部署历史', exact: true }).click();
      await expect(page.locator('.history-task')).toHaveCount(18);
      await expect(page.locator('.history-table thead th')).toHaveCount(width <= 1150 ? 6 : 7);
      const tableRight = (await page.locator('.history-table').boundingBox())!;
      const lastCell = (await page
        .locator('.history-task')
        .first()
        .locator('td')
        .last()
        .boundingBox())!;
      expect(Math.abs(lastCell.x + lastCell.width - tableRight.x - tableRight.width)).toBeLessThan(
        3,
      );
      const heights = await page
        .locator('.history-task')
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(heights.every((height) => height >= 32 && height <= 56), heights.join(', ')).toBe(true);
      expect(
        await page.locator('main').evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true);
      await boundaries();
      await shot(`单行历史-${theme}-${width}x${height}`);
      const first = page.locator('.history-task').first();
      await first.getByRole('button', { name: '展开目标', exact: true }).click();
      await expect(page.locator('.history-target-line')).toHaveCount(3);
      expect(
        await page.locator('main').evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true);
      await first.getByRole('button', { name: /更多任务/ }).click();
      const menu = page.getByRole('menu');
      await expect(menu.getByRole('menuitem', { name: '复制 JAR 指纹' })).toBeVisible();
      const bounds = (await menu.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      await page.keyboard.press('Escape');
      await first.getByRole('button', { name: '收起目标', exact: true }).click();
      await first.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toBeVisible();
      await page.getByRole('button', { name: '返回部署历史', exact: true }).click();
      await nav.getByRole('button', { name: '构建环境', exact: true }).click();
      const jdk = page.getByRole('table', { name: '本机 JDK 列表', exact: true });
      await expect(jdk.getByText('Java 21.0.8', { exact: true })).toHaveCount(5);
      await expect(page.locator('.jdk-table .compact-detail-row')).toHaveCount(0);
      const toolHeights = await jdk
        .locator('.compact-data-row')
        .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
      expect(toolHeights.every((height) => height >= 32 && height <= 56), toolHeights.join(', ')).toBe(true);
      await boundaries();
      await shot(`单行JDK-${theme}-${width}x${height}`);
      const jdkRow = jdk.getByRole('row', { name: 'JDK JDK 21-0', exact: true });
      await jdkRow.focus();
      await page.keyboard.press('Enter');
      await expect(jdk.locator('.tool-version')).toContainText('javac 21.0.8');
      await page.keyboard.press('Enter');
      await page.getByRole('tab', { name: '服务构建工具', exact: true }).click();
      const maven = page.getByRole('table', { name: '服务构建工具列表', exact: true });
      await expect(maven.getByText('Maven 3.9.9', { exact: true })).toHaveCount(5);
      await expect(maven.getByText('不可用', { exact: true })).toHaveCount(1);
      expect(
        await page.locator('main').evaluate((main) => main.scrollWidth <= main.clientWidth),
      ).toBe(true);
      await boundaries();
      await shot(`单行Maven-${theme}-${width}x${height}`);
      await maven.locator('.compact-data-row').first().click();
      await expect(maven.getByText('Maven Profile', { exact: true })).toBeVisible();
      await shot(`构建详情-${theme}-${width}x${height}`);
      await nav.getByRole('button', { name: '部署历史', exact: true }).click();
    }
  }
});

test('设置外观支持两种主题、跟随系统和重新启动后的偏好恢复', async () => {
  test.setTimeout(120_000);
  const page = await app.firstWindow();
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await settings.click();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  const themeOptions = page.getByRole('group', { name: '界面主题', exact: true });
  const colors: Record<string, string> = {};
  for (const theme of ['light', 'dark']) {
    await themeOptions.getByRole('button', { name: theme === 'light' ? '浅色' : '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect.poll(async () => (await page.evaluate(() => window.deployCenter!.load())).database.settings.theme).toBe(theme);
    colors[theme] = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    for (const [width, height] of sizes) {
      await size(width, height);
      await expect(settings).toBeInViewport({ ratio: 1 });
      await expect(themeOptions).toBeInViewport({ ratio: 1 });
      await boundaries();
      await shot('外观-' + theme + '-' + width + 'x' + height);
    }
  }
  expect(colors.light).not.toBe(colors.dark);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await settings.click();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  await themeOptions.getByRole('button', { name: '跟随系统' }).click();
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(colors[theme]);
  }
  await page.emulateMedia({ colorScheme: null });
});

test('正式包包含独立更新助手，无效参数在就绪前被拒绝且不启动安装', async () => {
  test.skip(!process.env.DEPLOY_CENTER_TEST_EXE, '独立助手资源位置只在正式包验收');
  const resourceDir = await app.evaluate(() => process.resourcesPath);
  const helper = path.join(resourceDir, 'update-handoff.exe');
  expect(await fs.readFile(helper)).toEqual(await fs.readFile('dist-electron/update-helper.exe'));
  const { spawn } = await import('node:child_process');
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(helper, ['invalid'], {
      detached: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('独立更新助手未正常退出'));
    }, 10000);
    child.stdout.on('data', (data) => {
      output += String(data);
    });
    child.stderr.on('data', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
  expect(result.code).toBe(1);
  expect(result.output).not.toContain('UPDATE_READY');
});


test('文本复制写入原生剪贴板并可直接粘贴，失败不会下载；目标编辑文案一致', async () => {
  const page=await app.firstWindow();
  const value='YOTOO 中文复制夹具\n完整提交 123456789abcdef';
  await app.evaluate(async ({clipboard,ClipboardItem,BrowserWindow})=>{
    const backup=[];
    for(const item of await clipboard.read()){
      const data:Record<string,any>={};
      for(const type of item.types)data[type]=await item.getType(type);
      backup.push(new ClipboardItem(data));
    }
    (globalThis as any).__clipboardBackup=backup;
    (globalThis as any).__copyDownloads=0;
    BrowserWindow.getAllWindows()[0].webContents.session.on('will-download',()=>{(globalThis as any).__copyDownloads++;});
  });
  let owned=value;
  try {
    await page.evaluate(value=>window.deployCenter!.copyText(value),value);
    expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe(value);
    await page.evaluate(async()=>{
      for(const bad of [42,null,'bad\0text']){
        let rejected=false;try{await window.deployCenter!.copyText(bad as string);}catch{rejected=true;}
        if(!rejected)throw new Error('无效剪贴板参数未拒绝');
      }
    });
    await page.getByRole('button',{name:'复制Git 提交',exact:true}).first().click();
    owned='b'.repeat(40);
    await expect.poll(()=>app.evaluate(({clipboard})=>clipboard.readText())).toBe(owned);
    await expect(page.getByRole('status').filter({hasText:'已复制'})).toBeVisible();
    await page.getByRole('button',{name:'服务管理',exact:true}).click();
    const search=page.locator('.entity-toolbar').getByRole('textbox');
    await search.focus();await page.keyboard.press('Control+V');await expect(search).toHaveValue(owned);
    await page.getByRole('navigation').getByRole('button',{name:'部署目标',exact:true}).click();
    await expect(page.locator('.entity-list').getByRole('button',{name:'编辑',exact:true})).toHaveCount(6);
    await expect(page.getByRole('button',{name:'编辑目标',exact:true})).toHaveCount(0);
    expect(await app.evaluate(()=>(globalThis as any).__copyDownloads)).toBe(0);
  }finally{
    await app.evaluate(async ({clipboard},owned)=>{
      const backup=(globalThis as any).__clipboardBackup;
      if(await clipboard.readText()===owned){if(backup.length)await clipboard.write(backup);else clipboard.clear();}
      delete (globalThis as any).__clipboardBackup;
    },owned);
  }
});
