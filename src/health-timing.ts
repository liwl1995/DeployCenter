import type { Health } from './model';

/** 旧配置继续按次数执行；编辑后可显式切换到按时长等待就绪。 */
export function healthTiming(health: Health) {
  return {
    delay: health.startDelay ?? 0,
    window:
      health.maxWait ?? health.retries * health.timeout + (health.retries - 1) * health.interval,
    byWindow: health.maxWait !== undefined,
  };
}
