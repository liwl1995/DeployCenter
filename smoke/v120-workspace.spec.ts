import Sqlite from 'better-sqlite3';
import { Storage } from '../electron/storage';
import { createTask } from '../src/engine';
import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { emptyDatabase, newService, newTargetTemplate } from '../src/defaults';
test.skip(process.platform !== 'win32', 'Windows 桌面及 .exe 验收仅在 Windows 运行');
let app: ElectronApplication, dir: string;
test.beforeEach(async () => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  dir = await fs.mkdtemp(path.join(base, 'v120-workspace-'));
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: dir, DEPLOY_CENTER_TESTING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await fs.writeFile(
    path.join(dir, 'test.jar'),
    Buffer.from(await (await writer.close()).arrayBuffer()),
  );
  const localHash = createHash('sha256')
    .update(await fs.readFile(path.join(dir, 'test.jar')))
    .digest('hex');
  const db = emptyDatabase(),
    service = newService();
  service.id = 'workspace-smoke';
  service.name = '中文空格项目';
  service.root = dir;
  service.jarDir = '.';
  service.jarName = 'test.jar';
  db.services = [service];
  db.lastService = service.id;
  db.servers = [
    {
      id: 'offline',
      name: '仅配置不连接',
      auth: 'alias',
      alias: 'fixture-do-not-connect',
      host: '',
      port: 22,
      user: '',
      keyPath: '',
      note: '本测试不连接服务器',
      credentialMode: 'ask',
    },
  ];
  db.targets = Array.from({ length: 4 }, (_, i) => ({
    ...newTargetTemplate(service.id, 'offline'),
    id: 'target-' + i,
    name: '环境' + i,
    production: i === 3,
    directory: '/fixture/中文 空格目录/' + i,
    start: './test.jar start',
    currentHash: localHash,
    currentCommit: 'b'.repeat(40),
    version: 'b'.repeat(40),
    healthState: '未配置健康检查',
  }));
  db.lastTargets = [db.targets[0].id];
  const store = new Storage(dir, {
    encrypt: async () => { throw new Error('界面夹具不写入凭据'); },
    decrypt: async () => { throw new Error('界面夹具不读取凭据'); },
  });
  store.saveConfig(db);
  store.close();
  app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: [
      ...(process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')]),
      ...(process.env.DEPLOY_CENTER_TEST_SCALE
        ? ['--force-device-scale-factor=' + process.env.DEPLOY_CENTER_TEST_SCALE]
        : []),
    ],
    env: env as Record<string, string>,
  });
  if (process.env.DEPLOY_CENTER_TEST_SCALE) {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(
      Number(process.env.DEPLOY_CENTER_TEST_SCALE),
    );
  }
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: '准备好，发布下一版本' })).toBeVisible();

});
test.afterEach(async () => {
  await app?.close();
  if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('越界');
  await fs.rm(dir, { recursive: true, force: true });
});
test('全部页面在三个宽度和两种主题下无横向溢出，真实边界始终可见', async () => {
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1000, 1280, 1600]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
        width,
      );
      for (const name of [
        '一键部署',
        '部署历史',
        '服务管理',
        '部署目标',
        '服务器',
        '构建环境',
        '设置',
      ]) {
        await nav.getByRole('button', { name, exact: true }).click();
        if (name === '一键部署')
          await expect(page.locator('.badge').filter({ hasText: '未选择 JDK' })).toBeVisible();
        await expect(page.getByText('真实部署 · 请核对目标', { exact: true })).toBeVisible();
        if (theme === 'dark' && width === 1000 && name === '一键部署')
          await page.screenshot({
            path: test
              .info()
              .outputPath('v120-deploy.png'),
            fullPage: true,
          });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          name + ':' + width + ':' + theme,
        ).toBe(true);
      }
    }
  }
  expect(errors).toEqual([]);
});
test('批次 2 默认紧凑目标与配置详情在三个窗口尺寸下可见', async () => {
  const page = await app.firstWindow();
  const nav = page.getByRole('navigation', { name: '主导航' });
  const main = page.getByRole('main');
  const captures = process.env.DEPLOY_CENTER_BATCH2_SCREENSHOTS;
  if (captures) await fs.mkdir(captures, { recursive: true });
  for (const [width, height] of [[1000, 620], [1280, 800], [1600, 900]]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
      [width, height],
    );
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([width, height]);
    const noOverflow = async () => {
      expect(await main.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    };
    await nav.getByRole('button', { name: '一键部署', exact: true }).click();
    await expect(page.getByRole('switch', { name: '紧凑目标列表', exact: true })).toBeChecked();
    const rows = page.locator('.target-compact');
    await expect(rows).toHaveCount(4);
    await expect(page.locator('.target-card')).toHaveCount(0);
    const first = rows.first();
    await first.scrollIntoViewIfNeeded();
    await expect(first).toBeInViewport({ ratio: 1 });
    const firstRow = (await first.boundingBox())!;
    expect(firstRow.height).toBeLessThanOrEqual(80);
    const footer = (await page.getByRole('contentinfo', { name: '应用状态' }).boundingBox())!;
    expect(firstRow.y + firstRow.height).toBeLessThanOrEqual(footer.y + 1);
    await noOverflow();
    await page.screenshot({
      path: path.join(captures ?? test.info().outputDir, 'deploy-' + width + 'x' + height + '.png'),
    });

    await nav.getByRole('button', { name: '部署目标', exact: true }).click();
    const filter = page.getByLabel('筛选服务');
    await expect(filter).toBeInViewport({ ratio: 1 });
    expect((await filter.boundingBox())!.width).toBeLessThanOrEqual(320);
    await page.getByRole('button', { name: '查看部署目标环境0详情', exact: true }).click();
    const health = page.getByText('健康检查', { exact: true });
    const readiness = page.getByText('启动等待 / 就绪窗口', { exact: true });
    await expect(health).toBeVisible();
    await expect(readiness).toBeVisible();
    expect((await health.boundingBox())!.y).toBe((await readiness.boundingBox())!.y);
    await expect(readiness.locator('..')).toContainText('不适用');
    await readiness.locator('..').scrollIntoViewIfNeeded();
    await expect(readiness.locator('..')).toBeInViewport({ ratio: 1 });
    const values = await page.locator('.configuration-group dd').evaluateAll((items) =>
      items.filter((item) => item.getClientRects().length).map((item) => {
        const style = getComputedStyle(item);
        return [style.fontSize, style.color];
      }),
    );
    expect(new Set(values.map(String)).size).toBe(1);
    await noOverflow();
    await page.screenshot({
      path: path.join(captures ?? test.info().outputDir, 'target-' + width + 'x' + height + '.png'),
    });
    await page.getByRole('button', { name: '返回列表', exact: true }).click();
  }
});

