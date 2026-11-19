import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { z } from 'zod';
import { shellQuote as q, type Database, type Server, type Target } from '../src/model';
import {
  onlineLogDuration,
  onlineLogLimit,
  onlineSearchLimit,
  type OnlineDownload,
  type OnlineLogSource,
  type OnlineSearch,
  type OnlineSearchResult,
} from '../src/online-logs';
import { MemoryCredentials } from './native-capabilities';
import type { LogSessions } from './observation';
import type { DesktopEvent } from '../src/platform';
import type { Transport } from './ssh';
import { sameServer } from './workspace';

export const onlineSearchSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((value) => !/[\r\n\0]/.test(value)),
  regex: z.boolean(),
  range: z.enum(['1', '4', '8', '24', '168']),
});

type Connection = {
  targetId: string;
  server: Server;
  source: OnlineLogSource;
  transport: Transport;
  location: string;
  credential: string;
  searching?: boolean;
};
type Download = OnlineDownload & { session: string; command: string; expires: number };
const dockerLineLimit = 20_000;
const oneMiB = 1024 ** 2;
const bash = (command: string) => 'LC_ALL=C bash -c ' + q(command);
const fileValid = (file: string) => file.startsWith('/') && !/[\r\n\0]/.test(file);
const fileStat = (conn: Connection) =>
  conn.transport.exec('LC_ALL=C stat -Lc ' + q('%s %d:%i') + ' -- ' + q(conn.location));

/** 目标路径和容器来自已保存的配置，搜索输入只用作固定命令的参数。 */
export class OnlineLogs {
  private connections = new Map<string, Connection>();
  private pending = new Set<string>();
  private downloads = new Map<string, Download>();
  private exporting = new Map<string, { session: string; abort: AbortController }>();

  constructor(
    private sessions: LogSessions,
    private emit: (event: DesktopEvent) => void,
    private chooseFile: (name: string) => Promise<string | undefined>,
    private now: () => number = Date.now,
  ) {}

  source(target: Target, server: Server): OnlineLogSource {
    return {
      target: target.name,
      server: server.name,
      address: server.auth === 'alias' ? server.alias : server.host + ':' + server.port,
      kind: target.mode === 'docker' ? 'docker' : 'file',
      location: target.mode === 'docker' ? target.container : target.appLogPath || '',
      production: target.production,
      password: server.auth === 'password',
      key: server.auth === 'key',
      session: this.sessions.sessionFor(target.id),
    };
  }

  reconcile(db: Database) {
    for (const [id, connection] of this.connections) {
      const target = db.targets.find((value) => value.id === connection.targetId);
      const server = db.servers.find((value) => value.id === target?.serverId);
      const source = target && server ? this.source(target, server) : undefined;
      if (
        !server ||
        !source ||
        server.id !== connection.server.id ||
        !sameServer(server, connection.server) ||
        source.production !== connection.source.production ||
        source.kind !== connection.source.kind ||
        source.location !== connection.source.location
      ) {
        this.sessions.stop(id, '目标或服务器配置已变更，请重新连接日志。');
        this.clear(id);
      }
    }
  }

  private clear(id: string) {
    const conn = this.connections.get(id);
    if (conn) conn.credential = '';
    this.connections.delete(id);
    for (const [token, plan] of this.downloads)
      if (plan.session === id) this.downloads.delete(token);
    for (const running of this.exporting.values())
      if (running.session === id) running.abort.abort();
  }

