import { expect, test, _electron as electron } from '@playwright/test';
import ssh2 from 'ssh2';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
import { runProcess } from '../electron/process';
import { expectViewport } from './window-size';

const distro = process.env.DEPLOY_CENTER_IMAGE_TEST_WSL;
test.skip(process.platform !== 'win32' || !distro, '需指定本机 WSL 发行版来执行真实只读日志命令');

test('服务工作台与目标快捷入口共享日志界面，通过回环 SSH 跟随、搜索、下载', async ({}, info) => {
  test.setTimeout(120_000);
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'online-e2e-'));
  const fixture = path.join(dir, "app's log.log");
  const destination = path.join(dir, '原始应用日志.log');
  const secret = 'fixture-secret-online-only';
  const line = '[ERROR] sync-orders ' + secret;
  const text = '启动完毕\r\n' + line + '\r\n请求已返回\r\n';
  await writeFile(fixture, text);
  const wsl = (args: string[]) =>
    runProcess('wsl.exe', ['-d', distro!, '--exec', ...args], {
      encoding: 'utf8',
      env: { ...process.env, WSL_UTF8: '1' },
      timeout: 25_000,
    });
  const wslFile = await wsl(['wslpath', '-a', '-u', fixture]);
  expect(wslFile.code).toBe(0);
  const file = wslFile.stdout.trim();
  const key = ssh2.utils.generateKeyPairSync('ed25519').private;
  const commands: string[] = [];
  let sendLine: ((text: string) => void) | undefined;
  const server = new ssh2.Server({ hostKeys: [key] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) =>
      ctx.method === 'password' && ctx.password === secret ? ctx.accept() : ctx.reject(),
    );
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('exec', (accept, _reject, info) => {
          const command = info.command;
          commands.push(command);
          const stream = accept();
          stream.on('error', () => {});
          stream.on('data', () => {});
          stream.on('end', () => {
            if (command.startsWith('LC_ALL=C tail -n 200 -F -- ')) {
              sendLine = (value) => {
                stream.write(value);
              };
              stream.write(text);
              return;
            }
            if (!/^(LC_ALL=C (stat -Lc |bash -c )|test -f )/.test(command)) {
              stream.exit(126);
              stream.end();
              return;
            }
            void wsl(['bash', '-c', command])
              .then((result) => {
                stream.write(result.stdout);
                stream.stderr.write(
                  result.stderr
                    .split(/\r?\n/)
                    .filter((row) => !row.startsWith('wsl:'))
                    .join('\n'),
                );
                stream.exit(result.code);
                stream.end();
              })
              .catch(() => {
                stream.exit(1);
                stream.end();
              });
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const env = {
    ...process.env,
    DEPLOY_CENTER_DATA_DIR: path.join(dir, 'data'),
    DEPLOY_CENTER_TESTING: '1',
  };
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
    const db = emptyDatabase();
    const service = {
      ...newService(),
      id: 'log-service',
      code: 'log-service',
      name: '日志验收服务',
      root: dir,
    };
    const target = {
      ...newTargetTemplate(service.id, 'log-server'),
      id: 'log-target',
      name: '正式日志目标',
      appLogPath: file,
      directory: '/opt/fixture',
      production: true,
      start: 'true',
    };
    db.services = [service];
    db.targets = [
      target,
      { ...target, id: 'unconfigured-log', name: '待配置目标', appLogPath: '' },
    ];
    db.servers = [
      {
        id: 'log-server',
        name: '回环夹具',
        host: '127.0.0.1',
        port: (server.address() as AddressInfo).port,
        user: 'fixture',
        auth: 'password',
        alias: '',
        keyPath: '',
        note: '',
        credentialMode: 'ask',
      },
    ];
    db.lastService = service.id;
    db.history = [];
    await page.evaluate((input) => window.deployCenter!.save(input), db);
    await page.reload();
    await expect(page.getByRole('tab', { name: '日志', exact: true })).toBeVisible();
    await button('查看线上日志 · 正式日志目标').click();
    await expect(page.getByText('正式环境 · 只读', { exact: true })).toBeVisible();
    await expect(page.getByText(/回环夹具 · 127\.0\.0\.1/)).toBeVisible();
    await button('连接日志').click();
    await page.getByLabel('登录密码', { exact: true }).fill(secret);
    await page
      .getByRole('dialog', { name: '连接日志' })
      .getByRole('button', { name: '连接', exact: true })
      .click();
    await button('信任并继续').click();
    const rawLine = page.getByText(line, { exact: true });
    await expect(rawLine).toBeVisible();
    await button('暂停跟随').click();
    sendLine!('实时新输出\n');
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const [session] = await window.deployCenter!.listOnlineLogSessions();
          return (await window.deployCenter!.readLogSession(session.id)).chunks
            .map((chunk) => chunk.text)
            .join('');
        }),
      )
      .toContain('实时新输出');
    await expect(page.getByText('实时新输出', { exact: true })).toHaveCount(0);
    await button('跳到最新').click();
    await expect(page.getByText('实时新输出', { exact: true })).toBeVisible();
    await button('继续跟随').click();
    await page.getByRole('textbox', { name: '过滤已加载日志' }).fill('sync-orders');
    await expect(rawLine).toBeVisible();
    await expect(page.getByText('启动完毕', { exact: true })).toHaveCount(0);
    await page.getByRole('textbox', { name: '过滤已加载日志' }).clear();

    for (const [width, height] of [
      [1000, 620],
      [1280, 800],
      [1600, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
        [width, height],
      );
      await expectViewport(page, width, height);
      const workspace = page.locator('.online-log-workspace');
      expect(await workspace.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      const log = (await page.getByRole('log', { name: '应用日志内容' }).boundingBox())!;
      expect(log.height).toBeGreaterThan(200);
      expect(log.y + log.height).toBeLessThanOrEqual(height);
      await page.screenshot({ path: info.outputPath('线上日志-' + width + '.png') });
    }

    await button('服务器历史').click();
    await page.getByRole('textbox', { name: '服务器历史搜索' }).fill('sync-orders');
    await button('搜索').click();
    await expect(page.getByText('1 条命中 · 范围内未截断')).toBeVisible();
    await page.getByText('范围内第 2 行').click();
    await expect(page.locator('.online-log-results pre')).toContainText(line);
    await expect(page.locator('.online-log-results pre')).toContainText('请求已返回');
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, destination);
    await button('下载完整日志').click();
    const download = page.getByRole('dialog', { name: '下载完整日志' });
    await expect(download.getByText('服务器日志大小', { exact: false })).toBeVisible();
    await expect(download.getByText('日志按服务器原文保存。')).toBeVisible();
    await download.getByRole('button', { name: '选择保存位置' }).click();
    await expect(page.getByText('完整日志已保存。')).toBeVisible();
    expect(await readFile(destination, 'utf8')).toBe(text);
    expect(
      commands.filter((command) => command.startsWith('LC_ALL=C tail -n 200 -F')),
    ).toHaveLength(1);
    expect(commands.join('\n')).not.toMatch(/\b(?:mkdir|systemctl|docker restart)\b/);

    await page.getByRole('combobox', { name: '日志目标' }).selectOption('unconfigured-log');
    await expect(button('配置日志路径')).toBeVisible();
    await button('配置日志路径').click();
    await expect(
      page.getByRole('textbox', { name: '应用日志绝对路径', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await button('部署目标').click();
    await button('线上日志').first().click();
    await expect(
      page.getByRole('dialog', { name: '线上日志' }).getByRole('region', { name: '线上应用日志' }),
    ).toBeVisible();
    await button('断开').click();
    await expect(button('重新连接')).toBeVisible();
  } finally {
    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (path.dirname(dir) === base && path.basename(dir).startsWith('online-e2e-'))
      await rm(dir, { recursive: true, force: true });
  }
});
