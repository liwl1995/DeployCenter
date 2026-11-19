import { StringDecoder } from 'node:string_decoder';
import { MemoryCredentials } from './native-capabilities';

/** 保留完整的 UTF-8 行并限制单行长度，避免流式日志无限积累。 */
export class LogLineBuffer {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  write(data: Buffer) {
    const text = this.pending + this.decoder.write(data);
    const lines = text.split('\n');
    if (lines.some((line) => Buffer.byteLength(line) > 2 * 1024 * 1024)) {
      this.pending = '';
      throw new Error('日志单行超过 2 MB，已停止跟随，请在服务器检查日志');
    }
    this.pending = lines.pop()!;
    return lines.length ? lines.join('\n') + '\n' : '';
  }
  end() {
    const text = this.pending + this.decoder.end();
    this.pending = '';
    return text;
  }
}

/** 按完整行脱敏，避免口令跨网络分片后漏出。 */
export class LineRedactor {
  private lines = new LogLineBuffer();
  private secrets: MemoryCredentials;
  constructor(values: Record<string, string>) {
    this.secrets = new MemoryCredentials(values);
  }
  write(data: Buffer) {
    return this.secrets.redact(this.lines.write(data));
  }
  end() {
    const text = this.secrets.redact(this.lines.end());
    this.secrets.clear();
    return text;
  }
}
