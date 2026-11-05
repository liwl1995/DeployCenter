import type { LogContext } from './features';
export type LogLine = { id: string; text: string; time?: number; step?: string; command?: string };
export type LogLevel = 'error' | 'warning' | 'info';
export const logLevel = (text: string): LogLevel =>
  /\[ERROR\]|错误|执行失败|构建失败|检查失败|ERROR\b/i.test(text)
    ? 'error'
    : /\[WARNING\]|\bWARN(?:ING)?\b|警告|异常非零/i.test(text)
      ? 'warning'
      : 'info';
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
/** 增量拼接物理行，处理网络分片和初始化快照与实时事件重叠；旧行对象保持不可变。 */
export class LogAccumulator {
  entries: LogLine[] = [];
  private sources = new Map<string, { offset: number; partial?: number }>();
  append(source: string, text: string, start?: number, context: LogContext = {}) {
    const state = this.sources.get(source) || { offset: start ?? 0, partial: undefined };
    let bytes = encoder.encode(text),
      offset = start ?? state.offset;
    if (offset < state.offset) {
      bytes = bytes.subarray(Math.min(bytes.length, state.offset - offset));
      offset = state.offset;
    }
    if (!bytes.length) return;
    const parts = decoder.decode(bytes).split('\n');
    let position = offset;
    parts.forEach((part, index) => {
      const complete = index < parts.length - 1;
      if (!complete && !part) return;
      const value = part.replace(/\r$/, '');
      if (state.partial !== undefined && index === 0) {
        const old = this.entries[state.partial];
        this.entries[state.partial] = { ...old, text: old.text + value };
      } else {
        state.partial = this.entries.length;
        this.entries.push({
          id: source + ':' + position,
          text: value,
          time: context.time,
          step: context.step,
          command: context.command,
        });
      }
      if (complete) state.partial = undefined;
      position += encoder.encode(part).length + (complete ? 1 : 0);
    });
    state.offset = offset + bytes.length;
    this.sources.set(source, state);
  }
  load(source: string, lines: string[], start = 0, contexts: LogContext[] = []) {
    let offset = start,
      cursor = 0;
    lines.forEach((line, index) => {
      if (index === lines.length - 1 && line === '') return;
      while (cursor < contexts.length && (contexts[cursor].end ?? Infinity) <= offset) cursor++;
      const candidate = contexts[cursor];
      const context =
        candidate && (candidate.offset ?? Infinity) <= offset && (candidate.end ?? -1) > offset
          ? candidate
          : {};
      const text = line + (index < lines.length - 1 ? '\n' : '');
      this.append(source, text, offset, context);
      offset += encoder.encode(text).length;
    });
  }
}
