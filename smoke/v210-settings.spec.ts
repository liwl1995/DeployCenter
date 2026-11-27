import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

test.skip(process.platform !== 'win32', '托盘和显示缩放需在 Windows 验收');

for (const scale of [1, 1.25, 1.5]) {
  test(`设置在 ${scale * 100}% 显示缩放下可用`, async () => {
    const root = path.resolve('.test-data');
    await fs.mkdir(root, { recursive: true });
    const data = await fs.mkdtemp(path.join(root, 'v210-settings-'));
    const exe = process.env.DEPLOY_CENTER_TEST_EXE;
    const start = () => electron.launch({
      executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
      args: [...(exe ? [] : [path.resolve('.')]), `--force-device-scale-factor=${scale}`],
      env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: data },
    });
    let app = await start();
    try {
      let page = await app.firstWindow();
      await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(scale);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({
        x: 16, y: 20, width: 900, height: 600,
      }));
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(page.getByRole('tab')).toHaveText(['通用', '部署与构建', '数据与备份', '软件更新', '关于与帮助']);
      await expect(page.getByRole('switch', { name: '记住窗口大小和位置' })).toBeChecked();
      await expect(page.getByRole('switch', { name: '任务日志默认跟随最新' })).toBeChecked();
      const captures = process.env.DEPLOY_CENTER_TEST_CAPTURES;
      if (captures) await fs.mkdir(captures, { recursive: true });
      const option = (label: string, name: string) =>
        page.getByRole('group', { name: label, exact: true }).getByRole('button', { name, exact: true });
      for (const theme of ['light', 'dark']) {
        await page.getByRole('tab', { name: '通用', exact: true }).click();
        await option('界面主题', theme === 'light' ? '浅色' : '深色').click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        for (const name of ['通用', '部署与构建', '数据与备份', '软件更新', '关于与帮助']) {
          await page.getByRole('tab', { name, exact: true }).click();
          await expect(page.getByRole('combobox')).toHaveCount(0);
          expect(await page.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth)).toBeLessThanOrEqual(1);
          if (captures && ['通用', '软件更新'].includes(name))
            await page.screenshot({ path: path.join(captures, `settings-${name}-${scale}-${theme}.png`) });
        }
      }
      if (scale !== 1) return;
      await page.getByRole('tab', { name: '软件更新', exact: true }).click();
      await expect(option('定期检查更新', '手动检查')).toHaveAttribute('aria-pressed', 'true');
      await option('定期检查更新', '自动检查并下载').click();
      await expect(option('定期检查更新', '自动检查并下载')).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('tab', { name: '通用', exact: true }).click();
      await option('界面缩放', '125%').click();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1.25);
      await page.getByRole('tab', { name: '数据与备份', exact: true }).click();
      await expect(option('产物保留方式', '按总占用上限')).toBeVisible();
      expect(await page.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth)).toBeLessThanOrEqual(1);
      await page.getByRole('tab', { name: '通用', exact: true }).click();
      await page.getByRole('switch', { name: '任务日志默认跟随最新' }).click();
      await expect(page.getByRole('switch', { name: '任务日志默认跟随最新' })).not.toBeChecked();
      await page.getByRole('switch', { name: '关闭时最小化到托盘' }).click();
      await expect(page.getByRole('switch', { name: '关闭时最小化到托盘' })).toBeChecked();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(false);
      await app.close();
      app = await start();
      page = await app.firstWindow();
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().height)).toBe(600);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(option('界面缩放', '125%')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('switch', { name: '任务日志默认跟随最新' })).not.toBeChecked();
      await expect(page.getByRole('switch', { name: '关闭时最小化到托盘' })).toBeChecked();
    } finally {
      await app.close().catch(() => {});
    }
  });
}

test('托盘实际窗口可切换任务与服务，操作按钮和 Esc 可用', async () => {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const data = await fs.mkdtemp(path.join(root, 'v210-tray-'));
  const entry = path.resolve('dist-electron', `v210-tray-${randomUUID()}.cjs`);
  await build({
    stdin: {
      contents: `
        import {app, Tray, screen} from 'electron';
        import {createTrayPanel} from './electron/tray-panel';
        app.setPath('userData', ${JSON.stringify(data)});
        app.whenReady().then(() => {
          let tray;
          const on = Tray.prototype.on;
          Tray.prototype.on = function(name, handler) {
            if (name === 'right-click') tray = this;
            return on.call(this, name, handler);
          };
          const state = { dark: true, closeToTray: false, task: {id:'task',name:'测试部署',progress:60},
            schedule:{name:'下一项',at:Date.now()+60000},services:[{id:'crm',name:'CRM'}] };
          const panel = createTrayPanel(${JSON.stringify(path.resolve('assets/icon.ico'))}, () => state, (action, id) => {
            if (action === 'toggle') state.closeToTray = !state.closeToTray;
            globalThis.trayAction = [action, id];
          });
          Tray.prototype.on = on;
          app.on('window-all-closed', () => {});
          app.on('before-quit', () => panel.close());
          globalThis.openTray = (edge) => {
            const area = screen.getPrimaryDisplay().workArea;
            tray.emit('right-click', {}, {x:area.x+area.width-20,y:edge==='top'?area.y-20:area.y+area.height,width:20,height:20});
          };
        });`,
      resolveDir: process.cwd(),
    },
    platform: 'node',
    bundle: true,
    external: ['electron'],
    format: 'cjs',
    outfile: entry,
  });
  const app = await electron.launch({
    executablePath: path.resolve('node_modules/electron/dist/electron.exe'),
    args: [entry],
  });
  try {
    const open = (edge: string) => app.evaluate(async ({ app }, position) => {
      await app.whenReady();
      (globalThis as unknown as { openTray(edge: string): void }).openTray(position);
    }, edge);
    await open('bottom');
    const page = await app.firstWindow();
    const heading = page.getByRole('heading', { name: 'YOTOO 部署中心', level: 1 });
    await expect(heading).toHaveCSS('font-size', '15px');
    await expect(heading).toHaveCSS('line-height', '22px');
    await expect(page.getByText('当前任务 · 60%')).toBeVisible();
    await expect(page.getByText('下一项', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '服务', exact: true }).click();
    await page.getByRole('switch', { name: '关闭到托盘' }).click();
    await expect(page.getByRole('switch', { name: '关闭到托盘' })).toBeChecked();
    if (process.env.DEPLOY_CENTER_TEST_CAPTURES) {
      await page.screenshot({ path: path.join(process.env.DEPLOY_CENTER_TEST_CAPTURES, '托盘服务.png') });
    }
    await page.getByRole('button', { name: 'CRM', exact: true }).click();
    expect(await app.evaluate(() =>
      (globalThis as unknown as { trayAction: string[] }).trayAction)).toEqual(['service', 'crm']);
    await open('top');
    expect(await app.evaluate(({ BrowserWindow, screen }) =>
      BrowserWindow.getAllWindows()[0].getBounds().y >= screen.getPrimaryDisplay().workArea.y)).toBe(true);
    await page.keyboard.press('Escape');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  } finally {
    await app.close();
    await fs.unlink(entry);
  }
});
