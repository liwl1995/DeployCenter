import { ChevronDown, Pencil, ScrollText } from 'lucide-react';
import type { ReactNode } from 'react';
import { HashValue } from './DeployDetails';
import { CompactStatus } from './compact-list';
import { Button } from './design/ui/button';
import { Checkbox } from './design/ui/checkbox';
import { BackupFields } from './forms';
import { fmtTime, modeLabel, remoteJar, serverAddress, type Backup, type Server, type Target } from './model';
import { deploymentTime, knownCommit } from './presentation';
import { Badge, Switch } from './ui';
import { EntityIcon } from './entity-icons';

export function DeploymentTargetRow({ target, server, checked, onChecked, open, onOpen,
  backup, onBackup, overridden, onRestore, onCopy, onEdit, onLogs, children }: {
  target: Target;
  server?: Server;
  checked: boolean;
  onChecked: () => void;
  open: boolean;
  onOpen: () => void;
  backup: Backup;
  onBackup: (backup: Backup) => void;
  overridden: boolean;
  onRestore: () => void;
  onCopy: (value: string) => void;
  onEdit?: () => void;
  onLogs?: () => void;
  children?: ReactNode;
}) {
  const t = target;
  return (
    <article className={'deployment-target' + (checked ? ' checked' : '')}>
      <div className="target-compact deployment-target-main">
        <Checkbox aria-label={'选择' + t.name} checked={checked} onCheckedChange={onChecked} />
        <span className="record-icon"><EntityIcon kind="target" icon={t.icon} size={18} strokeWidth={1.5} /></span>
        <button className="target-identity" aria-expanded={open}
          aria-label={(open ? '收起' : '展开') + t.name + '详情'} onClick={onOpen}>
          <strong>{t.name} {t.production && <Badge kind="warn">正式</Badge>}</strong>
          <small>{server ? serverAddress(server) + ' · ' + server.name : '未关联服务器'}</small>
        </button>
        <div className="target-artifact">
          <Badge>{modeLabel(t.mode)}</Badge>
          <HashValue label="Git 提交" value={t.currentCommit || knownCommit(t.version, t.currentHash)} onCopy={onCopy} />
        </div>
        <div className="target-health">
          <CompactStatus label={t.healthState} tone={/失败/.test(t.healthState) ? 'bad' : /通过/.test(t.healthState) ? 'good' : t.health.type === 'none' ? 'neutral' : 'warn'} />
          <time>{deploymentTime(t.lastDeploy) ? fmtTime(t.lastDeploy!).slice(5, 16) : '—'}</time>
        </div>
        <div className="target-backup" title={overridden ? '本次覆盖' : '目标默认'}>
          <Switch label={t.name + '备份'} checked={backup.enabled}
            onChange={(enabled) => onBackup({ ...backup, enabled })} />
        </div>
        <div className="deployment-target-actions">
          {onLogs && <Button variant="ghost" size="icon-compact" aria-label={'查看线上日志 · ' + t.name}
            title="查看线上日志" onClick={onLogs}><ScrollText size={15} /></Button>}
          {onEdit && <Button variant="ghost" size="icon-compact" aria-label={'编辑' + t.name}
            onClick={onEdit}><Pencil size={15} /></Button>}
          <Button variant="ghost" size="icon-compact" aria-label={'本次策略 · ' + t.name}
            aria-expanded={open} onClick={onOpen}><ChevronDown size={15} /></Button>
        </div>
      </div>
      {open && (
        <div className="target-override">
          <p className="path">{remoteJar(t)}</p>
          <HashValue label="JAR 指纹" value={t.currentHash} onCopy={onCopy} />
          <BackupFields value={backup} onChange={onBackup} />
          {children}
          {!backup.enabled && <p className="warning">未启用备份，失败时不能依赖本次备份恢复。</p>}
          <Button variant="link" size="compact" onClick={onRestore}>恢复该目标默认策略</Button>
        </div>
      )}
    </article>
  );
}
