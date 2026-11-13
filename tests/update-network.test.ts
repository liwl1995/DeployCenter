// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { createUpdateFetch } from '../electron/update-network';

const live: Readable[] = [];
afterEach(() => {
  for (const stream of live.splice(0)) stream.destroy();
});
function fixture(send: (client: EventEmitter) => void) {
  const client = Object.assign(new EventEmitter(), {
    abort: vi.fn(() => {
      client.emit('abort');
      client.emit('close');
    }),
    end: vi.fn(() => queueMicrotask(() => send(client))),
  });
  const factory = vi.fn(
    (_options: ClientRequestConstructorOptions) => client as unknown as ClientRequest,
  );
  return { fetch: createUpdateFetch(factory), factory, client };
}
function response(body = new PassThrough(), statusCode = 200) {
  const stream = Object.assign(body, {
    statusCode,
    headers: { 'content-type': 'application/octet-stream', 'x-fixture': ['one', 'two'] },
  });
  live.push(stream);
  return stream;
}
it('原生 redirect 事件返回手动 302，不调用 followRedirect，预期取消错误不会覆盖结果', async () => {
  const f = fixture((client) => {
    client.emit(
      'redirect',
      302,
      'GET',
      'https://release-assets.githubusercontent.com/github-production-release-asset/1/file',
      {},
    );
    client.emit('error', new Error('Redirect was cancelled'));
  });
  const result = await f.fetch(
    'https://github.com/liwl1995/DeployCenter/releases/download/v1/file',
    { redirect: 'manual' },
  );
  expect(result.status).toBe(302);
  expect(result.headers.get('location')).toContain('release-assets');
  expect(f.client.abort).toHaveBeenCalledOnce();
  expect(f.factory).toHaveBeenCalledWith(
    expect.objectContaining({ redirect: 'manual', credentials: 'omit', cache: 'no-store' }),
  );
});
it('正常响应流式返回字节和头，不等待完整下载', async () => {
  const body = response();
  const f = fixture((client) => client.emit('response', body));
  const result = await f.fetch('https://example.invalid/', {});
  expect(result.status).toBe(200);
  expect(result.headers.get('x-fixture')).toBe('one, two');
  const reader = result.body!.getReader();
  body.write(Buffer.from('part-1'));
  expect(Buffer.from((await reader.read()).value!).toString()).toBe('part-1');
  body.end(Buffer.from('part-2'));
  const chunks = [];
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    chunks.push(Buffer.from(part.value));
  }
  expect(Buffer.concat(chunks).toString()).toBe('part-2');
});
it('取消前后都终止请求，提前取消不会创建网络请求', async () => {
  const controller = new AbortController();
  controller.abort();
  const f = fixture(() => {});
  await expect(f.fetch('https://example.invalid/', { signal: controller.signal })).rejects.toThrow(
    /取消/,
  );
  expect(f.factory).not.toHaveBeenCalled();
  const body = response(),
    pending = new AbortController(),
    g = fixture((client) => client.emit('response', body));
  const result = await g.fetch('https://example.invalid/', { signal: pending.signal });
  const reader = result.body!.getReader();
  const read = reader.read();
  pending.abort();
  await expect(read).rejects.toThrow(/取消/);
  expect(g.client.abort).toHaveBeenCalledOnce();
});
it('消费端取消及服务端异常会停止下载，不把截断响应当作完成', async () => {
  const body = response(),
    f = fixture((client) => client.emit('response', body));
  const result = await f.fetch('https://example.invalid/', {});
  await result.body!.cancel();
  expect(f.client.abort).toHaveBeenCalled();
  const broken = response(),
    g = fixture((client) => client.emit('response', broken));
  const cancellation = new AbortController();
  const remove = vi.spyOn(cancellation.signal, 'removeEventListener');
  const reply = await g.fetch('https://example.invalid/', { signal: cancellation.signal });
  const reader = reply.body!.getReader();
  const read = reader.read();
  broken.destroy(new Error('更新连接提前关闭，请重试'));
  await expect(read).rejects.toThrow(/提前关闭/);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});
it('响应头之前的失败和中止明确返回错误', async () => {
  const f = fixture((client) => client.emit('error', new Error('连接失败')));
  await expect(f.fetch('https://example.invalid/', {})).rejects.toThrow('连接失败');
  const g = fixture((client) => client.emit('abort'));
  await expect(g.fetch('https://example.invalid/', {})).rejects.toThrow(/取消/);
});
it('暂停消费时施加背压，不把完整安装包缓存在内存中', async () => {
  let produced = 0;
  const stream = Readable.from(
    (async function* () {
      for (let i = 0; i < 1000; i++) {
        produced++;
        yield Buffer.alloc(16 * 1024);
      }
    })(),
  );
  const body = response(stream as PassThrough),
    f = fixture((client) => client.emit('response', body));
  const result = await f.fetch('https://example.invalid/', {});
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(produced).toBeLessThan(20);
  await result.body!.cancel();
});

it('请求写端提前 close 不影响后续响应，空响应返回状态且正常结束', async () => {
  const body = response();
  const f = fixture((client) => {
    client.emit('close');
    client.emit('response', body);
  });
  const result = await f.fetch('https://example.invalid/', {});
  body.end('ok');
  expect(await result.text()).toBe('ok');
  const empty = response(new PassThrough(), 204),
    g = fixture((client) => client.emit('response', empty));
  expect((await g.fetch('https://example.invalid/', {})).status).toBe(204);
});
