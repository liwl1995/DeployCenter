import type { Server, Target } from './model';
import { remoteJar, serverAddress } from './model';
import { healthLabels } from './presentation';
import { healthTiming } from './health-timing';
import { Disclosure } from './WorkspaceLayout';

/** 仅组织既有配置的展示，编辑及执行规则仍走原表单和部署流程。 */
export function TargetConfiguration({ target, server }: { target: Target; server?: Server }) {
  const timing = healthTiming(target.health);
  return (
    <div className="target-configuration">
      <section className="configuration-group">
        <h3>连接</h3>
        <dl className="configuration-grid">
          <div>
            <dt>服务器</dt>
            <dd>
              {server?.name || '未关联'}
              <small>{server ? serverAddress(server) : ''}</small>
            </dd>
          </div>
          <div>
            <dt>远程 JAR</dt>
            <dd className="path">{remoteJar(target)}</dd>
          </div>
        </dl>
      </section>
      <section className="configuration-group">
        <h3>运行</h3>
        <dl className="configuration-grid">
          {target.mode === 'docker' ? (
            <>
              <div>
                <dt>容器</dt>
                <dd>{target.container}</dd>
              </div>
              <div>
                <dt>挂载方式</dt>
                <dd>{target.mount === 'file' ? '单文件挂载' : '目录挂载'}</dd>
              </div>
            </>
          ) : (
            <>
              <div>
                <dt>启动 / 重启命令</dt>
                <dd className="path">{target.restart || target.start || '未配置'}</dd>
              </div>
              <div>
                <dt>停止命令</dt>
                <dd className="path">{target.stop || '未配置'}</dd>
              </div>
            </>
          )}
          <div>
            <dt>健康检查</dt>
            <dd>
              {target.health.type === 'none'
                ? '未配置'
                : healthLabels[target.health.type] + ' · ' + target.health.value}
            </dd>
          </div>
          {target.health.type !== 'none' && (
            <div>
              <dt>启动等待 / 就绪窗口</dt>
              <dd>
                {timing.delay} 秒 / {timing.window} 秒
              </dd>
            </div>
          )}
        </dl>
      </section>
      <section className="configuration-group">
        <h3>保护</h3>
        <dl className="configuration-grid">
          <div>
            <dt>默认备份</dt>
            <dd>{target.backup.enabled ? '开启' : '关闭'}</dd>
          </div>
          {target.backup.enabled && (
            <div>
              <dt>备份目录</dt>
              <dd className="path">{target.backup.directory}</dd>
            </div>
          )}
        </dl>
        <Disclosure title="高级保护规则" description="备份命名、权限调整及停止失败处理。">
          <dl className="configuration-grid">
            {target.backup.enabled && (
              <div>
                <dt>备份文件名模板</dt>
                <dd className="path">{target.backup.template}</dd>
              </div>
            )}
            <div>
              <dt>停止命令返回非零时</dt>
              <dd>{target.stopFailure === 'warn' ? '记录警告并继续' : '终止部署'}</dd>
            </div>
            {target.mode === 'jar' && (
              <div>
                <dt>调整可执行权限</dt>
                <dd>{target.chmod ? '启用 chmod +x' : '关闭'}</dd>
              </div>
            )}
          </dl>
        </Disclosure>
      </section>
    </div>
  );
}
