import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './design/ui/button';
import { EntityDetail, EntityWorkspace } from './WorkspaceLayout';
import { Badge } from './ui';
import { fmtTime, type Database, type Service } from './model';
import { deploymentTime, taskResult, toolLabels } from './presentation';
import type { TaskSummary } from './platform';

export function ServicesWorkspace({
  db,
  taskRows,
  onAdd,
  onPickIcon,
  renderActions: serviceActions,
}: {
  db: Database;
  taskRows: TaskSummary[];
  onAdd: () => void;
  onPickIcon: (id: string) => void;
  renderActions: (service: Service) => ReactNode;
}) {
  const cardTime = (value?: string) => (deploymentTime(value) ? fmtTime(value!).slice(5, 16) : '—');
  const serviceLastDeploy = (id: string) =>
    db.targets
      .filter((t) => t.serviceId === id && deploymentTime(t.lastDeploy))
      .map((t) => t.lastDeploy)
      .sort()
      .at(-1) ||
    db.history.find(
      (h) =>
        h.service.id === id &&
        ['success', 'unverified', 'rolledback'].includes(h.status) &&
        deploymentTime(h.time),
    )?.time;
  return (
    <>
      <p className="page-intro">项目、构建环境和产物路径独立配置。</p>
      <EntityWorkspace
        actions={
          <Button variant="default" size="compact" onClick={onAdd}>
            <Plus size={17} />
            添加服务
          </Button>
        }
        cardActions={serviceActions}
        cardState={(s) => ({
          good: !!serviceLastDeploy(s.id),
          label: serviceLastDeploy(s.id) ? '已部署' : '未部署',
        })}
        cardMeta={(s) => (
          <>
            <span>{db.targets.filter((t) => t.serviceId === s.id).length} 个目标</span>
            <time>{cardTime(serviceLastDeploy(s.id))}</time>
          </>
        )}
        summary={(s) => (
          <>
            <span className="path" title={s.root}>
              {s.root}
            </span>
            <span className="tags">
              <Badge>{s.jdk || '未选择 JDK'}</Badge>
              <Badge>{toolLabels[s.tool]}</Badge>
            </span>
          </>
        )}
        label="服务"
        items={db.services}
        entityKind="service"
        iconOf={(s) => s.icon}
        onPickIcon={(s) => onPickIcon(s.id)}
        title={(s) => s.name}
        subtitle={(s) => s.description || s.code}
        searchText={(s) => s.code + ' ' + s.root}
      >
        {(s) => (
          <EntityDetail key={s.id} title={s.name} action={serviceActions(s)}>
            <p className="muted">{s.description}</p>
            <p className="path">{s.root}</p>
            <div className="tags">
              <Badge>{s.jdk}</Badge>
              <Badge>{toolLabels[s.tool]}</Badge>
              {s.workDir && s.workDir !== '.' && <Badge>工作目录：{s.workDir}</Badge>}
            </div>
            <p className="code">
              {s.jarDir}\{s.jarName}
            </p>
            <p className="note">
              {(() => {
                const last = taskRows.find((r) => r.serviceId === s.id && !r.dryRun);
                return last
                  ? '上次部署：' + fmtTime(last.started) + ' · ' + taskResult(last)
                  : db.history.find((h) => h.service.id === s.id)
                    ? '上次部署：' + fmtTime(db.history.find((h) => h.service.id === s.id)!.time)
                    : '尚未部署';
              })()}
            </p>
          </EntityDetail>
        )}
      </EntityWorkspace>
    </>
  );
}
