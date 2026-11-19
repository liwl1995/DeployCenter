import { randomUUID } from 'node:crypto';
import { finished } from 'node:stream/promises';
import type { DesktopEvent } from '../src/platform';
import type { LogSessionSnapshot } from '../src/features';
import type { Transport, Channel } from './ssh';
import { LineRedactor, LogLineBuffer } from './log-redactor';
import { MemoryCredentials } from './native-capabilities';
import type { RunTarget, Task } from '../src/model';
import { onlineLogLimit, onlineLogSessionLimit } from '../src/online-logs';

type Active = {
  transport: Transport;
  channel: Channel;
  timer?: ReturnType<typeof setTimeout>;
  reason?: string;
};
/** 日志会话保存短时内存缓冲，关闭后立即释放连接和口令。 */
export class LogSessions {
  private closed = false;
  private pending = new Set<Transport>();
  private active = new Map<string, Active>();
  private buffers = new Map<string, LogSessionSnapshot>();
  private sizes = new Map<string, number>();
  private expiry = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private emit: (event: DesktopEvent) => void,
    private now: () => number = Date.now,
  ) {}
  private forget(id: string) {
    clearTimeout(this.expiry.get(id));
    this.expiry.delete(id);
    this.buffers.delete(id);
    this.sizes.delete(id);
  }
  private append(id: string, text: string, command: string) {
    if (!text) return;
    const buffer = this.buffers.get(id);
    if (!buffer) return;
    const size = Buffer.byteLength(text);
    buffer.offset += size;
    const chunk = {
      text,
      offset: buffer.offset,
      context: { time: this.now(), step: buffer.endsAt ? '部署后观察' : '应用日志', command },
    };
    buffer.chunks.push(chunk);
    let bytes = (this.sizes.get(id) ?? 0) + size;
    while ((bytes > onlineLogLimit || buffer.chunks.length > 2048) && buffer.chunks.length)
      bytes -= Buffer.byteLength(buffer.chunks.shift()!.text);
    this.sizes.set(id, bytes);
    this.emit({
      kind: 'container-log',
      id,
      ...chunk,
      active: buffer.active,
      notice: buffer.notice,
    });
  }
  async start(
    transport: Transport,
    command: string | (() => Promise<string>),
    targetId: string,
    credential = '',
    duration?: number,
    options: { raw?: boolean; onClose?: (id: string) => void } = {},
  ) {
    if (this.closed) {
      transport.close();
      throw new Error('日志观察已关闭');
    }
    if (this.pending.size + this.active.size >= onlineLogSessionLimit) {
      transport.close();
      throw new Error('已达到 3 个日志会话上限，请先停止其他目标的日志连接');
    }
    if (this.sessionFor(targetId)) {
      transport.close();
      throw new Error('该目标已在跟随日志，请重新打开目标日志');
    }
    let channel: Channel;
    let prepared: string;
    this.pending.add(transport);
    try {
      await transport.connect();
      prepared = typeof command === 'string' ? command : await command();
      if (this.closed) throw new Error('日志观察已关闭');
      channel = await transport.channel(prepared);
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
    const id = randomUUID();
    const readers = [0, 1].map(() =>
      options.raw ? new LogLineBuffer() : new LineRedactor({ active: credential }),
    );
    const commandMask = new MemoryCredentials({ active: credential }),
      safeCommand = commandMask.redact(prepared);
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
        const text = readers[index].write(data);
        const buffer = this.buffers.get(id);
        if (index === 1 && buffer && prepared.startsWith('LC_ALL=C tail ')) {
          if (/has been replaced|has appeared|file truncated/.test(text))
            buffer.notice = '日志已轮转，正在跟随当前文件。';
          else if (/has become inaccessible|Permission denied/.test(text))
            buffer.notice = '日志文件暂时不可读取，仍在等待。请检查文件和目录的权限。';
          if (options.raw && text) {
            this.emit({
              kind: 'container-log',
              id,
              text: '',
              offset: buffer.offset,
              active: buffer.active,
              notice: buffer.notice || text.trim(),
            });
            return;
          }
        }
        this.append(id, text, safeCommand);
      } catch {
        failed[index] = true;
        if (!options.raw)
          this.append(id, '\n日志单行过长，已停止跟随，请检查服务器日志。\n', safeCommand);
        this.stop(id, '日志单行超过 2 MB，已停止跟随，请在服务器检查日志');
      }
    };
    channel.output.on('data', receive(0));
    channel.error.on('data', receive(1));
    channel.input.end();
    if (duration) {
      entry.timer = setTimeout(() => this.stop(id, '观察时间已到，已停止跟随'), duration * 1000);
      entry.timer.unref?.();
    }
    // 等输出流排空再取未换行的最后一段，避免连接快速结束时丢失尾部。
    void Promise.allSettled([channel.done, finished(channel.output), finished(channel.error)]).then(
      (values) => {
        for (let i = 0; i < readers.length; i++) {
          const text = readers[i].end();
          if (!failed[i]) this.append(id, text, safeCommand);
        }
        if (entry.timer) clearTimeout(entry.timer);
        const buffer = this.buffers.get(id);
        const code = values[0].status === 'fulfilled' ? values[0].value : -1;
        if (buffer) {
          buffer.active = false;
          buffer.notice =
            entry.reason ||
            (code === 0
              ? '日志连接已结束，可重新连接。'
              : '日志连接已断开，请检查服务器或网络后重连。');
        }
        if (options.raw && buffer)
          this.emit({
            kind: 'container-log',
            id,
            text: '',
            offset: buffer.offset,
            active: false,
            notice: buffer.notice,
          });
        else
          this.append(
            id,
            '\n[' +
              (entry.reason || (code === 0 ? '日志连接已结束' : '日志连接结束，请检查上方输出')) +
              ']\n',
            safeCommand,
          );
        transport.close();
        this.active.delete(id);
        options.onClose?.(id);
        if (!this.closed) {
          const expiry = setTimeout(() => this.forget(id), 300000);
          expiry.unref?.();
          this.expiry.set(id, expiry);
          if (this.expiry.size > 12) this.forget(this.expiry.keys().next().value!);
        }
      },
    );
    return id;
  }
  read(id: string) {
    const buffer = this.buffers.get(id);
    if (!buffer) throw new Error('日志会话已过期，可重新连接查看最近日志');
    return structuredClone(buffer);
  }
  sessionFor(targetId: string) {
    for (const [id, entry] of this.active)
      if (!entry.reason && this.buffers.get(id)?.targetId === targetId) return id;
  }
  isActive(id: string) {
    return this.active.has(id);
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
    this.sizes.clear();
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
