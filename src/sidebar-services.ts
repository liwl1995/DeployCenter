import type { DesktopPreferences } from './desktop-preferences';
import type { Database } from './model';
import { deploymentTime } from './presentation';

export function sidebarServices(
  { services, targets, history }: Pick<Database, 'services' | 'targets' | 'history'>,
  { sortSidebarByDeployment, sidebarServiceOrder }: DesktopPreferences,
) {
  const positions = new Map(sidebarServiceOrder.map((id, index) => [id, index]));
  const latestDeployment = new Map<string, number>();
  const record = (id: string, value: string) => {
    const time = deploymentTime(value);
    if (time) latestDeployment.set(id, Math.max(latestDeployment.get(id) ?? -Infinity, Date.parse(time)));
  };
  if (sortSidebarByDeployment) {
    for (const target of targets) record(target.serviceId, target.lastDeploy);
    for (const entry of history)
      if (['success', 'unverified', 'rolledback'].includes(entry.status))
        record(entry.service.id, entry.time);
  }
  // 同一时间和未部署的服务按手动顺序排列，新服务跟在已保存的顺序后面。
  return services.map(({ id, name, icon }, index) => ({
    id, name, icon, tone: index % 4,
    position: positions.get(id) ?? sidebarServiceOrder.length + index,
    time: latestDeployment.get(id) ?? -Infinity,
  })).sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    return a.position - b.position;
  });
}
