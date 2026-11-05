import { useEffect, useState } from 'react';
import type { Database, Service } from './model';
import { fmtTime } from './model';
import type { DesktopAPI } from './platform';
import type { ToolResult } from './features';
import { toolLabels } from './presentation';
import { Badge, Card } from './ui';
import { MoreMenu } from './EntityActions';
import { WorkspaceTabs } from './WorkspaceLayout';
export function BuildEnvironment({
  api,
  db,
  onEdit,
  onAdd,
  onScan,
  onDelete,
  deletionReason,
}: {
  api: DesktopAPI;
  db: Database;
  onEdit: (service: Service) => void;
  onAdd: () => void;
  onScan: () => void;
  onDelete: (name: string) => void;
  deletionReason: (name: string) => string;
}) {
  const [jdks, setJdks] = useState<Record<string, { ok: boolean; text: string; time: string }>>({}),
    [tools, setTools] = useState<Record<string, ToolResult>>({}),
    [refresh, setRefresh] = useState(0),
    [running, setRunning] = useState(false),
    [error, setError] = useState('');
  const key = JSON.stringify([db.jdks, db.services]);
  useEffect(() => {
    let alive = true;
    setJdks({});
    setTools({});
    setError('');
    setRunning(true);
    void (async () => {
      try {
        await api.save(db);
        // 顺序检测，避免同一时间启动大量 Wrapper/Java 子进程。
        for (const jdk of db.jdks) {
          if (!alive) return;
          let result;
          try {
            result = {
              ok: true,
              text: await api.checkTool('jdk', jdk.path),
              time: new Date().toISOString(),
            };
          } catch (e) {
            result = { ok: false, text: String(e), time: new Date().toISOString() };
          }
          if (alive) setJdks((old) => ({ ...old, [jdk.name]: result }));
        }
        for (const service of db.services) {
          if (!alive) return;
          try {
            const result = await api.toolInfo(service.id);
            if (alive) setTools((old) => ({ ...old, [service.id]: result }));
          } catch (e) {
            if (alive)
              setTools((old) => ({
                ...old,
                [service.id]: {
                  serviceId: service.id,
                  tool: '',
                  version: '',
                  javaVersion: '',
                  workDir: '',
                  available: false,
                  reason: String(e),
                },
              }));
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setRunning(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, key, refresh]);
  return (
    <>
      <WorkspaceTabs
        label="构建环境分类"
        sections={[
          {
            id: 'jdk',
            label: 'JDK 管理',
            content: (
              <Card
                title="本机 JDK"
                action={
                  <div className="row wrap">
                    <MoreMenu
                      label="更多构建环境操作"
                      actions={[
                        { label: '扫描本机 JDK', onClick: onScan },
                        {
                          label: '重新检测',
                          disabled: running,
                          reason: running ? '正在检测，请稍候' : undefined,
                          onClick: () => setRefresh((r) => r + 1),
                        },
                      ]}
                    />
                    <button className="button primary" onClick={onAdd}>
                      添加 JDK
                    </button>
                  </div>
                }
              >
                {db.jdks.map((jdk) => {
                  const check = jdks[jdk.name],
                    refs = db.services.filter((s) => s.jdk === jdk.name).map((s) => s.name),
                    reason = deletionReason(jdk.name);
                  return (
                    <article className="list-row wrap" key={jdk.name}>
                      <div className="grow">
                        <h3>{jdk.name}</h3>
                        <p className="path">{jdk.path}</p>
                        <p className="note">使用服务：{refs.join('、') || '暂无服务使用'}</p>
                        {check && (
                          <>
                            <p className="note">检测时间：{fmtTime(check.time)}</p>
                            <pre className={check.ok ? 'tool-version' : 'warning'}>
                              {check.text || '命令成功，但未输出版本信息。'}
                            </pre>
                          </>
                        )}
                      </div>
                      <Badge kind={check ? (check.ok ? 'good' : 'warn') : ''}>
                        {check ? (check.ok ? '可用' : '不可用') : '检测中'}
                      </Badge>
                      <MoreMenu
                        label={'更多 JDK ' + jdk.name + '操作'}
                        actions={[
                          {
                            label: '删除 JDK 配置',
                            disabled: !!reason,
                            reason,
                            destructive: true,
                            onClick: () => onDelete(jdk.name),
                          },
                        ]}
                      />
                    </article>
                  );
                })}
                {!db.jdks.length && (
                  <p className="empty">尚未配置 JDK。添加完整 JDK 后，服务才能重新构建。</p>
                )}
              </Card>
            ),
          },
          {
            id: 'maven',
            label: '服务构建工具',
            content: (
              <Card className="mt" title="服务构建工具与实际版本">
                {db.services.map((service) => {
                  const tool = tools[service.id];
                  return (
                    <article className="list-row wrap" key={service.id}>
                      <div className="grow">
                        <h3>{service.name}</h3>
                        <p className="muted">配置方式：{toolLabels[service.tool]}</p>
                        {tool ? (
                          tool.available ? (
                            <>
                              <p className="path">实际工具：{tool.tool}</p>
                              <p className="path">工作目录：{tool.workDir}</p>
                              <pre className="tool-version">{tool.version}</pre>
                            </>
                          ) : (
                            <p className="warning">{tool.reason}</p>
                          )
                        ) : (
                          <p className="note">等待检测实际工具和版本…</p>
                        )}
                        <p className="note">
                          构建配置：{service.profiles || '未指定 Profile'} · {service.args}
                        </p>
                      </div>
                      <button className="button" onClick={() => onEdit(service)}>
                        编辑构建配置
                      </button>
                    </article>
                  );
                })}
              </Card>
            ),
          },
        ]}
      />
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <p className="note">
        JAVA_HOME 和 PATH 仅注入单次构建进程，不修改系统配置。版本检测不执行项目构建。
      </p>
    </>
  );
}
