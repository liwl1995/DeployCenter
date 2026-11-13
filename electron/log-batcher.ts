import type { WorkerMessage } from './contracts';
type Log = Extract<WorkerMessage, { kind: 'log' }>;

/** 仅合并已经脱敏的完整行，减少主进程逐分片同步写盘；交接前必须显式排空。 */
export class LogBatcher {
  private pending: Log[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private send: (message: Log) => void) {}
  append(message: Log) {
    const last = this.pending.at(-1);
    if (
      last &&
      last.taskId === message.taskId &&
      last.targetId === message.targetId &&
      last.context?.step === message.context?.step &&
      last.context?.command === message.context?.command
    )
      last.text += message.text;
    else this.pending.push({ ...message });
    this.bytes += Buffer.byteLength(message.text);
    if (this.bytes >= 65536) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 50);
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    this.pending = [];
    this.bytes = 0;
    for (const message of pending) this.send(message);
  }
}
