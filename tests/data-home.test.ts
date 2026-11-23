// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { cleanCompletedInstallerBackups, dataPaths, transferTree, finishTransfer } from '../electron/data-paths';
import { prepareDataHome } from '../electron/data-home';
import { singleInstance } from '../electron/single-instance';
const base = path.resolve('.test-data');
const dirs: string[] = [];
async function fixture() {
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'data-home-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.dirname(dir) !== base) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
it('所有可控数据路径从当前配置派生，中文空格路径和更换盘符不依赖用户目录', async () => {
  const root = await fixture(),
    directory = path.join(root, '自定义 数据');
  const paths = dataPaths(directory);
  for (const value of Object.values(paths))
    expect(value === directory || value.startsWith(directory + path.sep)).toBe(true);
  const changed = dataPaths(path.join(root, '另一个目录'));
  expect(changed.updates).not.toBe(paths.updates);
  expect(changed.logs).not.toBe(paths.logs);
  expect(() => dataPaths(path.join(root, '..', '..') + path.sep + '..')).toThrow();
});
it('后台只清理成功安装的备份，保留未确认备份和含目录联接的副本', async () => {
  const root = await fixture();
  const backup = dataPaths(root).installerBackup;
  for (const name of ['completed-123', '124', 'completed-125', 'legacy']) {
    const dir = path.join(backup, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'program.exe'), 'fixture');
  }
  await fs.symlink(path.join(backup, '124'), path.join(backup, 'completed-125', 'linked'), 'junction');
  await cleanCompletedInstallerBackups(root);
  expect((await fs.readdir(backup)).sort()).toEqual(['124', 'completed-125', 'legacy']);
  expect(await fs.readFile(path.join(backup, '124', 'program.exe'), 'utf8')).toBe('fixture');
});
it('旧版定位、运行资料、安装包和日志先验证转移，确认启动后才清理原件', async () => {
  const root = await fixture(),
    active = path.join(root, '实际 数据'),
    legacy = path.join(root, '旧用户目录', 'Settings');
  await fs.mkdir(legacy, { recursive: true });
  await fs.mkdir(active);
  const pointer = JSON.stringify({ schema: 1, active });
  await fs.writeFile(path.join(legacy, 'data-location.json'), pointer);
  await fs.writeFile(path.join(legacy, 'Local State'), 'runtime-state');
  await fs.mkdir(path.join(legacy, 'Updates', 'update-abc'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'Updates', 'update-abc', 'setup.exe'), 'MZ fixture');
  await fs.writeFile(path.join(legacy, 'update-install.log'), '旧日志');
  let location: string | undefined;
  const locator = {
    read: () => location,
    write: (value: string) => {
      location = value;
    },
  };
  const home = prepareDataHome(path.join(root, '默认目录'), legacy, locator);
  expect(home.directory).toBe(active);
  home.prepareProfile();
  expect(await fs.readFile(path.join(legacy, 'Updates', 'update-abc', 'setup.exe'), 'utf8')).toBe(
    'MZ fixture',
  );
  expect(await fs.readFile(path.join(active, 'Runtime', 'Local State'), 'utf8')).toBe(
    'runtime-state',
  );
  expect(await fs.stat(path.join(active, 'Updates')).catch(() => undefined)).toBeUndefined();
  home.complete(active);
  expect(await fs.readFile(path.join(active, 'Updates', 'update-abc', 'setup.exe'), 'utf8')).toBe(
    'MZ fixture',
  );
  expect(location).toBe(active);
  expect(await fs.stat(legacy).catch(() => undefined)).toBeUndefined();
  expect(
    await fs.readFile(
      path.join(active, 'Control', 'legacy-startup-backup', 'data-location.json'),
      'utf8',
    ),
  ).toBe(pointer);
  const again = prepareDataHome(path.join(root, '默认目录'), legacy, locator);
  expect(again.directory).toBe(active);
});
it('转移在完成前中断可以重做，已生成的工作控制记录不被旧记录覆盖', async () => {
  const root = await fixture(),
    active = path.join(root, 'active'),
    legacy = path.join(root, 'Settings');
  await fs.mkdir(legacy);
  await fs.writeFile(
    path.join(legacy, 'data-location.json'),
    JSON.stringify({ schema: 1, active }),
  );
  await fs.writeFile(path.join(legacy, 'Local State'), 'old');
  const locator = { read: () => undefined, write: vi.fn() };
  prepareDataHome(active, legacy, locator).prepareProfile();
  await fs.writeFile(path.join(active, 'Runtime', 'Local State'), 'new-session');
  const resumed = prepareDataHome(active, legacy, locator);
  resumed.prepareProfile();
  expect(await fs.readFile(path.join(active, 'Runtime', 'Local State'), 'utf8')).toBe(
    'new-session',
  );
  resumed.complete(active);
  expect(locator.write).toHaveBeenCalledWith(active);
});
it('指纹发生变化或有未知文件时不扩大删除范围', async () => {
  const root = await fixture(),
    source = path.join(root, 'old'),
    target = path.join(root, 'new');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'known.txt'), 'original');
  const transfer = transferTree(source, target);
  await fs.writeFile(path.join(source, 'known.txt'), 'changed');
  await fs.writeFile(path.join(source, 'unknown.txt'), 'keep');
  finishTransfer(transfer);
  expect(await fs.readFile(path.join(source, 'known.txt'), 'utf8')).toBe('changed');
  expect(await fs.readFile(path.join(source, 'unknown.txt'), 'utf8')).toBe('keep');
  expect(() => transferTree(source, path.join(source, 'child'))).toThrow('父子目录');
});
it('旧资料有链接或目标内容不一致时保留原件，不读取或删除目录外内容', async () => {
  const root = await fixture(),
    source = path.join(root, 'source'),
    target = path.join(root, 'target'),
    outside = path.join(root, 'outside');
  await fs.mkdir(source);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep'), 'keep');
  await fs.symlink(
    outside,
    path.join(source, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => transferTree(source, target)).toThrow('链接');
  expect(await fs.readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
  await fs.unlink(path.join(source, 'link'));
  await fs.writeFile(path.join(source, 'file'), 'source');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'file'), 'different');
  expect(() => transferTree(source, target)).toThrow('不同文件');
  expect(await fs.readFile(path.join(source, 'file'), 'utf8')).toBe('source');
});
it.skipIf(process.platform !== 'win32')(
  'Windows 单实例身份不依赖数据目录，第二实例只激活已有窗口',
  async () => {
    const root = await fixture(),
      activate = vi.fn(),
      first = await singleInstance(root, activate);
    try {
      expect(first.primary).toBe(true);
      const second = await singleInstance(root, () => {});
      expect(second.primary).toBe(false);
      await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1));
      second.close();
      expect(await fs.readdir(root)).toEqual([]);
    } finally {
      first.close();
    }
  },
);

