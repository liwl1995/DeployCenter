import Sqlite from 'better-sqlite3';
import { Storage } from '../electron/storage';
import { createTask } from '../src/engine';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
test.skip(process.platform !== 'win32', 'Windows 桌面及 .exe 验收仅在 Windows 运行');
let app: ElectronApplication, dir: string;
test.beforeEach(async () => {
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
  const store = new Storage(dir, {
    encrypt: async () => {
      throw new Error('界面夹具不写入凭据');
    },
    decrypt: async () => {
      throw new Error('界面夹具不读取凭据');
    },
  });
  store.saveConfig(db);
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
  await expect(page.getByRole('heading', { name: '准备好，发布下一版本' })).toBeVisible();
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
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [width, height],
  );
  const page = await app.firstWindow();
  await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
}
async function boundaries() {
  const page = await app.firstWindow();
  const main = page.getByRole('main');
  expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
  ).toBeLessThanOrEqual(1);
  await expect(page.getByRole('contentinfo', { name: '应用状态' })).toBeInViewport({ ratio: 1 });
}
async function shot(name: string) {
  const page = await app.firstWindow();
  await fs.mkdir(captures, { recursive: true });
  await page.screenshot({ path: path.join(captures, name + '.png') });
}
test('启动直接部署，三个配置页卡片与详情在三种尺寸下可用', async () => {
  const page = await app.firstWindow();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(page.getByRole('heading', { name: '准备好，发布下一版本' })).toBeVisible();
  await expect(nav.getByRole('button', { name: '首页总览' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重复上次部署' })).toHaveCount(0);
  for (const [width, height] of sizes) {
    await size(width, height);
    for (const name of ['服务管理', '部署目标', '服务器']) {
      await nav.getByRole('button', { name, exact: true }).click();
      const grid = page.locator('.entity-card-grid');
      await expect(grid.locator('.entity-card')).toHaveCount(6);
      const columns = await grid.evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length,
      );
      expect(columns).toBe(3);
      const lastCard = (await grid.locator('.entity-card').last().boundingBox())!;
      const footerBox = (await page.getByRole('contentinfo', { name: '应用状态' }).boundingBox())!;
      expect(lastCard.y + lastCard.height).toBeLessThanOrEqual(footerBox.y);
      await expect(
        grid.locator('.entity-card').first().locator('.entity-actions button'),
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
      const card = grid.locator('.entity-card').last();
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
    expect(first.y).toBeLessThan(290);
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
      await page.locator('.footer-task').click();
      const taskPage = page.locator('.task-page');
      const footer = page.getByRole('contentinfo', { name: '应用状态' });
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
        await expect(taskPage.getByRole('progressbar', { name: '文件上传进度' })).toBeVisible();
        for (const selector of ['.task-stage .spin', '.task-step-row .spin']) {
          await expect
            .poll(() =>
              taskPage.locator(selector).evaluate((el) => el.getAnimations()[0]?.playState),
            )
            .toBe('running');
        }
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
        await expect
          .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
          .toEqual([width, height]);
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
        const footerBounds = (await footer.boundingBox())!;
        expect(logBounds.y + logBounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
        await shot(fixture + '-' + width + 'x' + height);
        if (fixture === 'success') {
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
          });
          await shot(fixture + '-dark-' + width + 'x' + height);
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'light';
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
        const footerBefore = await footer.boundingBox();
        await main.evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        expect(await footer.boundingBox()).toEqual(footerBefore);
        await expect(taskPage.locator('.task-page-header')).toBeInViewport({ ratio: 1 });
      }
      db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    }
  } finally {
    db.close();
  }
});

test('配置与帮助展示仓库并使用系统浏览器打开，其他外链继续拒绝', async () => {
  const page = await app.firstWindow();
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (destination: string) => {
      (globalThis as unknown as { repositoryOpened?: string }).repositoryOpened = destination;
    };
  });
  await page.getByRole('navigation').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '配置与帮助', exact: true }).click();
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
  await boundaries();
  await shot('配置与帮助-仓库');
});
