import { connect } from 'node:net';
import type { Health } from '../src/model';
import { healthTiming } from '../src/health-timing';
import type { Clock } from './capabilities';

export type HealthProbe = (
  health: Health,
  timeoutMs: number,
  signal: AbortSignal,
) => Promise<boolean>;
const probeHealth: HealthProbe = async (health, timeoutMs, signal) => {
  if (health.type === 'http') {
    const response = await fetch(health.value, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: 'follow',
    });
    const ok = response.status >= 200 && response.status < 300;
    await response.body?.cancel();
    return ok;
  }
  if (health.type !== 'tcp') return false;
  const m = health.value.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
  if (!m) return false;
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: m[1] || m[2], port: Number(m[3]) });
    const end = (ok: boolean) => {
      signal.removeEventListener('abort', abort);
      socket.destroy();
      resolve(ok);
    };
    const abort = () => end(false);
    socket.setTimeout(timeoutMs, abort);
    socket.once('connect', () => end(true));
    socket.once('error', abort);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
};

/** 窗口内失败表示尚未就绪；仅窗口耗尽或旧配置次数用尽才返回失败。 */
export async function localHealth(
  health: Health,
  clock: Clock,
  signal: AbortSignal,
  log: (s: string) => void,
  probe: HealthProbe = probeHealth,
): Promise<boolean> {
  const timing = healthTiming(health);
  const sleep = async (ms: number) => {
    const end = clock.now() + ms;
    while (!signal.aborted && clock.now() < end)
      await clock.sleep(Math.min(1000, end - clock.now()));
  };
  if (timing.delay) {
    log('启动等待 ' + timing.delay + ' 秒后开始健康检查\n');
    await sleep(timing.delay * 1000);
  }
  const deadline = clock.now() + timing.window * 1000;
  let attempt = 0;
  while (
    !signal.aborted &&
    clock.now() < deadline &&
    (timing.byWindow || attempt < health.retries)
  ) {
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    let ok = false;
    try {
      ok = await probe(
        health,
        Math.max(1, Math.floor(Math.min(health.timeout * 1000, remaining))),
        signal,
      );
    } catch {
      ok = false;
    }
    log('本机健康检查第 ' + ++attempt + ' 次：' + (ok ? '通过' : '尚未就绪') + '\n');
    if (ok && !signal.aborted) return true;
    if (!timing.byWindow && attempt >= health.retries) break;
    await sleep(Math.min(health.interval * 1000, Math.max(0, deadline - clock.now())));
  }
  log(signal.aborted ? '健康检查已中止\n' : '健康检查等待结束，应用仍未就绪\n');
  return false;
}
