import { Fragment, useEffect, useState } from 'react';
import type { Database, Service } from './model';
import { fmtTime } from './model';
import type { DesktopAPI } from './platform';
import type { ToolResult } from './features';
import { toolLabels } from './presentation';
import { Card } from './ui';
import { MoreMenu } from './EntityActions';
import { ChevronDown } from 'lucide-react';
import { CompactStatus, compactVersion, shortReason } from './compact-list';
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
  const [expanded, setExpanded] = useState(new Set<string>());
  const [checking, setChecking] = useState('');
  const toggle = (key: string) =>
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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
          setChecking('jdk:' + jdk.name);
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
          setChecking('service:' + service.id);
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
        if (alive) {
          setRunning(false);
          setChecking('');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, key, refresh]);
  const refreshAction = {
    label: '重新检测',
    disabled: running,
    reason: running ? '正在检测，请稍候' : undefined,
    onClick: () => setRefresh((r) => r + 1),
  };
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
                className="compact-records tools-records"
                title="本机 JDK"
                action={
                  <div className="row">
                    <MoreMenu
                      label="更多构建环境操作"
                      actions={[{ label: '扫描本机 JDK', onClick: onScan }, refreshAction]}
                    />
                    <button className="button primary" onClick={onAdd}>
                      添加 JDK
                    </button>
                  </div>
                }
              >
                <table className="compact-table jdk-table" aria-label="本机 JDK 列表">
                  <colgroup>
                    <col className="tool-state-col" />
                    <col className="tool-name-col" />
                    <col className="tool-version-col" />
                    <col />
                    <col className="tool-refs-col" />
                    <col className="tool-menu-col" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">状态</th>
                      <th scope="col">名称</th>
                      <th scope="col">实际版本</th>
                      <th scope="col">安装路径</th>
                      <th scope="col">关联服务</th>
                      <th scope="col">
                        <span className="compact-visually-hidden">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {db.jdks.map((jdk) => {
                      const check = jdks[jdk.name],
                        refs = db.services.filter((s) => s.jdk === jdk.name).map((s) => s.name),
                        reason = deletionReason(jdk.name),
                        key = 'jdk:' + jdk.name,
                        isExpanded = expanded.has(key);
                      const label = check
                        ? check.ok
                          ? '可用'
                          : '不可用'
                        : checking === key
                          ? '检测中'
                          : '等待检测';
                      return (
                        <Fragment key={jdk.name}>
                          <tr
                            className="compact-data-row"
                            tabIndex={0}
                            aria-label={'JDK ' + jdk.name}
                            aria-expanded={isExpanded}
                            onClick={(e) => {
                              if (!(e.target as HTMLElement).closest('button,[role="menu"]'))
                                toggle(key);
                            }}
                            onKeyDown={(e) => {
                              if (e.target === e.currentTarget && ['Enter', ' '].includes(e.key)) {
                                e.preventDefault();
                                toggle(key);
                              }
                            }}
                          >
                            <td>
                              <CompactStatus
                                label={label}
                                tone={
                                  check
                                    ? check.ok
                                      ? 'good'
                                      : 'warn'
                                    : checking === key
                                      ? 'progress'
                                      : 'neutral'
                                }
                              />
                            </td>
                            <td>
                              <span className="compact-item-name">
                                <ChevronDown className={isExpanded ? 'expanded' : ''} size={14} />
                                <strong className="compact-ellipsis" title={jdk.name}>
                                  {jdk.name}
                                </strong>
                              </span>
                            </td>
                            <td>
                              <span
                                className={
                                  'compact-ellipsis compact-mono' +
                                  (check && !check.ok ? ' warning' : '')
                                }
                                title={check?.ok ? check.text : shortReason(check?.text)}
                              >
                                {check
                                  ? check.ok
                                    ? compactVersion(check.text, 'jdk')
                                    : shortReason(check.text)
                                  : '—'}
                              </span>
                            </td>
                            <td>
                              <span className="compact-ellipsis compact-path" title={jdk.path}>
                                {jdk.path}
                              </span>
                            </td>
                            <td title={refs.join('、') || '暂无服务使用'}>{refs.length} 个服务</td>
                            <td>
                              <MoreMenu
                                label={'更多 JDK ' + jdk.name + '操作'}
                                actions={[
                                  {
                                    label: isExpanded ? '收起检测详情' : '查看检测详情',
                                    onClick: () => toggle(key),
                                  },
                                  {
                                    label: '删除 JDK 配置',
                                    disabled: !!reason,
                                    reason,
                                    destructive: true,
                                    onClick: () => onDelete(jdk.name),
                                  },
                                ]}
                              />
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="compact-detail-row">
                              <td colSpan={6}>
                                <dl className="compact-facts">
                                  <div>
                                    <dt>安装路径</dt>
                                    <dd className="compact-path">{jdk.path}</dd>
                                  </div>
                                  <div>
                                    <dt>使用服务</dt>
                                    <dd>{refs.join('、') || '暂无服务使用'}</dd>
                                  </div>
                                  <div>
                                    <dt>检测时间</dt>
                                    <dd>{check ? fmtTime(check.time) : '尚未完成检测'}</dd>
                                  </div>
                                </dl>
                                <pre
                                  className={
                                    check && !check.ok ? 'tool-version warning' : 'tool-version'
                                  }
                                >
                                  {check?.text || '尚未收到版本输出。'}
                                </pre>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
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
              <Card
                className="compact-records tools-records"
                title="服务构建工具"
                action={<MoreMenu label="更多构建工具操作" actions={[refreshAction]} />}
              >
                <table className="compact-table maven-table" aria-label="服务构建工具列表">
                  <colgroup>
                    <col className="tool-state-col" />
                    <col />
                    <col className="maven-kind-col" />
                    <col className="tool-version-col" />
                    <col className="maven-jdk-col" />
                    <col className="maven-edit-col" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">状态</th>
                      <th scope="col">服务</th>
                      <th scope="col">构建方式</th>
                      <th scope="col">实际版本</th>
                      <th scope="col">所用 JDK</th>
                      <th scope="col">
                        <span className="compact-visually-hidden">操作</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {db.services.map((service) => {
                      const tool = tools[service.id],
                        key = 'service:' + service.id,
                        isExpanded = expanded.has(key);
                      const label = tool
                        ? tool.available
                          ? '可用'
                          : '不可用'
                        : checking === key
                          ? '检测中'
                          : '等待检测';
                      const actualKind = tool?.available
                        ? /(?:^|[\\/])mvnw(?:\.cmd)?$/i.test(tool.tool)
                          ? 'Wrapper'
                          : 'Maven'
                        : service.tool === 'wrapper'
                          ? 'Wrapper'
                          : service.tool === 'maven'
                            ? 'Maven'
                            : '自动选择';
                      return (
                        <Fragment key={service.id}>
                          <tr
                            className="compact-data-row"
                            tabIndex={0}
                            aria-label={'构建工具 ' + service.name}
                            aria-expanded={isExpanded}
                            onClick={(e) => {
                              if (!(e.target as HTMLElement).closest('button,[role="menu"]'))
                                toggle(key);
                            }}
                            onKeyDown={(e) => {
                              if (e.target === e.currentTarget && ['Enter', ' '].includes(e.key)) {
                                e.preventDefault();
                                toggle(key);
                              }
                            }}
                          >
                            <td>
                              <CompactStatus
                                label={label}
                                tone={
                                  tool
                                    ? tool.available
                                      ? 'good'
                                      : 'warn'
                                    : checking === key
                                      ? 'progress'
                                      : 'neutral'
                                }
                              />
                            </td>
                            <td>
                              <span className="compact-item-name">
                                <ChevronDown className={isExpanded ? 'expanded' : ''} size={14} />
                                <strong className="compact-ellipsis" title={service.name}>
                                  {service.name}
                                </strong>
                              </span>
                            </td>
                            <td title={toolLabels[service.tool]}>{actualKind}</td>
                            <td>
                              <span
                                className={
                                  'compact-ellipsis compact-mono' +
                                  (tool && !tool.available ? ' warning' : '')
                                }
                                title={tool?.available ? tool.version : shortReason(tool?.reason)}
                              >
                                {tool
                                  ? tool.available
                                    ? compactVersion(tool.version, 'maven')
                                    : shortReason(tool.reason)
                                  : '—'}
                              </span>
                            </td>
                            <td>
                              <span
                                className="compact-ellipsis"
                                title={tool?.javaVersion || service.jdk}
                              >
                                {service.jdk || '未配置'}
                              </span>
                            </td>
                            <td>
                              <button
                                className="button compact-edit"
                                onClick={() => onEdit(service)}
                              >
                                编辑配置
                              </button>
                            </td>
                          </tr>
                          {isExpanded && (
                            <tr className="compact-detail-row">
                              <td colSpan={6}>
                                <dl className="compact-facts">
                                  <div>
                                    <dt>实际工具</dt>
                                    <dd className="compact-path">{tool?.tool || '尚未获取'}</dd>
                                  </div>
                                  <div>
                                    <dt>工作目录</dt>
                                    <dd className="compact-path">{tool?.workDir || '尚未获取'}</dd>
                                  </div>
                                  <div>
                                    <dt>Maven Profile</dt>
                                    <dd>{service.profiles || '未指定'}</dd>
                                  </div>
                                  <div>
                                    <dt>构建参数</dt>
                                    <dd className="compact-path">{service.args || '未指定'}</dd>
                                  </div>
                                  <div>
                                    <dt>配置方式</dt>
                                    <dd>{toolLabels[service.tool]}</dd>
                                  </div>
                                  <div>
                                    <dt>实际 JDK</dt>
                                    <dd>
                                      {tool ? compactVersion(tool.javaVersion, 'jdk') : '尚未检测'}
                                    </dd>
                                  </div>
                                </dl>
                                {tool?.available ? (
                                  <pre className="tool-version">{tool.version}</pre>
                                ) : (
                                  <p className="warning">
                                    {tool?.reason || '等待检测实际工具和版本…'}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                {!db.services.length && (
                  <p className="empty">尚无服务。先在服务管理添加服务，再配置构建工具。</p>
                )}
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
        JAVA_HOME 和 PATH 仅作用于本次构建，不修改系统环境；版本检测不会执行项目构建。
      </p>
    </>
  );
}
