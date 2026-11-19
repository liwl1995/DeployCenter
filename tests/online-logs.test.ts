// @vitest-environment node
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OnlineLogs, onlineSearchSchema } from '../electron/online-logs';
import { LogSessions } from '../electron/observation';
import type { Channel, Transport } from '../electron/ssh';
import { seed } from '../src/model';
import type { DesktopEvent } from '../src/platform';

const base = path.resolve('.test-data');
const db = seed();
const target = {
  ...db.targets[0],
  mode: 'jar' as const,
  appLogPath: "/opt/team's service/app.log",
};
const server = db.servers[0];
const secret = 'fixture-private-password';
const logText = '打开数据库\nAuthorization: Bearer abc\n登录 ' + secret + '\n操作结束\n';
const code = (stdout = '', stderr = '', status = 0) => ({ code: status, stdout, stderr });
let dir: string;
let events: DesktopEvent[];
let sessions: LogSessions;
let logs: OnlineLogs;

function channel() {
  const output = new PassThrough();
  const error = new PassThrough();
  const input = new PassThrough();
  let finish!: (code: number) => void;
  const done = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const end = (status: number) => {
    output.end();
    error.end();
    finish(status);
  };
  const stream = { input, output, error, done, stop: vi.fn(() => end(255)) } satisfies Channel;
  return { stream, end };
}

function transport() {
  const follow = channel();
  const exec = vi.fn(async (_command: string) => code('regular file\n'));
  const remote = {
    exec,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    channel: vi.fn(async (_command: string) => follow.stream),
  };
  return {
    follow,
    remote,
    exec,
    connect: (t = target, duration?: number) =>
      logs.start(t, server, remote as unknown as Transport, secret, duration),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  await mkdir(base, { recursive: true });
  dir = await mkdtemp(path.join(base, 'online-log-'));
  events = [];
  sessions = new LogSessions((event) => events.push(event));
  logs = new OnlineLogs(
    sessions,
    (event) => events.push(event),
    async () => path.join(dir, '保存的日志.log'),
  );
});

afterEach(async () => {
  sessions.closeAll();
  vi.useRealTimers();
  await flush();
  if (path.dirname(dir) === base && path.basename(dir).startsWith('online-log-'))
    await rm(dir, { recursive: true, force: true });
});

it('只读取已配置文件，轮转后继续跟随并通知，实时与本地下载均保留原文', async () => {
  const t = transport();
  const session = await t.connect();
  expect(t.remote.channel).toHaveBeenCalledWith(
    "LC_ALL=C tail -n 200 -F -- '/opt/team'\\''s service/app.log'",
  );
  t.follow.stream.output.write(logText.slice(0, 39));
  t.follow.stream.output.write(logText.slice(39));
  t.follow.stream.error.write('tail: app.log has been replaced; following new file\n');
  expect(sessions.read(session).notice).toContain('轮转');
  expect(logs.source(target, server).session).toBe(session);
  expect(await logs.saveLoaded(session)).toBe(true);
  const saved = await readFile(path.join(dir, '保存的日志.log'), 'utf8');
  expect(saved).toBe(logText);
  expect(JSON.stringify(events)).toContain(secret);
  t.follow.end(255);
  await flush();
  expect(sessions.read(session)).toMatchObject({
    active: false,
    notice: expect.stringContaining('重连'),
  });
  expect(logs.list()).toEqual([]);
});

it('明确区分未配置、缺失、无权限、单行过长及会话数上限', async () => {
  await expect(transport().connect({ ...target, appLogPath: '' })).rejects.toThrow('绝对路径');
  for (const [reason, expected] of [
    ['No such file', '不存在'],
    ['Permission denied', '读取权限'],
  ]) {
    const fixture = transport();
    fixture.exec.mockResolvedValueOnce(code('', reason, 1));
    await expect(fixture.connect()).rejects.toThrow(expected);
    expect(fixture.remote.channel).not.toHaveBeenCalled();
  }
  const fixtures = [transport(), transport(), transport()];
  const ids = await Promise.all(
    fixtures.map((fixture, i) => fixture.connect({ ...target, id: String(i) })),
  );
  await expect(transport().connect({ ...target, id: 'other' })).rejects.toThrow('3 个日志会话');
  fixtures[0].follow.stream.output.write(Buffer.alloc(2 * 1024 ** 2 + 1, 0x61));
  await flush();
  expect(sessions.read(ids[0])).toMatchObject({
    active: false,
    notice: expect.stringContaining('单行超过'),
  });
  expect(logs.list()).toHaveLength(2);
});

