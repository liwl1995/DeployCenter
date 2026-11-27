import { Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './design/ui/button';
import { EntityDetail, EntityWorkspace } from './WorkspaceLayout';
import { Badge, Field } from './ui';
import { fmtTime, modeLabel, remoteJar, type Database, type Target } from './model';
import { deploymentTime } from './presentation';
import { TargetConfiguration } from './TargetConfiguration';
import { CompactStatus } from './compact-list';
import { operationStateLabels, type OperationStatus } from './operations';

export function TargetsWorkspace({
  db,
  serviceId,
  onService: selectService,
  onAdd,
  onConfigure,
  onPickIcon,
  renderActions: targetActions,
  runtime,
}: {
  db: Database;
  serviceId: string;
  onService: (id: string) => void;
  onAdd: () => void;
  onConfigure: (page: 'services' | 'servers') => void;
  onPickIcon: (id: string) => void;
  renderActions: (target: Target, detail?: boolean) => ReactNode;
  runtime?: Record<string, OperationStatus>;
}) {
  const targets = db.targets.filter((target) => target.serviceId === serviceId);
  const prerequisite = !db.services.length ? 'services' : !db.servers.length ? 'servers' : undefined;
  const cardTime = (value: string) => (deploymentTime(value) ? fmtTime(value).slice(5, 16) : '—');
  return (
    <>
      {prerequisite && (
        <p className="page-intro">{prerequisite === 'services' ? '先添加服务，再配置部署目标。' : '先添加服务器，再配置部署目标。'}</p>
      )}
      <EntityWorkspace
        actions={
          <Button
            variant="default"
            size="compact"
            onClick={prerequisite ? () => onConfigure(prerequisite) : onAdd}
          >
            <Plus size={17} />
            {prerequisite === 'services' ? '去添加服务' : prerequisite === 'servers' ? '去添加服务器' : '添加部署目标'}
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
              {runtime?.[t.id] && <span title={'最近运行检查 · ' + fmtTime(runtime[t.id].checkedAt)}>
                <CompactStatus label={operationStateLabels[runtime[t.id].state]}
                  tone={runtime[t.id].state === 'running' || runtime[t.id].state === 'matched' ? 'good' : 'neutral'} />
              </span>}
            </span>
          </>
        )}
        key={serviceId}
        label="部署目标"
        items={targets}
        entityKind="target"
        iconOf={(t) => t.icon}
        onPickIcon={(t) => onPickIcon(t.id)}
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
              <span className="row wrap">
                {t.name}
                <Badge kind={t.production ? 'warn' : ''}>{t.production ? '正式' : '非正式'}</Badge>
                <Badge>{modeLabel(t.mode)}</Badge>
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
