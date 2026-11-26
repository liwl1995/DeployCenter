import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  Box,
  ChevronsLeft,
  ChevronsRight,
  Layers,
  Search,
  Settings,
} from 'lucide-react';
import { Button } from '../ui/button';
import { HoverTip } from '../ui/hover-tip';
import { useSidebarCollapsed } from '../useSidebarCollapsed';
import { EntityIcon } from '../../entity-icons';
import type { EntityIcon as EntityIconType } from '../../model';
import type { WorkspacePage } from '../../workspace-model';

type DropPosition = 'before' | 'after';

export function ServiceSidebar({
  services,
  onReorder,
  savingOrder,
  deployedServices,
  current,
  page,
  onPage,
  onService,
  onSearch,
  global,
  task,
  settingsNavigation,
  updateAvailable,
  development,
}: {
  services: { id: string; name: string; tone: number; icon?: EntityIconType }[];
  onReorder: (ids: string[]) => Promise<void>;
  savingOrder: boolean;
  deployedServices: ReadonlySet<string>;
  current: string;
  page: WorkspacePage;
  onPage: (page: WorkspacePage) => void;
  onService: (id: string) => void;
  onSearch: () => void;
  global: ReactNode;
  task: ReactNode;
  settingsNavigation: ReactNode;
  updateAvailable: boolean;
  development?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const draggedService = useRef<string | undefined>(undefined);
  const [drop, setDrop] = useState<{ id: string; position: DropPosition }>();
  const { collapsed, toggle } = useSidebarCollapsed(ref);
  const Toggle = collapsed ? ChevronsRight : ChevronsLeft;
  const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏';
  const endDrag = () => {
    draggedService.current = undefined;
    setDrop(undefined);
  };
  const dropPosition = (event: DragEvent<HTMLButtonElement>): DropPosition => {
    const row = event.currentTarget.getBoundingClientRect();
    return event.clientY < row.top + row.height / 2 ? 'before' : 'after';
  };
  const moveService = (from: string, to: string, position: DropPosition) => {
    if (savingOrder || from === to) return;
    const ids = services.map(({ id }) => id);
    const originalIndex = ids.indexOf(from);
    if (originalIndex < 0 || !ids.includes(to)) return;
    ids.splice(originalIndex, 1);
    const newIndex = ids.indexOf(to) + Number(position === 'after');
    if (originalIndex === newIndex) return;
    ids.splice(newIndex, 0, from);
    void onReorder(ids);
  };
  return (
    <aside ref={ref} className="service-sidebar" data-collapsed={collapsed}>
      <div className="sidebar-brand">
        <a
          href="#deploy"
          aria-label="YOTOO 部署中心"
          onClick={(event) => {
            event.preventDefault();
            onPage('deploy');
          }}
        >
          <span className="sidebar-brand-mark" aria-hidden="true" />
          <strong>YOTOO 部署中心</strong>
        </a>
        <HoverTip content={toggleLabel} side="right">
          <Button variant="ghost" size="icon-compact" aria-label={toggleLabel} onClick={toggle}>
            <Toggle size={16} strokeWidth={1.5} />
          </Button>
        </HoverTip>
      </div>
      {development && <span className="sidebar-development">开发版</span>}
      <nav aria-label="主导航" className="sidebar-directory">
        {page === 'settings' ? (
          <>
            <button className="sidebar-link" aria-label="返回应用" onClick={() => onPage('deploy')}>
              <ArrowLeft size={16} />
              <span>返回应用</span>
            </button>
            {settingsNavigation}
          </>
        ) : (
          <>
            <div className="sidebar-service-heading">
              <span>服务</span>
              <Button variant="ghost" size="icon-compact" aria-label="搜索服务" onClick={onSearch}>
                <Search size={14} />
              </Button>
            </div>
            <div className="sidebar-services">
              {services.map((service, index) => (
                <HoverTip
                  key={service.id}
                  content={collapsed ? service.name : undefined}
                  side="right"
                >
                  <button
                    className="sidebar-link"
                    data-service-tone={service.tone}
                    data-drop-position={drop?.id === service.id ? drop.position : undefined}
                    aria-label={service.name}
                    aria-keyshortcuts={services.length > 1 ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                    aria-current={page === 'deploy' && current === service.id ? 'page' : undefined}
                    draggable={services.length > 1 && !savingOrder}
                    onClick={() => onService(service.id)}
                    onKeyDown={(event) => {
                      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                      event.preventDefault();
                      const up = event.key === 'ArrowUp';
                      const adjacent = services[index + (up ? -1 : 1)];
                      if (adjacent) moveService(service.id, adjacent.id, up ? 'before' : 'after');
                    }}
                    onDragStart={(event) => {
                      draggedService.current = service.id;
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('application/x-yotoo-sidebar-service', service.id);
                    }}
                    onDragOver={(event) => {
                      if (!draggedService.current) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const position = dropPosition(event);
                      setDrop((previous) => {
                        if (draggedService.current === service.id) return undefined;
                        if (previous?.id === service.id && previous.position === position) return previous;
                        return { id: service.id, position };
                      });
                    }}
                    onDragLeave={() => setDrop((previous) => previous?.id === service.id ? undefined : previous)}
                    onDrop={(event) => {
                      const from = draggedService.current;
                      if (!from) return;
                      event.preventDefault();
                      endDrag();
                      moveService(from, service.id, dropPosition(event));
                    }}
                    onDragEnd={endDrag}
                  >
                    <EntityIcon kind="service" icon={service.icon} size={17} strokeWidth={1.6} />
                    <span>{service.name}</span>
                    <i
                      className="sidebar-service-status"
                      data-deployed={deployedServices.has(service.id)}
                      title={deployedServices.has(service.id) ? '已部署' : '未部署'}
                    />
                  </button>
                </HoverTip>
              ))}
              {!services.length && (
                <button
                  className="sidebar-link"
                  aria-label="一键部署"
                  aria-current={page === 'deploy' ? 'page' : undefined}
                  onClick={() => onPage('deploy')}
                >
                  <Box size={17} />
                  <span>一键部署</span>
                </button>
              )}
            </div>
            {task}
            <div className="sidebar-global">{global}</div>
          </>
        )}
      </nav>
      <div className="sidebar-bottom">
        <button
          className="sidebar-link"
          aria-label="服务管理"
          aria-current={page === 'services' ? 'page' : undefined}
          onClick={() => onPage('services')}
        >
          <Layers size={16} strokeWidth={1.6} />
          <span>服务</span>
        </button>
        <button
          className="sidebar-link"
          aria-label="设置"
          aria-description={updateAvailable ? '有可用的软件更新' : undefined}
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => onPage('settings')}
        >
          <Settings size={16} strokeWidth={1.6} />
          <span>设置</span>
          {updateAvailable && <i className="update-notification-dot" aria-hidden="true" title="有可用的软件更新" />}
        </button>
      </div>
    </aside>
  );
}