it('明确恢复已有目录时先备份损坏控制记录，不清空数据库', async () => {
  const root = await fixture();
  const { Storage } = await import('../electron/storage');
  const { recoverDataHome } = await import('../electron/data-home');
  const crypto = {
    encrypt: async (value: string) => Buffer.from(value),
    decrypt: async (value: Buffer) => value.toString(),
  };
  const store = new Storage(root, crypto);
  await store.settle();
  store.close();
  await fs.mkdir(path.join(root, 'Control'), { recursive: true });
  await fs.writeFile(path.join(root, 'Control', 'data-location.json'), '{broken');
  await fs.writeFile(path.join(root, 'Control', 'migration.json'), 'bad journal');
  expect(recoverDataHome(root)).toBe(root);
  const backups = await fs.readdir(path.join(root, 'backups'));
  const backup = backups.find((name) => name.startsWith('location-recovery-'))!;
  expect(await fs.readFile(path.join(root, 'backups', backup, 'data-location.json'), 'utf8')).toBe(
    '{broken',
  );
  expect(await fs.stat(path.join(root, 'deploy-center.sqlite'))).toBeTruthy();
  expect(
    await fs.stat(path.join(root, 'Control', 'migration.json')).catch(() => undefined),
  ).toBeUndefined();
});

it('注册表位置已提交但旧文件尚未清理时，重启继续清理已验证的旧控制记录', async () => {
  const root = await fixture(),
    active = path.join(root, 'active'),
    legacy = path.join(root, 'Settings');
  await fs.mkdir(legacy);
  await fs.writeFile(
    path.join(legacy, 'data-location.json'),
    JSON.stringify({ schema: 1, active }),
  );
  await fs.writeFile(path.join(legacy, 'Local State'), 'state');
  let located: string | undefined;
  const locator = {
    read: () => located,
    write: (value: string) => {
      located = value;
    },
  };
  prepareDataHome(active, legacy, locator).prepareProfile();
  locator.write(active);
  const reboot = prepareDataHome(active, legacy, locator);
  reboot.prepareProfile();
  reboot.complete(active);
  expect(
    await fs.stat(path.join(legacy, 'data-location.json')).catch(() => undefined),
  ).toBeUndefined();
  expect(
    await fs.readFile(
      path.join(active, 'Control', 'legacy-startup-backup', 'data-location.json'),
      'utf8',
    ),
  ).toContain(active.replace(/\\/g, '\\\\'));
});
it('控制记录已切换而注册表仍指向旧目录时，为有效活动目录准备运行资料', async () => {
  const root = await fixture(),
    source = path.join(root, 'source'),
    target = path.join(root, 'target'),
    legacy = path.join(root, 'legacy');
  await fs.mkdir(path.join(source, 'Control'), { recursive: true });
  await fs.writeFile(
    path.join(source, 'Control', 'data-location.json'),
    JSON.stringify({ schema: 1, active: target }),
  );
  const home = prepareDataHome(source, legacy, { read: () => source, write: () => {} });
  expect(home.directory).toBe(source);
  expect(home.runtimeRoot).toBe(target);
});

