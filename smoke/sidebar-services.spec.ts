import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';

test.skip(process.platform !== 'win32', '在 Windows Electron 中检查侧栏拖放和滚动');

test('侧栏支持滚动、最近部署排序和手动排序，其他页面保持原顺序', async () => {
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const data = await fs.mkdtemp(path.join(root, 'sidebar-services-'));
  const exe = process.env.DEPLOY_CENTER_TEST_EXE;
  const start = () => electron.launch({
    executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
    args: exe ? [] : [path.resolve('.')],
    env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: data },
  });
  let app = await start();
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setBounds({ x: 16, y: 20, width: 900, height: 600 }),
    );
    const db = emptyDatabase();
    const names = Array.from({ length: 24 }, (_, index) => '验收服务 ' + (index + 1));
    db.services = names.map((name, index) => ({
      ...newService(), name, code: 'service-' + (index + 1), root: data,
    }));
    const server = {
      id: 'sidebar-server', name: '验收服务器', auth: 'alias' as const,
      alias: 'fixture-do-not-connect', host: '', port: 22, user: '', keyPath: '',
      note: '', credentialMode: 'ask' as const,
    };
    db.servers = [server];
    db.targets = [1, 2].map((index) => ({
      ...newTargetTemplate(db.services[index].id, server.id),
      name: '测试环境', directory: '/fixture/service-' + index,
      start: './service.jar start',
      lastDeploy: new Date(Date.UTC(2026, 0, index)).toISOString(),
    }));
    await page.evaluate((config) => window.deployCenter!.save(config), db);
    await page.reload();
    const list = () => page.locator('.sidebar-services');
    const rows = () => list().getByRole('button');
    const settings = () => page.getByRole('button', { name: '设置', exact: true });
    const toggle = () => page.getByRole('switch', { name: '按最近部署时间排序' });
    const back = () => page.getByRole('button', { name: '返回应用', exact: true });
    const theme = (name: string) =>
      page.getByRole('group', { name: '界面主题', exact: true }).getByRole('button', { name, exact: true });

    await expect(rows()).toHaveText(names);
    await expect(list()).toHaveCSS('scrollbar-width', 'none');
    await list().hover();
    await page.mouse.wheel(0, 1000);
    await expect.poll(() => list().evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await page.mouse.wheel(0, -1000);
    await expect.poll(() => list().evaluate((element) => element.scrollTop)).toBe(0);

    await settings().click();
    await expect(page.getByRole('tab', { name: '通用', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(toggle()).not.toBeChecked();
    await theme('浅色').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle().click();
    await expect(toggle()).toBeChecked();
    await back().click();
    const recentOrder = [names[2], names[1], names[0], ...names.slice(3)];
    await expect(rows()).toHaveText(recentOrder);

    await rows().nth(1).dragTo(rows().nth(0), { targetPosition: { x: 50, y: 22 } });
    await expect(rows()).toHaveText(recentOrder);
    await settings().click();
    await expect(toggle()).toBeChecked();
    await theme('深色').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('group', { name: '界面缩放', exact: true }).getByRole('button', { name: '125%', exact: true }).click();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    )).toBeCloseTo(1.25);
    await back().click();

    await rows().nth(2).dragTo(rows().nth(0), { targetPosition: { x: 50, y: 4 } });
    const draggedOrder = [names[0], names[2], names[1], ...names.slice(3)];
    await expect(rows()).toHaveText(draggedOrder);
    await rows().nth(1).press('Alt+ArrowDown');
    await expect(rows()).toHaveText(names);
    await expect(rows().nth(2)).toBeFocused();
    await rows().nth(1).press('Alt+ArrowUp');
    const manualOrder = [names[1], names[0], ...names.slice(2)];
    await expect(rows()).toHaveText(manualOrder);

    await settings().click();
    await expect(toggle()).not.toBeChecked();
    await back().click();
    await page.getByRole('button', { name: '服务管理', exact: true }).click();
    await expect(page.locator('.entity-list .entity-name')).toHaveText(names);
    await page.getByRole('button', { name: '部署目标', exact: true }).click();
    await expect(page.getByRole('combobox', { name: '筛选服务' }).locator('option')).toHaveText(names);

    await app.close();
    app = await start();
    page = await app.firstWindow();
    await expect(rows()).toHaveText(manualOrder);
    await settings().click();
    await expect(toggle()).not.toBeChecked();
  } finally {
    await app.close().catch(() => {});
    if (path.dirname(data) === root) await fs.rm(data, { recursive: true, force: true });
  }
});
