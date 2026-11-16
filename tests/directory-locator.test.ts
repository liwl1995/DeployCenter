// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DirectoryLocator } from '../electron/data-paths';
const base = path.resolve('.test-data');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试范围越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it.skipIf(process.platform !== 'win32')(
  '原生注册表定位支持中文空格，只记录目录且开发与正式值隔离（独立测试键）',
  async () => {
    await fs.mkdir(base, { recursive: true });
    const dir = await fs.mkdtemp(path.join(base, 'locator-'));
    dirs.push(dir);
    const id = randomUUID(),
      key = 'Software\\YOTOO\\DeployCenter.Tests\\' + id;
    const source = path.join(dir, 'UpdateHelper.cs'),
      helper = path.join(dir, 'update-helper.exe');
    const content = (await fs.readFile('installer/UpdateHelper.cs', 'utf8')).replace(
      '"Software\\\\YOTOO\\\\DeployCenter"',
      JSON.stringify(key),
    );
    expect(content).not.toContain('CreateSubKey("Software\\\\YOTOO\\\\DeployCenter")');
    await fs.writeFile(source, content);
    execFileSync(
      path.join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
      ['/nologo', '/target:exe', '/reference:System.Windows.Forms.dll', '/out:' + helper, source],
      { windowsHide: true },
    );
    try {
      const prod = new DirectoryLocator(helper, false),
        dev = new DirectoryLocator(helper, true);
      expect(prod.read()).toBeUndefined();
      prod.write(path.join(dir, '正式 中文 空格'));
      dev.write(path.join(dir, '开发'));
      expect(prod.read()).toBe(path.join(dir, '正式 中文 空格'));
      expect(dev.read()).toBe(path.join(dir, '开发'));
      expect(() => prod.write(path.join(dir, 'x') + path.sep + '..')).toThrow();
    } finally {
      if (!/^Software\\YOTOO\\DeployCenter\.Tests\\[a-f0-9-]{36}$/.test(key))
        throw new Error('测试注册表范围越界');
      execFileSync(
        path.join(process.env.SystemRoot!, 'System32/reg.exe'),
        ['delete', 'HKCU\\' + key, '/f'],
        { windowsHide: true },
      );
    }
  },
);
