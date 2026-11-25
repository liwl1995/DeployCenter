import { GitBranch, Rocket } from 'lucide-react';
import { useState } from 'react';
import { ArtifactInfo } from './ArtifactInfo';
import { ConfirmWarning } from './ConfirmWarning';
import { OldArtifactWarning } from './OldArtifactWarning';
import { credentialServers } from './credentials';
import { prototype } from './defaults';
import { HashValue } from './DeployDetails';
import { Button } from './design/ui/button';
import { modeLabel, remoteJar, serverAddress, type Task } from './model';
import { desktop, type Approval } from './platform';
import { confirmProduction, healthLabels, productionNames } from './presentation';
import { Badge, Card, Field, Modal, Switch } from './ui';
import { Disclosure } from './WorkspaceLayout';

const fixture = prototype && !desktop;

export function Confirm({
  task: initial,
  onStart,
  onCopy,
  onClose,
  returnFocus,
  saved = [],
  schedule = false,
  scheduledAt,
}: {
  schedule?: boolean;
  scheduledAt?: number;
  onCopy: (value: string) => void;
  saved?: string[];
  task: Task;
  onStart: (
    t: Task,
    credentials: Record<string, string>,
    approval: Approval,
    scheduledAt?: number,
  ) => void | Promise<void>;
  onClose: () => void;
  returnFocus?: HTMLElement;
}) {
  const [scheduleTime, setScheduleTime] = useState(() => {
    const date = new Date(
      scheduledAt && scheduledAt > Date.now() ? scheduledAt : Date.now() + 3600000,
    );
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const [word, setWord] = useState(''),
    [fallback, setFallback] = useState(false),
    [protect, setProtect] = useState(true);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false),
    [error, setError] = useState('');
  const servers = credentialServers(initial.targets.map((r) => r.server));
  const production = !initial.dryRun && initial.targets.some((r) => r.target.production),
    degraded =
      !initial.dryRun && initial.targets.some((r) => r.target.hashPolicy === 'size-confirm');
  const needsPassword = (s: (typeof servers)[number]) =>
    s.auth === 'password' && !(desktop && s.credentialMode === 'windows' && saved.includes(s.id));
  const firstPassword = servers.find(needsPassword);
  const title = schedule
    ? '确认定时发布'
    : initial.dryRun
      ? '确认试运行（远程只读）'
      : initial.operation === 'rollback'
        ? '确认回滚'
        : '确认部署';
  const actions = (
    <>
      {error && (
        <p role="alert" className="warning confirm-error">
          {error}
        </p>
      )}
      <div className="row wrap end">
        <Button
          variant="neutral" size="compact"
          data-autofocus={(!production && !firstPassword && !degraded) || undefined}
          onClick={onClose}
        >
          返回检查
        </Button>
        <Button
          data-confirm
          variant="default" size="compact"
          disabled={
            starting ||
            (production && (fixture ? word !== 'DEPLOY' : !confirmProduction(initial, names))) ||
            (degraded && !fallback) ||
            servers.some((s) => needsPassword(s) && !credentials[s.id])
          }
          onClick={async () => {
            setStarting(true);
            setError('');
            const task = structuredClone(initial);
            if (task.operation === 'rollback') {
              task.protectCurrent = protect;
              task.targets.forEach((r) => {
                r.backup.enabled = protect;
                r.steps = r.steps.map((s) =>
                  s.key === 'backup'
                    ? { ...s, label: protect ? '备份当前版本并校验' : '回滚前不另存当前版本' }
                    : s,
                );
              });
            }
            try {
              const at = new Date(scheduleTime).getTime();
              if (schedule && (!Number.isFinite(at) || at <= Date.now()))
                throw new Error('请选择未来的发布时间');
              await onStart(
                task,
                credentials,
                {
                  productionWord: word,
                  productionNames: names,
                  allowWeak: fallback,
                  protectCurrent: protect,
                },
                schedule ? at : undefined,
              );
              setCredentials({});
            } catch (e) {
              setError(String(e));
            } finally {
              setStarting(false);
            }
          }}
        >
          <Rocket size={17} />
          {schedule
            ? '确认计划'
            : initial.dryRun
              ? '开始试运行'
              : initial.operation === 'rollback'
                ? '回滚'
                : '部署'}
        </Button>
      </div>
    </>
  );
  return (
    <Modal title={title} onClose={onClose} wide footer={actions} returnFocus={returnFocus}>
      {schedule && (
        <>
          <Field label="发布时间">
            <input
              aria-label="发布时间"
              type="datetime-local"
              value={scheduleTime}
              onChange={(e) => setScheduleTime(e.target.value)}
            />
          </Field>
          <p className="note">
            时区：{Intl.DateTimeFormat().resolvedOptions().timeZone}
            。现在完成构建、连接测试和产物校验，到点上传部署；最晚延后 15
            分钟开始。电脑须开机且应用保持运行，退出或休眠错过时间不补发。
          </p>
          <p className="note">
            口令认证须配置 Windows 加密保存。配置、信任或线上版本变化后需要重新确认。
          </p>
        </>
      )}
      <div className="confirm-header">
        <h3>{initial.service.name}</h3>
        <Badge>
          {initial.dryRun
            ? '试运行 · 不构建、不上传、不修改远端'
            : initial.operation === 'rollback'
              ? '回滚历史备份，不构建'
              : initial.build === 'rebuild'
                ? '重新构建一次'
                : '使用现有 JAR'}
        </Badge>
        <OldArtifactWarning value={initial.artifact} service={initial.service} compact />
      </div>
      <p className="confirm-brief">
        {initial.targets.length} 个目标 · {initial.artifact.name} ·{' '}
        {initial.failurePolicy === 'stop' ? '失败后停止后续目标' : '失败后继续其他目标'}
      </p>
      {initial.note && <p className="note">本次内容：{initial.note}</p>}
      {initial.operation === 'rollback' && (
        <>
          <Field label="恢复来源">
            <p className="code">{initial.sourceBackup}</p>
          </Field>
          <Switch
            label="回滚前保护当前运行版本"
            checked={protect}
            onChange={setProtect}
            description="与恢复来源分开保存，恢复失败时用于保护当前版本"
          />
        </>
      )}
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
              <details className="confirm-target-details">
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
                  <p className="path">备份预览：{r.plannedBackupPath}</p>
                )}
              </details>
            )}
          </div>
        ))}
      </div>
      <p className="note">
        {fixture
          ? '所有执行均为本地模拟。'
          : initial.dryRun
            ? '本次仅执行只读检查，不上传或修改远程文件。'
            : '确认后将执行真实部署。'}
      </p>
      {degraded && (
        <label className="check-row warning">
          <input
            type="checkbox"
            className="ui-checkbox"
            data-autofocus={(!production && !firstPassword) || undefined}
            checked={fallback}
            onChange={(e) => setFallback(e.target.checked)}
          />
          确认允许缺少 SHA-256 工具时仅校验字节数（较弱校验）
        </label>
      )}
      {servers.map((s) => (
        <div className="confirm-target mt" key={s.id}>
          <div className="row wrap">
            <h3>{s.name} · 本次认证</h3>
            {s.credentialMode === 'windows' && (
              <ConfirmWarning label="口令保存提示" text={fixture
                ? 'Windows 凭据管理器是正式版能力。原型仍需本次输入，不会保存。'
                : saved.includes(s.id)
                  ? '已保存本机 DPAPI 加密凭据；留空复用，输入新值将更新。'
                  : '输入后使用当前 Windows 用户的 DPAPI 加密保存到本机。'} />
            )}
          </div>
          <Field
            label={
              (s.auth === 'password' ? '登录密码' : '私钥口令（未加密可留空）') + ' · ' + s.name
            }
            hint="仅保留在当前任务内存，任务结束清除，不进入配置、日志或导出"
          >
            <input
              type="password"
              data-autofocus={(!production && firstPassword?.id === s.id) || undefined}
              autoComplete="off"
              value={credentials[s.id] || ''}
              onChange={(e) => setCredentials((old) => ({ ...old, [s.id]: e.target.value }))}
            />
          </Field>
        </div>
      ))}
      {production && !fixture && (
        <div className="production-confirm">
          <strong>正式环境确认</strong>
          <p>逐个输入环境名称，确认本次会修改的位置；回滚也需要同样核对。</p>
          {productionNames(initial).map((target) => (
            <Field key={target.id} label={'输入环境名称：' + target.name}>
              <input
                data-autofocus
                value={names[target.id] || ''}
                onChange={(e) => setNames((old) => ({ ...old, [target.id]: e.target.value }))}
                autoComplete="off"
                placeholder={target.name}
              />
            </Field>
          ))}
        </div>
      )}
      {production && fixture && (
        <div className="production-confirm">
          <label className="field">
            <strong>正式环境确认</strong>
            <span>请输入 DEPLOY，确认目标及远程文件。</span>
            <input
              data-autofocus
              value={word}
              onChange={(e) => setWord(e.target.value)}
              autoComplete="off"
              placeholder="DEPLOY"
            />
          </label>
        </div>
      )}
      <Disclosure title={initial.build === 'rebuild' ? '构建、产物与 Git 详情' : '产物与 Git 详情'}>
        {initial.build === 'rebuild' && (
          <Card title="构建配置">
            <dl className="detail-list">
              <dt>构建工具</dt>
              <dd className="path">{initial.buildContext.tool}</dd>
              <dt>完整命令</dt>
              <dd className="path">{initial.buildContext.command}</dd>
              <dt>工作目录</dt>
              <dd className="path">{initial.buildContext.workDir}</dd>
              <dt>JDK</dt>
              <dd>
                {initial.buildContext.jdk} · {initial.buildContext.jdkPath}
              </dd>
              <dt>预期 JAR</dt>
              <dd className="path">{initial.buildContext.jarPath}</dd>
            </dl>
          </Card>
        )}
        <ArtifactInfo value={initial.artifact} />
        {initial.build === 'rebuild' && (
          <p className="note">
            {desktop
              ? '现有文件信息仅供参考；构建完成后将重新校验并生成不可变产物快照。'
              : '上方为当前示例产物；新产物大小、修改时间和哈希将在构建后重新检查。'}
          </p>
        )}
        <p className="branch">
          <GitBranch size={15} />
          {initial.service.git.branch}
          <HashValue label="Git 提交" value={initial.service.git.commit} onCopy={onCopy} />
        </p>
      </Disclosure>
    </Modal>
  );
}
