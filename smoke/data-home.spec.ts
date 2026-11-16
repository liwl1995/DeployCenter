import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { emptyDatabase } from '../src/defaults';

test.skip(process.platform !== 'win32', '旧版 Windows 加密与运行资料转移只在 Windows 验收');
let root: string, running: ElectronApplication | undefined;
test.afterEach(async () => {
  await running?.close();
  running = undefined;
  if (root) {
    if (path.dirname(root) !== path.resolve('.test-data')) throw new Error('验收路径越界');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
test('旧版用户目录资料迁入配置目录，Windows 加密仍可解密且已下载文件不用重下', async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  root = await fs.mkdtemp(path.join(base, 'legacy-home-'));
  const actual = path.join(root, '已配置 中文 数据'),
    legacy = path.join(root, '旧用户目录', 'Settings'),
    fallback = path.join(root, '不应创建的默认目录');
  await fs.mkdir(actual, { recursive: true });
  await fs.mkdir(legacy, { recursive: true });
  const minimal = path.join(root, 'legacy-main.cjs');
  await fs.writeFile(
    minimal,
    `const {app,BrowserWindow}=require('electron');app.setName('YOTOO 部署中心');app.setAppUserModelId('local.deploycenter.desktop');app.setPath('userData',${JSON.stringify(legacy)});app.setPath('sessionData',${JSON.stringify(legacy)});app.whenReady().then(()=>{const win=new BrowserWindow({show:false});win.loadURL('data:text/html,<title>旧版加密夹具</title>');});app.on('window-all-closed',()=>app.quit());`,
  );
  const seedEnv = { ...process.env };
  delete seedEnv.ELECTRON_RUN_AS_NODE;
  running = await electron.launch({ args: [minimal], env: seedEnv });
  await running.firstWindow();
  const secret = 'legacy-dpapi-only-fixture';
  const encrypted = await running.evaluate(
    async ({ safeStorage }, secret) => [...(await safeStorage.encryptStringAsync(secret))],
    secret,
  );
  await running.close();
  running = undefined;
  const store = new Storage(actual, {
    encrypt: async () => Buffer.from(encrypted),
    decrypt: async () => secret,
  });
  const db = emptyDatabase();
  db.servers = [
    {
      id: 'legacy-saved',
      name: '仅加密夹具，不连接',
      auth: 'password',
      alias: '',
      host: '127.0.0.1',
      port: 1,
      user: 'fixture',
      keyPath: '',
      note: '',
      credentialMode: 'windows',
    },
  ];
  store.saveConfig(db);
  await store.saveCredential('legacy-saved', secret);
  await store.settle();
  store.close();
  await fs.writeFile(
    path.join(legacy, 'data-location.json'),
    JSON.stringify({ schema: 1, active: actual }),
  );
  await fs.mkdir(path.join(legacy, 'Updates', 'update-Legacy'), { recursive: true });
  const payload = Buffer.from('MZ legacy fixture never execute');
  await fs.writeFile(path.join(legacy, 'Updates', 'update-Legacy', 'setup.exe'), payload);
  const env = {
    ...process.env,
    DEPLOY_CENTER_DATA_DIR: fallback,
    DEPLOY_CENTER_SETTINGS_DIR: legacy,
    DEPLOY_CENTER_TESTING: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  running = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')],
    env,
  });
  const page = await running.firstWindow();
  const loaded = await page.evaluate(() => window.deployCenter!.load());
  expect(loaded.dataDir).toBe(actual);
  expect(loaded.savedCredentials).toContain('legacy-saved');
  const plaintext = await running.evaluate(
    async ({ safeStorage }, bytes) =>
      (await safeStorage.decryptStringAsync(Buffer.from(bytes))).result,
    encrypted,
  );
  expect(plaintext).toBe(secret);
  expect(await fs.stat(fallback).catch(() => undefined)).toBeUndefined();
  const positions = await running.evaluate(({ app }) =>
    Object.fromEntries(
      ['userData', 'sessionData', 'temp', 'crashDumps', 'logs'].map((name) => [
        name,
        app.getPath(name as 'userData'),
      ]),
    ),
  );
  for (const value of Object.values(positions))
    expect(value.startsWith(actual + path.sep)).toBe(true);
  const state = await page.evaluate(() => window.deployCenter!.updateState());
  expect(state.stage).toBe('cached');
  expect(state.cacheDirectory).toBe(path.join(actual, 'Updates'));
  expect(await fs.readFile(state.installerPath!)).toEqual(payload);
  expect(await fs.stat(path.join(legacy, 'Updates')).catch(() => undefined)).toBeUndefined();
  expect(await fs.stat(path.join(legacy, 'Local State')).catch(() => undefined)).toBeUndefined();
  expect(
    await fs.stat(path.join(actual, 'Control', 'legacy-startup-backup', 'profile', 'Local State')),
  ).toBeTruthy();
});