  async start(
    target: Target,
    server: Server,
    transport: Transport,
    credential = '',
    duration = onlineLogDuration,
  ) {
    const source = this.source(target, server);
    if (source.kind === 'file' ? !fileValid(source.location) : !source.location) {
      transport.close();
      throw new Error(
        source.kind === 'file'
          ? '请在目标配置中填写应用日志的绝对路径。'
          : '请在目标配置中填写容器名称。',
      );
    }
    if (this.pending.has(target.id)) {
      transport.close();
      throw new Error('该目标正在连接，请等待连接结果。');
    }
    const conn: Connection = {
      targetId: target.id,
      server,
      source,
      transport,
      location: source.location,
      credential,
    };
    const mask = new MemoryCredentials({ active: credential });
    this.pending.add(target.id);
    try {
      const id = await this.sessions.start(
        transport,
        async () => {
          if (source.kind === 'docker') {
            const ref = await transport.exec(
              'docker inspect --type container --format ' +
                q('{{.Id}}') +
                ' -- ' +
                q(conn.location),
            );
            const container = ref.stdout.trim();
            if (ref.code || !/^[a-f0-9]{64}$/.test(container))
              throw new Error(
                '无法读取容器，请确认容器名称、Docker 服务和当前用户权限。 ' + ref.stderr.trim(),
              );
            conn.location = container;
            const check = await transport.exec('docker logs --tail 0 -- ' + q(container));
            if (check.code)
              throw new Error(
                '无法读取容器日志，请检查 Docker 权限或日志驱动。 ' + check.stderr.trim(),
              );
            return 'docker logs --timestamps --tail 200 --follow -- ' + q(container);
          }
          const file = q(conn.location);
          const check = await transport.exec('LC_ALL=C stat -Lc %F -- ' + file);
          if (check.code) {
            if (/Permission denied/.test(check.stderr))
              throw new Error('没有日志读取权限，请检查登录用户对目录和文件的权限。');
            if (/No such file/.test(check.stderr))
              throw new Error('日志文件不存在，请检查目标配置中的路径。');
            throw new Error('无法读取日志文件信息，请检查服务器和路径。 ' + check.stderr.trim());
          }
          const readable = await transport.exec('test -f ' + file + ' && test -r ' + file);
          if (readable.code)
            throw new Error('日志路径不是可读的普通文件，请检查路径和登录用户权限。');
          return 'LC_ALL=C tail -n 200 -F -- ' + file;
        },
        target.id,
        credential,
        duration,
        { raw: true, onClose: (id) => this.clear(id) },
      );
      if (this.sessions.isActive(id)) this.connections.set(id, conn);
      return id;
    } catch (error) {
      throw new Error(mask.redact(error instanceof Error ? error.message : String(error)));
    } finally {
      this.pending.delete(target.id);
      mask.clear();
    }
  }

  private connection(id: string) {
    const conn = this.connections.get(id);
    if (!conn) throw new Error('日志连接已断开，请重新连接。');
    return conn;
  }
  list() {
    return [...this.connections].map(([id, { source }]) => ({
      id,
      target: source.target,
      server: source.server,
    }));
  }

