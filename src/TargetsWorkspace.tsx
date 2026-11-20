import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './design/ui/button';
import { EntityDetail, EntityWorkspace } from './WorkspaceLayout';
import { Badge, Field } from './ui';
import { fmtTime, modeLabel, remoteJar, type Database, type Target } from './model';
import { deploymentTime } from './presentation';
import { TargetConfiguration } from './TargetConfiguration';

export function TargetsWorkspace({
  db,
  serviceId,
  onService: selectService,
  onAdd,
  renderActions: targetActions,
}: {
  db: Database;
  serviceId: string;
  onService: (id: string) => void;
  onAdd: () => void;
  renderActions: (target: Target, detail?: boolean) => ReactNode;
}) {
  const targets = db.targets.filter((target) => target.serviceId === serviceId);
  const cardTime = (value: string) => (deploymentTime(value) ? fmtTime(value).slice(5, 16) : '—');
  return (
    <>
      <p className="page-intro">每个服务与服务器的部署关系，都有独立的运行规则。</p>
      <EntityWorkspace
        actions={
          <Button
            variant="default"
            size="compact"
            disabled={!db.servers.length || !db.services.length}
            onClick={onAdd}
          >
            <Plus size={17} />
            添加部署目标
          </Button>
        }
        filters={
          <div className="target-service-filter">
            <Field label="筛选服务">
              <select value={serviceId} onChange={(e) => selectService(e.target.value)}>
                {db.services.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        }
        cardActions={targetActions}
        cardState={(t) => ({
          good: !!deploymentTime(t.lastDeploy),
          label: deploymentTime(t.lastDeploy) ? '已部署' : '未部署',
        })}
        cardMeta={(t) => (
          <>
            <span title={t.healthState}>{t.healthState}</span>
            <time>{cardTime(t.lastDeploy)}</time>
          </>
        )}
        summary={(t) => (
          <>
            <span className="path" title={remoteJar(t)}>
              {remoteJar(t)}
            </span>
            <span className="tags">
              <Badge>{modeLabel(t.mode)}</Badge>
              <Badge kind={t.production ? 'warn' : ''}>{t.production ? '正式' : '非正式'}</Badge>
            </span>
          </>
        )}
        key={serviceId}
        label="部署目标"
        items={targets}
        title={(t) => t.name}
        subtitle={(t) => db.servers.find((s) => s.id === t.serverId)?.name || '未关联服务器'}
        searchText={(t) =>
          [
            db.services.find((s) => s.id === t.serviceId)?.name,
            db.servers.find((s) => s.id === t.serverId)?.name,
            modeLabel(t.mode),
          ].join(' ')
        }
      >
        {(t) => (
          <EntityDetail
            key={t.id}
            title={
              <span className="row">
                {t.name}
                <Badge kind={t.production ? 'warn' : ''}>{modeLabel(t.mode)}</Badge>
              </span>
            }
            action={targetActions(t, true)}
          >
            <TargetConfiguration target={t} server={db.servers.find((s) => s.id === t.serverId)} />
          </EntityDetail>
        )}
      </EntityWorkspace>
    </>
  );
}
