// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const compiler =
  process.env.DEPLOY_CENTER_NSIS ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe',
  );
const enabled = process.platform === 'win32' && existsSync(compiler);
const base = path.resolve('.test-data');
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试范围越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it.skipIf(!enabled).each([false, true])(
  'NSIS 安装路径跟随中文配置目录，拒绝联接（联接：%s）',
  async (linked) => {
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'installer-paths-'));
    dirs.push(root);
    const actual = path.join(root, '真实 中文 数据'),
      chosen = linked ? path.join(root, 'link') : actual;
    await fs.mkdir(actual);
    await fs.writeFile(
      path.join(actual, '.yotoo-data-owner.ini'),
      '[application]\r\nid=local.deploycenter.desktop\r\n',
    );
    if (linked) await fs.symlink(actual, chosen, 'junction');
    const key = 'Software\\YOTOO\\DeployCenter.Tests\\' + randomUUID(),
      exe = path.join(root, 'check.exe'),
      result = path.join(root, 'result.txt');
    const build = spawnSync(
      compiler,
      [
        '/V2',
        '/WX',
        '/DPROJECT_DIR=' + path.resolve('.'),
        '/DOUTPUT_FILE=' + exe,
        '/DRESULT_FILE=' + result,
        '/DCASE_DIR=' + chosen,
        '/DYOTOO_LOCATION_KEY=' + key,
        path.resolve('installer/test-data-paths.nsi'),
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    expect(build.status, build.stdout + build.stderr).toBe(0);
    try {
      const run = spawnSync(exe, [], { windowsHide: true, timeout: 15000 });
      if (linked) {
        expect(run.status).toBe(1603);
        expect(existsSync(result)).toBe(false);
      } else {
        expect(run.status).toBe(0);
        const paths = (await fs.readFile(result))
          .toString('utf16le')
          .replace(/^\uFEFF/, '')
          .split('\r\n');
        expect(paths).toEqual([
          actual,
          path.join(actual, 'logs', 'installer'),
          path.join(actual, 'installer-backups'),
          path.join(actual, 'Control'),
        ]);
      }
    } finally {
      if (!/^Software\\YOTOO\\DeployCenter\.Tests\\[a-f0-9-]{36}$/.test(key))
        throw new Error('测试注册表范围越界');
      spawnSync(
        path.join(process.env.SystemRoot!, 'System32/reg.exe'),
        ['delete', 'HKCU\\' + key, '/f'],
        { windowsHide: true },
      );
    }
  },
);