test('紧凑列表会持久化，自定义快捷键不切页，预设载入仍需确认', async () => {
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  await expect(page.getByRole('switch', { name: '紧凑目标列表', exact: true })).toBeChecked();
  await page.getByRole('switch', { name: '紧凑目标列表', exact: true }).uncheck();
  await page.getByRole('switch', { name: '紧凑目标列表', exact: true }).check();
  await expect(page.locator('.target-compact')).toHaveCount(4);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.deployCenter!.load())).database.settings.compactTargets,
    )
    .toBe(true);
  await page.getByRole('button', { name: '展开环境0详情' }).click();
  await expect(page.locator('.target-card')).toHaveCount(1);
  await page.getByText('部署预设', { exact: true }).first().click();
  await page.getByRole('button', { name: '保存当前选择', exact: true }).click();
  await page.getByLabel('预设名称').fill('只读夹具预设');
  await page.getByRole('button', { name: '保存预设', exact: true }).click();
  await expect
    .poll(
      async () => (await page.evaluate(() => window.deployCenter!.load())).database.presets?.length,
    )
    .toBe(1);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '载入', exact: true }).first().click();
  await expect(page.getByRole('dialog', { name: '确认部署' })).toBeVisible();
  expect((await page.evaluate(() => window.deployCenter!.load())).task).toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('.deployment-note > summary').click();
  const note = page.getByLabel('本次内容', { exact: true });
  await note.focus();
  await page.keyboard.press('Alt+1');
  await expect(page.getByRole('heading', { name: '准备好，发布下一版本' })).toBeVisible();
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  await expect(page.getByText('只读夹具预设', { exact: true })).toBeVisible();
});
test('拖入系统文件经过主进程完整JAR校验；相同指纹提示不会绕过确认', async () => {
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  const external = path.join(dir, '拖入 产物.jar');
  await fs.copyFile(path.join(dir, 'test.jar'), external);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'native-drop-fixture';
    document.body.append(input);
  });
  await page.locator('#native-drop-fixture').setInputFiles(external);
  await page.evaluate(() => {
    const file = (document.getElementById('native-drop-fixture') as HTMLInputElement).files![0],
      transfer = new DataTransfer();
    transfer.items.add(file);
    document
      .querySelector('.app')!
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
  });
  await page.locator('.build-details > summary').click();
  await expect(page.locator('.artifact')).toContainText('拖入 产物.jar');
  await expect(page.locator('.artifact')).toContainText('文件已读取');
  const invalid = path.join(dir, '非法.jar');
  await fs.writeFile(invalid, 'not a ZIP');
  await page.locator('#native-drop-fixture').setInputFiles(invalid);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(
      (document.getElementById('native-drop-fixture') as HTMLInputElement).files![0],
    );
    document
      .querySelector('.app')!
      .dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
  });
  await expect(page.getByRole('dialog', { name: '操作失败' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '一键部署', exact: true })
    .click();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  await page.getByText('部署预检明细', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '部署预检' }).locator('..').locator('..'),
  ).toContainText('与线上相同');
  await page.getByRole('button', { name: '部署', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认部署' })).toContainText(
    '与线上相同：JAR 指纹一致',
  );
  expect((await page.evaluate(() => window.deployCenter!.load())).task).toBeUndefined();
});

