import type { Task } from './model';

/** 仅用于状态栏展示，复用当前任务已有的阶段进度，不改变任务执行状态。 */
export function taskProgress(task: Task) {
  const value =
    (Math.min(task.buildPhase, 3) +
      task.targets.reduce(
        (sum, run) => sum + (run.steps.length ? run.phase / run.steps.length : 0) * 3,
        0,
      )) /
    (3 + task.targets.length * 3);
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}
const key = (workspace: string) => 'yotoo-ui-expanded-targets:' + workspace;
export function readExpandedTargets(workspace: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(workspace)) || '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 1000)
      : [];
  } catch {
    return [];
  }
}
export function saveExpandedTargets(workspace: string, value: string[]) {
  try {
    localStorage.setItem(key(workspace), JSON.stringify(value.slice(0, 1000)));
  } catch {
    /* 界面偏好不可保存时不影响业务配置。 */
  }
}
