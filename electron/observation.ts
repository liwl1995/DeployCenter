import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import type { DesktopEvent } from '../src/platform';
import type { LogSessionSnapshot } from '../src/features';
import type { Transport, Channel } from './ssh';
import { LineRedactor } from './log-redactor';
import { MemoryCredentials } from './native-capabilities';
import type { RunTarget, Task } from '../src/model';

type Active = {
  transport: Transport;
  channel: Channel;
  timer?: ReturnType<typeof setTimeout>;
  reason?: string;
};
/** 观察会话只保存脱敏后的短时内存缓冲，关闭后立即释放连接和口令。 */
export class LogSessions {
  private closed = false;
  private pending = new Set<Transport>();
  private active = new Map<string, Active>();
  private buffers = new Map<string, LogSessionSnapshot>();
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private emit: (event: DesktopEvent) => void,
    private now: () => number = Date.now,
  ) {}
  private append(id: string, text: string, command: string) {
    if (!text) return;
    const buffer = this.buffers.get(id);
    if (!buffer) return;
    buffer.offset += Buffer.byteLength(text);
    const chunk = {
      text,
      offset: buffer.offset,
      context: { time: this.now(), step: buffer.endsAt ? '部署后观察' : '应用日志', command },
    };
    buffer.chunks.push(chunk);
    let bytes = buffer.chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0);
    while (bytes > 2 * 1024 ** 2 && buffer.chunks.length)
      bytes -= Buffer.byteLength(buffer.chunks.shift()!.text);
    this.emit({ kind: 'container-log', id, ...chunk, active: buffer.active });
  }
  async start(
    transport: Transport,
    command: string,
    targetId: string,
    credential = '',
    duration?: number,
  ) {
    if (this.closed) {
      transport.close();
      throw new Error('日志观察已关闭');
    }
    let channel: Channel;
    this.pending.add(transport);
    try {
      await transport.connect();
      if (this.closed) throw new Error('日志观察已关闭');
      channel = await transport.channel(command);
      if (this.closed) {
        channel.stop();
        throw new Error('日志观察已关闭');
      }
    } catch (e) {
      transport.close();
      throw e;
    } finally {
      this.pending.delete(transport);
    }
    const id = randomUUID(),
      redactors = [
        new LineRedactor({ active: credential }),
        new LineRedactor({ active: credential }),
      ];
    const commandMask = new MemoryCredentials({ active: credential }),
      safeCommand = commandMask.redact(command);
    commandMask.clear();
    this.buffers.set(id, {
      id,
      targetId,
      active: true,
      endsAt: duration ? this.now() + duration * 1000 : undefined,
      chunks: [],
      offset: 0,
    });
    const entry: Active = { transport, channel };
    this.active.set(id, entry);
    const failed = [false, false];
    const receive = (index: number) => (data: Buffer) => {
      if (failed[index]) return;
      try {
        this.append(id, redactors[index].write(data), safeCommand);
      } catch {
        failed[index] = true;
        this.append(id, '\n日志单行过长，已停止跟随，请检查服务器日志。\n', safeCommand);
        this.stop(id);
      }
    };
    channel.output.on('data', receive(0));
    channel.error.on('data', receive(1));
    channel.input.end();
    if (duration) {
      entry.timer = setTimeout(() => this.stop(id, '观察时间已到，已停止跟随'), duration * 1000);
      entry.timer.unref?.();
    }
    // 必须等输出流排空后再清除脱敏器，避免连接快速结束时缓冲尾部未经过脱敏。
    void Promise.allSettled([channel.done, finished(channel.output), finished(channel.error)]).then(
      (values) => {
        for (let i = 0; i < redactors.length; i++) {
          const text = redactors[i].end();
          if (!failed[i]) this.append(id, text, safeCommand);
        }
        if (entry.timer) clearTimeout(entry.timer);
        const buffer = this.buffers.get(id);
        if (buffer) buffer.active = false;
        const code = values[0].status === 'fulfilled' ? values[0].value : -1;
        this.append(
          id,
          '\n[' +
            (entry.reason || (code === 0 ? '日志连接已结束' : '日志连接结束，请检查上方输出')) +
            ']\n',
          safeCommand,
        );
        transport.close();
        this.active.delete(id);
        if (!this.closed) {
          const expiry = setTimeout(() => {
            this.buffers.delete(id);
            this.expiry.delete(id);
          }, 300000);
          expiry.unref?.();
          this.expiry.set(id, expiry);
        }
      },
    );
    return id;
  }
  read(id: string) {
    const buffer = this.buffers.get(id);
    if (!buffer) throw new Error('观察记录已过期，可重新连接查看最近日志');
    return structuredClone(buffer);
  }
  stop(id: string, reason = '已停止跟随') {
    const entry = this.active.get(id);
    if (!entry) return;
    entry.reason = reason;
    if (entry.timer) clearTimeout(entry.timer);
    entry.channel.stop();
    entry.transport.close();
  }
  closeAll() {
    this.closed = true;
    for (const transport of this.pending) transport.close();
    this.pending.clear();
    for (const id of this.active.keys()) this.stop(id);
    for (const timer of this.expiry.values()) clearTimeout(timer);
    this.expiry.clear();
    this.buffers.clear();
  }
}
/** 观察失败只报告给界面，不改变已经提交的部署结果；口令副本在发起连接后清除。 */
export async function observeTask(
  task: Task,
  values: Record<string, string>,
  start: (run: RunTarget, credential: string, duration: number) => Promise<string>,
  emit: (event: DesktopEvent) => void,
) {
  const runs = task.targets.filter(
    (r) => r.status === 'unverified' && r.target.observation?.enabled,
  );
  const credentials = Object.fromEntries(runs.map((r) => [r.server.id, values[r.server.id] || ''])),
    mask = new MemoryCredentials(credentials);
  values = {};
  try {
    if (task.dryRun || ['running', 'cancelling', 'interrupted'].includes(task.status)) return;
    for (const run of runs) {
      const duration = Math.max(10, Math.min(3600, run.target.observation?.duration || 60));
      try {
        const sessionId = await start(run, credentials[run.server.id] || '', duration);
        emit({
          kind: 'observation',
          taskId: task.id,
          targetId: run.target.id,
          label: run.target.name,
          sessionId,
          duration,
        });
      } catch (e) {
        emit({
          kind: 'observation-error',
          targetId: run.target.id,
          message: mask.redact('部署结果不受影响，自动观察未启动：' + String(e)),
        });
      }
    }
  } finally {
    for (const key of Object.keys(credentials)) delete credentials[key];
    mask.clear();
  }
}
