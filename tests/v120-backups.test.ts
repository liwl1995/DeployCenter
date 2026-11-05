// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import Sqlite from 'better-sqlite3';
import { Storage } from '../electron/storage';
import { BackupManager, cleanupBackupsScript } from '../electron/backup-manager';
import { createTask } from '../src/engine';
import { seed, type Task } from '../src/model';
import type { Transport } from '../electron/ssh';
import { canRollback } from '../src/records';
const roots: { dir: string; store: Storage }[] = [];
afterEach(async () => {
  for (const { dir, store } of roots.splice(0)) {
    await store.settle();
    store.close();
    if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
async function fixture() {
  await fs.mkdir('.test-data', { recursive: true });
  const dir = await fs.mkdtemp(path.resolve('.test-data/v120-backups-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  roots.push({ dir, store });
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  db.targets[0].backup.directory = 'backups';
  db.targets[0].backup.keepLast = 1;
  store.saveConfig(db);
  const target = db.targets[0];
  const tasks: Task[] = [];
  for (let i = 0; i < 3; i++) {
    const t = createTask(db, db.services[0], [target], {}, 'existing');
    t.id = 'DC-backup-' + i;
    t.status = 'success';
    t.targets[0].status = 'unverified';
    const r = t.targets[0];
    r.backupCreated = true;
    r.backupPath = r.plannedBackupPath = target.directory + '/backups/owned-' + i + '.jar';
    r.backupHash = String(i + 1).repeat(64);
    r.backupSize = 1024;
    store.complete(t);
    tasks.push(t);
  }
  await store.settle();
  let output = 'success';
  const scripts: string[] = [];
  const transport = {
    connect: async () => {},
    close() {},
    exec: async (_: string, opts: { input: string }) => {
      scripts.push(opts.input);
      if (!opts.input.includes('check_file()'))
        return {
          code: 0,
          stdout: store.remoteBackups
            .records()
            .map((r) => `${r.id}\tFILE\t1024 100`)
            .join('\n'),
          stderr: '',
        };
      const ids = store.remoteBackups
        .records()
        .filter((r) => opts.input.includes(r.id))
        .map((r) => r.id);
      return output === 'unknown'
        ? { code: 255, stdout: '', stderr: 'connection secret-fixture lost' }
        : {
            code: 0,
            stdout: 'VERIFIED\n' + ids.map((id) => 'DELETED\t' + id).join('\n') + '\nFINISHED\n',
            stderr: '',
          };
    },
  } as unknown as Transport;
  const manager = new BackupManager(
    store,
    () => transport,
    () => {},
  );
  return {
    store,
    target,
    tasks,
    manager,
    scripts,
    outcome: (value: string) => {
      output = value;
    },
  };
}
it('来源证明独立于历史保留；最新备份保护，导入历史不能冒领，损坏来源原样保留', async () => {
  const { store, target, manager } = await fixture();
  const sql = new Sqlite(path.join(store.dataDir, 'deploy-center.sqlite'));
  sql.prepare("DELETE FROM tasks WHERE id='DC-backup-0'").run();
  expect(store.remoteBackups.records()).toHaveLength(3);
  const p = await manager.preview(target.id, '');
  expect(p.entries.filter((e) => e.selected)).toHaveLength(2);
  expect(p.entries[0].protectedReason).toContain('最近');
  sql.prepare('UPDATE remote_backups SET json=? WHERE id=?').run('{broken', p.entries[1].id);
  expect(store.remoteBackups.records()).toHaveLength(2);
  expect(store.remoteBackups.issues).toHaveLength(1);
  sql.close();
  const t = createTask(store.database(), store.database().services[0], [target], {}, 'existing');
  store.saveTask(t);
  expect(store.remoteBackups.records()).toHaveLength(2);
  manager.close();
});
it('必须命中原清单与环境名；只删除确认文件并记录审计，历史备份标记不可回滚', async () => {
  const { store, target, manager, scripts } = await fixture();
  const db = store.database();
  db.targets[0].production = true;
  store.saveConfig(db);
  const p = await manager.preview(target.id, 'secret-fixture'),
    selected = p.entries.filter((e) => e.selected).map((e) => e.id);
  await expect(manager.apply(p.token, selected, 'DEPLOY')).rejects.toThrow('环境名称');
  await expect(manager.apply(p.token, [p.entries[0].id], target.name)).rejects.toThrow('受保护');
  expect(scripts).toHaveLength(1);
  const result = await manager.apply(p.token, selected, target.name);
  expect(result.status).toBe('success');
  expect(result.deleted).toHaveLength(2);
  expect(store.summaries().some((r) => r.maintenance?.id === result.id)).toBe(true);
  const changed = store
    .database()
    .history.filter((h) => result.deleted.includes(h.backupPath || ''));
  expect(changed).toHaveLength(2);
  expect(changed.every((h) => h.backupRemoved && !canRollback(store.database(), h))).toBe(true);
  expect(JSON.stringify(store.remoteBackups.audits())).not.toContain('secret-fixture');
  expect(scripts[1]).not.toMatch(/rm\s+-rf/);
  expect(scripts[1]).toContain('check_file');
  expect(scripts[1]).toContain('mkdir -m 700');
  manager.close();
});
it('运行和中断任务的回滚来源保护，状态变化后旧清单不能执行', async () => {
  const { store, target, manager, tasks, scripts } = await fixture();
  const p = await manager.preview(target.id, '');
  const t = structuredClone(tasks[0]);
  t.id = 'DC-interrupted-reference';
  t.status = 'interrupted';
  t.operation = 'rollback';
  t.sourceBackup = tasks[0].targets[0].backupPath;
  store.saveTask(t);
  await expect(
    manager.apply(
      p.token,
      p.entries.filter((e) => e.selected).map((e) => e.id),
      '',
    ),
  ).rejects.toThrow('状态已变化');
  expect(scripts).toHaveLength(1);
  const next = await manager.preview(target.id, '');
  expect(next.entries.find((e) => e.path === t.sourceBackup)?.protectedReason).toContain('中断');
  manager.close();
});
it('断线保留待核实审计且脱敏；核实仅发送只读脚本', async () => {
  const { store, target, manager, scripts, outcome } = await fixture();
  const p = await manager.preview(target.id, 'secret-fixture');
  outcome('unknown');
  const result = await manager.apply(
    p.token,
    p.entries.filter((e) => e.selected).map((e) => e.id),
    '',
  );
  expect(result.status).toBe('unknown');
  expect(result.message).not.toContain('secret-fixture');
  expect(store.remoteBackups.records().every((r) => !r.removed)).toBe(true);
  const protectedPlan = await manager.preview(target.id, '');
  expect(protectedPlan.entries.filter((e) => e.selected)).toHaveLength(0);
  await manager.reconcile(result.id, '');
  expect(scripts.at(-1)).not.toContain('rm -');
  expect(scripts.at(-1)).not.toContain('mkdir');
  manager.close();
});
it('清理脚本拒绝目录穿越与外部文件，仅固定目录内单文件，校验失败先于删除', () => {
  const target = seed().targets[0],
    entry = {
      id: 'a'.repeat(64),
      path: '/safe/backups/a.jar',
      hash: 'b'.repeat(64),
      size: 4,
      modified: 100,
    };
  for (const file of ['/outside/a.jar', '/safe/backups/../a.jar', '/safe/backups/a.jar\n'])
    expect(() =>
      cleanupBackupsScript(target, '/safe/backups', 'DC-CLEAN-test', [{ ...entry, path: file }]),
    ).toThrow('范围');
  const script = cleanupBackupsScript(target, '/safe/backups', 'DC-CLEAN-test', [entry]);
  expect(script.indexOf('VERIFIED')).toBeLessThan(script.indexOf("rm -f -- './a.jar'"));
  expect(script).toContain('cd -P');
  expect(script).toContain('[ ! -L "$1" ]');
});
it.skipIf(process.platform !== 'win32' && !process.env.DEPLOY_CENTER_TEST_BASH)(
  '生成的远程清理脚本通过真实 Bash 语法检查（不执行删除）',
  async () => {
    const { store, target, manager } = await fixture(),
      records = store.remoteBackups.records();
    const script = cleanupBackupsScript(target, target.directory + '/backups', 'DC-CLEAN-syntax', [
      {
        id: records[1].id,
        path: records[1].path,
        size: records[1].size,
        modified: 100,
        hash: records[1].hash!,
      },
    ]);
    const { runProcess } = await import('../electron/process');
    const file = path.join(store.dataDir, 'syntax.sh');
    await fs.writeFile(file, script);
    const result = await runProcess(
      process.env.DEPLOY_CENTER_TEST_BASH || 'E:/dev/git/bin/bash.exe',
      ['-n', file.replace(/\\/g, '/')],
      { timeout: 10000 },
    );
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    manager.close();
  },
);
