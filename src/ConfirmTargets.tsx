import { modeLabel, remoteJar, serverAddress, type Task } from './model';
import { healthLabels } from './presentation';
import { Badge } from './ui';
import { EntityIcon } from './entity-icons';

/** 单次部署和批量发布共用目标摘要与可展开的细节。 */
export function ConfirmTargets({ task: initial, showObservation = false }: { task: Task; showObservation?: boolean }) {
  return (
    <div className="confirm-targets">
      {initial.targets.map((r) => {
        const deploying = initial.operation === 'deploy' && !initial.dryRun;
        const sameJar = deploying && initial.build === 'existing' &&
          !!initial.artifact.sha256 && initial.artifact.sha256 === r.target.currentHash;
        const backupPreview = deploying && r.backup.enabled && r.target.hasOldJar && r.plannedBackupPath;
        const canCreate = deploying && r.target.createDirectory;
        return (
          <div className="confirm-target" key={r.target.id}>
            <div className="row spread">
              <h3 className="confirm-target-name">{r.target.name}</h3>
              <Badge kind={r.target.production ? 'warn' : ''}>
                {r.target.production && '正式 · '}
                {modeLabel(r.target.mode)}
              </Badge>
            </div>
            <p className="muted confirm-server">
              <EntityIcon kind="server" icon={r.server.icon} size={15} strokeWidth={1.75} />
              {r.server.name} · {serverAddress(r.server)}
            </p>
            <p className="path">远程文件：{remoteJar(r.target)}</p>
            {deploying && (
              <p className="muted">
                {r.backup.enabled ? '存在旧 JAR 时备份，回滚前需要确认' : '本次不备份旧版本'}
              </p>
            )}
            {r.target.health.type === 'none' && (
              <p className="muted">未配置健康检查，结果将标记健康未验证</p>
            )}
            {showObservation && (
              <p className="muted">
                日志观察：{r.target.observation?.enabled
                  ? '健康未验证时观察 ' + r.target.observation.duration + ' 秒'
                  : '关闭'}
              </p>
            )}
            {(canCreate || sameJar || r.target.mode === 'docker' || r.target.health.type !== 'none' || backupPreview) && (
              <details className="confirm-target-details">
                <summary>目标详情</summary>
                {canCreate && <p className="muted">允许在部署时创建缺失目录</p>}
                {sameJar && <p className="muted">所选 JAR 与上次记录的线上指纹一致</p>}
                {r.target.mode === 'docker' && (
                  <p className="muted">
                    容器：{r.target.container} · {r.target.containerJar}
                  </p>
                )}
                {r.target.health.type !== 'none' && (
                  <p className="muted">
                    健康检查：{healthLabels[r.target.health.type]} · {r.target.health.value}
                  </p>
                )}
                {backupPreview && <p className="path">备份预览：{backupPreview}</p>}
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
