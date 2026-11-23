import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { emptyDatabase, newService } from '../src/defaults';

test.skip(process.platform !== 'win32', '在 Windows Electron 中验收教学向导');

const scratch = path.resolve('.test-data');
async function markInstallation(data: string, id: string) {
  const control = path.join(data, 'Control');
  await fs.mkdir(control, { recursive: true });
  await fs.writeFile(path.join(control, 'install-tutorial.id'), id);
}
async function launch(data: string) {
  const exe = process.env.DEPLOY_CENTER_TEST_EXE;
  return electron.launch({
    executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
    args: exe ? [] : [path.resolve('.')],
    env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: data },
  });
}

test('安装后自动显示等高五步教学，支持完成、重新打开和跨重启跳过', async ({}, info) => {
  await fs.mkdir(scratch, { recursive: true });
  const data = await fs.mkdtemp(path.join(scratch, 'tutorial-first-run-'));
  const installId = '134100000000000001-100';
  await markInstallation(data, installId);
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    const guide = page.getByRole('dialog', { name: '教学向导' });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('button', { name: '下一步' })).toBeFocused();
    await app.evaluate(({ BrowserWindow, nativeTheme }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(900, 600);
      win.webContents.setZoomFactor(1.25);
      nativeTheme.themeSource = 'dark';
    });
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(720);
    const content = guide.locator('.modal-content');
    await expect(content).toHaveCSS('scrollbar-width', 'none');
    const frame = await guide.boundingBox();
    const footer = await guide.locator('footer').boundingBox();
    const capture = async (filename: string) => {
      await expect(page.locator('.overlay').last()).toHaveCSS('opacity', '1');
      expect(await guide.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
      const image = await app.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
      await fs.writeFile(info.outputPath(filename), Buffer.from(image, 'base64'));
    };
    for (const [index, title] of [
      '配置构建环境', '添加服务器', '添加服务', '添加部署目标', '完成第一次部署',
    ].entries()) {
      await expect(guide.getByRole('heading', { name: title, exact: true })).toBeVisible();
      await expect.poll(() => guide.getByRole('img', { name: /标出/ }).evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      expect((await guide.boundingBox())?.height).toBe(frame?.height);
      expect((await guide.locator('footer').boundingBox())?.y).toBe(footer?.y);
      expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
      if (index === 0) await expect(guide.getByRole('listitem')).toHaveCount(2);
      if (index === 2) await capture('tutorial-dark.png');
      if (index < 4) {
        const next = guide.getByRole('button', { name: '下一步' });
        await expect(next).toBeInViewport();
        if (index === 0) await next.press('Enter');
        else await next.click();
      }
    }
    await expect(guide.getByRole('button', { name: '完成' })).toBeInViewport();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThanOrEqual(600);
    expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await guide.getByRole('button', { name: '上一步' }).click();
    await expect(guide.getByRole('heading', { name: '添加部署目标' })).toBeVisible();
    await guide.getByRole('button', { name: '下一步' }).click();
    await expect(guide.getByRole('button', { name: '去部署工作台' })).toBeVisible();
    await guide.getByRole('button', { name: '完成' }).click();
    await expect(guide).toHaveCount(0);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('tab', { name: '关于与帮助' }).click();
    const open = page.getByRole('button', { name: /教学向导/ });
    await open.click();
    await expect(guide.getByRole('heading', { name: '配置构建环境' })).toBeVisible();
    await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light'; });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await capture('tutorial-light.png');
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
    await open.click();
    await guide.getByRole('button', { name: '跳过' }).click();
    await expect.poll(async () => JSON.parse(await fs.readFile(path.join(data, 'desktop-preferences.json'), 'utf8'))
      .preferences.tutorialInstallId).toBe(installId);
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByText('还没有服务', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '教学向导' })).toHaveCount(0);
  } finally {
    await app.close();
    if (path.dirname(data) === scratch) await fs.rm(data, { recursive: true, force: true });
  }
});

test('已有服务时同版本覆盖也自动弹一次，普通重开不弹', async () => {
  await fs.mkdir(scratch, { recursive: true });
  const data = await fs.mkdtemp(path.join(scratch, 'tutorial-upgrade-'));
  const store = new Storage(data, {
    encrypt: async (value) => Buffer.from(value), decrypt: async (value) => String(value),
  });
  try {
    const db = emptyDatabase();
    db.services.push({ ...newService(), name: '示例订单服务', code: 'orders', root: data });
    store.saveConfig(db);
  } finally { store.close(); }
  let app = await launch(data);
  try {
    let page = await app.firstWindow();
    const guide = () => page.getByRole('dialog', { name: '教学向导' });
    await expect(page.getByRole('tab', { name: '部署目标' })).toBeVisible();
    await expect(guide()).toHaveCount(0);
    for (const id of ['134100000000000002-100', '134100000000000003-100']) {
      await app.close();
      await markInstallation(data, id);
      app = await launch(data);
      page = await app.firstWindow();
      await expect(guide()).toBeVisible();
      await expect.poll(async () => JSON.parse(await fs.readFile(path.join(data, 'desktop-preferences.json'), 'utf8'))
        .preferences.tutorialInstallId).toBe(id);
      await guide().getByRole('button', { name: '跳过' }).click();
    }
    await app.close();
    app = await launch(data);
    page = await app.firstWindow();
    await expect(page.getByRole('tab', { name: '部署目标' })).toBeVisible();
    await expect(guide()).toHaveCount(0);
  } finally {
    await app.close();
    if (path.dirname(data) === scratch) await fs.rm(data, { recursive: true, force: true });
  }
});
