import type { UpdatePolicy } from '../src/desktop-preferences';
import type { AppUpdater } from './app-updater';

const firstDelay = 60_000;
const interval = 6 * 60 * 60_000;

/** 手动操作和后台检查共用更新器；下载结束后仍等待用户启动安装。 */
export function backgroundUpdates(
  updater: Pick<AppUpdater, 'isBusy' | 'check' | 'download'>,
  onError: (error: unknown) => void,
) {
  let policy: UpdatePolicy = 'manual';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const schedule = (delay: number, attempt: number) => {
    timer = setTimeout(async () => {
      try {
        if (updater.isBusy()) return;
        const state = await updater.check();
        if (state.stage === 'available' && policy === 'download' && attempt === generation)
          await updater.download();
      } catch (error) {
        onError(error);
      } finally {
        if (attempt === generation) schedule(interval, attempt);
      }
    }, delay);
    timer.unref();
  };
  return (next: UpdatePolicy) => {
    clearTimeout(timer);
    policy = next;
    generation++;
    if (policy !== 'manual') schedule(firstDelay, generation);
  };
}
