import type { DesktopPreferences } from './desktop-preferences';
import type { Database } from './model';
import { lastServiceDeployments } from './presentation';

export function sidebarServices(
  { services, targets, history }: Pick<Database, 'services' | 'targets' | 'history'>,
  { sortSidebarByDeployment, sidebarServiceOrder }: DesktopPreferences,
) {
  const positions = new Map(sidebarServiceOrder.map((id, index) => [id, index]));
  const latestDeployment = lastServiceDeployments({ targets, history });
  // 同一时间和未部署的服务按手动顺序排列，新服务跟在已保存的顺序后面。
  return services.map(({ id, name, icon }, index) => ({
    id, name, icon, tone: index % 4,
    position: positions.get(id) ?? sidebarServiceOrder.length + index,
    deployed: latestDeployment.has(id),
    time: sortSidebarByDeployment && latestDeployment.has(id)
      ? Date.parse(latestDeployment.get(id)!)
      : -Infinity,
  })).sort((a, b) => {
    if (a.time !== b.time) return b.time - a.time;
    return a.position - b.position;
  });
}