test('1.2.1 分类层级、详情工作区和提示横幅在实际桌面中可用', async () => {
  test.setTimeout(120000);
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1000, 1280, 1600]) {
      await app.evaluate(
        ({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].setSize(value, 900),
        width,
      );
      for (const name of [
        '一键部署',
        '服务管理',
        '部署目标',
        '服务器',
        '构建环境',
        '部署历史',
        '设置',
      ]) {
        await nav.getByRole('button', { name, exact: true }).click();
        if (name === '设置') {
          for (const tab of ['外观与提醒', '部署与构建', '数据与存储', '配置与帮助']) {
            await page.getByRole('tab', { name: tab, exact: true }).click();
            await expect(page.getByRole('tabpanel')).toBeVisible();
            const overflow = await page.locator('main').evaluate((main) =>
              [...main.querySelectorAll('button,input,select,textarea')]
                .filter((el) => {
                  const rect = el.getBoundingClientRect();
                  return (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    (rect.left < main.getBoundingClientRect().left - 1 ||
                      rect.right > window.innerWidth - 3)
                  );
                })
                .map((el) => el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 60)),
            );
            expect(overflow, name + '/' + tab + '/' + width + '/' + theme).toEqual([]);
            if (width === 1280)
              await page.screenshot({
                path: path.resolve('.test-data', 'v121-' + theme + '-设置-' + tab + '.png'),
                fullPage: true,
              });
          }
        }
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          name + '/' + width,
        ).toBe(true);
        if (width === 1280)
          await page.screenshot({
            path: path.resolve('.test-data', 'v121-' + theme + '-' + name + '.png'),
            fullPage: true,
          });
      }
    }
    // 使用真正的 notice 样式验证内边距、边框和主题背景，避免只检查类名。
    const notice = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'notice wide';
      el.textContent = '横幅检查';
      document.querySelector('main')!.prepend(el);
      const css = getComputedStyle(el),
        rect = el.getBoundingClientRect();
      const result = {
        padding: css.paddingTop,
        border: css.borderLeftWidth,
        background: css.backgroundColor,
        grid: css.gridColumn,
        right: rect.right,
        width: window.innerWidth,
      };
      el.remove();
      return result;
    });
    expect(notice.padding).toBe('16px');
    expect(notice.border).toBe('4px');
    expect(notice.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(notice.grid).toBe('1 / -1');
    expect(notice.right).toBeLessThanOrEqual(notice.width);
  }
  await nav.getByRole('button', { name: '部署目标', exact: true }).click();
  await expect(page.locator('.entity-card')).toHaveCount(4);
  await expect(page.locator('.entity-detail')).toHaveCount(0);
  await page.getByRole('textbox', { name: '搜索部署目标' }).fill('不存在');
  await expect(page.getByText('没有匹配项，请调整搜索内容。')).toBeVisible();
  await page.getByRole('textbox', { name: '搜索部署目标' }).fill('');
  await page.getByRole('button', { name: '查看部署目标环境2详情', exact: true }).click();
  await expect(page.locator('.entity-detail h2')).toContainText('环境2');
  await page.getByRole('button', { name: /更多目标环境2操作/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual((await page.evaluate(() => innerHeight)) + 1);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('1.2.4 确认弹窗首屏可操作，展开详情或滚动时底栏保持可见', async () => {
  const page = await app.firstWindow();
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('button', { name: '一键部署', exact: true })
    .click();
  await page.getByRole('button', { name: '使用现有 JAR', exact: true }).click();
  const launch = page.getByRole('button', { name: '部署', exact: true });
  for (const [width, height] of [[1280, 800], [1000, 620]]) {
    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
      [width, height],
    );
    await launch.click();
    const modal = page.getByRole('dialog', { name: '确认部署', exact: true });
    const body = modal.locator('.modal-content');
    const footer = modal.locator('.modal-footer');
    const confirm = footer.getByRole('button', { name: '部署', exact: true });
    const back = footer.getByRole('button', { name: '返回检查', exact: true });
    await expect(back).toBeFocused();
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await expect(back).toBeInViewport({ ratio: 1 });
    await expect(body).toContainText('远程文件');
    const metadata = body.locator('details').filter({ hasText: '产物与 Git 详情' });
    await expect(metadata).not.toHaveAttribute('open');
    await expect(metadata.getByText('文件已读取', { exact: true })).toBeHidden();
    await metadata.locator('summary').click();
    await expect(metadata.getByText('文件已读取', { exact: true })).toBeVisible();
    const before = await confirm.boundingBox();
    await body.evaluate((element) => {
      element.scrollTop = 0;
    });
    await body.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await confirm.boundingBox()).toEqual(before);
    await expect(confirm).toBeInViewport({ ratio: 1 });
    await confirm.focus();
    await page.keyboard.press('Tab');
    await expect(modal.getByRole('button', { name: '关闭弹窗' })).toBeFocused();
    await back.click();
    await expect(modal).toHaveCount(0);
    await expect(launch).toBeFocused();
  }
  expect((await page.evaluate(() => window.deployCenter!.load())).task).toBeUndefined();
});

