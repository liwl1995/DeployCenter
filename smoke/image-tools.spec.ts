import { test, expect, _electron as electron } from '@playwright/test';
import { ZipWriter, BlobWriter, TextReader } from '@zip.js/zip.js';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../electron/process';

const distro = process.env.DEPLOY_CENTER_IMAGE_TEST_WSL;
test.skip(process.platform !== 'win32' || !distro, '需指定启用 Docker Engine 的 WSL 验收环境');

test('Windows 界面通过 WSL 构建 Docker 镜像、实时查看日志并导出本机镜像包', async ({}, info) => {
  test.setTimeout(300_000);
  const base = path.resolve('.test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(path.join(base, 'image-e2e-'));
  const project = path.join(dir, '中文 Project');
  const data = path.join(dir, 'Data');
  const name = 'yotoo-fixture-' + path.basename(dir).toLowerCase();
  const reference = name + ':smoke';
  const cancelledReference = name + ':cancel-smoke';
  await mkdir(project);
  const jar = new ZipWriter(new BlobWriter());
  await jar.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\n'));
  const pickedJar = path.join(project, 'picked archive.jar');
  await writeFile(pickedJar, Buffer.from(await (await jar.close()).arrayBuffer()));
  await writeFile(
    path.join(project, 'Dockerfile'),
    'FROM scratch\nARG YOTOO_JAR_FILE\nCOPY ["${YOTOO_JAR_FILE}", "/test.jar"]\n',
  );
  const env = { ...process.env, DEPLOY_CENTER_DATA_DIR: data, DEPLOY_CENTER_TESTING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath:
      process.env.DEPLOY_CENTER_TEST_EXE || path.resolve('node_modules/electron/dist/electron.exe'),
    args: process.env.DEPLOY_CENTER_TEST_EXE ? [] : [path.resolve('.')],
    env: env as Record<string, string>,
  });
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '服务管理', exact: true }).click();
    await page.getByRole('button', { name: '添加服务', exact: true }).click();
    await page.getByLabel('服务名称', { exact: true }).fill('测试镜像服务');
    await page.getByLabel('服务标识', { exact: true }).fill('fixture');
    await page.getByLabel('项目根目录', { exact: true }).fill(project);
    await page.getByLabel('产物目录', { exact: true }).fill('.');
    await page.getByLabel('本地 JAR 文件名', { exact: true }).fill('test.jar');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.deployCenter!.load())).database.services.length,
      )
      .toBe(1);
    await page.getByRole('button', { name: '镜像工具', exact: true }).click();
    await expect(page.getByRole('heading', { name: '构建配置' })).toBeVisible();
    await page.getByLabel('WSL 发行版', { exact: true }).selectOption(distro!);
    await expect(page.getByRole('button', { name: '浏览… Dockerfile', exact: true })).toHaveText(
      '浏览…',
    );
    await expect(page.getByRole('button', { name: '浏览… 构建目录', exact: true })).toHaveText(
      '浏览…',
    );
    await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toHaveCount(0);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, pickedJar);
    await page.getByRole('button', { name: '选择本地 JAR', exact: true }).click();
    await expect(page.locator('.image-artifact strong')).toHaveText('picked archive.jar');
    await page.getByLabel('镜像名', { exact: true }).fill(name);
    await page.getByLabel('版本标签', { exact: true }).fill('smoke');
    await page.getByRole('button', { name: '构建并导出' }).click();
    await page
      .getByRole('group', { name: '镜像任务状态筛选' })
      .getByRole('button', { name: '全部' })
      .click();
    const row = page.getByRole('row', { name: /查看镜像任务/ }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('heading', { name: '测试镜像服务 · 镜像构建' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toBeVisible();
    await expect
      .poll(
        async () => {
          const state = await page.evaluate(() => window.deployCenter!.listImageJobs());
          return state.jobs[0]?.status === 'failed' ? state.jobs[0].message : state.jobs[0]?.status;
        },
        { timeout: 230_000 },
      )
      .toBe('success');
    await expect(page.getByText('镜像包已生成', { exact: false }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: '导入到服务器' })).toHaveCount(0);
    const { jobs } = await page.evaluate(() => window.deployCenter!.listImageJobs());
    expect(jobs[0].stages.every((step) => step.status === 'success')).toBeTruthy();
    expect(jobs[0].archive?.reference).toBe(reference);
    expect(jobs[0].archive?.path).toMatch(/Data[\\/]images/);
    expect((await stat(jobs[0].archive!.path)).size).toBeGreaterThan(1024);
    await page.screenshot({ path: info.outputPath('镜像构建日志.png') });
    await page.getByRole('button', { name: '返回镜像包' }).click();
    await page
      .getByRole('table', { name: '镜像包列表' })
      .filter({ has: page.getByRole('button', { name: '导入到服务器' }) })
      .getByRole('button', { name: '导入到服务器' })
      .click();
    await page.getByRole('button', { name: '镜像包信息' }).click();
    await expect(
      page.getByRole('dialog', { name: '镜像包信息' }).getByText(reference, { exact: true }),
    ).toBeVisible();

    // 静态小程序让构建停在实际的 RUN 指令，不依赖拉取远端基础镜像。
    const wsl = (args: string[]) => runProcess('wsl.exe', ['-d', distro!, '--exec', ...args], {
      encoding: 'utf8', env: { ...process.env, WSL_UTF8: '1' }, timeout: 25_000,
    });
    const compiler = await wsl(['sh', '-c', 'command -v gcc']);
    if (compiler.code === 0) {
      await page.keyboard.press('Escape');
      const mapped = await wsl(['wslpath', '-a', '-u', project]);
      expect(mapped.code).toBe(0);
      const root = mapped.stdout.trim();
      await writeFile(path.join(project, 'wait.c'), '#include <unistd.h>\nint main(void) { sleep(180); return 0; }\n');
      const compile = await wsl(['gcc', '-static', root + '/wait.c', '-o', root + '/wait']);
      expect(compile.code, compile.stderr).toBe(0);
      await writeFile(
        path.join(project, 'Dockerfile'),
        'FROM scratch\nARG YOTOO_JAR_FILE\nCOPY ["\${YOTOO_JAR_FILE}", "/test.jar"]\nCOPY wait /wait\nRUN ["/wait"]\n',
      );
      const tabs = page.getByRole('tablist', { name: '镜像工具' });
      await tabs.getByRole('tab', { name: '构建镜像包' }).click();
      await page.getByLabel('WSL 发行版', { exact: true }).selectOption(distro!);
      await page.getByRole('button', { name: '选择本地 JAR', exact: true }).click();
      await page.getByLabel('镜像名', { exact: true }).fill(name);
      await page.getByLabel('版本标签', { exact: true }).fill('cancel-smoke');
      await page.getByRole('button', { name: '构建并导出' }).click();
      const pending = page.getByRole('row', { name: /测试镜像服务/ }).first();
      await expect(pending.getByRole('button', { name: '取消构建' })).toBeVisible();
      await expect.poll(async () => {
        const { jobs } = await page.evaluate(() => window.deployCenter!.listImageJobs());
        const log = await page.evaluate((id) => window.deployCenter!.readImageLogs(id), jobs[0].id);
        return log.map((chunk) => chunk.text).join('');
      }, { timeout: 45_000 }).toContain('RUN ["/wait"]');
      await pending.getByRole('button', { name: '取消构建' }).click();
      await expect.poll(async () => {
        const { jobs } = await page.evaluate(() => window.deployCenter!.listImageJobs());
        return jobs[0].status;
      }, { timeout: 15_000 }).toBe('cancelled');
      const { jobs: after } = await page.evaluate(() => window.deployCenter!.listImageJobs());
      expect(after[0].archive).toBeUndefined();
      const output = await page.evaluate((id) => window.deployCenter!.readImageLogs(id), after[0].id);
      expect(output.map((chunk) => chunk.text).join('')).toContain('镜像构建已取消');
    }
  } finally {
    await app.close();
    await runProcess('wsl.exe', ['-d', distro!, '--exec', 'docker', 'image', 'rm', reference, cancelledReference], {
      timeout: 15_000,
    }).catch(() => {});
    if (dir.startsWith(base + path.sep)) await rm(dir, { recursive: true, force: true });
  }
});
