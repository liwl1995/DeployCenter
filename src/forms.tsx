import { useEffect, useId, useState, type FormEvent } from 'react';
import type { DiagnosticResult } from './features';
import { fmtTime } from './model';
import { ShieldCheck } from 'lucide-react';
import { Field, Switch, Demo, PathInput } from './ui';
import {
  type Database,
  type Service,
  type Server,
  type Target,
  type Health,
  type Backup,
  remoteJar,
} from './model';
import { desktop } from './platform';
import { healthTiming } from './health-timing';
import { prototype } from './defaults';
type SaveProps<T> = { initial: T; db: Database; onSave: (value: T) => void; onClose: () => void };
const Submit = ({ onClose }: { onClose: () => void }) => (
  <footer className="modal-actions">
    <button type="button" className="button" onClick={onClose}>
      取消
    </button>
    <button className="button primary" type="submit">
      保存配置
    </button>
  </footer>
);
export function ServiceForm({ initial, db, onSave, onClose }: SaveProps<Service>) {
  const [v, set] = useState(structuredClone(initial));
  const update = (key: keyof Service, value: string) => set((old) => ({ ...old, [key]: value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <div className="form-grid">
        <Field label="服务名称">
          <input required value={v.name} onChange={(e) => update('name', e.target.value)} />
        </Field>
        <Field label="服务标识">
          <input required value={v.code} onChange={(e) => update('code', e.target.value)} />
        </Field>
        <Field label="备注" wide>
          <input value={v.description} onChange={(e) => update('description', e.target.value)} />
        </Field>
        <Field label="项目根目录" wide>
          <PathInput
            label="项目根目录"
            kind="directory"
            required
            value={v.root}
            onChange={(value) => update('root', value)}
          />
        </Field>
        <Field label="构建工作目录" hint="相对路径以项目根目录解析">
          <input required value={v.workDir} onChange={(e) => update('workDir', e.target.value)} />
        </Field>
        <Field label="构建 JDK">
          <select value={v.jdk} onChange={(e) => update('jdk', e.target.value)}>
            <option value="">请选择</option>
            {db.jdks.map((j) => (
              <option key={j.name}>{j.name}</option>
            ))}
          </select>
        </Field>
        <Field label="构建工具">
          <select value={v.tool} onChange={(e) => update('tool', e.target.value)}>
            <option value="wrapper">项目 Maven Wrapper</option>
            <option value="maven">本地 Maven</option>
            <option value="auto">自动（Wrapper 优先）</option>
          </select>
        </Field>
        <Field
          label="Maven 可执行文件路径"
          hint={
            v.tool === 'wrapper'
              ? 'Wrapper 模式不会回退到本地 Maven'
              : '可留空使用 PATH 中的 mvn.cmd'
          }
        >
          <PathInput
            label="Maven 可执行文件路径"
            kind="maven"
            value={v.mavenPath}
            disabled={v.tool === 'wrapper'}
            onChange={(value) => update('mavenPath', value)}
          />
        </Field>
        {desktop && (
          <>
            <Field label="构建超时（秒）">
              <input
                type="number"
                min="30"
                max="86400"
                value={v.buildTimeout || 1800}
                onChange={(e) => set((old) => ({ ...old, buildTimeout: Number(e.target.value) }))}
              />
            </Field>
            <Field label="构建日志编码">
              <select
                value={v.logEncoding || 'auto'}
                onChange={(e) =>
                  set((old) => ({ ...old, logEncoding: e.target.value as Service['logEncoding'] }))
                }
              >
                <option value="auto">自动识别 UTF-8 / GBK</option>
                <option value="utf8">UTF-8</option>
                <option value="gb18030">GBK / GB18030</option>
              </select>
            </Field>
          </>
        )}
        <Field label="构建参数" wide>
          <input required value={v.args} onChange={(e) => update('args', e.target.value)} />
        </Field>
        <Field label="Maven Profiles" hint="多个 Profile 用逗号分隔">
          <input
            value={v.profiles}
            placeholder="test,release"
            onChange={(e) => update('profiles', e.target.value)}
          />
        </Field>
        <Field label="产物目录">
          <input required value={v.jarDir} onChange={(e) => update('jarDir', e.target.value)} />
        </Field>
        <Field label="本地 JAR 文件名" hint="各部署目标可配置不同的远程文件名">
          <input
            required
            pattern="[^/\\]+\.jar"
            value={v.jarName}
            onChange={(e) => update('jarName', e.target.value)}
          />
        </Field>
      </div>
      <p className="note">
        <ShieldCheck size={16} /> JAVA_HOME 和 PATH 只作用于本次构建进程，不修改系统环境变量。
      </p>
      <Submit onClose={onClose} />
    </form>
  );
}
export function ServerForm({
  initial,
  onSave,
  onClose,
  encryptionAvailable = true,
  onTestResult,
}: SaveProps<Server> & {
  encryptionAvailable?: boolean;
  onTestResult?: (server: Server, result: DiagnosticResult) => void;
}) {
  const [v, set] = useState(structuredClone(initial));
  const [candidate, setCandidate] = useState<{ hosts: string[]; warnings: string[] }>({
    hosts: [],
    warnings: [],
  });
  const [testSecret, setTestSecret] = useState(''),
    [testing, setTesting] = useState(false),
    [testResult, setTestResult] = useState<DiagnosticResult>(),
    [testError, setTestError] = useState('');
  const listId = useId();
  useEffect(() => {
    if (!desktop || v.auth !== 'alias') return;
    let alive = true;
    void desktop
      .sshAliases(v.sshConfigFile || undefined)
      .then((value) => {
        if (alive) setCandidate(value);
      })
      .catch(() => {
        if (alive)
          setCandidate({ hosts: [], warnings: ['无法读取候选列表，可继续手动输入别名。'] });
      });
    return () => {
      alive = false;
    };
  }, [v.auth, v.sshConfigFile]);
  const test = async () => {
    setTesting(true);
    setTestError('');
    try {
      const result = await desktop!.testDraft(v, testSecret);
      setTestResult(result);
      setTestSecret('');
      onTestResult?.(v, result);
    } catch (e) {
      setTestError(String(e));
    } finally {
      setTesting(false);
    }
  };
  const update = (key: keyof Server, value: string | number) =>
    set((old) => ({ ...old, [key]: value }));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(v);
      }}
    >
      <div className="form-grid">
        <Field label="服务器名称" wide>
          <input required value={v.name} onChange={(e) => update('name', e.target.value)} />
        </Field>
        <Field label="认证方式" wide>
          <select value={v.auth} onChange={(e) => update('auth', e.target.value)}>
            <option value="alias">Windows SSH Config 别名</option>
            <option value="password">用户名 + 密码</option>
            <option value="key">SSH 私钥</option>
          </select>
        </Field>
        {v.auth === 'alias' ? (
          <>
            <Field
              label="SSH Config 别名"
              hint="沿用系统 OpenSSH，包括 ProxyJump、IdentityFile 和 Agent"
              wide
            >
              <input
                required
                list={listId}
                value={v.alias}
                onChange={(e) => update('alias', e.target.value)}
              />
            </Field>
            <datalist id={listId}>
              {candidate.hosts.map((host) => (
                <option key={host} value={host} />
              ))}
            </datalist>
            {candidate.warnings.map((warning) => (
              <p className="note wide" key={warning}>
                {warning}
              </p>
            ))}
            {desktop && (
              <Field
                label="SSH 配置文件（可选）"
                hint="留空使用当前用户的默认 SSH Config；实际连接沿用系统 SSH 完整配置。"
                wide
              >
                <input
                  value={v.sshConfigFile || ''}
                  onChange={(e) => update('sshConfigFile', e.target.value)}
                />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="IP 地址或域名">
              <input required value={v.host} onChange={(e) => update('host', e.target.value)} />
            </Field>
            <Field label="SSH 端口">
              <input
                required
                type="number"
                min="1"
                max="65535"
                value={v.port}
                onChange={(e) => update('port', +e.target.value)}
              />
            </Field>
            <Field label="登录用户名" wide>
              <input required value={v.user} onChange={(e) => update('user', e.target.value)} />
            </Field>
            {v.auth === 'key' && (
              <Field label="SSH 私钥路径" wide>
                <PathInput
                  label="SSH 私钥路径"
                  kind="key"
                  required
                  value={v.keyPath}
                  onChange={(value) => update('keyPath', value)}
                />
              </Field>
            )}
            <Field label="凭据保存方式" wide>
              <select
                value={v.credentialMode}
                onChange={(e) => update('credentialMode', e.target.value)}
              >
                <option value="ask">每次部署时询问</option>
                <option value="windows" disabled={desktop && !encryptionAvailable}>
                  {desktop
                    ? '使用 Windows 加密保存到本机'
                    : '保存到 Windows 凭据管理器（正式版实现）'}
                </option>
              </select>
            </Field>
            <p className="note wide">
              {v.credentialMode === 'windows'
                ? desktop
                  ? '使用当前 Windows 用户的 DPAPI 加密；下次部署可复用。加密不可用时将阻止保存。'
                  : 'Windows 凭据管理器是正式版能力；原型仍在部署确认时询问，不保存口令。'
                : '部署确认时按服务器询问密码或私钥口令，仅保留在任务内存。'}
            </p>
          </>
        )}
        <Field label="备注" wide>
          <textarea value={v.note} onChange={(e) => update('note', e.target.value)} />
        </Field>
      </div>
      <p className="note">
        <ShieldCheck size={16} /> 密码和密钥走 SSH 库，别名走系统
        OpenSSH。保存的口令不会进入导出文件。
      </p>
      {desktop && (
        <details className="mt">
          <summary>测试当前表单的连接（无需先保存）</summary>
          <p className="note">
            只做连接和只读体检，不保存表单或本次口令；首次连接仍需要核对主机指纹。
          </p>
          {v.auth !== 'alias' && (
            <Field
              label={v.auth === 'password' ? '测试使用的密码' : '测试使用的私钥口令'}
              hint="已有同身份的本机加密凭据可留空复用，未加密私钥也可留空。"
            >
              <input
                type="password"
                autoComplete="off"
                value={testSecret}
                onChange={(e) => setTestSecret(e.target.value)}
              />
            </Field>
          )}
          <button type="button" className="button" disabled={testing} onClick={() => void test()}>
            {testing ? '测试中…' : '测试当前表单连接'}
          </button>
          {testError && (
            <p role="alert" className="warning">
              {testError}
            </p>
          )}
          {testResult && (
            <>
              <p className="note">
                {testResult.ok ? '测试通过' : '测试未通过'} · {fmtTime(testResult.time)}
              </p>
              <pre className="terminal">{testResult.output}</pre>
            </>
          )}
        </details>
      )}
      <Submit onClose={onClose} />
    </form>
  );
}
export function BackupFields({
  value,
  onChange,
}: {
  value: Backup;
  onChange: (v: Backup) => void;
}) {
  return (
    <>
      <Switch
        label="备份旧 JAR"
        checked={value.enabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled && (
        <>
          <div className="form-grid">
            <Field label="备份目录" hint="相对路径以远程部署目录解析">
              <input
                value={value.directory}
                onChange={(e) => onChange({ ...value, directory: e.target.value })}
              />
            </Field>
            <Field
              label="建议保留备份数量"
              hint="0 为不建议清理；仅预选较旧备份，远程删除仍须预览并确认"
            >
              <input
                type="number"
                min="0"
                max="10000"
                value={value.keepLast ?? 0}
                onChange={(e) => onChange({ ...value, keepLast: Number(e.target.value) })}
              />
            </Field>
            <Field label="备份命名模板" hint="支持 {name}、{yyyyMMdd-HHmmss}、{task}">
              <input
                required
                value={value.template}
                onChange={(e) => onChange({ ...value, template: e.target.value })}
              />
            </Field>
          </div>
          <Switch
            label="失败自动回滚"
            description="有有效备份时恢复旧版本；首次部署无旧文件时跳过备份"
            checked={value.autoRollback}
            onChange={(autoRollback) => onChange({ ...value, autoRollback })}
          />
        </>
      )}
    </>
  );
}
export function TargetForm({ initial, db, onSave, onClose }: SaveProps<Target>) {
  const [v, set] = useState(() => ({
    ...structuredClone(initial),
    health: {
      ...initial.health,
      startDelay: initial.health.startDelay ?? 0,
      maxWait: healthTiming(initial.health).window,
    },
  }));
  const [tab, setTab] = useState('基本信息');
  const [error, setError] = useState('');
  const update = <K extends keyof Target>(key: K, value: Target[K]) =>
    set((old) => ({ ...old, [key]: value }));
  const health = <K extends keyof Health>(key: K, value: Health[K]) =>
    update('health', { ...v.health, [key]: value });
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (
      !v.name.trim() ||
      !v.fileName.endsWith('.jar') ||
      /[\/\\\x00\r\n]/.test(v.fileName) ||
      !v.directory.startsWith('/') ||
      !v.serverId
    ) {
      setTab('基本信息');
      setError('请填写环境名称、服务器、绝对远程目录和独立的 .jar 文件名。');
      return;
    }
    if (v.mode === 'jar' && !v.start.trim() && !v.restart.trim()) {
      setTab('运行方式');
      setError('请补齐启动命令，或容器名称和容器内绝对 JAR 路径。');
      return;
    }
    if (v.mode === 'docker' && (!v.container.trim() || !v.containerJar.startsWith('/'))) {
      setTab('运行方式');
      setError('请补齐启动命令，或容器名称和容器内绝对 JAR 路径。');
      return;
    }
    if (
      v.health.type !== 'none' &&
      (!v.health.value.trim() ||
        [v.health.timeout, v.health.retries, v.health.interval, v.health.maxWait ?? 1].some(
          (n) => !Number.isInteger(n) || n < 1,
        ))
    ) {
      setTab('健康检查');
      setError('请填写健康检查地址或命令，检查超时、等待窗口及间隔必须为正整数。');
      return;
    }
    if (
      !Number.isInteger(v.health.startDelay) ||
      v.health.startDelay! < 0 ||
      v.health.startDelay! > 3600 ||
      v.health.maxWait! > 3600
    ) {
      setTab('健康检查');
      setError('启动等待应为 0–3600 秒，最长等待窗口应为 1–3600 秒。');
      return;
    }
    if (
      v.observation &&
      (!Number.isInteger(v.observation.duration) ||
        v.observation.duration < 10 ||
        v.observation.duration > 3600)
    ) {
      setError('观察持续时间应为 10–3600 秒。');
      return;
    }
    if (
      (v.appLogPath && (!v.appLogPath.startsWith('/') || /[\r\n\0]/.test(v.appLogPath))) ||
      (v.mode === 'jar' && v.observation?.enabled && !v.appLogPath)
    ) {
      setError('请填写有效的应用日志绝对路径后再启用观察。');
      return;
    }
    if (v.backup.enabled && !v.backup.template.trim()) {
      setTab('备份与安全');
      setError('请填写备份文件名模板。');
      return;
    }
    setError('');
    onSave(v);
  };
  return (
    <form noValidate onSubmit={submit}>
      <div className="tabs" role="tablist" aria-label="部署目标配置">
        {['基本信息', '运行方式', '健康检查', '备份与安全'].map((t) => (
          <button
            type="button"
            key={t}
            role="tab"
            aria-selected={t === tab}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="form-grid" hidden={tab !== '基本信息'}>
        <Field label="关联服务">
          <select value={v.serviceId} onChange={(e) => update('serviceId', e.target.value)}>
            {db.services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="环境名称">
          <input value={v.name} onChange={(e) => update('name', e.target.value)} />
        </Field>
        <Field label="关联服务器" hint="同一台服务器可被多个服务复用" wide>
          <select value={v.serverId} onChange={(e) => update('serverId', e.target.value)}>
            {db.servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="远程 JAR 目录">
          <input
            value={v.directory}
            onChange={(e) => update('directory', e.target.value)}
            placeholder="/opt/services/app"
          />
        </Field>
        <Field label="远程 JAR 文件名" hint="独立于本地文件名">
          <input value={v.fileName} onChange={(e) => update('fileName', e.target.value)} />
        </Field>
        <div className="wide">
          <Switch
            label="正式环境"
            description="每次部署和回滚都必须核对并输入本次正式环境名称，永不自动勾选"
            checked={v.production}
            onChange={(x) => update('production', x)}
          />
        </div>
        <p className="code wide">{remoteJar(v)}</p>
      </div>
      <div hidden={tab !== '运行方式'}>
        {desktop && (
          <div className="form-grid">
            <Field label="远程命令超时（秒）">
              <input
                type="number"
                min="5"
                max="3600"
                value={v.commandTimeout || 120}
                onChange={(e) => update('commandTimeout', Number(e.target.value))}
              />
            </Field>
            {v.mode === 'docker' && (
              <Field label="容器稳定性观察（秒）">
                <input
                  type="number"
                  min="1"
                  max="300"
                  value={v.stabilitySeconds || 5}
                  onChange={(e) => update('stabilitySeconds', Number(e.target.value))}
                />
              </Field>
            )}
          </div>
        )}
        <Field label="部署方式">
          <select
            value={v.mode}
            onChange={(e) => {
              const mode = e.target.value as Target['mode'];
              set((old) => ({
                ...old,
                mode,
                ...(mode === 'jar'
                  ? {
                      container: '',
                      containerJar: '',
                      stop: './' + old.fileName + ' stop',
                      start: './' + old.fileName + ' start',
                    }
                  : { stop: '', start: '', restart: '', chmod: false }),
              }));
            }}
          >
            <option value="jar">普通 JAR</option>
            <option value="docker">Docker JAR</option>
          </select>
        </Field>
        {v.mode === 'jar' ? (
          <>
            <div className="form-grid">
              <Field label="停止命令" hint="在远程 JAR 目录执行" wide>
                <input value={v.stop} onChange={(e) => update('stop', e.target.value)} />
              </Field>
              <Field label="启动命令" wide>
                <input value={v.start} onChange={(e) => update('start', e.target.value)} />
              </Field>
              <Field
                label="替代重启命令"
                hint="选填；有值时在替换后使用，替换前仍执行停止步骤"
                wide
              >
                <input value={v.restart} onChange={(e) => update('restart', e.target.value)} />
              </Field>
              <Field label="停止命令非零时">
                <select
                  value={v.stopFailure}
                  onChange={(e) => update('stopFailure', e.target.value as Target['stopFailure'])}
                >
                  <option value="warn">作为警告（允许服务原本未运行）</option>
                  <option value="fail">终止部署</option>
                </select>
              </Field>
            </div>
            <Switch
              label="替换后执行 chmod +x"
              checked={v.chmod}
              onChange={(x) => update('chmod', x)}
            />
          </>
        ) : (
          <div className="form-grid">
            <Field label="容器名称">
              <input value={v.container} onChange={(e) => update('container', e.target.value)} />
            </Field>
            <Field
              label="挂载方式"
              hint="容器已停止时，替换后会按路径重新挂载，最终以容器内哈希为准。"
            >
              <select
                value={v.mount}
                onChange={(e) => update('mount', e.target.value as Target['mount'])}
              >
                <option value="directory">目录绑定（停容器后原子替换）</option>
                <option value="file">单文件绑定（停容器后原子替换）</option>
              </select>
            </Field>
            <Field label="容器内 JAR 路径" wide>
              <input
                value={v.containerJar}
                onChange={(e) => update('containerJar', e.target.value)}
              />
            </Field>
            <p className="note wide">
              预检以 docker inspect 为准；重启后核验容器内 JAR 哈希、运行时长、重启次数和健康状态。
            </p>
          </div>
        )}
      </div>
      <div hidden={tab !== '健康检查'}>
        <div className="form-grid">
          <Field label="检查方式" wide>
            <select
              value={v.health.type}
              onChange={(e) => health('type', e.target.value as Health['type'])}
            >
              <option value="none">不配置（只确认启动，健康未验证）</option>
              <option value="http">HTTP</option>
              <option value="tcp">TCP 端口</option>
              <option value="command">自定义远程命令</option>
            </select>
          </Field>
          {desktop && ['http', 'tcp'].includes(v.health.type) && (
            <Field label="检查位置" wide>
              <select
                value={v.health.location || 'remote'}
                onChange={(e) => health('location', e.target.value as 'local' | 'remote')}
              >
                <option value="remote">在服务器上通过 SSH 检查</option>
                <option value="local">从本机检查</option>
              </select>
            </Field>
          )}
          {v.health.type !== 'none' && (
            <>
              <Field
                label={
                  v.health.type === 'http'
                    ? 'HTTP 健康地址'
                    : v.health.type === 'tcp'
                      ? 'TCP 地址（host:port）'
                      : '检查命令（退出码 0 为通过）'
                }
                wide
              >
                <input value={v.health.value} onChange={(e) => health('value', e.target.value)} />
              </Field>
              <Field label="单次超时（秒）">
                <input
                  type="number"
                  min="1"
                  value={v.health.timeout}
                  onChange={(e) => health('timeout', +e.target.value)}
                />
              </Field>
              <Field label="启动等待（秒）">
                <input
                  type="number"
                  min="0"
                  max="3600"
                  value={v.health.startDelay}
                  onChange={(e) => health('startDelay', +e.target.value)}
                />
              </Field>
              <Field label="最长等待窗口（秒）">
                <input
                  type="number"
                  min="1"
                  max="3600"
                  value={v.health.maxWait}
                  onChange={(e) => health('maxWait', +e.target.value)}
                />
              </Field>
              <Field label="重试间隔（秒）">
                <input
                  type="number"
                  min="1"
                  value={v.health.interval}
                  onChange={(e) => health('interval', +e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        {v.health.type !== 'none' && (
          <p className="note">
            启动命令和容器校验通过后先等待 {v.health.startDelay} 秒，再在 {v.health.maxWait}{' '}
            秒内每隔 {v.health.interval}{' '}
            秒探测。首次通过即继续，超时仍未就绪才判失败；回滚后的旧版本也使用此规则。
          </p>
        )}
        <p className="note">
          {desktop
            ? 'HTTP/TCP 按所选位置执行，自定义命令在服务器上执行；未配置时标记健康未验证。'
            : '从目标服务器执行。未配置健康检查时，任务结果会明确标记「健康未验证」。'}
        </p>
      </div>
      <div hidden={tab !== '备份与安全'}>
        <BackupFields value={v.backup} onChange={(x) => update('backup', x)} />
        <hr />
        <Field label="远程校验策略">
          <select
            value={v.hashPolicy}
            onChange={(e) => update('hashPolicy', e.target.value as Target['hashPolicy'])}
          >
            <option value="required">必须 SHA-256，不满足则终止</option>
            <option value="size-confirm">无哈希工具时允许字节数（部署时额外确认）</option>
          </select>
        </Field>
        <Switch
          label="允许创建不存在的远程目录"
          description="默认关闭；开启后会在部署确认中明确列出"
          checked={v.createDirectory}
          onChange={(x) => update('createDirectory', x)}
        />
        {prototype && db.settings.demoMode && (
          <Demo>
            {' '}
            <Switch
              label="模拟首次部署（无旧 JAR）"
              checked={!v.hasOldJar}
              onChange={(x) => update('hasOldJar', !x)}
            />
          </Demo>
        )}
      </div>
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      {desktop && (
        <details className="mt">
          <summary>部署后日志观察</summary>
          {v.mode === 'jar' && (
            <Field
              label="应用日志绝对路径"
              hint="只读取此文件，不执行启动脚本。健康检查失败时也可用它查看最近日志。"
            >
              <input
                value={v.appLogPath || ''}
                onChange={(e) => update('appLogPath', e.target.value)}
                placeholder="/var/log/service/application.log"
              />
            </Field>
          )}
          <Switch
            label="健康未验证时自动观察日志"
            checked={v.observation?.enabled || false}
            onChange={(enabled) =>
              update('observation', { enabled, duration: v.observation?.duration || 60 })
            }
            description="部署完成后跟随应用或容器日志，不影响部署结果。本次部署中可以临时覆盖。"
          />
          <Field label="默认观察时间（秒）" hint="10–3600 秒；到时或关闭日志窗口即停止连接。">
            <input
              type="number"
              min="10"
              max="3600"
              value={v.observation?.duration ?? 60}
              onChange={(e) =>
                update('observation', {
                  enabled: v.observation?.enabled || false,
                  duration: Number(e.target.value),
                })
              }
            />
          </Field>
        </details>
      )}
      <Submit onClose={onClose} />
    </form>
  );
}