it('服务器搜索返回截断状态和上下文，保留命中及上下文原文', async () => {
  const t = transport();
  const id = await t.connect();
  t.exec.mockResolvedValueOnce(code('9000000 1:2\n'));
  t.exec.mockResolvedValueOnce(
    code(
      '1-context ' +
        secret +
        '\r\n' +
        Array.from({ length: 201 }, (_, i) => i + 2 + ':ERROR result ' + i + '\r\n').join(''),
      'YOTOO_LINES 230\n',
    ),
  );
  const query = "'; echo ordinary-text; #";
  const result = await logs.search(id, { query, regex: false, range: '4' });
  expect(result).toMatchObject({ scope: '当前文件 · 末尾 4 MB', truncated: true });
  expect(result.matches).toHaveLength(200);
  expect(result.matches[0]).toMatchObject({
    before: ['context ' + secret + '\r'],
    text: 'ERROR result 0\r',
    after: ['ERROR result 1\r', 'ERROR result 2\r'],
  });
  const command = t.exec.mock.calls.at(-1)![0];
  expect(command).toContain('grep -a -n -i -C 2 -F --');
  expect(command).toContain('tail -c 4194304');
  expect(
    onlineSearchSchema.safeParse({ query: 'line\nbreak', regex: true, range: '4' }).success,
  ).toBe(false);
  await expect(logs.search(id, { query: 'ERROR', regex: false, range: '24' })).rejects.toThrow(
    '支持的搜索范围',
  );
});

it('目标路径修改会断开旧会话，搜索和下载不会继续在旧路径执行', async () => {
  const t = transport();
  const id = await t.connect();
  const changed = { ...target, appLogPath: '/var/log/current.log' };
  logs.reconcile({ ...db, targets: [changed], servers: [server] });
  expect(logs.source(changed, server).session).toBeUndefined();
  await expect(logs.prepare(id)).rejects.toThrow('连接已断开');
  await flush();
  expect(sessions.read(id).notice).toContain('配置已变更');
});

it('下载先测原始大小并绑定文件身份，完整保存原始字节，取消后清除临时文件', async () => {
  const t = transport();
  const id = await t.connect();
  const download = channel();
  const original = Buffer.concat([
    Buffer.from(logText.replaceAll('\n', '\r\n')),
    Buffer.from([0xff, 0x0a]),
  ]);
  t.remote.channel.mockImplementationOnce(async () => {
    download.stream.output.end(original);
    download.end(0);
    return download.stream;
  });
  t.exec.mockResolvedValueOnce(code(original.length + ' 12:345\n'));
  const plan = await logs.prepare(id);
  expect(plan.bytes).toBe(original.length);
  expect(await logs.download(plan.token)).toBe(true);
  const command = t.remote.channel.mock.calls.at(-1)![0];
  expect(command).toContain('/proc/self/fd/3');
  expect(command).toContain('head -c ' + plan.bytes);
  expect(events).toContainEqual({
    kind: 'online-log-download',
    token: plan.token,
    bytes: plan.bytes,
  });
  expect(await readFile(path.join(dir, '保存的日志.log'))).toEqual(original);

  const stalled = channel();
  t.remote.channel.mockResolvedValueOnce(stalled.stream);
  t.exec.mockResolvedValueOnce(code('50 12:345\n'));
  const next = await logs.prepare(id);
  const pending = logs.download(next.token);
  await vi.waitFor(() => expect(t.remote.channel).toHaveBeenCalledTimes(3));
  logs.cancel(next.token);
  expect(await pending).toBe(false);
  expect(await readdir(dir)).toEqual(['保存的日志.log']);
  expect(await readFile(path.join(dir, '保存的日志.log'))).toEqual(original);
  await expect(logs.download(next.token)).rejects.toThrow('过期');
});

it('容器日志固定到已核对的容器 ID，搜索与大小预检保持只读', async () => {
  const t = transport();
  const container = 'a'.repeat(64);
  t.exec.mockResolvedValueOnce(code(container + '\n')).mockResolvedValueOnce(code());
  const id = await logs.start(
    { ...target, mode: 'docker', container: 'yotoo-container' },
    server,
    t.remote as unknown as Transport,
  );
  expect(t.remote.channel).toHaveBeenCalledWith(
    "docker logs --timestamps --tail 200 --follow -- '" + container + "'",
  );
  t.exec.mockResolvedValueOnce(code('1:started\n', 'YOTOO_LINES 20000\n'));
  expect(await logs.search(id, { query: 'started', regex: false, range: '168' })).toMatchObject({
    scope: '当前容器 · 近 7 天 · 最多最近 20,000 行',
    truncated: true,
  });
  t.exec.mockResolvedValueOnce(code('1725125115\n')).mockResolvedValueOnce(code('123456\n'));
  expect(await logs.prepare(id)).toMatchObject({ bytes: 123456 });
  expect(t.exec.mock.calls.at(-1)![0]).toContain('1725125115');
  expect(t.exec.mock.calls.flat().join('\n')).not.toMatch(/docker (?:rm|start|restart|load)/);
});
