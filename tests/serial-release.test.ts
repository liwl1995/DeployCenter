import { describe, expect, it, vi } from 'vitest';
import { createTask } from '../src/engine';
import { seed, type Task } from '../src/model';
import type { Approval, DesktopAPI, PrepareRequest, Startup } from '../src/platform';
import { SerialRelease } from '../src/serial-release';

const approval: Approval = { productionWord: '', productionNames: {}, allowWeak: false, protectCurrent: true };

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
  const journal = new Map<string, string>();
  const store = { getItem: (key: string) => journal.get(key) ?? null, setItem: (key: string, value: string) => journal.set(key, value) };
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
    load: async () => ({ unfinished: [...tasks.values()].filter((task) => task.status === 'interrupted') } as Startup),
  };
  const make = () => new SerialRelease(api, store, 'release');
  const release = make();
  const last = () => [...tasks.values()].at(-1)!;
  const end = (status: Exclude<Task['status'], 'running' | 'cancelling'>, task = last()) => {
    task.status = status;
    task.targets[0].status = status === 'interrupted' ? 'unknown' : status === 'partial' ? 'failed' : status;
    task.elapsed = 12;
    release.observe(structuredClone(task));
  };
  async function begin(policy: PrepareRequest['failurePolicy']) {
    release.begin(await release.preview(requests), { [db.servers[0].id]: 'memory-only' }, approval, policy);
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  }
  return { begin, release, make, last, end, start, cancel, requests, prepare, services, journal };
}

describe('串行发布清单', () => {
  it.each(['stop', 'continue'] as const)('按清单策略 %s 处理失败，单服务目标策略仍沿用配置', async (policy) => {
    const f = fixture();
    await f.begin(policy);
    expect(f.prepare).toHaveBeenCalledTimes(3);
    expect(f.last().service.id).toBe(f.requests[0].serviceId);
    expect(f.last().failurePolicy).toBe('stop');
    f.end('failed');
    if (policy === 'stop') {
      await vi.waitFor(() => expect(f.release.get()?.state).toBe('done'));
      expect(f.release.get()?.rows.map((row) => row.state)).toEqual(['failed', 'skipped']);
      expect(f.start).toHaveBeenCalledTimes(1);
    } else {
      await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
      expect(f.last().service.id).toBe(f.requests[1].serviceId);
      f.end('success');
      await vi.waitFor(() => expect(f.release.get()?.message).toBe('部分成功'));
    }
    expect(f.journal.get('release')).not.toContain('memory-only');
  });

  it('重启后暂停，核实原任务并重新确认后才发布剩余服务', async () => {
    const f = fixture();
    await f.begin('continue');
    const recovered = f.make();
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
    recovered.begin(await recovered.preview(f.requests.slice(1)), {}, approval, 'continue', true);
    await vi.waitFor(() => expect(f.start).toHaveBeenCalledTimes(2));
  });

  it('暂停时保留中断现场，取消等任务结束并跳过后续服务', async () => {
    const interrupted = fixture();
    await interrupted.begin('continue');
    interrupted.end('interrupted');
    await vi.waitFor(() => expect(interrupted.release.get()?.state).toBe('paused'));
    expect(interrupted.start).toHaveBeenCalledTimes(1);
    interrupted.release.end();
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
    f.release.begin(previews, {}, approval, 'stop');
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledTimes(3));
    await f.release.cancel();
    releaseCheck();
    await vi.waitFor(() => expect(f.release.get()?.message).toBe('已取消'));
    expect(f.release.get()?.rows.map((row) => row.state)).toEqual(['skipped', 'skipped']);
    expect(f.start).not.toHaveBeenCalled();
  });
});
