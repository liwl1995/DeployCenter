// @vitest-environment node
import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync, renameSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { DataDirectory } from '../electron/data-directory';
import { Storage } from '../electron/storage';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
const roots: string[] = [];
const stores: Storage[] = [];
const crypto = {
  encrypt: async (value: string) => Buffer.from('encrypted:' + value),
  decrypt: async (value: Buffer) => value.toString().slice(10),
};
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) {
    if (!root.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试路径越界');
    await fs.rm(root, { recursive: true, force: true });
  }
});
async function fixture() {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'migration-中文 '));
  roots.push(root);
  const source = path.join(root, '原数据'),
    target = path.join(root, '新数据'),
    settings = path.join(root, '位置设置');
  const store = new Storage(source, crypto);
  stores.push(store);
  const manager = new DataDirectory(settings, source, [path.join(root, 'system')]);
  await manager.locate();
  manager.markOwned(source);
  return { root, source, target, settings, store, manager };
}
describe('1.2.0 数据目录迁移（隔离真实文件与 SQLite）', () => {
  it('先复制验证，重启后切换；凭据、日志、历史和本地快照路径可用，原目录保留', async () => {
    const f = await fixture();
    const db = seed();
    const task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
    task.status = 'success';
    task.targets[0].status = 'unverified';
    task.artifact.path = path.join(f.source, 'artifacts', task.id, 'app.jar');
    task.artifact.sha256 = 'a'.repeat(64);
    task.targets[0].backupCreated = false;
    f.store.saveConfig(db);
    f.store.complete(task);
    f.store.appendLog(task.id, '原日志\n');
    await f.store.saveCredential('s19', 'fixture-password');
    await fs.mkdir(path.dirname(task.artifact.path), { recursive: true });
    await fs.writeFile(task.artifact.path, 'snapshot');
    await fs.mkdir(path.join(f.source, 'tmp'));
    await fs.writeFile(path.join(f.source, 'tmp', '临时文件'), 'temp');
    await fs.mkdir(path.join(f.source, 'backups'), { recursive: true });
    await fs.writeFile(path.join(f.source, 'backups', 'fixture'), 'backup');
    await fs.mkdir(path.join(f.source, '空目录', '子目录'), { recursive: true });
    const expectedHistory = f.store.database().history;
    const result = await f.manager.migrate(
      f.target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      () => {},
    );
    expect(result.state).toBe('pending');
    expect((await f.manager.info()).path).toBe(f.source);
    expect(await fs.readFile(path.join(f.source, 'logs', task.id, 'build.log'), 'utf8')).toBe(
      '原日志\n',
    );
    f.store.close();
    const next = new DataDirectory(f.settings, f.source);
    expect((await next.locate()).directory).toBe(f.target);
    const moved = new Storage(f.target, crypto);
    stores.push(moved);
    expect(await moved.credential('s19')).toBe('fixture-password');
    expect(moved.database().history).toHaveLength(expectedHistory.length);
    expect(moved.task(task.id)!.artifact.path).toBe(
      path.join(f.target, 'artifacts', task.id, 'app.jar'),
    );
    expect(await fs.readFile(path.join(f.target, 'tmp', '临时文件'), 'utf8')).toBe('temp');
    expect(await fs.readdir(path.join(f.target, '空目录', '子目录'))).toEqual([]);
    expect((await next.info()).previous).toBe(f.source);
    expect(await fs.stat(f.source)).toBeTruthy();
  });
  it('取消清理本次复制副本，原数据可继续写入', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'big.bin'), Buffer.alloc(1024 * 1024));
    await expect(
      f.manager.migrate(
        f.target,
        () => undefined,
        () => f.store.pause(),
        () => f.store.resume(),
        (progress) => {
          if (progress.copied > 0) f.manager.cancel();
        },
      ),
    ).rejects.toThrow('取消');
    expect(await fs.stat(path.join(f.source, 'big.bin'))).toBeTruthy();
    f.store.saveConfig(seed());
    expect(f.store.database().services.length).toBe(2);
    expect(await fs.readdir(f.target).catch(() => [])).toEqual([]);
  });
  it('活动、取消和中断任务状态由主进程 guard 阻止，未关闭数据库', async () => {
    const f = await fixture();
    for (const reason of ['任务正在运行', '任务正在取消', '存在未处理的中断任务'])
      await expect(
        f.manager.migrate(
          f.target,
          () => reason,
          () => {
            throw new Error('不得暂停');
          },
          () => {},
          () => {},
        ),
      ).rejects.toThrow(reason);
    expect(f.store.database().services).toHaveLength(0);
  });
  it('拒绝当前、内部、父目录、系统目录、非空目录，不覆盖已有文件', async () => {
    const f = await fixture();
    for (const target of [
      f.source,
      path.join(f.source, 'child'),
      f.root,
      path.join(f.root, 'system', 'data'),
    ])
      expect((await f.manager.inspect(target)).valid).toBe(false);
    await fs.mkdir(f.target);
    await fs.writeFile(path.join(f.target, 'mine.txt'), 'user');
    expect((await f.manager.inspect(f.target)).valid).toBe(false);
    expect(await fs.readFile(path.join(f.target, 'mine.txt'), 'utf8')).toBe('user');
  });
  it('崩溃时只清理拥有标记的复制文件，继续使用原目录', async () => {
    const f = await fixture();
    await fs.mkdir(f.target);
    const id = randomUUID();
    await fs.writeFile(path.join(f.target, '.yotoo-migration-owner'), id);
    await fs.writeFile(path.join(f.target, 'part.bin'), 'partial');
    await fs.mkdir(f.settings, { recursive: true });
    await fs.writeFile(
      path.join(f.settings, 'migration.json'),
      JSON.stringify({
        id,
        source: f.source,
        target: f.target,
        stage: 'copying',
        files: ['part.bin'],
        createdTarget: true,
      }),
    );
    const next = new DataDirectory(f.settings, f.source);
    const value = await next.locate();
    expect(value.directory).toBe(f.source);
    expect(value.notice).toContain('被中断');
    expect(
      await fs.access(path.join(f.target, 'part.bin')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  it('重启前复制数据被破坏时不切换，不创建一份空数据', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.source, 'log.txt'), 'keep');
    await f.manager.migrate(
      f.target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      () => {},
    );
    await fs.unlink(path.join(f.target, 'log.txt'));
    const next = new DataDirectory(f.settings, f.source);
    await expect(next.locate()).rejects.toThrow('无法读取');
    expect(await fs.readFile(path.join(f.source, 'log.txt'), 'utf8')).toBe('keep');
  });
  it('位置损坏或自定义目录失踪明确拒绝，不静默初始化默认目录', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.settings, 'data-location.json'), '{broken');
    await expect(new DataDirectory(f.settings, f.source).locate()).rejects.toThrow('位置配置损坏');
    await fs.writeFile(
      path.join(f.settings, 'data-location.json'),
      JSON.stringify({ schema: 1, active: path.join(f.root, 'missing') }),
    );
    await expect(new DataDirectory(f.settings, f.source).locate()).rejects.toThrow('缺少数据库');
    expect(
      await fs.access(path.join(f.root, 'missing')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
  it('清理旧目录必须精确确认路径，旧目录变动则保留', async () => {
    const f = await fixture();
    await f.manager.migrate(
      f.target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      () => {},
    );
    f.store.close();
    const next = new DataDirectory(f.settings, f.source);
    await next.locate();
    await expect(next.removePrevious(f.root)).rejects.toThrow('不匹配');
    await fs.writeFile(path.join(f.source, 'user-added.txt'), 'keep');
    await expect(next.removePrevious(f.source)).rejects.toThrow('新增文件');
    expect(await fs.readFile(path.join(f.source, 'user-added.txt'), 'utf8')).toBe('keep');
  });
  it('旧目录文件集未变时显式清理，保持新目录可读', async () => {
    const f = await fixture();
    await f.manager.migrate(
      f.target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      () => {},
    );
    f.store.close();
    const next = new DataDirectory(f.settings, f.source);
    await next.locate();
    await expect(next.removePrevious(f.source)).resolves.toBe(true);
    expect(
      await fs.access(f.source).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const check = new Sqlite(path.join(f.target, 'deploy-center.sqlite'), { readonly: true });
    expect(check.pragma('quick_check', { simple: true })).toBe('ok');
    check.close();
  });
});
it('复制后目录被换成联接时，取消不会跟随联接删除外部文件', async () => {
  const f = await fixture(),
    outside = path.join(f.root, '外部保留'),
    nested = path.join(f.source, 'nested');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'keep.txt'), 'outside');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'keep.txt'), 'source');
  let changed = false;
  await expect(
    f.manager.migrate(
      f.target,
      () => undefined,
      () => f.store.pause(),
      () => f.store.resume(),
      (progress) => {
        if (!changed && progress.files > 0) {
          const dest = path.join(f.target, 'nested');
          // 夹具在当前同步进度回调里替换目录，再请求取消。
          if (existsSync(path.join(dest, 'keep.txt'))) {
            changed = true;
            renameSync(dest, dest + '-copied');
            symlinkSync(outside, dest, process.platform === 'win32' ? 'junction' : 'dir');
            f.manager.cancel();
          }
        }
      },
    ),
  ).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8')).toBe('outside');
  expect(await fs.readFile(path.join(nested, 'keep.txt'), 'utf8')).toBe('source');
});
