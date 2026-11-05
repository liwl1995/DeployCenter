// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { LogSessions, observeTask } from '../electron/observation';
import type { Channel, Transport } from '../electron/ssh';
import type { DesktopEvent } from '../src/platform';
import { createTask } from '../src/engine';
import { seed } from '../src/model';
const created: LogSessions[] = [];
afterEach(() => {
  for (const s of created.splice(0)) s.closeAll();
  vi.useRealTimers();
});
function transport(immediate = false) {
  const output = new PassThrough(),
    error = new PassThrough(),
    input = new PassThrough();
  let resolve: (value: number) => void = () => {};
  const done = new Promise<number>((r) => {
    resolve = r;
  });
  const channel: Channel = {
    output,
    error,
    input,
    done,
    stop: vi.fn(() => {
      output.end();
      error.end();
      resolve(0);
    }),
  };
  const remote = {
    connect: vi.fn().mockResolvedValue(undefined),
    channel: vi.fn(async () => {
      if (immediate) {
        output.end('secret-fixture\n');
        error.end('password=another-secret\n');
        resolve(0);
      }
      return channel;
    }),
    close: vi.fn(),
  } as unknown as Transport;
  return { remote, channel, output, error, resolve };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
it('连接快速结束且输出先缓冲时，仍对所有尾部输出脱敏；不丢失首段', async () => {
  const events: DesktopEvent[] = [],
    sessions = new LogSessions((e) => events.push(e)),
    f = transport(true);
  created.push(sessions);
  const id = await sessions.start(f.remote, 'docker logs fixture', 'target', 'secret-fixture');
  await tick();
  const snapshot = sessions.read(id);
  expect(snapshot.active).toBe(false);
  const text = JSON.stringify([snapshot, events]);
  expect(text).not.toContain('secret-fixture');
  expect(text).not.toContain('another-secret');
  expect(text).toContain('已隐藏');
  expect(f.remote.close).toHaveBeenCalled();
});
it('观察在指定时限自动停止，手动停止只关闭只读会话，关闭全部后不留定时器', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const sessions = new LogSessions(() => {}),
    f = transport();
  created.push(sessions);
  const id = await sessions.start(f.remote, 'tail -n 200 -f fixture', 'target', '', 10);
  f.output.write('观察中\n');
  await tick();
  expect(sessions.read(id).active).toBe(true);
  await vi.advanceTimersByTimeAsync(9999);
  expect(f.channel.stop).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await tick();
  expect(f.channel.stop).toHaveBeenCalledOnce();
  expect(sessions.read(id).active).toBe(false);
  expect(
    sessions
      .read(id)
      .chunks.map((c) => c.text)
      .join(''),
  ).toContain('观察时间已到');
  sessions.closeAll();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});
it('仅观察启用且健康未验证的已结束目标，默认60秒，失败不修改结果或输出口令', async () => {
  const db = seed(),
    task = createTask(db, db.services[0], [db.targets[0]], {}, 'existing'),
    events: DesktopEvent[] = [];
  task.status = 'success';
  task.targets[0].status = 'unverified';
  task.targets[0].target.observation = { enabled: true, duration: 60 };
  const start = vi.fn().mockResolvedValue('session-fixture'),
    values = { [task.targets[0].server.id]: 'private-fixture' };
  await observeTask(task, values, start, (e) => events.push(e));
  expect(start).toHaveBeenCalledWith(task.targets[0], 'private-fixture', 60);
  expect(events[0].kind).toBe('observation');
  expect(values[task.targets[0].server.id]).toBe('private-fixture');
  start.mockRejectedValue(new Error('private-fixture'));
  events.length = 0;
  await observeTask(task, values, start, (e) => events.push(e));
  expect(JSON.stringify(events)).not.toContain('private-fixture');
  expect(task.status).toBe('success');
  start.mockClear();
  task.dryRun = true;
  await observeTask(task, values, start, () => {});
  expect(start).not.toHaveBeenCalled();
  task.dryRun = false;
  task.status = 'interrupted';
  await observeTask(task, values, start, () => {});
  expect(start).not.toHaveBeenCalled();
});
