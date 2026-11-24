// @vitest-environment node
import { it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Windows 系统 .NET Framework 原生夹具在其他平台明确跳过，跨平台启动参数和失败保护另有测试。
it.skipIf(process.platform !== 'win32').each([
  ['node', false],
  ['electron', false],
  ['node', true],
] as const)(
  '真实独立助手等待 %s 退出后交接，并复核产物（篡改：%s）',
  async (runtime, tampered) => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, 'update-entry-'));
    const file = path.join(dir, "中文 空格 ' $安装器.cmd");
    const marker = path.join(dir, 'launched.txt');
    const payload = Buffer.from('@echo off\r\necho launched>"%~dp0launched.txt"\r\n', 'ascii');
    await fs.writeFile(file, payload);
    // 同一 C# 实现，仅隔离产品进程名和失败弹窗；仍实测等待、校验与启动，避免干扰正式程序。
    const source = path.join(dir, 'UpdateHelper.cs');
    await fs.writeFile(
      source,
      (await fs.readFile('installer/UpdateHelper.cs', 'utf8'))
        .replace('"YOTOO 部署中心", "Deploy Center"', JSON.stringify('DC-' + path.basename(dir)))
        .replace(
          'MessageBox.Show(message, "YOTOO 部署中心 更新失败", MessageBoxButtons.OK, MessageBoxIcon.Error)',
          'File.AppendAllText(log, " [测试记录安装失败提示]")',
        ),
    );
    const helper = path.join(dir, 'update-helper.exe');
    execFileSync(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
      ),
      ['/nologo', '/target:exe', '/reference:System.Windows.Forms.dll', '/out:' + helper, source],
      { windowsHide: true },
    );
    const { build } = await import('esbuild');
    const entry = path.join(dir, 'parent.cjs');
    await build({
      stdin: {
        contents: `import { existsSync } from 'node:fs';
import { launchInstallerAfterExit } from ${JSON.stringify(path.resolve('electron/update-installer.ts'))};
${runtime === 'electron' ? `import { app } from 'electron'; app.setPath('userData', ${JSON.stringify(path.join(dir, 'electron-data'))});` : ''}
(async () => {
${runtime === 'electron' ? 'await app.whenReady();' : ''}
await launchInstallerAfterExit(${JSON.stringify(file)}, ${JSON.stringify(createHash('sha256').update(payload).digest('hex'))}, ${JSON.stringify(path.join(dir, "中文 空格 ' $目录"))}, ${JSON.stringify(dir)}, ${JSON.stringify(helper)}, ${JSON.stringify(path.join(dir, 'Runtime'))});
console.log('PARENT_READY');
setInterval(() => { if (existsSync(${JSON.stringify(path.join(dir, 'exit-parent'))})) ${runtime === 'electron' ? 'app.quit()' : 'process.exit(0)'}; }, 50);
})().catch(error => { console.error(error); process.exit(1); });`,
        resolveDir: process.cwd(),
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: entry,
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const executable: string =
      runtime === 'electron'
        ? createRequire(path.resolve('package.json'))('electron')
        : process.execPath;
    const parent = spawn(executable, [entry], {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finished = once(parent, 'exit');
    let errors = '';
    parent.stderr.on('data', (data) => {
      errors += String(data);
    });
    let completed = false;
    try {
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('正式启动函数未就绪：' + errors)), 20000);
        const earlyExit = () => {
          clearTimeout(timer);
          reject(new Error('父进程提前退出：' + errors));
        };
        parent.once('exit', earlyExit);
        parent.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        parent.stdout.on('data', (data) => {
          output += String(data);
          if (output.includes('PARENT_READY')) {
            clearTimeout(timer);
            parent.off('exit', earlyExit);
            resolve();
          }
        });
      });
      expect(
        await fs
          .stat(marker)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);
      if (tampered) await fs.appendFile(file, '\r\nREM changed after ready');
      await fs.writeFile(path.join(dir, 'exit-parent'), 'exit');
      expect((await finished)[0], errors).toBe(0);
      if (tampered) {
        await expect
          .poll(
            async () => fs.readFile(path.join(dir, 'update-install.log'), 'utf8').catch(() => ''),
            { timeout: 10000 },
          )
          .toContain('[测试记录安装失败提示]');
        expect(await fs.readFile(path.join(dir, 'update-install.log'), 'utf8')).toContain(
          '安装包校验失败',
        );
        expect(
          await fs
            .stat(marker)
            .then(() => true)
            .catch(() => false),
        ).toBe(false);
      } else {
        await expect
          .poll(async () => fs.readFile(marker, 'utf8').catch(() => ''), { timeout: 10000 })
          .toContain('launched');
      }
      completed = true;
    } finally {
      if (parent.exitCode === null) parent.kill();
      if (path.dirname(dir) !== base) throw new Error('测试目录越界');
      // 失败时保留本夹具现场，避免删掉仍在读取的文件。
      if (completed)
        await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  40000,
);