test('1.2.4 全部收起恢复紧凑列表，卡片指纹与其他字段上下对齐', async () => {
  const page = await app.firstWindow();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  const compact = page.getByRole('switch', { name: '紧凑目标列表', exact: true });
  const collapse = page.getByRole('button', { name: '全部收起', exact: true });
  await expect(compact).toBeChecked();
  await expect(page.locator('.target-compact')).toHaveCount(4);
  await compact.uncheck();
  await expect(page.locator('.target-card')).toHaveCount(4);
  const positions = await page.locator('.target-card .target-facts').first().evaluate((el) => {
    const label = el.querySelector('.hash-value > span')!;
    const code = el.querySelector('.hash-value > code')!;
    const copy = el.querySelector('.hash-value > button')!;
    const top = (item: Element) => Math.round(item.getBoundingClientRect().top);
    return {
      label: top(label),
      code: top(code),
      copy: top(copy),
      deployed: top(el.children[1]),
      fingerprint: label.textContent,
    };
  });
  expect(positions.fingerprint).toBe('JAR 指纹');
  expect(positions.label).toBe(positions.deployed);
  expect(positions.code).toBeGreaterThan(positions.label);
  expect(positions.copy).toBeGreaterThan(positions.label);
  await collapse.click();
  await expect(compact).toBeChecked();
  await expect(page.locator('.target-compact')).toHaveCount(4);
  await page.getByRole('button', { name: '展开环境0详情', exact: true }).click();
  await expect(page.locator('.target-card')).toHaveCount(1);
  await collapse.click();
  await expect(page.locator('.target-card')).toHaveCount(0);
  await expect
    .poll(async () => (await page.evaluate(() => window.deployCenter!.load())).database.settings.compactTargets)
    .toBe(true);
  await page.reload();
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  await expect(page.locator('.target-compact')).toHaveCount(4);
});

