import { useRef, type ReactNode } from 'react';
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
import type { Service } from '../../model';
import type { WorkspacePage } from '../../workspace-model';

export function ServiceSidebar({
  services,
  deployedServices,
  current,
  page,
  onPage,
  onService,
  onSearch,
  global,
  task,
  settingsNavigation,
}: {
  services: Service[];
  deployedServices: ReadonlySet<string>;
  current: string;
  page: WorkspacePage;
  onPage: (page: WorkspacePage) => void;
  onService: (id: string) => void;
  onSearch: () => void;
  global: ReactNode;
  task: ReactNode;
  settingsNavigation: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const { collapsed, toggle } = useSidebarCollapsed(ref);
  const Toggle = collapsed ? ChevronsRight : ChevronsLeft;
  const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏';
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
                    data-service-tone={index % 4}
                    aria-label={service.name}
                    aria-current={page === 'deploy' && current === service.id ? 'page' : undefined}
                    onClick={() => onService(service.id)}
                  >
                    <Box size={17} strokeWidth={1.6} />
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
          aria-current={page === 'settings' ? 'page' : undefined}
          onClick={() => onPage('settings')}
        >
          <Settings size={16} strokeWidth={1.6} />
          <span>设置</span>
        </button>
      </div>
    </aside>
  );
}
