import type { UpdatePolicy } from '../src/desktop-preferences';
import type { AppUpdater } from './app-updater';

const firstDelay = 60_000;
const interval = 6 * 60 * 60_000;

/** 手动操作和后台检查共用更新器；下载结束后仍等待用户启动安装。 */
export function backgroundUpdates(
  updater: Pick<AppUpdater, 'isBusy' | 'restore' | 'check' | 'download'>,
  onError: (error: unknown) => void,
) {
  let policy: UpdatePolicy = 'manual';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  const schedule = (delay: number, attempt: number) => {
    timer = setTimeout(async () => {
      try {
        if (updater.isBusy()) return;
        // 先恢复已校验的缓存，离线检查失败时仍可使用已下载的安装包。
        await updater.restore();
        if (attempt !== generation || updater.isBusy()) return;
        const state = await updater.check();
        if (state.stage === 'available' && policy === 'download' && attempt === generation)
          await updater.download();
      } catch (error) {
        onError(error);
      } finally {
        if (attempt === generation && policy !== 'manual') schedule(interval, attempt);
      }
    }, delay);
    timer.unref();
  };
  return (next: UpdatePolicy, checkOnStartup = false) => {
    clearTimeout(timer);
    policy = next;
    generation++;
    if (checkOnStartup || policy !== 'manual') schedule(checkOnStartup ? 0 : firstDelay, generation);
  };
}
