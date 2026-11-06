// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import { Storage } from '../electron/storage';
import { Controller } from '../electron/controller';
import type { resolveBuild } from '../electron/files';
import type { WorkerMessage, ControlMessage } from '../electron/contracts';
import { seed, type Task } from '../src/model';
import { taskNotice, taskProgress, taskWindowTitle } from '../src/presentation';
import { MemoryCredentials } from '../electron/native-capabilities';
const fixtures: { dir: string; store: Storage }[] = [];
async function fixture() {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'v120-gate-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  db.services[0].root = dir;
  db.services[0].jarDir = '.';
  db.services[0].jarName = 'fixture.jar';
  store.saveConfig(db);
  await store.settle();
  fixtures.push({ dir, store });
  return { dir, store };
}
afterEach(async () => {
  for (const { dir, store } of fixtures.splice(0)) {
    await store.settle();
    store.close();
    if (!dir.startsWith(path.resolve('.test-data') + path.sep)) throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
const approval = { productionWord: '', allowWeak: true, protectCurrent: true };
it('确认后 JDK 失效仍由主进程拦截，完成回调失败不影响结果且清除内存凭据', async () => {
  const { dir, store } = await fixture(),
    db = store.database();
  db.servers.find((s) => s.id === db.targets[0].serverId)!.auth = 'password';
  store.saveConfig(db);
  let valid = true,
    workers = 0,
    message: (m: WorkerMessage) => void = () => {};
  const resolve: typeof resolveBuild = async () => {
    if (!valid) throw new Error('JDK 已不可用');
    return {
      tool: 'fixture',
      args: [],
      cwd: dir,
      env: { JAVA_HOME: dir, PATH: '' },
      java: 'fixture-java',
      jdkPath: dir,
      run: async () => ({ code: 0, stdout: '', stderr: '', successMarker: true }),
    };
  };
  const c = new Controller(
    store,
    (callback) => {
      workers++;
      message = callback;
      return { send() {}, close() {} };
    },
    () => {},
    {
      resolveBuild: resolve,
      onFinished: () => {
        throw new Error('通知失败');
      },
    },
  );
  const prepared = await c.prepare({
    serviceId: db.services[0].id,
    targetIds: [db.targets[0].id],
    build: 'rebuild',
    overrides: {},
    failurePolicy: 'stop',
    note: '本次优化说明',
  });
  valid = false;
  await expect(c.start(prepared.token, {}, approval)).rejects.toThrow('JDK 已不可用');
  expect(workers).toBe(0);
  valid = true;
  const secret = 'memory-fixture-only',
    serverId = db.targets[0].serverId;
  const started = await c.start(prepared.token, { [serverId]: secret }, approval);
  expect(c.credentialFor(serverId)).toBe(secret);
  started.status = 'failed';
  started.targets[0].status = 'failed';
  started.endedAt = Date.now();
  message({ kind: 'done', task: started });
  expect(c.credentialFor(serverId)).toBeUndefined();
  expect(store.task(started.id)?.status).toBe('failed');
  expect(store.database().history[0].note).toBe('本次优化说明');
  expect(JSON.stringify(store.task(started.id))).not.toContain(secret);
});
it('多个正式目标逐项确认，通用 DEPLOY 或只填写一项都不能启动', async () => {
  const { store, dir } = await fixture(),
    db = store.database(),
    original = db.targets[0];
  original.production = true;
  db.targets.push({
    ...structuredClone(original),
    id: 'second-production',
    name: '第二正式环境',
    directory: '/fixture/second',
  });
  store.saveConfig(db);
  const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
  await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
  await fs.writeFile(
    path.join(dir, 'fixture.jar'),
    Buffer.from(await (await zip.close()).arrayBuffer()),
  );
  const sent: ControlMessage[] = [];
  let receive: (m: WorkerMessage) => void = () => {};
  const c = new Controller(
    store,
    (callback) => {
      receive = callback;
      return { send: (m) => sent.push(m), close() {} };
    },
    () => {},
  );
  const p = await c.prepare({
    serviceId: db.services[0].id,
    targetIds: [original.id, 'second-production'],
    build: 'existing',
    ...(process.platform === 'win32' ? {} : { jarPath: path.join(dir, 'fixture.jar') }),
    overrides: {},
    failurePolicy: 'stop',
  });
  await expect(c.start(p.token, {}, { ...approval, productionWord: 'DEPLOY' })).rejects.toThrow(
    '环境名称',
  );
  await expect(
    c.start(p.token, {}, { ...approval, productionNames: { [original.id]: original.name } }),
  ).rejects.toThrow('环境名称');
  expect(sent).toHaveLength(0);
  const started = await c.start(
    p.token,
    {},
    {
      ...approval,
      productionNames: { [original.id]: original.name, 'second-production': '第二正式环境' },
    },
  );
  expect(sent).toHaveLength(1);
  started.status = 'cancelled';
  started.endedAt = Date.now();
  for (const r of started.targets) r.status = 'cancelled';
  receive({ kind: 'done', task: started });
});
it('通知使用结果和原因白名单，标题与任务栏进度不泄漏备注、命令或凭据', async () => {
  const { store } = await fixture(),
    db = store.database();
  const { createTask } = await import('../src/engine');
  const t: Task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing');
  t.service.name = '服务 secret-value';
  t.note = 'private-note';
  t.buildContext.command = 'secret-command';
  t.targets[0].error = '健康检查失败 password=secret-value';
  t.status = 'running';
  t.buildPhase = 3;
  expect(taskWindowTitle(t)).toContain('部署中 1/1');
  expect(taskProgress(t)).toBeGreaterThanOrEqual(0);
  t.status = 'failed';
  const redactor = new MemoryCredentials({ active: 'secret-value' });
  const body = taskNotice(t, (text) => redactor.redact(text));
  redactor.clear();
  expect(body).toContain('应用未在等待窗口内就绪');
  expect(body).not.toContain('secret-value');
  expect(body).not.toContain('private-note');
  expect(body).not.toContain('secret-command');
  expect(taskProgress(t)).toBe(-1);
  expect(taskWindowTitle(t)).toBe('YOTOO 部署中心');
  t.dryRun = true;
  t.status = 'success';
  expect(taskNotice(t)).toContain('检查通过');
});
