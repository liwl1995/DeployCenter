import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import { createTask } from '../src/engine';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';
import { expectViewport } from './window-size';

test.skip(process.platform !== 'win32', '实际窗口与系统标题栏仅在 Windows 验收');

test('服务工作台在桌面窗口中可切换、筛选、打开任务和设置', async () => {
  test.setTimeout(120_000);
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'v200-window-'));
  const captures = path.resolve(process.env.DEPLOY_CENTER_TEST_CAPTURES || 'release/2.0.0-preview');
  await fs.mkdir(captures, { recursive: true });
  const db = emptyDatabase();
  db.settings.theme = 'dark';
  const service = {
    ...newService(),
    id: 'sample-crm',
    code: 'sample-crm',
    name: '客户关系管理',
    description: '业务平台 · CRM 后端',
    root: dir,
    jarDir: '.',
    jarName: 'crm-service.jar',
  };
  const jar = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await jar.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await fs.writeFile(
    path.join(dir, service.jarName),
    Buffer.from(await (await jar.close()).arrayBuffer()),
  );
  const production = {
    ...newTargetTemplate(service.id, 'isolated-server'),
    id: 'production-sample',
    name: '正式环境',
    directory: '/fixture/production',
    stop: './service.jar stop',
    start: './service.jar start',
    production: true,
  };
  const staging = {
    ...production,
    id: 'staging-sample',
    name: '测试环境',
    directory: '/fixture/staging',
    production: false,
    lastDeploy: new Date().toISOString(),
    healthState: '上次检查通过',
    currentCommit: 'a'.repeat(40),
    currentHash: 'b'.repeat(64),
  };
  db.services = [
    service,
    { ...service, id: 'campus-alarm', code: 'campus-alarm', name: '校园告警' },
  ];
  db.servers = [
    {
      id: 'isolated-server',
      name: '桌面验收服务器',
      auth: 'alias',
      alias: 'fixture-do-not-connect',
      host: '',
      port: 22,
      user: '',
      keyPath: '',
      note: '',
      credentialMode: 'ask',
    },
  ];
  db.targets = [staging, production];
  db.lastTargets = [staging.id, production.id];
  db.lastService = service.id;
  const storage = new Storage(dir, {
    encrypt: async () => {
      throw new Error('视觉验收不写入凭据');
    },
    decrypt: async () => {
      throw new Error('视觉验收不读取凭据');
    },
  });
  storage.saveConfig(db);
  const pastTask = createTask(db, service, [staging], {}, 'existing');
  pastTask.status = 'failed';
  pastTask.endedAt = pastTask.startedAt + 21_000;
  pastTask.elapsed = 21;
  pastTask.buildSteps.forEach((step) => {
    step.status = 'skipped';
  });
  pastTask.targets[0].status = 'failed';
  const failure =
    pastTask.targets[0].steps.find((step) => step.key === 'preflight') ||
    pastTask.targets[0].steps[0];
  failure.status = 'failed';
  pastTask.note = '桌面验收任务';
  storage.saveTask(pastTask);
  // 把本次打开的记录放在列表后方，确保返回时确实有滚动位置可恢复。
  for (let index = 0; index < 28; index++) {
    const row = structuredClone(pastTask);
    row.id += '-' + index;
    row.startedAt += 1000 * (index + 1);
    row.started = new Date(row.startedAt).toISOString();
    row.note += ' · ' + index;
    storage.saveTask(row);
  }
  storage.appendLog(pastTask.id, '使用已有 JAR，已校验产物完整性\n', undefined, {
    time: pastTask.startedAt,
  });
  storage.appendLog(pastTask.id, '错误：远程目录无写入权限\n', staging.id, {
    time: pastTask.endedAt,
    step: failure.key,
  });
  storage.close();

  const packaged = process.env.DEPLOY_CENTER_TEST_EXE;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DEPLOY_CENTER_DATA_DIR: dir,
    DEPLOY_CENTER_SETTINGS_DIR: path.join(dir, 'locator'),
    DEPLOY_CENTER_TESTING: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: packaged || path.resolve('node_modules/electron/dist/electron.exe'),
    args: [
      ...(packaged ? [] : [path.resolve('.')]),
      ...(process.env.DEPLOY_CENTER_TEST_SCALE
        ? ['--force-device-scale-factor=' + process.env.DEPLOY_CENTER_TEST_SCALE]
        : []),
    ],
    env: env as Record<string, string>,
  });
  try {
    const window = await app.firstWindow();
    const nav = window.getByRole('navigation', { name: '主导航' });
    const releaseTabs = window.getByRole('tablist', { name: '服务工作台' });
    const actions = window.locator('.deployment-footer');
    await expect(window.getByRole('heading', { name: service.name, exact: true })).toBeVisible();
    await window.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
    await expect(actions.getByRole('button', { name: '部署', exact: true })).toBeEnabled();
    const scale = Number(process.env.DEPLOY_CENTER_TEST_SCALE || 1);
    const [defaultWidth, defaultHeight] = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getSize(),
    );
    expect(Math.max(Math.abs(defaultWidth - 1000), Math.abs(defaultHeight - 650))).toBeLessThanOrEqual(
      scale > 1 ? 3 : 0,
    );
    await expect(window.getByRole('checkbox', { name: '选择正式环境' })).not.toBeChecked();
    await expect(window.getByRole('checkbox', { name: '选择测试环境' })).toBeChecked();

    if (process.env.DEPLOY_CENTER_TEST_SCALE)
      await expect.poll(() => window.evaluate(() => devicePixelRatio)).toBe(scale);
    const sizes = [[900, 600], [1000, 620], [1280, 800], ...(scale === 1 ? [[1600, 900]] : [])];
    for (const theme of ['dark', 'light']) {
      await window.getByRole('button', { name: '设置', exact: true }).click();
      await window.getByRole('tab', { name: '外观与提醒' }).click();
      await window.getByLabel('界面主题').selectOption(theme);
      await expect(window.locator('html')).toHaveAttribute('data-theme', theme);
      await window.getByRole('button', { name: '返回应用' }).click();
      for (const [width, height] of sizes) {
        await app.evaluate(
          ({ BrowserWindow }, size) =>
            BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
          [width, height],
        );
        await expectViewport(window, width, height);
        await expect(actions).toBeInViewport({ ratio: 1 });
        await expect(window.locator('.deployment-target').last()).toBeInViewport({ ratio: 1 });
        await expect(window.locator('.service-sidebar')).toHaveAttribute(
          'data-collapsed',
          String(width < 960),
        );
        const bounds = await window.evaluate(() => {
          const chrome = (
            navigator as Navigator & {
              windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect: () => DOMRect };
            }
          ).windowControlsOverlay;
          const header = document.querySelector('.desktop-page-header')!;
          return {
            horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
            contentOverflow:
              document.querySelector('.service-workspace-scroll')!.scrollWidth -
              document.querySelector('.service-workspace-scroll')!.clientWidth,
            windowControls: chrome?.visible,
            captionClearance:
              (chrome?.getTitlebarAreaRect().right || innerWidth) -
              header.lastElementChild!.getBoundingClientRect().right,
          };
        });
        expect(bounds.horizontalOverflow).toBeLessThanOrEqual(1);
        expect(bounds.contentOverflow).toBeLessThanOrEqual(1);
        expect(bounds.windowControls).toBe(true);
        expect(bounds.captionClearance).toBeGreaterThanOrEqual(0);
        await expect(actions.getByRole('button', { name: '部署', exact: true })).toBeEnabled();
        await window.screenshot({
          path: path.join(captures, `部署-${width}x${height}-${theme}.png`),
          animations: 'disabled',
        });
        await window.getByRole('checkbox', { name: '选择正式环境' }).check();
        const deploy = actions.getByRole('button', { name: '部署', exact: true });
        await deploy.click();
        const dialog = window.getByRole('dialog', { name: '确认部署' });
        const confirm = dialog.getByRole('button', { name: '部署', exact: true });
        await expect(confirm).toBeInViewport({ ratio: 1 });
        await expect(confirm).toBeDisabled();
        await expect(dialog.locator('input[data-autofocus]')).toBeFocused();
        await window.screenshot({
          path: path.join(captures, `确认-${width}x${height}-${theme}.png`),
          animations: 'disabled',
        });
        await dialog.getByRole('button', { name: '返回检查' }).click();
        await expect(deploy).toBeFocused();
        await window.getByRole('checkbox', { name: '选择正式环境' }).uncheck();
      }
    }

    await window.getByRole('button', { name: '正式', exact: true }).click();
    await expect(window.getByText('1 个已选目标未在当前筛选中显示')).toBeVisible();
    await window.getByRole('button', { name: '全部目标', exact: true }).click();
    await window.getByRole('button', { name: '展开测试环境详情' }).click();
    await expect(window.getByRole('button', { name: '收起测试环境详情' })).toBeVisible();
    await window.getByRole('button', { name: '收起测试环境详情' }).click();

    await releaseTabs.getByRole('tab', { name: '部署目标' }).focus();
    await window.keyboard.press('ArrowRight');
    await expect(releaseTabs.getByRole('tab', { name: '发布记录' })).toBeFocused();
    await expect(window.getByText('桌面验收任务', { exact: true })).toBeAttached();
    await window.getByRole('button', { name: '筛选部署历史' }).click();
    await expect(window.getByRole('dialog', { name: '筛选部署历史' })).toBeInViewport({ ratio: 1 });
    await window.keyboard.press('Escape');
    await expect(window.getByRole('button', { name: '筛选部署历史' })).toBeFocused();
    await window.getByRole('button', { name: '筛选部署历史' }).click();
    const filter = window.getByRole('dialog', { name: '筛选部署历史' });
    await filter.getByLabel('任务结果').selectOption('failed');
    await filter.getByRole('button', { name: '应用', exact: true }).click();
    await window.getByRole('textbox', { name: '搜索完整历史' }).fill('桌面验收');
    const row = window.getByRole('row', { name: '查看任务：桌面验收任务', exact: true });
    const scroll = window.locator('.service-workspace-scroll');
    await row.scrollIntoViewIfNeeded();
    const position = await scroll.evaluate((element) => element.scrollTop);
    expect(position).toBeGreaterThan(0);
    await row.click();
    await expect(window.getByRole('heading', { name: '执行日志' })).toBeVisible();
    await expect(window.locator('.log-viewport')).toBeInViewport({ ratio: 1 });
    await expect(window.locator('.log-viewport')).toContainText('远程目录无写入权限');
    await window.screenshot({ path: path.join(captures, '历史任务.png') });
    await window.getByRole('button', { name: '返回部署' }).click();
    await expect(releaseTabs.getByRole('tab', { name: '发布记录' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(window.getByLabel('已应用的筛选')).toBeVisible();
    await expect(window.getByRole('textbox', { name: '搜索完整历史' })).toHaveValue('桌面验收');
    await expect(row).toBeFocused();
    expect(await scroll.evaluate((element) => element.scrollTop)).toBe(position);
    await nav.getByRole('button', { name: '校园告警', exact: true }).click();
    await expect(window.getByRole('heading', { name: '校园告警' })).toBeVisible();
    await expect(window.getByText('还没有部署目标')).toBeVisible();
    await window.emulateMedia({ reducedMotion: 'reduce' });
    const sidebarToggle = window.getByRole('button', { name: '收起侧栏' });
    await sidebarToggle.hover();
    const tooltip = window.locator('[data-radix-popper-content-wrapper] [data-state]').first();
    await expect(tooltip).toBeVisible();
    expect(
      await tooltip.evaluate((node) => parseFloat(getComputedStyle(node).animationDuration)),
    ).toBeLessThan(0.001);
    await window.mouse.move(300, 150);
    await window.getByRole('button', { name: '设置', exact: true }).click();
    await window.getByRole('tab', { name: '配置与帮助' }).click();
    await expect(window.getByRole('heading', { name: '软件更新' })).toBeVisible();
    await window.screenshot({ path: path.join(captures, '配置与帮助.png') });
    await window.getByRole('tab', { name: '外观与提醒' }).click();
    await window.getByLabel('界面主题').selectOption('light');
    await expect(window.locator('html')).toHaveAttribute('data-theme', 'light');
    await window.getByRole('button', { name: '返回应用' }).click();
    await window.getByRole('button', { name: '服务管理', exact: true }).click();
    await expect(window.locator('.entity-record')).toHaveCount(2);
    await window.screenshot({ path: path.join(captures, '服务管理-浅色.png') });
  } finally {
    await app.close();
    if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});
