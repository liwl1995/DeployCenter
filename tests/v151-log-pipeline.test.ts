// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { LogBatcher } from '../electron/log-batcher';
import { parseWorkbenchPoll, pollWorkbench, workbenchPollScript } from '../electron/workbench';
import { seed } from '../src/model';
import { createTask } from '../src/engine';
import type { Transport } from '../electron/ssh';
afterEach(() => vi.useRealTimers());
it('密集输出合并后在 50ms 内发布，不跨目标或步骤合并，交接显式排空', () => {
  vi.useFakeTimers();
  const send = vi.fn(),
    batch = new LogBatcher(send);
  for (let n = 0; n < 100; n++)
    batch.append({
      kind: 'log',
      taskId: 'task',
      text: '第' + n + '行\n',
      context: { step: '构建' },
    });
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(50);
  expect(send).toHaveBeenCalledOnce();
  expect(send.mock.calls[0][0].text.split('\n')).toHaveLength(101);
  batch.append({
    kind: 'log',
    taskId: 'task',
    targetId: 'target',
    text: '连接\n',
    context: { step: '连接' },
  });
  batch.append({
    kind: 'log',
    taskId: 'task',
    targetId: 'target',
    text: '校验\n',
    context: { step: '校验' },
  });
  batch.flush();
  expect(send).toHaveBeenCalledTimes(3);
  vi.advanceTimersByTime(100);
  expect(send).toHaveBeenCalledTimes(3);
});
it('日志批次达到上限立即写出，不等待静默计时器', () => {
  const send = vi.fn(),
    batch = new LogBatcher(send);
  batch.append({ kind: 'log', taskId: 'task', text: 'x'.repeat(65536) });
  expect(send).toHaveBeenCalledOnce();
});
it('一次读取保持二进制日志边界，包括跨片 UTF-8；拒绝截断和越界响应', async () => {
  const journal = Buffer.from('1\tSTEP\tstart\tSTART\n'),
    output = Buffer.from('应用正在启动\n');
  const packet = Buffer.concat([
    Buffer.from(`RUNNING\t0\t${journal.length}\t${output.length}\n`),
    journal,
    output,
  ]);
  expect(parseWorkbenchPoll(packet).output).toEqual(output);
  expect(() => parseWorkbenchPoll(packet.subarray(0, -1))).toThrow('长度');
  expect(() => parseWorkbenchPoll(Buffer.from('RUNNING\t0\t262145\t0\n'))).toThrow();
  const db = seed(),
    run = createTask(db, db.services[0], [db.targets[0]], {}, 'existing').targets[0];
  const execBytes = vi.fn().mockResolvedValue(packet),
    exec = vi.fn(),
    read = vi.fn();
  const transport = { execBytes, exec, read } as unknown as Transport;
  const result = await pollWorkbench(transport, run, 'task-target', { journal: 0, log: 0 });
  expect(result.state).toBe('RUNNING');
  expect(execBytes).toHaveBeenCalledOnce();
  expect(exec).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});
it('合并读取先核对工作台身份和普通文件，不执行删除并拒绝非法偏移', () => {
  const target = seed().targets[0];
  const script = workbenchPollScript(target, 'task-target', { journal: 0, log: 42 });
  expect(script.indexOf('dc_verify\n')).toBeLessThan(script.indexOf('tail -c'));
  expect(script).toContain('dc_file "$JOB/journal"');
  expect(script).toContain('tail -c +43');
  expect(script.slice(script.lastIndexOf('dc_verify\n'))).not.toMatch(/rm -|mv /);
  expect(() => workbenchPollScript(target, 'task-target', { journal: -1, log: 0 })).toThrow('偏移');
});
