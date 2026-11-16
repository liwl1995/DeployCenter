// @vitest-environment node
import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const compiler =
  process.env.DEPLOY_CENTER_NSIS ||
  path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder/Cache/nsis-3.0.4.1/nsis-3.0.4.1-1mx3n/Bin/makensis.exe',
  );
it.skipIf(process.platform !== 'win32' || !existsSync(compiler))(
  '原生安装阶段不回退，插件重置不影响总体进度；详情计时器可收起且不遮挡首行',
  async () => {
    const base = path.resolve('.test-data');
    await fs.mkdir(base, { recursive: true });
    const root = await fs.mkdtemp(path.join(base, 'installer-progress-'));
    try {
      const exe = path.join(root, 'check.exe');
      const build = spawnSync(
        compiler,
        [
          '/INPUTCHARSET',
          'UTF8',
          '/V2',
          '/WX',
          '/DPROJECT_DIR=' + path.resolve('.'),
          '/DOUTPUT_FILE=' + exe,
          '/DCASE_DIR=' + root,
          'installer/test-progress.nsi',
        ],
        { windowsHide: true, encoding: 'utf8' },
      );
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const run = spawnSync(exe, [], { windowsHide: true, timeout: 15000 });
      expect(run.status, String(run.error)).toBe(0);
      expect(await fs.stat(path.join(root, 'passed.txt'))).toBeTruthy();
    } finally {
      if (path.dirname(root) !== base) throw new Error('测试目录越界');
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
