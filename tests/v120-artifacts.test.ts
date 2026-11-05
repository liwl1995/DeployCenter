// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Sqlite from 'better-sqlite3';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { Storage } from '../electron/storage';
import { snapshotJar } from '../electron/files';
import { snapshotPath, managedPath } from '../electron/managed-path';
import { artifactPolicy, defaultArtifactPolicy } from '../electron/artifact-store';
import { createTask } from '../src/engine';
import { seed, type Task, type ArtifactPolicy } from '../src/model';

const base = path.resolve('.test-data');
const fixtures: { dir: string; store: Storage }[] = [];
let now = Date.parse('2026-11-04T10:00:00Z');
const crypto = {
  encrypt: async (s: string) => Buffer.from(s),
  decrypt: async (b: Buffer) => b.toString(),
};
async function fixture() {
  await fsp.mkdir(base, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(base, 'artifacts-'));
  now = Date.parse('2026-11-04T10:00:00Z');
  const store = new Storage(dir, crypto, () => now);
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  store.saveConfig(db);
  await store.settle();
  fixtures.push({ dir, store });
  return { dir, store };
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.store.settle();
    f.store.close();
    if (!f.dir.startsWith(base + path.sep)) throw new Error('测试目录越界');
    await fsp.rm(f.dir, { recursive: true, force: true });
  }
});
function task(store: Storage, id: string, status: Task['status'] = 'failed') {
  const db = store.database();
  const t = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  t.id = 'DC-' + id;
  t.startedAt = now;
  t.updatedAt = now;
  t.started = new Date(now).toISOString();
  t.status = status;
  t.endedAt = ['running', 'cancelling', 'interrupted'].includes(status) ? undefined : now;
  t.targets[0].status =
    status === 'success' ? 'unverified' : status === 'cancelled' ? 'cancelled' : 'failed';
  return t;
}
async function object(store: Storage, t: Task, text = t.id, legacy = false) {
  const bytes = Buffer.from(text),
    hash = createHash('sha256').update(bytes).digest('hex');
  const file = path.join(
    store.dataDir,
    'artifacts',
    legacy ? t.id : 'sha256',
    legacy ? '测试 应用.jar' : hash + '.jar',
  );
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, bytes);
  t.artifact = {
    name: '应用.jar',
    path: file,
    source: 'file',
    exists: true,
    size: bytes.length,
    modified: new Date(now).toISOString(),
    sha256: hash,
  };
  store.saveTask(t);
  return file;
}
async function jar(file: string) {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await writer.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await writer.add('应用.txt', new TextReader('相同的产物内容'));
  await fsp.writeFile(file, Buffer.from(await (await writer.close()).arrayBuffer()));
}
describe('1.2.0 内容去重和引用保护', () => {
  it('两个任务及重复选择同一内容只保存一份，释放一个引用不影响另一个', async () => {
    const { store, dir } = await fixture(),
      source = path.join(dir, '输入.jar');
    await jar(source);
    const a = task(store, 'same-a', 'success'),
      b = task(store, 'same-b');
    a.artifact = await snapshotJar(source, a.id, dir);
    store.saveTask(a);
    b.artifact = await snapshotJar(source, b.id, dir, undefined, store.artifacts.sources());
    store.saveTask(b);
    expect(a.artifact.path).toBe(b.artifact.path);
    expect(fs.readdirSync(path.dirname(a.artifact.path))).toHaveLength(1);
    store.artifacts.forget(a.id);
    await store.artifacts.automatic();
    expect(store.artifacts.availability(b.id).available).toBe(true);
    b.status = 'success';
    b.targets[0].status = 'unverified';
    store.complete(b);
    await store.settle();
    expect(fs.existsSync(a.artifact.path)).toBe(false);
    expect(store.task(b.id)?.artifact.sha256).toBe(b.artifact.sha256);
    expect(store.database().history[0].artifact.size).toBe(b.artifact.size);
  });
  it.each(['failed', 'cancelled'] as const)(
    '%s 产物保留到 7 天边界，清理后说明替代路径',
    async (status) => {
      const { store } = await fixture();
      const t = task(store, status, status),
        file = await object(store, t);
      await store.artifacts.automatic();
      expect(fs.existsSync(file)).toBe(true);
      now += 7 * 86400000 - 1;
      await store.artifacts.automatic();
      expect(fs.existsSync(file)).toBe(true);
      now++;
      await store.artifacts.automatic();
      expect(fs.existsSync(file)).toBe(false);
      expect(store.artifacts.availability(t.id)).toMatchObject({ available: false });
      expect(store.artifacts.availability(t.id).reason).toMatch(/重新构建.*选择现有 JAR/);
      expect(store.artifacts.availability(t.id).reason).toContain('远程备份回滚不受影响');
    },
  );
  it.each(['running', 'cancelling', 'interrupted'] as const)(
    '%s 在任何策略和手动清理中都受保护',
    async (status) => {
      const { store } = await fixture(),
        t = task(store, status, status),
        file = await object(store, t);
      now += 365 * 86400000;
      for (const mode of ['success', 'count', 'size'] as const) {
        store.applyArtifactPolicy({
          ...defaultArtifactPolicy,
          mode,
          maxCount: 1,
          maxGB: 0.000000001,
        });
        await store.artifacts.automatic();
        const p = store.artifacts.preview('artifacts');
        expect(p.files).toBe(0);
        if (status === 'interrupted') await store.artifacts.apply(p.token, true);
        else await expect(store.artifacts.apply(p.token, true)).rejects.toThrow('正在执行');
        expect(fs.existsSync(file)).toBe(true);
      }
    },
  );
  it('失败任务只重试成功后释放原引用，原失败记录仍保持真实结果', async () => {
    const { store } = await fixture(),
      old = task(store, 'retry-parent'),
      file = await object(store, old);
    const retry = task(store, 'retry-child', 'success');
    retry.artifact = structuredClone(old.artifact);
    retry.retryOf = old.id;
    store.complete(retry);
    await store.settle();
    expect(fs.existsSync(file)).toBe(false);
    expect(store.task(old.id)?.status).toBe('failed');
  });
  it('共享成功与失败引用时，成功完成不能删除失败任务的文件', async () => {
    const { store } = await fixture(),
      failed = task(store, 'shared-failed'),
      file = await object(store, failed);
    const ok = task(store, 'shared-ok', 'success');
    ok.artifact = structuredClone(failed.artifact);
    store.complete(ok);
    await store.settle();
    expect(fs.existsSync(file)).toBe(true);
    expect(store.artifacts.preview('artifacts').tasks.sort()).toEqual([failed.id, ok.id].sort());
  });
});
describe('1.2.0 保留策略和安全清理', () => {
  it.each(['count', 'size'] as const)('%s 策略保留最近内容，边界和受保护引用优先', async (mode) => {
    const { store } = await fixture();
    const files: string[] = [];
    for (let i = 0; i < 3; i++) {
      now += 1000;
      files.push(await object(store, task(store, 'policy-' + i, 'success'), 'jar' + i));
    }
    const policy: ArtifactPolicy = {
      ...defaultArtifactPolicy,
      mode,
      maxCount: 2,
      maxGB: 8 / 1024 ** 3,
    };
    const p = store.artifacts.preview('policy', policy);
    expect(p.files).toBe(1);
    expect(p.bytes).toBe(4);
    expect(fs.existsSync(files[0])).toBe(true);
    await store.artifacts.apply(p.token, true);
    store.applyArtifactPolicy(policy);
    expect(files.map((f) => fs.existsSync(f))).toEqual([false, true, true]);
    expect(() => artifactPolicy({ ...policy, maxCount: 0 })).toThrow('无效');
    expect(() => artifactPolicy({ ...policy, maxGB: 0 })).toThrow('无效');
  });
  it('成功默认删除；人工确认前不删除，状态变化使旧预览失效', async () => {
    const { store } = await fixture(),
      t = task(store, 'confirmation'),
      file = await object(store, t);
    let p = store.artifacts.preview('artifacts');
    await expect(store.artifacts.apply(p.token, false)).rejects.toThrow('确认');
    expect(fs.existsSync(file)).toBe(true);
    t.status = 'interrupted';
    store.saveTask(t);
    await expect(store.artifacts.apply(p.token, true)).rejects.toThrow('已变化');
    expect(fs.existsSync(file)).toBe(true);
    t.status = 'success';
    t.endedAt = now;
    t.targets[0].status = 'unverified';
    store.complete(t);
    await store.settle();
    expect(fs.existsSync(file)).toBe(false);
  });
  it('拒绝 ..、目录外路径、异常结构和符号链接，外部文件保持完整', async () => {
    const { dir } = await fixture(),
      outside = path.join(dir, '外部.jar');
    await fsp.writeFile(outside, '保留');
    expect(() => snapshotPath(dir, outside)).toThrow();
    expect(() =>
      snapshotPath(dir, path.join(dir, 'artifacts') + path.sep + '..' + path.sep + '外部.jar'),
    ).toThrow();
    expect(() => snapshotPath(dir, path.join(dir, 'artifacts', 'unknown', 'a.jar'))).toThrow();
    await fsp.mkdir(path.join(dir, 'artifacts'), { recursive: true });
    await fsp.symlink(
      dir,
      path.join(dir, 'artifacts', 'DC-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => snapshotPath(dir, path.join(dir, 'artifacts', 'DC-link', '外部.jar'))).toThrow(
      '链接',
    );
    expect(() => managedPath(dir, 'tmp', outside)).toThrow();
    expect(fs.readFileSync(outside, 'utf8')).toBe('保留');
  });
  it('清理前校验内容，已被改写的产物不删除', async () => {
    const { store } = await fixture(),
      t = task(store, 'changed'),
      file = await object(store, t);
    const p = store.artifacts.preview('artifacts');
    await fsp.writeFile(file, '已修改');
    const r = await store.artifacts.apply(p.token, true);
    expect(r.files).toBe(0);
    expect(r.warnings.join()).toContain('不一致');
    expect(fs.existsSync(file)).toBe(true);
  });
  it('历史清理释放无引用产物，仍被另一任务引用的继续保留', async () => {
    const { store } = await fixture(),
      a = task(store, 'old'),
      file = await object(store, a);
    const b = task(store, 'new');
    b.artifact = structuredClone(a.artifact);
    now += 1000;
    store.saveTask(b);
    const db = store.database();
    db.settings.historyLimit = 1;
    store.saveConfig(db);
    await store.settle();
    expect(store.task(a.id)).toBeUndefined();
    expect(fs.existsSync(file)).toBe(true);
    expect(store.artifacts.availability(b.id).available).toBe(true);
  });
});
describe('1.2.0 临时文件和 1.1.0 升级', () => {
  it('启动仅清理超过 24 小时的临时文件，保护运行和中断任务', async () => {
    const { store, dir } = await fixture();
    const make = async (id: string, old: boolean) => {
      const file = path.join(dir, 'tmp', id, 'build-command-fixture', 'launch.cmd');
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, 'rem 测试');
      await fsp.utimes(file, new Date(now), new Date(now - (old ? 86400001 : 1000)));
      return file;
    };
    const old = task(store, 'temp-old'),
      active = task(store, 'temp-active', 'running'),
      interrupted = task(store, 'temp-interrupted', 'interrupted');
    for (const t of [old, active, interrupted]) store.saveTask(t);
    const oldFile = await make(old.id, true),
      newFile = await make('DC-temp-new', false),
      activeFile = await make(active.id, true),
      interruptedFile = await make(interrupted.id, true);
    await store.artifacts.cleanTemporary(true);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
    expect(fs.existsSync(activeFile)).toBe(true);
    expect(fs.existsSync(interruptedFile)).toBe(true);
    active.status = 'cancelled';
    active.endedAt = now;
    store.complete(active);
    await store.settle();
    expect(fs.existsSync(activeFile)).toBe(false);
    expect(fs.existsSync(interruptedFile)).toBe(true);
  });
  it('旧版快照升级先备份，未经确认保留，确认只删成功产物并保留异常内容', async () => {
    const f = await fixture(),
      ok = task(f.store, 'legacy-ok', 'success'),
      failed = task(f.store, 'legacy-failed'),
      interrupted = task(f.store, 'legacy-interrupted', 'interrupted');
    const okFile = await object(f.store, ok, 'ok', true),
      badFile = await object(f.store, failed, 'bad', true),
      intFile = await object(f.store, interrupted, 'int', true);
    const unknown = path.join(f.dir, 'artifacts', '不明内容.jar');
    await fsp.writeFile(unknown, '未知');
    f.store.close();
    const sql = new Sqlite(path.join(f.dir, 'deploy-center.sqlite'));
    sql.exec(
      'DROP TABLE artifact_objects; DROP TABLE artifact_refs; DROP TABLE app_meta; PRAGMA user_version=2;',
    );
    sql.close();
    f.store = new Storage(f.dir, crypto, () => now);
    fixtures[fixtures.length - 1].store = f.store;
    await f.store.maintainStartup();
    const u = f.store.artifacts.usage();
    expect(u.legacy.pending).toBe(true);
    expect(u.legacy.successBytes).toBe(2);
    expect(u.legacy.warnings.join()).toContain('元数据缺失');
    expect(fs.readdirSync(path.join(f.dir, 'backups')).length).toBeGreaterThan(0);
    expect(fs.existsSync(okFile)).toBe(true);
    const p = f.store.artifacts.preview('legacy-success');
    expect(p.files).toBe(1);
    await f.store.artifacts.apply(p.token, true);
    expect([okFile, badFile, intFile, unknown].map((f) => fs.existsSync(f))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    await f.store.artifacts.automatic();
    expect(fs.existsSync(badFile)).toBe(true);
    now += 7 * 86400000;
    await f.store.artifacts.automatic();
    expect(fs.existsSync(badFile)).toBe(false);
    expect(fs.existsSync(intFile)).toBe(true);
    const usage = f.store.artifacts.usage();
    expect(usage.total).toBe(
      usage.database + usage.logs + usage.artifacts + usage.temporary + usage.backups + usage.other,
    );
  });
});

it('快照发布后尚未回传路径就中断时，按指纹保护；无法确认指纹时保守保留', async () => {
  const { store } = await fixture(),
    known = task(store, 'published-before-crash', 'success'),
    file = await object(store, known);
  const interrupted = task(store, 'crash-before-snapshot-event', 'interrupted');
  interrupted.artifact = {
    ...structuredClone(known.artifact),
    path: path.join(store.dataDir, 'source.jar'),
  };
  store.saveTask(interrupted);
  expect(store.artifacts.preview('artifacts').files).toBe(0);
  await store.artifacts.automatic();
  expect(fs.existsSync(file)).toBe(true);
  interrupted.artifact.sha256 = undefined;
  store.saveTask(interrupted);
  const plan = store.artifacts.preview('artifacts');
  expect(plan.files).toBe(0);
  expect(plan.warnings.join()).toContain('归属尚未确认');
});

it('中断的试运行或远程回滚不占用本地快照引用，全部目标已成功即使结束时取消也释放', async () => {
  const { store } = await fixture(),
    ok = task(store, 'all-targets-success', 'cancelled');
  ok.targets[0].status = 'unverified';
  const file = await object(store, ok);
  const check = task(store, 'readonly-interrupted', 'interrupted');
  check.dryRun = true;
  check.artifact.sha256 = undefined;
  store.saveTask(check);
  const rollback = task(store, 'rollback-interrupted', 'interrupted');
  rollback.operation = 'rollback';
  rollback.artifact.sha256 = undefined;
  store.saveTask(rollback);
  await store.artifacts.automatic();
  expect(fs.existsSync(file)).toBe(false);
});

it('旧任务 JSON 损坏时保留原字符串、全部可能共享产物及相关临时文件，并能显示问题', async () => {
  const { store, dir } = await fixture(),
    t = task(store, 'metadata-corrupt', 'success'),
    file = await object(store, t);
  const temp = path.join(dir, 'tmp', t.id, 'launch.cmd');
  await fsp.mkdir(path.dirname(temp), { recursive: true });
  await fsp.writeFile(temp, 'keep');
  await fsp.utimes(temp, new Date(0), new Date(0));
  const sql = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
  sql.prepare('UPDATE tasks SET json=? WHERE id=?').run('{ invalid json', t.id);
  sql.close();
  await store.maintainStartup();
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(temp)).toBe(true);
  expect(store.hasUnreadableTasks()).toBe(true);
  expect(store.summaries()[0].uncertain).toBe(true);
  expect(store.artifacts.usage().legacy.warnings.join()).toContain('元数据无法读取');
  const plan = store.artifacts.preview('artifacts');
  expect(plan.files).toBe(0);
  await expect(store.artifacts.apply(plan.token, true)).rejects.toThrow('无法读取');
  const check = new Sqlite(path.join(dir, 'deploy-center.sqlite'));
  expect(
    (check.prepare('SELECT json FROM tasks WHERE id=?').get(t.id) as { json: string }).json,
  ).toBe('{ invalid json');
  check.close();
});
it('确认旧版后超过保护期的重复副本合并，两个任务仍可重试；中断时不合并', async () => {
  const { store } = await fixture(),
    a = task(store, 'old-duplicate-a'),
    b = task(store, 'old-duplicate-b');
  const first = await object(store, a, 'same-old-jar', true);
  now += 1000;
  const second = await object(store, b, 'same-old-jar', true);
  const policy = { ...defaultArtifactPolicy, mode: 'count' as const, maxCount: 1 };
  store.applyArtifactPolicy(policy);
  await store.artifacts.automatic();
  expect([fs.existsSync(first), fs.existsSync(second)]).toEqual([true, true]);
  const review = store.artifacts.preview('legacy-success');
  await store.artifacts.apply(review.token, true);
  await store.artifacts.automatic();
  expect([fs.existsSync(first), fs.existsSync(second)]).toEqual([true, true]);
  now += 8 * 86400000;
  a.status = 'interrupted';
  store.saveTask(a);
  expect(store.artifacts.preview('policy').files).toBe(0);
  a.status = 'failed';
  store.saveTask(a);
  const plan = store.artifacts.preview('policy');
  expect(plan.files).toBe(1);
  expect(plan.tasks).toEqual([]);
  expect(plan.warnings.join()).toContain('仍可重试');
  await store.artifacts.apply(plan.token, true);
  const pathA = store.artifacts.availability(a.id),
    pathB = store.artifacts.availability(b.id);
  expect(pathA.available).toBe(true);
  expect(pathA.path).toBe(pathB.path);
  expect(store.task(a.id)!.artifact.path).toBe(store.task(b.id)!.artifact.path);
  expect([fs.existsSync(first), fs.existsSync(second)].filter(Boolean)).toHaveLength(1);
});
