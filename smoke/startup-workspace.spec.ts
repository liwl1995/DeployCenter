import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test.skip(process.platform !== 'win32', '在 Windows 的 Electron 中核对原生主题和启动首帧');

test('启动骨架、工作台首帧与原生主题一致，更新提醒同步显示', async () => {
  test.setTimeout(60000);
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'startup-workspace-'));
  const exe = process.env.DEPLOY_CENTER_TEST_EXE;
  const entry = path.join(dir, 'observe-startup.cjs');
  if (!exe) await fs.writeFile(entry, `
    const { app } = require('electron');
    app.once('browser-window-created', (_, window) => {
      window.once('show', () => { globalThis.opacityAtShow = window.getOpacity(); });
      const setOpacity = window.setOpacity.bind(window);
      window.setOpacity = (opacity) => {
        setOpacity(opacity);
        if (opacity !== 1) return;
        globalThis.revealTime = Date.now();
        globalThis.firstVisibleFrame = window.webContents.capturePage({ x: 30, y: 50, width: 1, height: 24 })
          .then((image) => {
            const bitmap = image.toBitmap();
            return bitmap.length > 4 && bitmap[0] !== bitmap[bitmap.length - 4];
          });
        window.webContents.executeJavaScript(\`
          new MutationObserver((_, observer) => {
            if (!document.querySelector('.desktop-shell')) return;
            document.documentElement.dataset.workspaceTime = String(Date.now());
            observer.disconnect();
          }).observe(document.getElementById('root'), { childList: true });
        \`);
      };
    });
    require(${JSON.stringify(path.resolve('dist-electron/main.cjs'))});
  `);
  const app = await electron.launch({
    executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
    args: exe ? [] : [entry],
    env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('.desktop-shell')).toBeVisible();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(true);
    if (!exe) {
      expect(await app.evaluate(() => Reflect.get(globalThis, 'opacityAtShow'))).toBe(0);
      expect(await app.evaluate(() => Reflect.get(globalThis, 'firstVisibleFrame'))).toBe(true);
      const reveal = await app.evaluate(() => Number(Reflect.get(globalThis, 'revealTime')));
      const workspace = Number(await page.locator('html').getAttribute('data-workspace-time'));
      expect(workspace - reveal).toBeGreaterThanOrEqual(1000);
    }
    const boot = await page.evaluate(() => window.deployCenter!.load());
    await page.addInitScript(() => {
      const colors = new Set<string>();
      const observer = new MutationObserver(() => {
        const shell = document.querySelector('#startup-shell');
        if (shell) colors.add(getComputedStyle(shell).backgroundColor);
        if (!document.querySelector('.desktop-shell')) return;
        document.documentElement.dataset.skeletonColors = JSON.stringify([...colors]);
        document.documentElement.dataset.firstWorkspaceColor = getComputedStyle(document.body).backgroundColor;
        observer.disconnect();
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-startup-theme'] });
    });
    for (const theme of ['dark', 'light', 'system'] as const) {
      const dark = await app.evaluate(({ ipcMain, nativeTheme }, { boot, theme }) => {
        nativeTheme.themeSource = theme;
        ipcMain.removeHandler('deploy:load');
        ipcMain.handle('deploy:load', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return { ...boot, darkTheme: nativeTheme.shouldUseDarkColors, database: { ...boot.database, settings: { ...boot.database.settings, theme } } };
        });
        return nativeTheme.shouldUseDarkColors;
      }, { boot, theme });
      if (theme !== 'system') expect(dark).toBe(theme === 'dark');
      const color = dark ? 'rgb(28, 28, 30)' : 'rgb(255, 255, 255)';
      await page.goto(page.url().split('#')[0] + (dark ? '#startup-dark' : '#'));
      await page.reload({ waitUntil: 'commit' });
      const skeleton = page.locator('#startup-shell');
      await expect(skeleton).toBeVisible();
      const mediaDark = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches);
      console.log(`启动主题 ${theme}：nativeTheme=${dark ? 'dark' : 'light'}，媒体查询=${mediaDark ? 'dark' : 'light'}`);
      await expect(skeleton).toHaveCSS('background-color', color);
      await expect(page.locator('.desktop-shell')).toBeVisible();
      await expect(skeleton).toHaveCount(0);
      await expect(page.locator('html')).toHaveAttribute('data-skeleton-colors', JSON.stringify([color]));
      await expect(page.locator('html')).toHaveAttribute('data-first-workspace-color', color);
    }
    const settings = page.getByRole('button', { name: '设置', exact: true });
    await expect(settings.locator('.update-notification-dot')).toHaveCount(0);
    const emit = (available: boolean) => app.evaluate(({ BrowserWindow }, available) => {
      BrowserWindow.getAllWindows()[0].webContents.send('deploy:event', {
        kind: 'update',
        update: {
          stage: available ? 'available' : 'current',
          currentVersion: '2.3.3',
          release: { version: available ? '3.0.0' : '2.3.3', notes: '', publishedAt: '', size: 1 },
          received: 0,
          speed: 0,
        },
      });
    }, available);
    await emit(true);
    await expect(settings.locator('.update-notification-dot')).toBeVisible();
    await settings.press('Enter');
    const update = page.getByRole('tab', { name: '软件更新', exact: true });
    await expect(update.locator('.update-notification-dot')).toBeVisible();
    await update.press('Enter');
    const startupCheck = page.getByRole('switch', { name: '启动时检查更新' });
    await expect(startupCheck).not.toBeChecked();
    await startupCheck.press('Space');
    await expect(startupCheck).toBeChecked();
    await emit(false);
    await expect(update.locator('.update-notification-dot')).toHaveCount(0);

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('deploy:load');
      ipcMain.handle('deploy:load', () => { throw new Error('模拟启动失败'); });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toContainText('模拟启动失败');
    await expect(page.locator('#startup-shell')).toHaveCount(0);
  } finally {
    await app.close();
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
});