  async search(id: string, request: OnlineSearch): Promise<OnlineSearchResult> {
    const conn = this.connection(id);
    if (conn.searching) throw new Error('正在搜索服务器日志，请等待当前搜索完成。');
    conn.searching = true;
    const mask = new MemoryCredentials({ active: conn.credential });
    try {
      const docker = conn.source.kind === 'docker';
      if (!(docker ? ['1', '24', '168'] : ['1', '4', '8']).includes(request.range))
        throw new Error('请选择当前日志来源支持的搜索范围。');
      const limit = Number(request.range) * oneMiB;
      const location = q(conn.location);
      let bounded = false;
      let read: string;
      if (docker) {
        read =
          'docker logs --timestamps --since ' +
          q(request.range + 'h') +
          ' --tail ' +
          dockerLineLimit +
          ' -- ' +
          location +
          ' 2>&1';
      } else {
        const stat = await fileStat(conn);
        if (stat.code || !/^\d+ \d+:\d+\s*$/.test(stat.stdout))
          throw new Error('无法读取日志文件，请检查路径和权限或重连。');
        bounded = Number(stat.stdout.split(' ')[0]) > limit;
        // 末尾字节区间可能从一行中间开始，移除这条不完整的记录。
        read = 'tail -c ' + limit + ' -- ' + location;
      }
      const start = bounded ? 'NR == 1 { next } ' : '';
      const grep =
        'grep -a -n -i -C 2 ' + (request.regex ? '-E' : '-F') + ' -- ' + q(request.query);
      const count = start + '{ print } END { print "YOTOO_LINES " NR > "/dev/stderr" }';
      // 扫描完整范围，限制返回条数，避免 grep 提前退出导致上游 SIGPIPE。
      const cap = '/^[0-9]+:/ { hits++ } hits <= ' + (onlineSearchLimit + 2) + ' { print }';
      const command =
        read +
        ' | awk ' +
        q(count) +
        ' | ' +
        grep +
        ' | awk ' +
        q(cap) +
        '; s=("$' +
        '{PIPESTATUS[@]}"); if (( s[0] || s[1] || s[3] )); then exit 3; fi; exit "$' +
        '{s[2]}"';
      const result = await conn.transport.exec(bash(command), {
        timeout: 30_000,
        maxOutput: 4 * oneMiB,
      });
      if (result.code > 1 || result.code < 0) {
        if (request.regex && /grep:/.test(result.stderr))
          throw new Error('正则表达式无效，请检查 POSIX 扩展正则语法或切回文本匹配。');
        throw new Error('服务器搜索失败或超时，请缩小范围，或检查连接与日志读取权限。');
      }
      const countMatch = result.stderr.match(/(?:^|\n)YOTOO_LINES (\d+)(?:\n|$)/);
      if (!countMatch) throw new Error('服务器搜索未完整结束，请重新连接后重试。');
      const rows = new Map<number, { text: string; match: boolean }>();
      for (const row of result.stdout.split('\n')) {
        const parsed = /^(\d+)([:-])([\s\S]*)$/.exec(row);
        if (parsed)
          rows.set(Number(parsed[1]), {
            match: parsed[2] === ':',
            text: parsed[3],
          });
      }
      const lines = [...rows].filter(([, row]) => row.match);
      const context = (line: number, offsets: number[]) =>
        offsets.flatMap((offset) => rows.get(line + offset)?.text ?? []);
      const range = request.range === '168' ? '7 天' : request.range + ' 小时';
      return {
        scope: docker
          ? '当前容器 · 近 ' + range + ' · 最多最近 20,000 行'
          : '当前文件 · 末尾 ' + request.range + ' MB',
        truncated:
          bounded ||
          lines.length > onlineSearchLimit ||
          (docker && Number(countMatch[1]) >= dockerLineLimit),
        matches: lines.slice(0, onlineSearchLimit).map(([line, row]) => ({
          line,
          text: row.text,
          before: context(line, [-2, -1]),
          after: context(line, [1, 2]),
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('输出超过限制'))
        throw new Error('搜索结果太大，请缩小搜索范围或使用更具体的关键词。');
      throw new Error(mask.redact(message));
    } finally {
      conn.searching = false;
      mask.clear();
    }
  }

  async prepare(id: string): Promise<OnlineDownload> {
    const conn = this.connection(id);
    let raw: string;
    let command: string;
    if (conn.source.kind === 'docker') {
      const cutoff = await conn.transport.exec('date +%s');
      if (cutoff.code || !/^\d{1,12}$/.test(cutoff.stdout.trim()))
        throw new Error('无法确定服务器时间，请检查连接后重试。');
      command =
        'docker logs --timestamps --until ' +
        q(cutoff.stdout.trim()) +
        ' -- ' +
        q(conn.location) +
        ' 2>&1';
      const count = await conn.transport.exec(bash('set -o pipefail; ' + command + ' | wc -c'), {
        timeout: 30_000,
      });
      if (count.code)
        throw new Error('无法在 30 秒内测量完整容器日志，请检查日志驱动，或下载已加载内容。');
      raw = count.stdout.trim();
    } else {
      const stat = await fileStat(conn);
      const parts = /^(\d+) (\d+:\d+)$/.exec(stat.stdout.trim());
      if (stat.code || !parts) throw new Error('无法确认远程文件大小，请检查路径和读取权限。');
      raw = parts[1];
      const info = '/proc/self/fd/3';
      // 核对已打开文件的身份，防止轮转后读取另一份文件。
      command =
        'exec 3< ' +
        q(conn.location) +
        ' || exit 1; ' +
        'test -f ' +
        info +
        ' && test "$(stat -Lc %d:%i ' +
        info +
        ')" = ' +
        q(parts[2]) +
        ' || exit 1; head -c ' +
        raw +
        ' <&3';
    }
    const bytes = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(bytes))
      throw new Error('服务器返回的日志大小无效。');
    this.connection(id);
    for (const [token, plan] of this.downloads)
      if (plan.session === id || plan.expires < this.now()) this.downloads.delete(token);
    const token = randomUUID();
    const download = { token, bytes, source: conn.source.location };
    this.downloads.set(token, {
      ...download,
      session: id,
      command: bash(command),
      expires: this.now() + 300_000,
    });
    return download;
  }

  isExporting() {
    return this.exporting.size > 0;
  }

  cancel(token: string) {
    this.downloads.delete(token);
    this.exporting.get(token)?.abort.abort();
  }

  private async save(
    file: string,
    write: (output: Awaited<ReturnType<typeof open>>) => Promise<void>,
    signal?: AbortSignal,
  ) {
    const pending = path.join(path.dirname(file), '.yotoo-log-' + randomUUID() + '.part');
    const output = await open(pending, 'wx');
    try {
      try {
        await write(output);
      } finally {
        await output.close();
      }
      signal?.throwIfAborted();
      await rename(pending, file);
    } finally {
      await rm(pending, { force: true }).catch(() => {});
    }
  }

  async saveLoaded(id: string) {
    const text = this.sessions
      .read(id)
      .chunks.map((chunk) => chunk.text)
      .join('');
    if (!text) throw new Error('当前没有可下载的日志。');
    if (Buffer.byteLength(text) > onlineLogLimit) throw new Error('已加载日志超过 2 MB。');
    const file = await this.chooseFile('已加载应用日志.log');
    if (!file) return false;
    await this.save(file, async (output) => {
      await output.writeFile(text, 'utf8');
    });
    return true;
  }

  async download(token: string) {
    const plan = this.downloads.get(token);
    if (!plan || plan.expires < this.now()) throw new Error('下载确认已过期，请重新获取文件大小。');
    this.downloads.delete(token);
    const conn = this.connection(plan.session);
    const abort = new AbortController();
    this.exporting.set(token, { session: plan.session, abort });
    try {
      const file = await this.chooseFile('完整应用日志.log');
      if (!file || abort.signal.aborted) return false;
      await this.save(
        file,
        async (output) => {
          const channel = await conn.transport.channel(plan.command);
          let received = 0;
          let last = 0;
          let timedOut = false;
          const waitForData = () =>
            setTimeout(() => {
              timedOut = true;
              channel.stop();
            }, 60_000);
          const stop = () => channel.stop();
          channel.error.resume();
          const done = Promise.allSettled([
            channel.done,
            finished(channel.output),
            finished(channel.error),
          ]);
          abort.signal.addEventListener('abort', stop, { once: true });
          const initial = waitForData();
          let idle = initial;
          try {
            abort.signal.throwIfAborted();
            channel.input.end();
            for await (const chunk of channel.output) {
              abort.signal.throwIfAborted();
              clearTimeout(idle);
              idle = waitForData();
              received += chunk.length;
              if (received > plan.bytes) throw new Error('日志大小已变化，请重新确认并下载。');
              await output.writeFile(chunk);
              if (this.now() - last >= 100 || received === plan.bytes) {
                last = this.now();
                this.emit({ kind: 'online-log-download', token, bytes: received });
              }
            }
            const [code] = await done;
            abort.signal.throwIfAborted();
            if (code.status !== 'fulfilled' || code.value || received !== plan.bytes)
              throw new Error('日志文件已轮转、内容已变化或连接断开，请重新确认后下载。');
          } catch (error) {
            if (timedOut) throw new Error('60 秒未收到日志内容，下载已停止，请检查连接后重试。');
            throw error;
          } finally {
            clearTimeout(idle);
            abort.signal.removeEventListener('abort', stop);
            channel.stop();
            await done;
          }
        },
        abort.signal,
      );
      return true;
    } catch (error) {
      if (abort.signal.aborted) return false;
      throw error;
    } finally {
      this.exporting.delete(token);
    }
  }
}