test('1.2.2 固定外壳在最小窗口中保持页脚可见、导航可操作、分组标题不被覆盖', async () => {
  test.setTimeout(120000);
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const size of [
      [1000, 620],
      [1280, 800],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h),
        size,
      );
      for (const name of [
        '一键部署',
        '部署历史',
        '服务管理',
        '部署目标',
        '服务器',
        '构建环境',
        '设置',
      ]) {
        await nav.getByRole('button', { name, exact: true }).click();
        const before = await page.getByRole('contentinfo', { name: '应用状态' }).boundingBox();
        const view = await page.evaluate(() => ({
          width: innerWidth,
          height: innerHeight,
          y: scrollY,
        }));
        expect(before!.y + before!.height).toBeLessThanOrEqual(view.height + 1);
        expect(before!.y + before!.height).toBeGreaterThanOrEqual(view.height - 1);
        expect(view.y).toBe(0);
        await page.locator('.workspace > main').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        const after = await page.getByRole('contentinfo', { name: '应用状态' }).boundingBox();
        expect(after).toEqual(before);
        expect(await page.evaluate(() => scrollY)).toBe(0);
        expect(
          await page
            .locator('.sidebar')
            .evaluate((el) => Math.abs(el.getBoundingClientRect().height - innerHeight) < 2),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        if (size[0] === 1000 && name === '设置')
          await page.screenshot({
            path: path.resolve('.test-data', 'v122-' + theme + '-最小窗口.png'),
          });
      }
      for (const [group, name] of [
        ['操作', '一键部署'],
        ['配置', '服务管理'],
      ]) {
        await nav.getByText(group, { exact: true }).scrollIntoViewIfNeeded();
        await nav.getByRole('button', { name, exact: true }).hover();
        const title = await nav.getByText(group, { exact: true }).boundingBox(),
          button = await nav.getByRole('button', { name, exact: true }).boundingBox();
        expect(title!.y + title!.height).toBeLessThanOrEqual(button!.y);
      }
      expect(
        await page.locator('.brand > span:last-child').evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el.firstChild!);
          return range.getClientRects().length;
        }),
      ).toBe(1);
    }
  }
  await expect(nav.getByRole('button', { name: /快速前往/ })).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await app.evaluate(({ shell }) => {
    const state = globalThis as unknown as { openedDataPaths: string[] };
    state.openedDataPaths = [];
    shell.openPath = async (value) => {
      state.openedDataPaths.push(value);
      return '';
    };
  });
  await page.getByRole('button', { name: /数据目录：/ }).click();
  await expect
    .poll(() =>
      app.evaluate(() => (globalThis as unknown as { openedDataPaths: string[] }).openedDataPaths),
    )
    .toEqual([dir]);
});

