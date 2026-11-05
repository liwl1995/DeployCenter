// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DataDirectory, migrationDestination } from '../electron/data-directory';
import { MigrationReporter } from '../electron/migration-progress';
import { Storage } from '../electron/storage';
import { seed } from '../src/model';
import type { MigrationProgress } from '../src/features';
const roots: string[] = [],
  stores: Storage[] = [];
const crypto = {
  encrypt: async (s: string) => Buffer.from(s),
  decrypt: async (b: Buffer) => b.toString(),
};
async function fixture() {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'v122-迁移 '));
  roots.push(root);
  const source = path.join(root, '原数据'),
    parent = path.join(root, '上级目录'),
    settings = path.join(root, '位置配置');
  const store = new Storage(source, crypto);
  stores.push(store);
  store.saveConfig(seed());
  const manager = new DataDirectory(settings, source, [path.join(root, 'system')]);
  await manager.locate();
  manager.markOwned(source);
  return { root, source, parent, settings, store, manager };
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('越界');
    await fs.rm(root, { recursive: true, force: true });
  }
});
it('上级目录可有其他内容，只迁入 DeployCenter；全部内容校验后重启激活，原目录保留', async () => {
  const f = await fixture(),
    target = migrationDestination(f.parent),
    events: MigrationProgress[] = [];
  await fs.mkdir(f.parent);
  await fs.writeFile(path.join(f.parent, '其他应用.txt'), '保留');
  await fs.mkdir(path.join(f.source, '空目录'));
  await fs.writeFile(path.join(f.source, '完整文件.bin'), Buffer.alloc(512 * 1024, 7));
  expect((await f.manager.inspect(target)).valid).toBe(true);
  const result = await f.manager.migrate(
    target,
    () => undefined,
    () => f.store.pause(),
    () => f.store.resume(),
    (event) => events.push(event),
  );
  expect(result.state).toBe('pending');
  expect(events.map((e) => e.state)).toEqual(
    expect.arrayContaining(['preparing', 'copying', 'verifying', 'pending']),
  );
  expect(result.files).toBe(result.totalFiles);
  expect(result.verifiedFiles).toBe(result.totalFiles);
  expect(events.some((e) => !!e.currentFile)).toBe(true);
  expect(await fs.readdir(path.join(target, '空目录'))).toEqual([]);
  expect((await f.manager.info()).path).toBe(f.source);
  expect(await fs.readFile(path.join(f.parent, '其他应用.txt'), 'utf8')).toBe('保留');
  f.store.close();
  const next = new DataDirectory(f.settings, f.source);
  expect((await next.locate()).directory).toBe(target);
  const moved = new Storage(target, crypto);
  stores.push(moved);
  expect(moved.database().services[0].name).toBe(seed().services[0].name);
  expect(existsSync(path.join(f.source, 'deploy-center.sqlite'))).toBe(true);
});
it('已有非空 DeployCenter 不覆盖，父路径链接及越界片段不能绕过安全检查', async () => {
  const f = await fixture(),
    target = migrationDestination(f.parent);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'keep'), '原内容');
  expect((await f.manager.inspect(target)).valid).toBe(false);
  await expect(
    f.manager.migrate(
      target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      () => {},
    ),
  ).rejects.toThrow('非空');
  expect(await fs.readFile(path.join(target, 'keep'), 'utf8')).toBe('原内容');
  expect(() =>
    migrationDestination(path.join(f.root, 'valid') + path.sep + '..' + path.sep + 'outside'),
  ).toThrow();
  await fs.symlink(
    f.parent,
    path.join(f.root, '链接'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => migrationDestination(path.join(f.root, '链接'))).toThrow('链接');
  expect((await f.manager.inspect(migrationDestination(path.join(f.root, 'system')))).valid).toBe(
    false,
  );
});
it('准备阶段取消不复制、不暂停数据库，校验阶段取消安全清理副本并恢复原目录', async () => {
  const f = await fixture();
  let paused = false;
  await expect(
    f.manager.migrate(
      migrationDestination(f.parent),
      () => undefined,
      () => {
        paused = true;
        f.store.pause();
      },
      () => f.store.resume(),
      (e) => {
        if (e.state === 'preparing') f.manager.cancel();
      },
    ),
  ).rejects.toThrow('取消');
  expect(paused).toBe(false);
  expect(existsSync(migrationDestination(f.parent))).toBe(false);
  await expect(
    f.manager.migrate(
      migrationDestination(f.parent),
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      (e) => {
        if (e.state === 'verifying') f.manager.cancel();
      },
    ),
  ).rejects.toThrow('取消');
  expect(await fs.readdir(migrationDestination(f.parent)).catch(() => [])).toEqual([]);
  f.store.saveConfig(seed());
  expect(f.store.database().services).toHaveLength(2);
});
it('旧版直接迁入上级目录的已有位置指针保持有效，不追加新层级，不改变数据库版本', async () => {
  const f = await fixture();
  await f.manager.migrate(
    f.parent,
    () => undefined,
    () => f.store.pause(),
    () => f.store.resume(),
    () => {},
  );
  f.store.close();
  const next = new DataDirectory(f.settings, f.source);
  expect((await next.locate()).directory).toBe(f.parent);
  expect(existsSync(path.join(f.parent, 'DeployCenter'))).toBe(false);
  const moved = new Storage(f.parent, crypto);
  stores.push(moved);
  expect(moved.database().servers).toHaveLength(seed().servers.length);
  expect((await next.info()).previous).toBe(f.source);
});
it('进度事件节流，阶段立即发出，滑动统计的速度和剩余时间可用假时钟验证', () => {
  let time = 0;
  const events: MigrationProgress[] = [];
  const meter = new MigrationReporter(
    'source',
    'target',
    (value) => events.push(value),
    () => time,
  );
  meter.update({}, true);
  meter.update({ state: 'copying', total: 20000 });
  time = 1000;
  meter.update({ copied: 5000 });
  expect(meter.value.bytesPerSecond).toBe(5000);
  expect(meter.value.remainingSeconds).toBe(3);
  const count = events.length;
  for (let i = 1; i < 50; i++) {
    time = 1000 + i;
    meter.update({ copied: 5000 + i });
  }
  expect(events).toHaveLength(count);
  expect(meter.value.copied).toBe(5049);
  meter.update({ state: 'verifying', verified: 0 });
  expect(events.at(-1)?.state).toBe('verifying');
  time = 2049;
  meter.update({ verified: 10000 });
  expect(meter.value.bytesPerSecond).toBe(10000);
  meter.update({ state: 'pending' });
  expect(events.at(-1)?.remainingSeconds).toBe(0);
});
