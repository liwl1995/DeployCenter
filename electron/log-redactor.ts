import { StringDecoder } from 'node:string_decoder';
import { MemoryCredentials } from './native-capabilities';
/** 按完整行脱敏，避免口令或 UTF-8 字符跨网络分片后漏出。 */
export class LineRedactor {
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private secrets: MemoryCredentials;
  constructor(values: Record<string, string>) {
    this.secrets = new MemoryCredentials(values);
  }
  write(data: Buffer) {
    this.pending += this.decoder.write(data);
    if (this.pending.length > 2 * 1024 * 1024)
      throw new Error('日志单行超过 2 MB，已停止跟随，请在服务器检查日志');
    const end = this.pending.lastIndexOf('\n') + 1;
    if (!end) return '';
    const safe = this.secrets.redact(this.pending.slice(0, end));
    this.pending = this.pending.slice(end);
    return safe;
  }
  end() {
    const text = this.secrets.redact(this.pending + this.decoder.end());
    this.pending = '';
    this.secrets.clear();
    return text;
  }
}
