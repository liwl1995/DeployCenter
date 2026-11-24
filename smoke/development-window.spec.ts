import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test.skip(process.platform !== 'win32', '在 Windows 的 Electron 中核对开发版窗口标记');

test('开发版标记在窗口标题和侧栏显示，折叠侧栏时仍完整可见', async () => {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'development-window-'));
  const exe = process.env.DEPLOY_CENTER_TEST_EXE;
  try {
    const app = await electron.launch({
      executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
      args: exe ? [] : [path.resolve('.')],
      env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: dir },
    });
    try {
      const page = await app.firstWindow();
      await expect(page.locator('.desktop-shell')).toBeVisible();
      const badge = page.locator('.sidebar-development');
      if (exe) {
        await expect(badge).toHaveCount(0);
        return;
      }
      await expect(badge).toHaveText('开发版');
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()))
        .toBe('开发版 · YOTOO 部署中心');
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(900, 600);
        window.webContents.setZoomFactor(1.25);
      });
      const sidebarElement = page.locator('.service-sidebar');
      await expect(sidebarElement).toHaveAttribute('data-collapsed', 'true');
      await expect(badge).toBeInViewport({ ratio: 1 });
      const bounds = await badge.boundingBox();
      const sidebar = await sidebarElement.boundingBox();
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width);
      await page.getByRole('button', { name: '展开侧栏' }).press('Enter');
      await expect(badge).toBeInViewport({ ratio: 1 });
      const boot = await page.evaluate(() => window.deployCenter!.load());
      await app.evaluate(({ ipcMain }, boot) => {
        ipcMain.removeHandler('deploy:load');
        ipcMain.handle('deploy:load', () => ({ ...boot, development: false }));
      }, boot);
      await page.reload();
      await expect(page.locator('.desktop-shell')).toBeVisible();
      await expect(badge).toHaveCount(0);
    } finally {
      await app.close();
    }
  } finally {
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
});
