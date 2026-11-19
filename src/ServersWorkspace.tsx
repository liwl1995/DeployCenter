import { Plus, Server as ServerIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './design/ui/button';
import { Badge } from './ui';
import { serverAddress, fmtTime, type Database, type Server } from './model';
import { deploymentTime } from './presentation';
import { EntityDetail, EntityWorkspace } from './WorkspaceLayout';

export const serverIdentity = (server: Server) =>
  JSON.stringify([
    server.host,
    server.user,
    server.port,
    server.auth,
    server.alias,
    server.keyPath,
    server.sshConfigFile,
  ]);
export type ServerCheck = { ok: boolean; time: string; identity: string };

export function ServersWorkspace({
  db,
  desktop,
  checks: serverChecks,
  onAdd,
  renderActions: serverActions,
}: {
  db: Database;
  desktop: boolean;
  checks: Record<string, ServerCheck>;
  onAdd: () => void;
  renderActions: (s: Server) => ReactNode;
}) {
  const cardTime = (value: string) => (deploymentTime(value) ? fmtTime(value).slice(5, 16) : '—');
  return (
    <>
      <p className="page-intro">认证信息集中维护，同一台服务器可关联多个服务。</p>
      <EntityWorkspace
        actions={
          <Button
            variant={db.servers.length ? 'neutral' : 'default'}
            size="compact"
            onClick={onAdd}
          >
            <Plus size={17} />
            添加服务器
          </Button>
        }
        cardActions={serverActions}
        cardState={(s) => ({
          good: serverChecks[s.id]?.identity === serverIdentity(s) && serverChecks[s.id].ok,
          label:
            serverChecks[s.id]?.identity === serverIdentity(s)
              ? serverChecks[s.id].ok
                ? '测试通过'
                : '测试未通过'
              : '未测试',
        })}
        cardMeta={(s) => (
          <>
            <span>{db.targets.filter((t) => t.serverId === s.id).length} 个目标</span>
            <time>
              {serverChecks[s.id]?.identity === serverIdentity(s)
                ? cardTime(new Date(serverChecks[s.id].time).toISOString())
                : '—'}
            </time>
          </>
        )}
        summary={(s) => (
          <>
            <span className="path" title={serverAddress(s)}>
              {serverAddress(s)}
            </span>
            <span className="tags">
              <Badge>
                {s.auth === 'alias' ? 'SSH 别名' : s.auth === 'password' ? '密码认证' : '私钥认证'}
              </Badge>
            </span>
          </>
        )}
        label="服务器"
        items={db.servers}
        title={(s) => s.name}
        subtitle={(s) => s.note || '服务器连接配置'}
      >
        {(s) => {
          const related = db.targets.filter((t) => t.serverId === s.id);
          return (
            <EntityDetail title={s.name}>
              <div className="list-row server-row" key={s.id}>
                <ServerIcon size={20} />
                <div className="grow">
                  <p className="muted">
                    {serverAddress(s)} ·{' '}
                    {s.auth === 'alias'
                      ? 'SSH Config'
                      : s.auth === 'password'
                        ? '密码认证'
                        : '私钥认证'}
                  </p>
                  <small>
                    关联 {new Set(related.map((t) => t.serviceId)).size} 个服务 / {related.length}{' '}
                    个部署目标
                  </small>
                </div>
                <Badge>
                  {serverChecks[s.id]?.identity === serverIdentity(s)
                    ? (serverChecks[s.id].ok ? '测试通过' : '测试未通过') +
                      ' · ' +
                      fmtTime(serverChecks[s.id].time)
                    : '未测试'}
                </Badge>
                {serverActions(s)}
              </div>
            </EntityDetail>
          );
        }}
      </EntityWorkspace>
      <p className="note">
        {desktop
          ? '被目标引用的服务器不可删除。口令仅使用当前 Windows 用户 DPAPI 加密，导出不包含口令。'
          : '被目标引用的服务器不可删除。原型不保存或导出密码及私钥口令。'}
      </p>
    </>
  );
}
