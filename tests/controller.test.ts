// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '../electron/storage';
import { Controller } from '../electron/controller';
import { seed } from '../src/model';
import { BlobWriter, ZipWriter, TextReader } from '@zip.js/zip.js';
import type { ControlMessage, WorkerMessage } from '../electron/contracts';
const created: { store: Storage; dir: string }[] = [];
async function fixture() {
  const base = path.resolve('.test-data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'controller-'));
  const store = new Storage(dir, {
    encrypt: async (s) => Buffer.from(s),
    decrypt: async (b) => b.toString(),
  });
  const db = seed();
  db.history = [];
  db.taskHistory = {};
  store.saveConfig(db);
  created.push({ store, dir });
  return store;
}
afterEach(async () => {
  for (const { store, dir } of created.splice(0)) {
    store.close();
    if (!path.resolve(dir).startsWith(path.resolve('.test-data') + path.sep))
      throw new Error('测试目录越界');
    await fs.rm(dir, { recursive: true, force: true });
  }
});
describe('主进程任务确认与持久化边界', () => {
  it('未知服务、其他服务目标、重复目标均在 worker 启动前拒绝', async () => {
    const storage = await fixture();
    let workers = 0;
    const c = new Controller(
      storage,
      () => {
        workers++;
        return { send() {}, close() {} };
      },
      () => {},
    );
    const request = {
      serviceId: 'missing',
      targetIds: ['t19'],
      build: 'existing',
      overrides: {},
      failurePolicy: 'stop',
    };
    await expect(c.prepare(request)).rejects.toThrow('服务');
    await expect(c.prepare({ ...request, serviceId: 'crm', targetIds: ['t72'] })).rejects.toThrow(
      '不属于',
    );
    await expect(
      c.prepare({ ...request, serviceId: 'crm', targetIds: ['t19', 't19'] }),
    ).rejects.toThrow();
    expect(workers).toBe(0);
  });
  it('确认 token 缺失或过期不能启动任务', async () => {
    const storage = await fixture();
    const c = new Controller(
      storage,
      () => {
        throw new Error('不应创建 worker');
      },
      () => {},
    );
    await expect(
      c.start(
        'not-issued',
        {},
        { productionWord: 'DEPLOY', allowWeak: true, protectCurrent: true },
      ),
    ).rejects.toThrow('确认已过期');
  });
  it('正式与弱校验确认由主进程拦截；状态先存储，再发事件，崩溃不自动继续', async () => {
    const storage = await fixture(),
      db = storage.database(),
      dir = created.at(-1)!.dir;
    db.services[0].root = dir;
    db.services[0].jarDir = '.';
    db.services[0].jarName = 'fixture.jar';
    db.targets[0].production = true;
    db.targets[0].hashPolicy = 'size-confirm';
    storage.saveConfig(db);
    const zip = new ZipWriter(new BlobWriter(), { useWebWorkers: false });
    await zip.add('META-INF/MANIFEST.MF', new TextReader('Manifest-Version: 1.0\r\n'));
    await fs.writeFile(
      path.join(dir, 'fixture.jar'),
      Buffer.from(await (await zip.close()).arrayBuffer()),
    );
    let callback: (m: WorkerMessage) => void = () => {},
      exit = () => {},
      workers = 0;
    const calls: ControlMessage[] = [];
    const c = new Controller(
      storage,
      (onMessage, onExit) => {
        workers++;
        callback = onMessage;
        exit = onExit;
        return { send: (m) => calls.push(m), close() {} };
      },
      (event) => {
        if (event.kind === 'task')
          expect(storage.task(event.task.id)?.status).toBe(event.task.status);
      },
    );
    const prepared = await c.prepare({
      serviceId: 'crm',
      targetIds: ['t19'],
      build: 'existing',
      overrides: {},
      failurePolicy: 'stop',
    });
    await expect(
      c.start(prepared.token, {}, { productionWord: '', allowWeak: true, protectCurrent: true }),
    ).rejects.toThrow('DEPLOY');
    await expect(
      c.start(
        prepared.token,
        {},
        { productionWord: 'DEPLOY', allowWeak: false, protectCurrent: true },
      ),
    ).rejects.toThrow('弱校验');
    expect(workers).toBe(0);
    const started = await c.start(
      prepared.token,
      {},
      { productionWord: 'DEPLOY', allowWeak: true, protectCurrent: true },
    );
    expect(c.active()).toBe(true);
    expect(calls[0].kind).toBe('begin');
    started.targets[0].status = 'running';
    callback({ kind: 'snapshot', task: started });
    exit();
    expect(c.active()).toBe(false);
    expect(storage.task(started.id)?.status).toBe('interrupted');
    expect(storage.task(started.id)?.targets[0].status).toBe('unknown');
  });
  it('只有用户确认首次主机指纹才写信任记录，变更指纹禁止忽略', async () => {
    const storage = await fixture();
    const c = new Controller(
      storage,
      () => ({ send() {}, close() {} }),
      () => {},
    );
    const request = {
      id: 'one',
      server: 'test',
      endpoint: '127.0.0.1:10022',
      fingerprint: 'SHA256:test',
      changed: false,
    };
    const pending = c.trust.request(request, 'fixture-key');
    expect(storage.pins()).toEqual({});
    c.trust.answer('one', true);
    expect(await pending).toBe(true);
    expect(storage.pins()[request.endpoint].key).toBe('fixture-key');
    const changed = c.trust.request({ ...request, id: 'two', changed: true }, 'different-key');
    expect(() => c.trust.answer('two', true, 'TRUST')).toThrow('禁止');
    c.trust.answer('two', false);
    expect(await changed).toBe(false);
    expect(storage.pins()[request.endpoint].key).toBe('fixture-key');
  });
});