test('1.2.2 部署首屏可见主要内容，数据页三块不折叠，迁移在独立向导中确认最终目录', async () => {
  const page = await app.firstWindow(),
    nav = page.getByRole('navigation', { name: '主导航' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  const main = page.locator('.workspace > main');
  expect(await main.evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.locator('.build-details').evaluate((el: HTMLDetailsElement) => el.open)).toBe(
    false,
  );
  for (const locator of [
    page.locator('.service-picker'),
    page.locator('.target-compact').first(),
    page.getByRole('button', { name: '部署', exact: true }),
    page.getByRole('button', { name: '试运行（远程只读）', exact: true }),
  ]) {
    const rect = await locator.boundingBox(),
      bounds = await main.boundingBox();
    expect(rect!.y).toBeGreaterThanOrEqual(bounds!.y);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height);
  }
  await expect(page.getByRole('heading', { name: '最近部署', exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.resolve('.test-data', 'v122-部署默认首屏.png') });
  await page
    .locator('.target-compact')
    .first()
    .getByRole('button', { name: '展开环境0详情' })
    .click();
  await nav.getByRole('button', { name: '服务管理', exact: true }).click();
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  await expect(page.locator('.target-card')).toHaveCount(1);
  await page.reload();
  await nav.getByRole('button', { name: '一键部署', exact: true }).click();
  await expect(page.locator('.target-card')).toHaveCount(1);
  await page.screenshot({ path: path.resolve('.test-data', 'v122-部署首屏.png') });
  await nav.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('tab', { name: '数据与存储', exact: true }).click();
  for (const name of ['存储占用与清理', '数据位置', '保留规则'])
    await expect(page.getByRole('heading', { name, exact: true })).toHaveCount(1);
  await expect(page.getByRole('tabpanel').locator('details')).toHaveCount(0);
  await expect(page.getByLabel('选择上级目录')).toHaveCount(0);
  await expect(
    page.getByRole('tabpanel').getByRole('button', { name: '使用说明', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '更换数据目录', exact: true }).click();
  await page.getByLabel('选择上级目录').fill(path.join(dir, '迁移父目录'));
  await expect(page.getByTestId('migration-final-path')).toHaveText(
    path.join(dir, '迁移父目录', 'DeployCenter'),
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 620));
  const modal = page.getByRole('dialog', { name: '更换数据目录' });
  await modal.locator('.modal-content').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const cancel = await modal.getByRole('button', { name: '取消', exact: true }).boundingBox();
  expect(cancel!.y + cancel!.height).toBeLessThan(await page.evaluate(() => innerHeight));
  await page.screenshot({ path: path.resolve('.test-data', 'v122-迁移向导.png') });
  // 此处只注入进度展示夹具，不发起迁移；实际文件复制和恢复由迁移用例覆盖。
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send('deploy:event', {
      kind: 'migration',
      progress: {
        state: 'copying',
        copied: 60 * 1024 * 1024,
        total: 100 * 1024 * 1024,
        files: 120,
        totalFiles: 200,
        message: '进度展示夹具：正在复制',
        currentFile: '日志/进度展示夹具-用于检查长文件名和窄窗口下的取消操作.log',
        bytesPerSecond: 10 * 1024 * 1024,
        remainingSeconds: 4,
      },
    }),
  );
  const stop = modal.getByRole('button', { name: '取消迁移，保留原目录', exact: true });
  await expect(stop).toBeVisible();
  await modal.locator('.modal-content').evaluate((el) => {
    el.scrollTop = 0;
  });
  const stopBox = await stop.boundingBox(),
    modalBox = await modal.boundingBox();
  expect(stopBox!.y).toBeGreaterThan(modalBox!.y);
  expect(stopBox!.y + stopBox!.height).toBeLessThan(modalBox!.y + modalBox!.height);
  await expect(modal.getByText(/预计剩余：4 秒/)).toBeVisible();
  await page.screenshot({ path: path.resolve('.test-data', 'v122-迁移进度展示.png') });
});
