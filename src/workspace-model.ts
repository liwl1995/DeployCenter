import type { Database, Preset, Task } from './model';
import type { DesktopAPI } from './platform';
export const workspacePages = [
  { page: 'deploy', name: '一键部署', group: '操作' },
  { page: 'task', name: '当前任务', group: '操作' },
  { page: 'history', name: '部署历史', group: '操作' },
  { page: 'services', name: '服务管理', group: '配置' },
  { page: 'targets', name: '部署目标', group: '配置' },
  { page: 'servers', name: '服务器', group: '配置' },
  { page: 'tools', name: '构建环境', group: '配置' },
  { page: 'settings', name: '设置', group: '配置' },
] as const;
export type WorkspacePage = (typeof workspacePages)[number]['page'];
export function guideSteps(
  db: Database,
  tasks: { dryRun?: boolean; status: Task['status']; uncertain?: boolean }[],
) {
  return [
    { key: 'jdk', name: '配置 JDK', page: 'tools', done: !!db.jdks.length },
    { key: 'service', name: '添加服务', page: 'services', done: !!db.services.length },
    { key: 'server', name: '添加服务器', page: 'servers', done: !!db.servers.length },
    { key: 'target', name: '配置部署目标', page: 'targets', done: !!db.targets.length },
    {
      key: 'check',
      name: '完成一次试运行',
      page: 'deploy',
      done: tasks.some((t) => t.dryRun && !t.uncertain && t.status === 'success'),
    },
  ] as const;
}
export function presetReason(db: Database, p: Preset) {
  if (!db.services.some((s) => s.id === p.serviceId))
    return '预设引用的服务已删除，请重新保存预设。';
  if (
    !p.targetIds.length ||
    p.targetIds.some((id) => !db.targets.some((t) => t.id === id && t.serviceId === p.serviceId))
  )
    return '预设中的目标已变化，请检查并重新保存。';
  return '';
}
/** 预设只带选择，仍进入既有 prepare / 确认 / start 安全边界。 */
export async function preparePreset(api: DesktopAPI, db: Database, p: Preset) {
  const reason = presetReason(db, p);
  if (reason) throw new Error(reason);
  await api.save(db);
  return api.prepare({
    serviceId: p.serviceId,
    targetIds: [...p.targetIds],
    build: p.build,
    overrides: structuredClone(p.overrides),
    failurePolicy: p.failurePolicy,
  });
}
export function localComparison(input: {
  ahead?: number;
  behind?: number;
  sameJar?: boolean;
  newerJar?: boolean;
  dirty?: boolean;
}) {
  if (input.ahead !== undefined && input.behind !== undefined) {
    const suffix = input.dirty ? '；本地有未提交修改' : '';
    if (input.ahead && input.behind) return '本地与线上提交已分叉' + suffix;
    if (input.ahead) return '本地比线上新 ' + input.ahead + ' 个提交' + suffix;
    if (input.behind) return '本地比线上旧 ' + input.behind + ' 个提交' + suffix;
    if (input.sameJar) return '本地提交和 JAR 均与线上相同' + suffix;
    return '本地提交与线上相同；JAR ' + (input.newerJar ? '比线上新' : '差异无法判断') + suffix;
  }
  return input.sameJar ? '本地 JAR 与线上相同' : input.newerJar ? '本地 JAR 比线上新' : '无法判断';
}
