import type { ClientRequest, ClientRequestConstructorOptions } from 'electron';
import { Readable } from 'node:stream';

type RequestFactory = (options: ClientRequestConstructorOptions) => ClientRequest;
/** Electron fetch 的 manual 模式不返回 3xx；显式捕获事件，交回更新器逐跳核对地址。 */
export function createUpdateFetch(request: RequestFactory) {
  return (url: string, options: RequestInit): Promise<Response> =>
    new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) {
        reject(new DOMException('更新请求已取消', 'AbortError'));
        return;
      }
      let responseSent = false,
        finished = false;
      let incoming: Readable | undefined;
      const client = request({
        url,
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: Object.fromEntries(new Headers(options.headers).entries()),
      });
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const fail = (error: Error) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (incoming) incoming.destroy(error);
        if (!responseSent) reject(error);
      };
      const abort = () => {
        fail(new DOMException('更新请求已取消', 'AbortError'));
        client.abort();
      };
      // 不移除错误监听：手动 3xx 返回后 Electron 仍可能报告预期的取消错误。
      client.on('error', fail);
      client.on('abort', () => fail(new DOMException('更新请求已取消', 'AbortError')));
      // 请求写端的 close 可早于响应；响应失败由其 error/aborted 和取消信号处理。
      client.on('redirect', (status, _method, destination) => {
        if (finished) return;
        finished = true;
        responseSent = true;
        cleanup();
        // 不在此直接跟随，下一次请求仍须经过 AppUpdater 的 HTTPS 和来源检查。
        resolve(new Response(null, { status, headers: { location: destination } }));
        client.abort();
      });
      client.on('response', (message) => {
        if (finished) return;
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(message.headers))
            for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
          // Electron 实际响应继承 Node Readable；toWeb 保留背压，避免缓存整个安装包。
          incoming = message as unknown as Readable;
          incoming.once('error', fail);
          const status = message.statusCode;
          if ([204, 205, 304].includes(status)) {
            finished = true;
            responseSent = true;
            cleanup();
            resolve(new Response(null, { status, headers }));
            client.abort();
            return;
          }
          incoming.once('aborted', () => fail(new Error('更新下载连接已中断，请重试')));
          incoming.once('end', () => {
            finished = true;
            cleanup();
          });
          const reader = (
            Readable.toWeb(incoming, {
              strategy: { highWaterMark: 64 * 1024, size: (chunk: Uint8Array) => chunk.byteLength },
            }) as ReadableStream<Uint8Array>
          ).getReader();
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const item = await reader.read();
                if (item.done) controller.close();
                else controller.enqueue(item.value);
              } catch (error) {
                controller.error(error);
              }
            },
            async cancel() {
              finished = true;
              cleanup();
              client.abort();
              await reader.cancel().catch(() => {});
            },
          });
          resolve(new Response(body, { status, headers }));
          responseSent = true;
        } catch (error) {
          fail(error instanceof Error ? error : new Error('无法读取更新响应'));
          client.abort();
        }
      });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else client.end();
    });
}
