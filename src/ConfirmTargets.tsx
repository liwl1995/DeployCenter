import { ConfirmWarning } from './ConfirmWarning';
import { modeLabel, remoteJar, serverAddress, type Task } from './model';
import { healthLabels } from './presentation';
import { Badge } from './ui';

/** 部署与清单共用同一份目标确认摘要，清单默认展开运行与备份细节。 */
export function ConfirmTargets({ task: initial, expanded = false }: { task: Task; expanded?: boolean }) {
  return (
    <div className="confirm-targets">
      {initial.targets.map((r) => (
        <div className="confirm-target" key={r.target.id}>
          <div className="row spread">
            <div className="row wrap">
              <h3>{r.target.name}</h3>
              {initial.operation === 'deploy' &&
                initial.artifact.sha256 &&
                initial.artifact.sha256 === r.target.currentHash && (
                  <ConfirmWarning label="线上产物提示" text={'与线上相同：JAR 指纹一致，仍可继续部署以重新启动。' +
                    (initial.build === 'rebuild' ? '本次重新构建后会再次校验产物。' : '')} />
                )}
              {initial.operation === 'deploy' && !r.backup.enabled && (
                <ConfirmWarning label="备份提示" text="不备份：无法使用本次备份回滚。" />
              )}
              {r.target.createDirectory && (
                <ConfirmWarning label="远程目录提示" text={'已允许创建缺失目录：' + r.target.directory} />
              )}
            </div>
            <Badge kind={r.target.production ? 'warn' : ''}>
              {r.target.production && '正式 · '}
              {modeLabel(r.target.mode)}
            </Badge>
          </div>
          <p className="muted">
            {r.server.name} · {serverAddress(r.server)}
          </p>
          <p className="path">远程文件：{remoteJar(r.target)}</p>
          {initial.operation === 'deploy' && r.backup.enabled && (
            <p className="muted">
              {r.target.hasOldJar
                ? '保留备份，回滚前需要确认'
                : '首次部署无旧 JAR，跳过备份'}
            </p>
          )}
          {r.target.health.type === 'none' && (
            <p className="muted">未配置健康检查，结果将标记健康未验证</p>
          )}
          {(r.target.mode === 'docker' ||
            r.target.health.type !== 'none' ||
            (initial.operation === 'deploy' && r.backup.enabled && r.target.hasOldJar)) && (
            <details className="confirm-target-details" open={expanded || undefined}>
              <summary>目标详情</summary>
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
              {initial.operation === 'deploy' && r.backup.enabled && r.target.hasOldJar && (
                expanded
                  ? <p className="path">备份目录：{r.backup.directory || 'backups'} · 命名模板：{r.backup.template}</p>
                  : <p className="path">备份预览：{r.plannedBackupPath}</p>
              )}
            </details>
          )}
        </div>
      ))}
    </div>
  );
}
