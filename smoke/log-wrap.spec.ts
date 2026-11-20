import { test, expect, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import { createTask } from '../src/engine';
import { expectViewport } from './window-size';

test.skip(process.platform !== 'win32', '需要 Windows Electron 和隔离的本地历史');

test('日志按全局设置随窗口折行，列表更多操作在最后', async () => {
  test.setTimeout(60_000);
  const root = path.resolve('.test-data');
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'log-wrap-'));
  const service = { ...newService(), name: '日志验收', code: 'log-wrap', root: dir };
  const server = {
    id: 'log-wrap-server', name: '验收服务器', auth: 'alias' as const,
    alias: 'fixture-do-not-connect', host: '', port: 22, user: '', keyPath: '',
    note: '', credentialMode: 'ask' as const,
  };
  const target = {
    ...newTargetTemplate(service.id, server.id), name: '验收环境',
    directory: '/fixture/log-wrap', start: './service.jar start',
  };
  const db = emptyDatabase();
  db.services = [service];
  db.servers = [server];
  db.targets = [target];
  db.lastService = service.id;
  const task = createTask(db, service, [target], {}, 'existing');
  task.status = 'success';
  task.targets[0].status = 'success';
  task.endedAt = task.startedAt + 1000;
  task.note = '日志折行验收';
  const longLine = '长行日志 ' + 'x'.repeat(350);
  const storage = new Storage(dir, {
    encrypt: async () => { throw new Error('验收不使用凭据'); },
    decrypt: async () => { throw new Error('验收不使用凭据'); },
  });
  try {
    storage.saveConfig(db);
    storage.saveTask(task);
    storage.appendLog(task.id, '历史日志\n'.repeat(150) + longLine + '\n', target.id, {
      time: task.endedAt,
      step: '上传',
    });
  } finally {
    storage.close();
  }
  const exe = process.env.DEPLOY_CENTER_TEST_EXE;
  const app = await electron.launch({
    executablePath: exe || path.resolve('node_modules/electron/dist/electron.exe'),
    args: exe ? [] : [path.resolve('.')],
    env: { ...process.env, DEPLOY_CENTER_TESTING: '1', DEPLOY_CENTER_DATA_DIR: dir },
  });
  try {
    const page = await app.firstWindow();
    const resize = async (width: number) => {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 620), width);
      await expectViewport(page, width, 620);
    };
    const open = async (name: string) => page.getByRole('button', { name, exact: true }).click();
    const history = async () => {
      await open('部署历史');
      await page.getByRole('row', { name: '查看任务：日志折行验收' }).click();
      return page.getByRole('log', { name: '任务日志' });
    };
    await resize(1000);
    let logs = await history();
    const line = () => logs.getByText(longLine, { exact: true });
    await expect(line()).toBeVisible();
    await expect(logs).toHaveAttribute('data-wrap', 'false');
    await expect.poll(() => logs.evaluate((log) => log.scrollWidth - log.clientWidth)).toBeGreaterThan(0);

    await open('设置');
    await page.getByRole('switch', { name: '日志自动折行' }).click();
    await expect(page.getByRole('switch', { name: '日志自动折行' })).toBeChecked();
    await open('返回应用');
    logs = await history();
    await expect(logs).toHaveAttribute('data-wrap', 'true');
    await expect(page.getByRole('checkbox', { name: '自动折行' })).toHaveCount(0);
    await expect.poll(() => logs.evaluate((log) => log.scrollWidth - log.clientWidth)).toBeLessThanOrEqual(1);
    const narrowHeight = await line().evaluate((element) => element.offsetHeight);
    const narrowWidth = await line().evaluate((element) => element.offsetWidth);
    expect(narrowHeight).toBeGreaterThan(28);
    await resize(1280);
    await expect.poll(() => line().evaluate((element) => element.offsetWidth)).toBeGreaterThan(narrowWidth);
    await expect.poll(() => line().evaluate((element) => element.offsetHeight)).toBeLessThan(narrowHeight);
    await expect.poll(() => logs.evaluate((log) => log.scrollHeight - log.clientHeight - log.scrollTop)).toBeLessThanOrEqual(1);
    await expect(page.getByRole('checkbox', { name: '跟随最新' })).toBeChecked();

    for (const [name, middle] of [['服务管理', '去部署'], ['部署目标', '去部署'], ['服务器', '测试连接']]) {
      await open(name);
      await expect(page.locator('.entity-record .entity-actions button')).toHaveText(['编辑', middle, '更多']);
    }
  } finally {
    await app.close();
    if (path.dirname(dir) === root) await fs.rm(dir, { recursive: true, force: true });
  }
});
