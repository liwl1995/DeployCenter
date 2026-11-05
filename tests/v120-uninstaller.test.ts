// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const cache = path.join(
  process.env.LOCALAPPDATA || '',
  'electron-builder',
  'Cache',
  'nsis-3.0.4.1',
);
const compiler =
  [
    process.env.DEPLOY_CENTER_NSIS || '',
    path.join(cache, 'Bin', 'makensis.exe'),
    ...(fs.existsSync(cache)
      ? fs.readdirSync(cache).map((name) => path.join(cache, name, 'Bin', 'makensis.exe'))
      : []),
  ].find((file) => file && fs.existsSync(file)) || '';
const enabled = process.platform === 'win32' && fs.existsSync(compiler);
if (!enabled)
  process.stderr.write(
    '[SKIP] NSIS 原生清理保护测试需要 Windows 和已缓存的 NSIS 编译器；不操作任何正式安装。\n',
  );
const created: string[] = [];
async function fixture() {
  const base = path.resolve('.test-data');
  await fsp.mkdir(base, { recursive: true });
  const root = await fsp.mkdtemp(path.join(base, 'nsis-data-'));
  created.push(root);
  return root;
}
afterEach(async () => {
  for (const dir of created.splice(0)) {
    if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试路径越界');
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
async function check(root: string, target: string, remove = false) {
  const exe = path.join(root, 'check.exe'),
    result = path.join(root, 'result.txt');
  const build = spawnSync(
    compiler,
    [
      '/V2',
      '/DPROJECT_DIR=' + path.resolve('.'),
      '/DOUTPUT_FILE=' + exe,
      '/DRESULT_FILE=' + result,
      '/DCASE_DIR=' + target,
      ...(remove ? ['/DREMOVE_FIXTURE'] : []),
      path.resolve('installer/test-data-cleanup.nsi'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (build.status !== 0) throw new Error(build.stdout + build.stderr);
  const run = spawnSync(exe, [], { windowsHide: true });
  if (run.error) throw run.error;
  return { result: await fsp.readFile(result, 'utf8'), code: run.status };
}
async function owned(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, '.yotoo-data-owner.ini'),
    '[application]\r\nid=local.deploycenter.desktop\r\n',
  );
  await fsp.writeFile(path.join(dir, 'deploy-center.sqlite'), 'fixture-only');
}
describe.skipIf(!enabled)('NSIS 自定义数据目录清理原生夹具（不安装、不写注册表）', () => {
  it('中文空格目录有归属标记时可清理，旁边文件保留', async () => {
    const root = await fixture(),
      dir = path.join(root, '中文 数据');
    await owned(dir);
    await fsp.writeFile(path.join(root, '保留.txt'), 'keep');
    expect(await check(root, dir, true)).toEqual({ result: 'ok', code: 0 });
    expect(fs.existsSync(dir)).toBe(false);
    expect(await fsp.readFile(path.join(root, '保留.txt'), 'utf8')).toBe('keep');
  }, 15000);
  it('拒绝无归属目录、磁盘根目录和带 .. 的路径', async () => {
    const root = await fixture(),
      dir = path.join(root, 'unowned');
    await fsp.mkdir(dir);
    for (const target of [dir, path.parse(root).root, dir + '\\..\\unowned'])
      expect(await check(root, target)).toEqual({ result: 'blocked', code: 2 });
    expect(fs.existsSync(dir)).toBe(true);
  }, 15000);
  it('拒绝目录树里的联接及祖先联接，不跟随到外部文件', async () => {
    const root = await fixture(),
      outside = path.join(root, '外部'),
      dir = path.join(root, 'owned');
    await owned(dir);
    await owned(outside);
    await fsp.symlink(outside, path.join(dir, 'link'), 'junction');
    expect((await check(root, dir)).result).toBe('blocked');
    const linked = path.join(root, 'ancestor-link');
    await fsp.symlink(outside, linked, 'junction');
    expect((await check(root, linked)).result).toBe('blocked');
    expect(await fsp.readFile(path.join(outside, 'deploy-center.sqlite'), 'utf8')).toBe(
      'fixture-only',
    );
  }, 15000);
});
it.skipIf(!enabled)(
  '清理模块仅包含而未展开时通过严格警告检查，不向安装阶段泄漏卸载变量',
  async () => {
    const root = await fixture(),
      exe = path.join(root, 'include-only.exe');
    const build = spawnSync(
      compiler,
      [
        '/WX',
        '/V2',
        '/DPROJECT_DIR=' + path.resolve('.'),
        '/DOUTPUT_FILE=' + exe,
        path.resolve('installer/test-include-only.nsi'),
      ],
      { encoding: 'utf8' },
    );
    expect(build.error).toBeUndefined();
    expect(build.status, build.stdout + build.stderr).toBe(0);
    expect(fs.existsSync(exe)).toBe(true);
  },
);
