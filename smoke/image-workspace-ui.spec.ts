import { test, expect, _electron as electron } from '@playwright/test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ImageJob } from '../src/images';
import { expectViewport } from './window-size';

test.skip(process.platform !== 'win32', '桌面控制与 Windows 安装版验收仅在 Windows 运行');

test('镜像紧凑列表、返回位置、输入控件与固定操作栏', async ({}, info) => {
  test.setTimeout(90_000);
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'image-ui-'));
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')],
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    const button = (name: string) => page.getByRole('button', { name, exact: true });
    await button('服务管理').click();
    await button('添加服务').click();
    await page.getByLabel('服务名称', { exact: true }).fill('镜像界面验收服务');
    await page.getByLabel('服务标识', { exact: true }).fill('image-fixture');
    await page.getByLabel('项目根目录', { exact: true }).fill(dir);
    await button('保存配置').click();
    await button('服务器').click();
    await button('添加服务器').click();
    await page.getByLabel('服务器名称', { exact: true }).fill('界面验收服务器');
    await page.getByLabel('认证方式', { exact: true }).selectOption('password');
    await page.getByLabel('IP 地址或域名', { exact: true }).fill('127.0.0.1');
    await page.getByLabel('登录用户名', { exact: true }).fill('fixture');
    await button('保存配置').click();
    await button('镜像界面验收服务').click();
    await page.getByRole('banner').getByRole('button', { name: '添加部署目标' }).click();
    const targetTabs = page.getByRole('tablist', { name: '部署目标配置' });
    await targetTabs.getByRole('tab', { name: '基本信息' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(targetTabs.getByRole('tab', { name: '运行方式' })).toBeFocused();
    await expect(targetTabs.locator('[tabindex="0"]')).toHaveCount(1);
    await expect(page.getByRole('tabpanel', { name: '运行方式' })).toBeVisible();
    await page.keyboard.press('Escape');

    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('deploy:image-distributions');
      ipcMain.handle('deploy:image-distributions', () => ['Ubuntu-24.04']);
      ipcMain.removeHandler('deploy:image-list');
      ipcMain.handle('deploy:image-list', () => {
        throw new Error('测试镜像读取失败');
      });
      ipcMain.removeHandler('deploy:image-logs');
      ipcMain.handle('deploy:image-logs', () => [
        { offset: 0, text: '镜像日志测试\n', time: Date.now(), step: '上传镜像包' },
      ]);
    });
    await button('镜像工具').click();
    const tabs = page.getByRole('tablist', { name: '镜像工具' });
    const tab = (name: string) => tabs.getByRole('tab', { name, exact: true });
    await expect(page.getByRole('textbox', { name: 'Dockerfile' })).toHaveAttribute('readonly', '');
    await expect(page.getByRole('textbox', { name: '构建目录' })).toHaveAttribute('readonly', '');
    await expect(button('选择本地 JAR')).toBeVisible();
    const footer = page.getByRole('group', { name: '镜像构建操作' });
    const view = page.locator('.image-content:visible').first();
    for (const [width, height] of [
      [900, 600],
      [1000, 620],
      [1280, 800],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
        [width, height],
      );
      await expectViewport(page, width, height);
      const footerBefore = (await footer.boundingBox())!;
      await view.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await footer.boundingBox()).toEqual(footerBefore);
      expect(footerBefore.y + footerBefore.height).toBeGreaterThan(height - 4);
      expect(await view.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(
        (await page.getByLabel('WSL 发行版', { exact: true }).boundingBox())!.width,
      ).toBeLessThan((await view.boundingBox())!.width * 0.6);
    }
    await tab('导入到服务器').click();
    await expect(page.getByRole('textbox', { name: '镜像包' })).toHaveAttribute('readonly', '');
    const importFooter = page.getByRole('group', { name: '镜像导入操作' });
    for (const name of ['镜像包信息', '导入前检查', '导入镜像'])
      await expect(importFooter.getByRole('button', { name, exact: true })).toBeVisible();
    await tab('镜像包').click();
    await expect(page.getByText('测试镜像读取失败')).toBeVisible();
    await expect(page.getByText('正在读取镜像任务…')).toHaveCount(0);

    const start = Date.now();
    const id = (n: number) => '2d74fc8e-92de-47ec-be1a-' + String(n).padStart(12, '0');
    const jobs: ImageJob[] = Array.from({ length: 32 }, (_, index) => ({
      id: id(index),
      name: '完成记录 ' + index,
      kind: 'build',
      status: 'failed',
      started: start - 2000 - index * 6000,
      finished: start - index * 6000,
      stages: [],
    }));
    jobs.unshift({
      id: id(99),
      name: '正在导入夹具',
      kind: 'import',
      status: 'running',
      started: start,
      stages: [
        { name: '检查', status: 'success' },
        { name: '上传镜像包', status: 'running', started: start },
      ],
      upload: { bytes: 2, size: 4, speed: 1 },
    });
    await app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('deploy:image-list');
      ipcMain.handle('deploy:image-list', () => ({ directory: 'data/images', jobs: value }));
    }, jobs);
    await button('重新读取').click();
    const table = page.getByRole('table', { name: '镜像包列表' });
    const filter = page.getByRole('group', { name: '镜像任务状态筛选' });
    await expect(filter.getByRole('button', { name: '执行中' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(table.getByRole('columnheader').first()).toHaveText('状态');
    await expect(table.locator('tr[data-image-job]')).toHaveCount(1);
    await table.getByRole('row', { name: /正在导入夹具/ }).press('Enter');
    await page.getByLabel('日志级别').selectOption('error');
    await expect(page.getByRole('progressbar', { name: '文件上传进度' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    await button('返回镜像包').click();
    await filter.getByRole('button', { name: '已结束' }).click();
    await expect(table.locator('tr[data-image-job]')).toHaveCount(32);
    const row = table.getByRole('row', { name: '查看镜像任务：完成记录 29' });
    await row.scrollIntoViewIfNeeded();
    const scroll = await view.evaluate((el) => el.scrollTop);
    expect(scroll).toBeGreaterThan(0);
    await row.click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(900, 600),
    );
    await expectViewport(page, 900, 600);
    await expect(
      page.locator('.image-workspace > header').getByText('失败', { exact: true }),
    ).toBeVisible();
    await expect(page.locator('.image-workspace .task-duration')).toBeHidden();
    await button('返回镜像包').click();
    await expect(row).toBeFocused();
    expect(await view.evaluate((el) => el.scrollTop)).toBe(scroll);
    await page.screenshot({ path: info.outputPath('镜像包表格.png') });
  } finally {
    await app.close();
    if (path.dirname(dir) === base && path.basename(dir).startsWith('image-ui-'))
      await rm(dir, { recursive: true, force: true });
  }
});
