// @vitest-environment node
import { expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { installerArguments } from '../electron/update-installer';

it.skipIf(process.platform !== 'win32').each([
  ['success', 0, false],
  ['installer-failed', 3, false],
  ['tampered', 0, true],
] as const)('静默助手等待应用退出并在 %s 后重新打开应用', async (_case, installerExit, tamper) => {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'silent-update-'));
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const installer = path.join(dir, '安装器.exe');
  const oldApp = path.join(dir, path.basename(dir) + '.exe');
  const helper = path.join(dir, 'update-helper.exe');
  const log = path.join(dir, 'update-install.log');
  let parent: ReturnType<typeof spawn> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const compile = (source: string, output: string, extra: string[] = []) => {
      execFileSync(csc, ['/nologo', '/target:exe', '/out:' + output, ...extra, source], { windowsHide: true });
    };
    const appFile = path.join(dir, 'App.cs');
    const setupFile = path.join(dir, 'Setup.cs');
    await fs.writeFile(appFile, `
using System;
using System.IO;
[assembly: System.Reflection.AssemblyInformationalVersion("2.1.1")]
class App { public static void Main() { File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "reopened.txt"), "ok"); } }`);
    await fs.writeFile(setupFile, `
using System;
using System.IO;
class Setup { public static int Main() {
  File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer-args.txt"), Environment.CommandLine);
  return ${installerExit};
} }`);
    compile(appFile, oldApp);
    compile(setupFile, installer);
    compile(path.resolve('installer/UpdateHelper.cs'), helper, ['/reference:System.Windows.Forms.dll']);
    const digest = createHash('sha256').update(await fs.readFile(installer)).digest('hex');
    parent = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { windowsHide: true });
    const parentExit = once(parent, 'exit');
    const args = installerArguments(installer, digest, dir, log, parent.pid!);
    child = spawn(helper, [...args, '2.1.1', Buffer.from(oldApp).toString('base64')], { windowsHide: true });
    const childExit = once(child, 'exit');
    const output = createInterface({ input: child.stdout! });
    expect(await once(output, 'line')).toEqual(['UPDATE_READY']);
    await expect(fs.stat(path.join(dir, 'installer-args.txt'))).rejects.toThrow(/ENOENT/);
    if (tamper) await fs.appendFile(installer, 'tampered');
    parent.stdin!.end();
    expect((await parentExit)[0]).toBe(0);
    expect((await childExit)[0]).toBe(installerExit || tamper ? 1 : 0);
    await expect.poll(() => fs.readFile(path.join(dir, 'reopened.txt'), 'utf8').catch(() => '')).toBe('ok');
    if (tamper) await expect(fs.stat(path.join(dir, 'installer-args.txt'))).rejects.toThrow(/ENOENT/);
    else expect(await fs.readFile(path.join(dir, 'installer-args.txt'), 'utf8')).toContain('/S /YOTOOUPDATE /D=' + dir);
    if (installerExit || tamper) {
      expect(await fs.readFile(log, 'utf8')).toContain(tamper ? '安装包校验失败' : '安装程序退出码：3');
      expect(await fs.readFile(path.join(dir, 'last-update-error.txt'), 'utf8')).toContain('更新安装未完成');
    }
  } finally {
    if (parent?.exitCode === null) parent.kill();
    if (child?.exitCode === null) child.kill();
    if (path.dirname(dir) === base) await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 30_000);
