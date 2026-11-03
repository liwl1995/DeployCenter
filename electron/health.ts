import { connect } from 'node:net';
import type { Health } from '../src/model';
import type { Clock } from './capabilities';
export async function localHealth(
  health: Health,
  clock: Clock,
  signal: AbortSignal,
  log: (s: string) => void,
): Promise<boolean> {
  for (let i = 0; i < health.retries; i++) {
    if (signal.aborted) return false;
    let ok = false;
    try {
      if (health.type === 'http') {
        const response = await fetch(health.value, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(health.timeout * 1000)]),
          redirect: 'follow',
        });
        ok = response.status >= 200 && response.status < 300;
        await response.body?.cancel();
      } else if (health.type === 'tcp') {
        const m = health.value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
        if (!m) throw new Error('TCP 地址格式无效');
        ok = await new Promise<boolean>((resolve) => {
          const socket = connect({ host: m[1] || m[2], port: Number(m[3]) });
          const end = (success: boolean) => {
            socket.destroy();
            resolve(success);
          };
          socket.setTimeout(health.timeout * 1000, () => end(false));
          socket.once('connect', () => end(true));
          socket.once('error', () => end(false));
          signal.addEventListener('abort', () => end(false), { once: true });
        });
      }
    } catch {
      ok = false;
    }
    log('本机健康检查 ' + (i + 1) + '/' + health.retries + '：' + (ok ? '通过' : '失败') + '\n');
    if (ok) return true;
    if (i + 1 < health.retries) await clock.sleep(health.interval * 1000);
  }
  return false;
}