it('旧缓存与当前目录有冲突时保留双方并提示，不阻止有效数据目录使用', async () => {
  const root = await fixture(),
    active = path.join(root, 'active'),
    legacy = path.join(root, 'Settings');
  await fs.mkdir(path.join(legacy, 'Updates', 'update-abc'), { recursive: true });
  await fs.mkdir(path.join(active, 'Updates', 'update-abc'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'Updates', 'update-abc', 'setup.exe'), 'old');
  await fs.writeFile(path.join(active, 'Updates', 'update-abc', 'setup.exe'), 'new');
  const home = prepareDataHome(active, legacy, { read: () => active, write: () => {} });
  home.prepareProfile();
  expect(home.complete(active)).toContain('已保留');
  expect(await fs.readFile(path.join(legacy, 'Updates', 'update-abc', 'setup.exe'), 'utf8')).toBe(
    'old',
  );
  expect(await fs.readFile(path.join(active, 'Updates', 'update-abc', 'setup.exe'), 'utf8')).toBe(
    'new',
  );
});

it('运行或日志目录是联接时拒绝写到数据目录外', async () => {
  const root = await fixture(),
    outside = path.join(root, 'outside'),
    active = path.join(root, 'active');
  await fs.mkdir(outside);
  await fs.mkdir(active);
  await fs.symlink(
    outside,
    path.join(active, 'Runtime'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => dataPaths(active)).toThrow('链接');
  expect(await fs.readdir(outside)).toEqual([]);
});

it.each([false, true])(
  '旧框架缓存跟随数据目录，重复安装包不增加占用（相同内容：%s）',
  async (same) => {
    const root = await fixture(),
      active = path.join(root, 'data'),
      legacy = path.join(root, 'Settings'),
      cache = path.join(root, 'framework');
    await fs.mkdir(path.join(active, 'Updates', 'update-known'), { recursive: true });
    await fs.mkdir(cache);
    await fs.writeFile(path.join(active, 'Updates', 'update-known', 'setup.exe'), 'known');
    await fs.writeFile(path.join(cache, 'installer.exe'), same ? 'known' : 'different');
    const home = prepareDataHome(active, legacy, { read: () => active, write: () => {} }, [
      { source: cache, target: 'Updates', installerCache: true },
    ]);
    expect(home.complete(active)).toBeUndefined();
    expect(await fs.stat(cache).catch(() => undefined)).toBeUndefined();
    expect(
      await fs.readFile(path.join(active, 'Updates', 'update-known', 'setup.exe'), 'utf8'),
    ).toBe('known');
    const copy = path.join(active, 'Updates', 'legacy-framework-cache', 'installer.exe');
    if (same) expect(await fs.stat(copy).catch(() => undefined)).toBeUndefined();
    else expect(await fs.readFile(copy, 'utf8')).toBe('different');
  },
);
