// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTask } from '../src/engine';
import { seed, type Task } from '../src/model';
import type { Approval, DesktopAPI, PrepareRequest } from '../src/platform';
import { SerialRelease } from '../electron/serial-release';
import { Storage } from '../electron/storage';
import { DataDirectory, migrationDestination } from '../electron/data-directory';
import { Controller } from '../electron/controller';
import { ReleaseScheduler, scheduleConfiguration, schedulePins } from '../electron/scheduler';
import type { ReleaseSchedule } from '../src/schedules';
import type { WorkerMessage, WorkerInput } from '../electron/contracts';

const approval: Approval = { productionWord: '', productionNames: {}, allowWeak: false, protectCurrent: true };
const base = path.resolve('.test-data');
const directories: string[] = [];
const stores: Storage[] = [];
const crypto = { encrypt: async (secret: string) => Buffer.from(secret), decrypt: async (secret: Buffer) => secret.toString() };

function openStorage(dir: string) {
  const storage = new Storage(dir, crypto);
  stores.push(storage);
  return storage;
}

afterEach(async () => {
  for (const store of stores.splice(0)) {
    if (store.isOpen()) await store.settle();
    store.close();
  }
  for (const dir of directories.splice(0)) {
    const resolved = fs.realpathSync(dir);
    if (!resolved.startsWith(fs.realpathSync(base) + path.sep)) throw new Error('测试目录越界');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function fixture() {
  const db = seed();
  const services = [db.services[0], { ...db.services[0], id: 'second', name: '服务二' }];
  const targets = services.map((service, index) => ({
    ...db.targets[0], id: 'release-target-' + index, production: false, serviceId: service.id,
  }));
  const requests = services.map((service, i): PrepareRequest => ({
    serviceId: service.id, targetIds: [targets[i].id], build: 'rebuild', overrides: {}, failurePolicy: 'stop',
  }));
  const snapshots = new Map<string, Task>();
  const tasks = new Map<string, Task>();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, 'serial-release-'));
  directories.push(dir);
  const store = openStorage(dir);
  const prepare = vi.fn(async (request: PrepareRequest) => {
    const index = services.findIndex((service) => service.id === request.serviceId);
    const task = createTask(db, services[index], [targets[index]], request.overrides, request.build);
    const token = 'token-' + snapshots.size;
    task.id = 'task-' + snapshots.size;
    snapshots.set(token, task);
    return { task, token };
  });
  const start = vi.fn<DesktopAPI['start']>(async (token) => {
    const task = structuredClone(snapshots.get(token)!);
    tasks.set(task.id, task);
    return task;
  });
  const cancel = vi.fn<DesktopAPI['cancel']>(async () => {});
  const api = {
    prepare, start, cancel, readTask: async (id: string) => structuredClone(tasks.get(id)!),
    unfinished: () => [...tasks.values()].some((task) => task.status === 'interrupted'),
    active: () => false,
    blocked: () => undefined,
  };
  const make = (storage = store) => new SerialRelease(api, (run) => storage.saveReleaseRun(run), () => {}, storage.releaseRun());
  const release = make();
  const last = () => [...tasks.values()].at(-1)!;
  const end = (status: Exclude<Task['status'], 'running' | 'cancelling'>, task = last()) => {
    task.status = status;
    task.targets[0].status = status === 'interrupted' ? 'unknown' : status === 'partial' ? 'failed' : status;
    task.elapsed = 12;
    release.observe(structuredClone(task));
  };
  async function begin(policy: PrepareRequest['failurePolicy']) {
    const review = await release.preview(requests);
    release.begin(review.token, { [db.servers[0].id]: 'memory-only' }, approval, policy, false);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  }
  return { begin, release, make, last, end, start, cancel, requests, prepare, services, store, dir, db };
}

describe('串行发布清单', () => {
  it('旧窗口记录只导入一次，数据目录切换后从 SQLite 打开暂停状态', async () => {
    const f = fixture();
    const legacy = {
      state: 'running', message: '', failurePolicy: 'stop',
      rows: [{ request: f.requests[0], name: '服务一', targets: ['测试'], state: 'queued' }],
    };
    expect(() => f.release.importLegacy('{"rows":[]}')).toThrow();
    expect(f.store.releaseRun()).toBeUndefined();
    f.release.importLegacy(JSON.stringify({ ...legacy, credentials: { sample: 'must-not-persist' } }));
    f.release.importLegacy(JSON.stringify({ ...legacy, state: 'done' }));
    expect(f.store.releaseRun()).toMatchObject({ state: 'paused' });
    expect(JSON.stringify(f.store.releaseRun())).not.toContain('must-not-persist');
    expect(f.start).not.toHaveBeenCalled();
    const parent = fs.mkdtempSync(path.join(base, 'serial-release-moved-'));
    directories.push(parent);
    const settings = path.join(parent, 'control');
    const locator = new DataDirectory(settings, f.dir);
    await locator.locate();
    locator.markOwned(f.dir);
    const moved = migrationDestination(parent);
    await locator.migrate(moved, () => undefined, () => f.store.pause(), () => f.store.resume(), () => {});
    expect((await new DataDirectory(settings, f.dir).locate()).directory).toBe(moved);
    const recovered = f.make(openStorage(moved));
    expect(recovered.get()).toMatchObject({ state: 'paused', rows: [{ state: 'queued' }] });
    expect(f.start).not.toHaveBeenCalled();
  });

  it('确认由主进程保存，过期或替换的确认无法认领执行权', async () => {
    const f = fixture();
    const first = await f.release.preview(f.requests);
    const second = await f.release.preview(f.requests);
    expect(() => f.release.begin(first.token, {}, approval, 'continue', false)).toThrow('确认已过期');
    expect(f.release.active()).toBe(false);
    f.release.begin(second.token, {}, approval, 'continue', false);
    expect(f.release.active()).toBe(true);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(1));
  });

  it('两项服务之间没有 worker 时，手动部署和到点的定时发布仍需等待', async () => {
    const f = fixture();
    for (const server of f.db.servers) server.auth = 'alias';
    for (const service of f.services) service.root = f.dir;
    f.db.services = f.services;
    f.db.targets = f.services.map((service, index) => ({
      ...f.db.targets[0], id: f.requests[index].targetIds[0], serviceId: service.id, production: false,
    }));
    f.store.saveConfig(f.db);
    const workers: { input: WorkerInput; report: (message: WorkerMessage) => void; exit: () => void }[] = [];
    const controller = new Controller(f.store, (report, exit) => ({
      send(message) { if (message.kind === 'begin') workers.push({ input: message.value, report, exit }); },
      close() {},
    }), (event) => {
      if (event.kind === 'task' && event.committed) release.observe(event.task);
    }, {
      releaseActive: () => release.active(),
      resolveBuild: async () => ({
        tool: 'mvn', args: [], cwd: f.dir, java: 'java', jdkPath: f.dir, env: { JAVA_HOME: f.dir, PATH: '' },
        run: async () => { throw new Error('此测试不启动 Maven'); },
      }),
    });
    let unblock!: () => void;
    const between = new Promise<void>((resolve) => { unblock = resolve; });
    const release: SerialRelease = new SerialRelease({
      async prepare(request, owned) {
        if (owned && request.serviceId === f.requests[1].serviceId) await between;
        return controller.prepare(request, owned);
      },
      start: (token, credentials, value) => controller.start(token, credentials, value, undefined, true),
      cancel: (id) => controller.cancel(id),
      readTask: (id) => f.store.task(id),
      active: () => controller.active(),
      unfinished: () => f.store.unfinished().length > 0,
      blocked: () => scheduler.isDispatching() ? '定时发布正在启动' : undefined,
    }, (run) => f.store.saveReleaseRun(run), () => {});
    const scheduler = new ReleaseScheduler(f.store, controller, release.active, () => {}, () => 1_000_000, () => 1_000_000);
    const task = createTask(f.db, f.services[1], [f.db.targets[1]], {}, 'existing');
    const plan: ReleaseSchedule = {
      id: 'SP-release', state: 'ready', reason: '', createdAt: 1, scheduledAt: 1_000_000,
      preparationId: task.id, task, approval,
      configuration: scheduleConfiguration(f.db, task), pins: schedulePins(task, {}),
    };
    f.store.saveSchedule(plan);
    const manual = await controller.prepare(f.requests[0]);
    const review = await release.preview(f.requests);
    release.begin(review.token, {}, approval, 'continue', false);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    const complete = (index: number) => {
      const { input, report } = workers[index];
      const result = structuredClone(input.task);
      result.status = 'success';
      result.targets[0].status = 'success';
      report({ kind: 'done', task: result });
    };
    try {
      complete(0);
      expect(controller.active()).toBe(false);
      expect(release.active()).toBe(true);
      await expect(controller.prepare(f.requests[0])).rejects.toThrow('串行发布清单');
      await expect(controller.start(manual.token, {}, approval)).rejects.toThrow('串行发布清单');
      await expect(controller.startScheduled(plan)).rejects.toThrow('串行发布清单');
      await scheduler.tick();
      expect(f.store.schedules()[0].state).toBe('waiting');
      expect(workers).toHaveLength(1);
    } finally { unblock(); }
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[0].exit();
    expect(controller.active()).toBe(true);
    complete(1);
    await vi.waitFor(() => expect(release.get()?.message).toBe('全部成功'));
    expect(release.active()).toBe(false);
    await expect(controller.prepare(f.requests[0])).resolves.toHaveProperty('token');
  });

  it.each([
    ['failed', 'failed', '发布失败'],
    ['failed', 'partial', '部分成功'],
    ['failed', 'success', '部分成功'],
    ['success', 'success', '全部成功'],
    ['failed', 'cancelled', '已取消'],
  ] as const)('首个服务 %s、最后一个服务 %s，直接完成与核实后完成均显示「%s」', async (first, last, message) => {
    for (const interrupted of [false, true]) {
      const f = fixture();
      await f.begin('continue');
      f.end(first);
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
      if (interrupted) {
        f.end('interrupted');
        await vi.waitFor(() => expect(f.release.get()).toMatchObject({ state: 'paused', rows: [{ state: first }, { state: 'unknown' }] }));
      }
      f.end(last);
      if (interrupted) await f.release.check();
      await vi.waitFor(() => expect(f.release.get()?.state).toBe('done'));
      expect(f.release.get()?.rows.map((row) => row.state)).toEqual([first, last]);
      expect(f.release.get()?.message).toBe(message);
      expect(f.start).toHaveBeenCalledTimes(2);
    }
  });

  it.each(['stop', 'continue'] as const)('按清单策略 %s 处理失败，单服务目标策略仍沿用配置', async (policy) => {
    const f = fixture();
    await f.begin(policy);
    expect(f.prepare).toHaveBeenCalledTimes(3);
    expect(f.last().service.id).toBe(f.requests[0].serviceId);
    expect(f.last().failurePolicy).toBe('stop');
    f.end('failed');
    if (policy === 'stop') {
      await vi.waitFor(() => expect(f.release.get()?.state).toBe('done'));
      expect(f.release.get()?.message).toBe('发布失败');
      expect(f.release.get()?.rows.map((row) => row.state)).toEqual(['failed', 'skipped']);
      expect(f.start).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
      expect(f.last().service.id).toBe(f.requests[1].serviceId);
      f.end('success');
      await vi.waitFor(() => expect(f.release.get()?.message).toBe('部分成功'));
    }
    expect(JSON.stringify(f.store.releaseRun())).not.toContain('memory-only');
  });

  it('重启后暂停，核实原任务并重新确认后才发布剩余服务', async () => {
    const f = fixture();
    await f.begin('continue');
    f.store.close();
    const recovered = f.make(openStorage(f.dir));
    expect(recovered.get()?.state).toBe('paused');
    f.last().status = 'interrupted';
    f.last().targets[0].status = 'unknown';
    await recovered.check();
    expect(recovered.get()?.rows[0].state).toBe('unknown');
    expect(f.start).toHaveBeenCalledTimes(1);
    f.last().status = 'success';
    f.last().targets[0].status = 'success';
    await recovered.check();
    expect(recovered.get()?.rows.map((row) => row.state)).toEqual(['success', 'queued']);
    const review = await recovered.preview(f.requests.slice(1));
    recovered.begin(review.token, {}, approval, 'continue', true);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  });

  it('暂停时保留中断现场，取消等任务结束并跳过后续服务', async () => {
    const interrupted = fixture();
    await interrupted.begin('continue');
    interrupted.end('interrupted');
    await vi.waitFor(() => expect(interrupted.release.get()?.state).toBe('paused'));
    expect(interrupted.start).toHaveBeenCalledTimes(1);
    interrupted.release.end();
    expect(interrupted.release.get()).toMatchObject({ state: 'done', message: '已结束 · 保留原任务状态' });
    expect(interrupted.release.get()?.rows.map((row) => row.state)).toEqual(['unknown', 'skipped']);
    const cancelled = fixture();
    await cancelled.begin('continue');
    await cancelled.release.cancel();
    expect(cancelled.cancel).toHaveBeenCalledWith(cancelled.last().id);
    cancelled.end('success');
    await vi.waitFor(() => expect(cancelled.release.get()?.message).toBe('已取消'));
    expect(cancelled.release.get()?.rows.map((row) => row.state)).toEqual(['success', 'skipped']);
    expect(cancelled.start).toHaveBeenCalledTimes(1);
  });

  it('取消途中断线并重启，核实原任务后仍按取消收尾', async () => {
    const f = fixture();
    await f.begin('continue');
    await f.release.cancel();
    f.end('interrupted');
    await vi.waitFor(() => expect(f.release.get()?.state).toBe('paused'));
    f.store.close();
    const recovered = f.make(openStorage(f.dir));
    f.end('success');
    await recovered.check();
    expect(recovered.get()).toMatchObject({ state: 'done', message: '已取消', rows: [{ state: 'success' }, { state: 'skipped' }] });
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('服务设置变化后需重新确认，不用旧确认启动', async () => {
    const f = fixture();
    await f.begin('continue');
    f.services[1].git = { ...f.services[1].git, commit: 'changed' };
    f.end('success');
    await vi.waitFor(() => expect(f.release.get()?.state).toBe('paused'));
    expect(f.release.get()?.message).toContain('配置或产物已变化');
    expect(f.start).toHaveBeenCalledTimes(1);
  });

  it('启动前正在重新检查时取消，两个服务都不会启动', async () => {
    const f = fixture();
    const previews = await f.release.preview(f.requests);
    const original = f.prepare.getMockImplementation()!;
    let releaseCheck!: () => void;
    const wait = new Promise<void>((resolve) => { releaseCheck = resolve; });
    f.prepare.mockImplementationOnce(async (request) => { await wait; return original(request); });
    f.release.begin(previews.token, {}, approval, 'stop', false);
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(3));
    await f.release.cancel();
    releaseCheck();
    await vi.waitFor(() => expect(f.release.get()?.message).toBe('已取消'));
    expect(f.release.get()?.rows.map((row) => row.state)).toEqual(['skipped', 'skipped']);
    expect(f.start).not.toHaveBeenCalled();
  });
});
