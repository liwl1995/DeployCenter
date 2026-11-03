import { Client } from 'ssh2';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PassThrough, Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Server } from '../src/model';
import { shellQuote as q } from '../src/model';
import type { Pin } from './contracts';
import type { TrustRequest } from '../src/platform';

export const systemSsh = () =>
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
    : 'ssh';

export type Channel = {
  input: Writable;
  output: Readable;
  error: Readable;
  done: Promise<number>;
  stop: () => void;
};
export type ConnectOptions = {
  credential?: string;
  signal?: AbortSignal;
  pins: Record<string, Pin>;
  trust: (request: TrustRequest, key: string) => Promise<boolean>;
};
export interface Transport {
  connect(): Promise<void>;
  channel(command: string): Promise<Channel>;
  exec(
    command: string,
    options?: { input?: string; timeout?: number; maxOutput?: number },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
  upload(
    file: string,
    remote: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  read(file: string, offset: number, max?: number): Promise<Buffer>;
  close(): void;
}
class BaseTransport {
  async exec(
    this: Transport,
    command: string,
    options: { input?: string; timeout?: number; maxOutput?: number } = {},
  ) {
    const ch = await this.channel(command);
    const chunks: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0;
    const limit = options.maxOutput || 2 * 1024 * 1024;
    const consume = (array: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit) ch.stop();
      else array.push(chunk);
    };
    ch.output.on('data', consume(chunks));
    ch.error.on('data', consume(errors));
    const timeout = setTimeout(() => ch.stop(), options.timeout || 30000);
    ch.input.end(options.input || '');
    try {
      const code = await ch.done;
      if (bytes > limit) throw new Error('远程命令输出超过限制，请使用日志查看功能');
      return {
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  async upload(
    this: Transport,
    file: string,
    remote: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
  ) {
    const ch = await this.channel(`umask 077; set -C; cat > ${q(remote)}`);
    let bytes = 0,
      stderr = '';
    ch.output.resume();
    ch.error.on('data', (b) => (stderr = (stderr + b.toString()).slice(-8000)));
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        onProgress(bytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(createReadStream(file), meter, ch.input, { signal });
      const code = await ch.done;
      if (code) throw new Error('远程上传失败：' + stderr);
    } catch (e) {
      ch.stop();
      throw e;
    }
  }
  async read(this: Transport, file: string, offset: number, max = 262144) {
    if (!Number.isSafeInteger(offset) || offset < 0 || max > 1048576)
      throw new Error('日志读取范围无效');
    const ch = await this.channel(
      `if [ -f ${q(file)} ]; then tail -c +${offset + 1} -- ${q(file)} | head -c ${max}; fi`,
    );
    const buffers: Buffer[] = [];
    ch.error.resume();
    ch.input.end();
    ch.output.on('data', (b) => buffers.push(b));
    const code = await ch.done;
    if (code) throw new Error('无法读取远端任务日志');
    return Buffer.concat(buffers);
  }
}
class LibraryTransport extends BaseTransport implements Transport {
  private client = new Client();
  private closed = false;
  constructor(
    private server: Server,
    private options: ConnectOptions,
  ) {
    super();
  }
  connect(): Promise<void> {
    const s = this.server,
      opt = this.options;
    const endpoint = s.host.toLowerCase().replace(/^\[|\]$/g, '') + ':' + s.port;
    return new Promise((resolve, reject) => {
      let complete = false;
      const abort = () => {
        this.client.destroy();
        reject(new Error('连接已取消'));
      };
      opt.signal?.addEventListener('abort', abort, { once: true });
      this.client.once('ready', () => {
        complete = true;
        opt.signal?.removeEventListener('abort', abort);
        resolve();
      });
      this.client.on('error', (e) => {
        if (!complete) {
          opt.signal?.removeEventListener('abort', abort);
          reject(
            new Error(
              'SSH 连接失败（' +
                (/auth|Authentication/i.test(e.message)
                  ? '认证失败'
                  : /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/.test(e.message)
                    ? '网络不通'
                    : '握手或协议错误') +
                '）：' +
                e.message,
            ),
          );
        }
      });
      const settings = {
        host: s.host.replace(/^\[|\]$/g, ''),
        port: s.port,
        username: s.user,
        readyTimeout: 120000,
        keepaliveInterval: 10000,
        keepaliveCountMax: 3,
        hostVerifier: (key: Buffer, callback: (accept: boolean) => void) => {
          const raw = key.toString('base64'),
            fingerprint =
              'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          const old = opt.pins[endpoint];
          if (old?.key === raw) {
            callback(true);
            return;
          }
          if (old) {
            reject(
              new Error(
                '主机指纹不一致，可能存在中间人风险。已阻止连接；请通过独立渠道核实并在本机管理原信任记录。',
              ),
            );
            callback(false);
            return;
          }
          opt
            .trust({ id: randomUUID(), endpoint, server: s.name, fingerprint, changed: !!old }, raw)
            .then(
              (accepted) => {
                if (accepted) opt.pins[endpoint] = { key: raw, fingerprint };
                callback(accepted);
              },
              () => callback(false),
            );
        },
      };
      const begin = async () => {
        try {
          if (opt.signal?.aborted) throw new Error('连接已取消');
          if (s.auth === 'password')
            this.client.connect({ ...settings, password: opt.credential || '', tryKeyboard: true });
          else
            this.client.connect({
              ...settings,
              privateKey: await readFile(s.keyPath),
              passphrase: opt.credential || undefined,
            });
        } catch (e) {
          reject(e);
        }
      };
      this.client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) =>
        finish(prompts.length === 1 && !prompts[0].echo ? [opt.credential || ''] : []),
      );
      void begin();
    });
  }
  channel(command: string): Promise<Channel> {
    if (this.closed) return Promise.reject(new Error('SSH 会话已关闭'));
    return new Promise((resolve, reject) =>
      this.client.exec(command, (error, stream) => {
        if (error) {
          reject(error);
          return;
        }
        const done = new Promise<number>((finish, fail) => {
          let code = -1;
          const disconnected = () => {
            if (!stream.closed) {
              stream.destroy();
              fail(new Error('SSH 连接中断，需核实远端任务'));
            }
          };
          stream.on('exit', (status) => (code = status ?? -1));
          stream.once('close', () => {
            this.client.removeListener('close', disconnected);
            finish(code);
          });
          stream.once('error', fail);
          this.client.once('close', disconnected);
        });
        void done.catch(() => {});
        resolve({
          input: stream,
          output: stream,
          error: stream.stderr,
          done,
          stop: () => stream.destroy(),
        });
      }),
    );
  }
  async upload(
    file: string,
    remote: string,
    onProgress: (bytes: number) => void,
    signal?: AbortSignal,
  ) {
    const sftp = await new Promise<import('ssh2').SFTPWrapper>((resolve, reject) =>
      this.client.sftp((e, value) => (e ? reject(e) : resolve(value))),
    );
    let bytes = 0;
    const stream = sftp.createWriteStream(remote, { flags: 'wx', mode: 0o600 });
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        onProgress(bytes);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(createReadStream(file), meter, stream, { signal });
    } finally {
      sftp.end();
    }
  }
  close() {
    this.closed = true;
    this.client.end();
  }
}
class OpenSshTransport extends BaseTransport implements Transport {
  private children = new Set<ReturnType<typeof spawn>>();
  constructor(
    private server: Server,
    private options: ConnectOptions,
  ) {
    super();
  }
  async connect() {
    const result = await this.exec('printf DEPLOY_CENTER_CONNECTED', { timeout: 20000 });
    if (result.code)
      throw new Error(
        'SSH 别名连接失败：' +
          result.stderr +
          '\n别名模式使用已有 known_hosts 与密钥/Agent；首次主机信任请先在本机 OpenSSH 完成，密码请使用密码认证方式。',
      );
  }
  channel(command: string): Promise<Channel> {
    if (this.options.signal?.aborted) return Promise.reject(new Error('连接已取消'));
    const child = spawn(
      systemSsh(),
      [
        ...(this.server.sshConfigFile ? ['-F', this.server.sshConfigFile] : []),
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=10',
        '-o',
        'ServerAliveCountMax=3',
        '--',
        this.server.alias,
        command,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false },
    );
    this.children.add(child);
    const done = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => {
        this.children.delete(child);
        resolve(code ?? 255);
      });
    });
    void done.catch(() => {});
    return Promise.resolve({
      input: child.stdin!,
      output: child.stdout!,
      error: child.stderr!,
      done,
      stop: () => child.kill(),
    });
  }
  close() {
    for (const child of this.children) child.kill();
    this.children.clear();
  }
}
export function createTransport(server: Server, options: ConnectOptions): Transport {
  return server.auth === 'alias'
    ? new OpenSshTransport(server, options)
    : new LibraryTransport(server, options);
}
export async function mustExec(t: Transport, command: string, input?: string) {
  const result = await t.exec(command, { input });
  if (result.code) throw new Error((result.stderr || result.stdout || '远程命令失败').trim());
  return result.stdout;
}
export function memoryChannel(): Channel {
  const output = new PassThrough();
  return {
    input: new PassThrough(),
    output,
    error: new PassThrough(),
    done: Promise.resolve(0),
    stop: () => output.destroy(),
  };
}
