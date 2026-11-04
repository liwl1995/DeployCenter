import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Rocket,
  Boxes,
  Server as ServerIcon,
  Wrench,
  History as HistoryIcon,
  Settings,
  SlidersHorizontal,
  Plus,
  Search,
  Check,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  X,
  Terminal,
  Copy,
  Download,
  Upload,
  ChevronRight,
  ShieldCheck,
  GitBranch,
  FileArchive,
  Pencil,
  Coffee,
  Loader2,
  CircleCheck,
  Trash2,
  FolderOpen,
} from 'lucide-react';
import {
  loadDatabase,
  validDatabase,
  safeConfigJson,
  artifactFor,
  localJar,
  remoteJar,
  modeLabel,
  serverAddress,
  statusLabel,
  fmtTime,
  seconds,
  snapshotService,
  snapshotTarget,
  snapshotServer,
  type ServiceSnapshot,
  type TaskRecord,
  type Database,
  type Service,
  type Server,
  type Target,
  type Backup,
  type Artifact,
  type Task,
  type History,
} from './model';
import { createTask, startTask, tick, cancelTask, requestFailure } from './engine';
import { recordTask, pruneHistory, canRollback as rollbackAllowed, historyLogs } from './records';
import { CredentialSession, credentialServers } from './credentials';
import { diagnostics } from './validation';
import { Badge, Card, Field, Switch, Modal, Steps, Demo, download } from './ui';
import { ServiceForm, ServerForm, TargetForm, BackupFields } from './forms';
import './style.css';
import brandIcon from '../assets/icon.svg';
import { newService, newTargetTemplate, emptyDatabase, prototype } from './defaults';
import {
  desktop,
  initialArtifact,
  mergedDatabase,
  type Startup,
  type TrustRequest,
  type Approval,
  type TaskSummary,
  type ServiceInfo,
} from './platform';
import {
  TrustDialog,
  CredentialPrompt,
  NativeLogs,
  ContainerLogs,
  LockTakeover,
} from './DesktopViews';

type Page =
  | 'deploy'
  | 'services'
  | 'targets'
  | 'servers'
  | 'tools'
  | 'history'
  | 'settings'
  | 'task';
type Dialog =
  | { kind: 'service'; value: Service }
  | { kind: 'server'; value: Server }
  | { kind: 'target'; value: Target }
  | { kind: 'picker' }
  | { kind: 'confirm'; task: Task; token?: string }
  | { kind: 'cancel' }
  | { kind: 'history'; value: History }
  | { kind: 'delete'; entity: 'service' | 'target'; id: string }
  | { kind: 'jdk' }
  | null;
const nav = [
  { page: 'deploy', name: '一键部署', icon: Rocket },
  { page: 'services', name: '服务管理', icon: Boxes },
  { page: 'targets', name: '部署目标', icon: SlidersHorizontal },
  { page: 'servers', name: '服务器', icon: ServerIcon },
  { page: 'tools', name: '构建环境', icon: Wrench },
  { page: 'history', name: '部署历史', icon: HistoryIcon },
  { page: 'settings', name: '设置', icon: Settings },
] as const;
const uid = () => Math.random().toString(36).slice(2, 10);
const isActive = (t: Task | null) => !!t && ['running', 'cancelling'].includes(t.status);
const failedStatuses = ['failed', 'rolledback'];
function upsert<T extends { id: string }>(list: T[], v: T) {
  return list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v];
}
function niceSize(bytes: number) {
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}
function LogViewer({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current && ref.current && !window.getSelection()?.toString())
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length]);
  return (
    <pre
      className="terminal"
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      }}
      aria-label="任务日志"
    >
      <span className="terminal-caption">
        {desktop ? '执行日志' : '模拟任务日志 · 未连接服务器'}
      </span>
      {lines.map((line, i) => (
        <span
          key={i}
          className={line.includes('错误') ? 'log-error' : line.includes('回滚') ? 'log-warn' : ''}
        >
          {line}
        </span>
      ))}
    </pre>
  );
}
function ArtifactInfo({ value, service }: { value: Artifact; service: ServiceSnapshot }) {
  return (
    <div className="artifact">
      <div className="row spread">
        <span className="row">
          <FileArchive size={16} />
          <strong>{value.name}</strong>
        </span>
        <Badge kind={value.exists ? 'good' : 'danger'}>
          {value.source === 'sample'
            ? '示例文件信息'
            : value.exists
              ? '文件已读取'
              : value.source === 'file'
                ? '文件不存在或无法读取'
                : '尚未检测'}
        </Badge>
      </div>
      <p className="path">{value.path}</p>
      <div className="metadata">
        <span>
          大小：{value.source === 'unknown' ? '待检测' : !value.exists ? '—' : niceSize(value.size)}
        </span>
        <span>
          修改：
          {value.source === 'unknown' ? '待检测' : !value.exists ? '—' : fmtTime(value.modified)}
        </span>
      </div>
      {value.exists && new Date(value.modified) < new Date(service.git.time) && (
        <p className="warning">
          <AlertTriangle size={15} />
          JAR 早于当前 Git 提交，请确认是否需要重新构建。
        </p>
      )}
    </div>
  );
}
function Workspace({ boot }: { boot?: Startup } = {}) {
  const [loaded] = useState(
    () => boot || (prototype ? loadDatabase() : { database: emptyDatabase(), recovery: undefined }),
  );
  const [db, setDb] = useState<Database>(loaded.database);
  const [recovery, setRecovery] = useState(loaded.recovery);
  const credentials = useRef(new CredentialSession());
  const [failureOverride, setFailureOverride] = useState<
    Database['settings']['failurePolicy'] | null
  >(null);
  const [page, setPage] = useState<Page>('deploy');
  const [serviceId, setServiceId] = useState(() =>
    db.services.some((s) => s.id === db.lastService) ? db.lastService : db.services[0].id,
  );
  const [selected, setSelected] = useState<string[]>(() =>
    db.lastTargets.filter((id) =>
      db.targets.some((t) => t.id === id && t.serviceId === serviceId && !t.production),
    ),
  );
  const [build, setBuild] = useState<Task['build']>('rebuild');
  const [overrides, setOverrides] = useState<Record<string, Backup>>({});
  const [expanded, setExpanded] = useState<string[]>([]);
  const [artifact, setArtifact] = useState<Artifact>(() =>
    (desktop ? initialArtifact : artifactFor)(db.services.find((s) => s.id === serviceId)!),
  );
  const [jarSelection, setJarSelection] = useState<string>();
  const [localInfo, setLocalInfo] = useState<(ServiceInfo & { serviceId: string }) | null>(null);
  const [localInfoBusy, setLocalInfoBusy] = useState(false);
  const [localInfoError, setLocalInfoError] = useState('');
  const [infoRefresh, setInfoRefresh] = useState(0);
  const [taskReturnPage, setTaskReturnPage] = useState<Page>('deploy');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [task, setTask] = useState<Task | null>(boot?.task || null);
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState<TrustRequest | undefined>(boot?.pendingTrust);
  const [saved, setSaved] = useState(boot?.savedCredentials || []);
  const [unfinished, setUnfinished] = useState(boot?.unfinished || []);
  const [nativeDialog, setNativeDialog] = useState<{
    title: string;
    content?: string;
    server?: Server;
    recover?: Task;
    logs?: string;
    lockTarget?: string;
    lock?: { token: string; owner: string; created: number; stale: boolean; message: string };
  } | null>(null);
  const [taskRows, setTaskRows] = useState<TaskSummary[]>([]);
  const [inspected, setInspected] = useState(0);
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [historyService, setHistoryService] = useState('all');
  const [historyServer, setHistoryServer] = useState('all');
  const [historyEnv, setHistoryEnv] = useState('all');
  const [historyDate, setHistoryDate] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const recorded = useRef(new Set<string>());
  const service = db.services.find((s) => s.id === serviceId)!;
  const displayService =
    localInfo?.serviceId === serviceId ? { ...service, git: localInfo.git } : service;
  const targets = db.targets.filter((t) => t.serviceId === serviceId);
  const chosen = targets.filter((t) => selected.includes(t.id));
  const effective = (t: Target) => overrides[t.id] || t.backup;
  const notify = (text: string) => setMessage(text);
  useEffect(() => {
    if (recovery) return;
    if (desktop) {
      const timer = setTimeout(() => {
        void desktop!.save(db).catch((e) => setStorageError(String(e)));
      }, 350);
      return () => clearTimeout(timer);
    }
    try {
      localStorage.setItem('deploy-center-v2', safeConfigJson(db));
    } catch {
      setStorageError('浏览器未允许本地保存，本次修改将在关闭页面后丢失。');
    }
  }, [db, recovery]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4500);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    document.documentElement.dataset.theme = db.settings.theme;
  }, [db.settings.theme]);
  useEffect(() => {
    if (desktop || !isActive(task)) return;
    const timer = setInterval(() => setTask((current) => (current ? tick(current) : null)), 850);
    return () => clearInterval(timer);
  }, [task?.id, task?.status]);
  useEffect(() => {
    if (desktop || !task || isActive(task)) return;
    credentials.current.clear();
    if (recorded.current.has(task.id)) return;
    recorded.current.add(task.id);
    setDb((old) => recordTask(old, task));
  }, [task]);
  useEffect(() => () => credentials.current.clear(), []);
  useEffect(() => {
    if (db.history.length > db.settings.historyLimit) setDb((old) => pruneHistory(old));
  }, [db.history.length, db.settings.historyLimit]);
  useEffect(() => {
    if (!desktop) return;
    const refresh = () => {
      void desktop!.listTasks().then(setTaskRows);
      void desktop!.load().then((value) => {
        setSaved(value.savedCredentials);
        setUnfinished(value.unfinished);
      });
    };
    refresh();
    return desktop!.onEvent((event) => {
      if (event.kind === 'task') {
        setTask(event.task);
        if (!['running', 'cancelling'].includes(event.task.status)) {
          refresh();
          setInfoRefresh((n) => n + 1);
        }
      } else if (event.kind === 'database') setDb((old) => mergedDatabase(old, event.database));
      else if (event.kind === 'trust') setTrust(event.request);
      else if (event.kind === 'trust-closed')
        setTrust((old) => (old?.id === event.id ? undefined : old));
    });
  }, []);
  useEffect(() => {
    if (!desktop || recovery || page !== 'deploy') return;
    let stale = false;
    setLocalInfoBusy(true);
    setLocalInfoError('');
    void (async () => {
      try {
        // 确保刚编辑的配置先落库，主进程只读取已保存服务允许的路径。
        await desktop!.save(db);
        const info = await desktop!.serviceInfo(service.id, jarSelection);
        if (!stale) {
          setLocalInfo({ ...info, serviceId: service.id });
          setArtifact(info.artifact);
        }
      } catch (error) {
        if (!stale) setLocalInfoError(String(error));
      } finally {
        if (!stale) setLocalInfoBusy(false);
      }
    })();
    return () => {
      stale = true;
    };
  }, [
    service.id,
    service.root,
    service.jarDir,
    service.jarName,
    jarSelection,
    infoRefresh,
    page,
    recovery,
  ]);
  async function nativeAction(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      setNativeDialog({ title: '操作失败', content: String(e) });
    }
  }
  async function pickJar() {
    if (!desktop) {
      fileRef.current?.click();
      return;
    }
    await nativeAction(async () => {
      const file = await desktop!.choose('jar');
      if (file) {
        setArtifact(await desktop!.inspectJar(file));
        setJarSelection(file);
      }
    });
  }
  async function importNative() {
    await nativeAction(async () => {
      const data = await desktop!.importConfig();
      if (data) {
        setDb(data);
        setRecovery(undefined);
        setServiceId(data.services[0].id);
        setSelected([]);
        setOverrides({});
        setArtifact(initialArtifact(data.services[0]));
        setJarSelection(undefined);
        setLocalInfo(null);
        setInfoRefresh((n) => n + 1);
      }
    });
  }
  function selectService(id: string) {
    const s = db.services.find((s) => s.id === id)!;
    setServiceId(id);
    setJarSelection(undefined);
    setLocalInfo(null);
    const prior = db.lastTargets.filter((tid) =>
      db.targets.some((t) => t.id === tid && t.serviceId === id && !t.production),
    );
    const fallback = db.targets.find((t) => t.serviceId === id && !t.production);
    setSelected(prior.length ? prior : fallback ? [fallback.id] : []);
    setArtifact((desktop ? initialArtifact : artifactFor)(s));
    setOverrides({});
    setDb((old) => ({ ...old, lastService: id }));
  }
  function toggleTarget(t: Target) {
    const next = selected.includes(t.id) ? selected.filter((x) => x !== t.id) : [...selected, t.id];
    setSelected(next);
    setDb((old) => ({
      ...old,
      lastService: serviceId,
      lastTargets: next.filter((id) => !db.targets.find((t) => t.id === id)?.production),
    }));
  }
  async function launch(targetList = chosen, rollback?: History, dryRun = false) {
    if (isActive(task)) {
      setPage('task');
      notify('请先结束当前任务');
      return;
    }
    if (!targetList.length) {
      notify('请至少选择一个部署目标');
      return;
    }
    if (!desktop && build === 'existing' && !artifact.exists && !rollback) {
      notify('请先选择有效的现有 JAR 文件');
      return;
    }
    if (desktop) {
      setBusy(true);
      try {
        await desktop!.save(db);
        const result = await desktop!.prepare({
          serviceId: rollback?.service.id || serviceId,
          targetIds: targetList.map((t) => t.id),
          build,
          jarPath: artifact.path || undefined,
          overrides,
          failurePolicy: failureOverride ?? db.settings.failurePolicy,
          historyId: rollback?.id,
          dryRun,
        });
        setDialog({ kind: 'confirm', ...result });
      } catch (e) {
        setNativeDialog({ title: '部署准备失败', content: String(e) });
      } finally {
        setBusy(false);
      }
      return;
    }
    const sourceService = rollback
      ? {
          ...db.services.find((s) => s.id === rollback.service.id)!,
          git: { ...rollback.service.git, commit: rollback.target.version },
        }
      : service;
    const prepared = createTask(
      db,
      sourceService,
      targetList,
      overrides,
      build,
      rollback?.artifact || artifact,
      rollback,
    );
    prepared.failurePolicy = failureOverride ?? db.settings.failurePolicy;
    setDialog({ kind: 'confirm', task: prepared });
  }
  function canRollback(h: History) {
    return rollbackAllowed(db, h);
  }
  function repeatLast() {
    const last = db.history.find(
      (h) => h.operation === 'deploy' && db.services.some((s) => s.id === h.service.id),
    );
    if (!last) {
      notify('没有可重复的部署记录');
      return;
    }
    selectService(last.service.id);
    const all = db.history
      .filter((h) => h.taskId === last.taskId)
      .map((h) => db.targets.find((t) => t.id === h.target.id))
      .filter((t): t is Target => !!t && !t.production);
    setSelected(all.map((t) => t.id));
    setBuild(last.build);
    setPage('deploy');
    notify('已带入上次配置；正式环境需要重新勾选。');
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('已复制');
    } catch {
      download('deploy-diagnostics.txt', text);
      notify('浏览器未允许剪贴板访问，已改为下载文本。');
    }
  }
  function retry(onlyFailed: boolean) {
    if (!task) return;
    const ids = task.targets
      .filter((r) => !onlyFailed || failedStatuses.includes(r.status))
      .map((r) => r.target.id);
    const s = db.services.find((s) => s.id === task.service.id);
    if (!s) {
      notify('当前服务已不存在，请重新配置');
      return;
    }
    selectService(s.id);
    setSelected(ids);
    setBuild('existing');
    setArtifact(task.artifact);
    setJarSelection(task.artifact.path);
    setPage('deploy');
    notify('已准备重试；复用本任务产物，部署前请重新确认配置。');
  }
  function newTarget(): Target {
    const example = newTargetTemplate(serviceId, db.servers[0]?.id || '');
    return {
      ...example,
      id: uid(),
      serviceId,
      serverId: db.servers[0]?.id || '',
      name: '新环境',
      directory: '/opt/services/' + service.code,
      fileName: service.jarName,
      mode: 'jar',
      container: '',
      containerJar: '',
      chmod: true,
      stop: `./${service.jarName} stop`,
      start: `./${service.jarName} start`,
      production: false,
      version: '未部署',
      lastDeploy: '—',
      healthState: '未检测',
      hasOldJar: false,
    };
  }
  function saveTarget(t: Target) {
    setDb((old) => ({ ...old, targets: upsert(old.targets, t) }));
    setOverrides((old) => {
      const next = { ...old };
      delete next[t.id];
      return next;
    });
    if (t.production) setSelected((old) => old.filter((id) => id !== t.id));
    setDialog(null);
    notify('部署目标已保存');
  }
  const header = (title: string, description: string, action?: ReactNode) => (
    <header className="page-header">
      <div>
        <p className="eyebrow">LOCAL WORKSPACE / {page.toUpperCase()}</p>
        <h1>{title}</h1>
        <p className="muted">{description}</p>
      </div>
      {action}
    </header>
  );
  const filteredHistory = db.history.filter(
    (h) =>
      (historyFilter === 'all' ||
        (historyFilter === 'success'
          ? ['success', 'unverified'].includes(h.status)
          : failedStatuses.includes(h.status))) &&
      (historyService === 'all' || h.service.id === historyService) &&
      (historyServer === 'all' || h.server.id === historyServer) &&
      (historyEnv === 'all' || h.target.name === historyEnv) &&
      (!historyDate || h.time.slice(0, 10) === historyDate),
  );
  const historyTable = (list: History[]) => (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>服务 / 环境</th>
            <th>服务器</th>
            <th>结果</th>
            <th>时间 / 耗时</th>
            <th>版本 / 备份</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {list.map((h) => (
            <tr key={h.id}>
              <td>
                <strong>{h.service.name}</strong>
                <small>
                  {h.target.name} · {h.operation === 'rollback' ? '回滚' : '部署'}
                </small>
              </td>
              <td>
                {h.server.name}
                <small>{serverAddress(h.server)}</small>
              </td>
              <td>
                <Badge
                  kind={
                    ['success'].includes(h.status)
                      ? 'good'
                      : ['failed', 'rolledback'].includes(h.status)
                        ? 'warn'
                        : ''
                  }
                >
                  {statusLabel[h.status]}
                </Badge>
              </td>
              <td>
                {fmtTime(h.time)}
                <small>{seconds(h.elapsed)}</small>
              </td>
              <td>
                <code>{h.service.git.commit}</code>
                <small>{h.backupPath ? '有备份' : '无备份'}</small>
              </td>
              <td>
                <button className="link" onClick={() => setDialog({ kind: 'history', value: h })}>
                  详情
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!list.length && <p className="empty">没有匹配的部署记录</p>}
    </div>
  );
  const changeBackup = (id: string, b: Backup) => setOverrides((old) => ({ ...old, [id]: b }));
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage('deploy');
          }}
        >
          <span className="brand-mark">
            <img src={brandIcon} alt="" />
          </span>
          <span>
            YOTOO 部署中心<small>本地部署工作台</small>
          </span>
        </a>
        <span className="nav-heading">工作空间</span>
        <nav aria-label="主导航">
          {nav.map((n) => (
            <button
              key={n.page}
              className={page === n.page ? 'selected' : ''}
              onClick={() => setPage(n.page)}
            >
              <n.icon size={18} />
              {n.name}
              {n.page === 'targets' && <small>{db.targets.length}</small>}
            </button>
          ))}
          {task && (
            <button className={page === 'task' ? 'selected' : ''} onClick={() => setPage('task')}>
              {isActive(task) ? <Loader2 size={18} className="spin" /> : <CircleCheck size={18} />}
              当前任务
            </button>
          )}
        </nav>
        <div className="sidebar-footer">
          <span className="local-dot" />
          <div>
            数据保存在本机
            <small>
              {desktop
                ? '桌面部署工具 · ' + (boot?.version || '1.1.0')
                : '界面原型 v0.3 · 模拟执行'}
            </small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <div className="workspace-bar">
          <span className="row">
            <ShieldCheck size={15} />
            单用户 · 本地工作空间
          </span>
          <Badge>{desktop ? '真实部署 · 请核对目标' : '界面原型 · 未连接服务器'}</Badge>
        </div>
        <main>
          {desktop && unfinished.length > 0 && (
            <div className="warning" role="status">
              <strong>存在未结束的部署任务</strong>
              <p>核实只读取原任务状态或清理未启动的上传，不会继续后续目标或重新替换。</p>
              {unfinished.map((t) => (
                <button
                  className="button"
                  key={t.id}
                  disabled={isActive(task)}
                  onClick={() => setNativeDialog({ title: '核实中断任务 · ' + t.id, recover: t })}
                >
                  {t.service.name} · 核实原任务
                </button>
              ))}
            </div>
          )}
          {recovery && (
            <div className="warning" role="alert">
              <strong>
                {recovery.backupKey
                  ? '配置无法读取，已备份原始数据。'
                  : '配置无法读取，原键仍保留；备份存储不可用，请下载原始数据。'}
              </strong>
              <p>确认前不会覆盖原配置。备份键：{recovery.backupKey || '未写入'}</p>
              <div className="row wrap">
                <button
                  className="button"
                  onClick={() => download('deploy-center-original.txt', recovery.raw)}
                >
                  下载原始数据
                </button>
                <button
                  className="button"
                  onClick={() => {
                    if (desktop)
                      void nativeAction(async () => {
                        await desktop!.confirmRecovery();
                        setRecovery(undefined);
                      });
                    else setRecovery(undefined);
                  }}
                >
                  {desktop ? '确认恢复为空配置' : '确认使用示例配置并保存'}
                </button>
              </div>
            </div>
          )}
          {storageError && (
            <p className="warning" role="alert">
              {storageError}
            </p>
          )}
          {page === 'deploy' && (
            <>
              {header(
                '准备好，发布下一版本',
                '选择服务和目标，确认每次发布的边界。',
                <button className="button" onClick={repeatLast}>
                  <RotateCcw size={16} />
                  重复上次部署
                </button>,
              )}
              <div className="deploy-layout">
                <div className="stack">
                  <Card
                    title={
                      <>
                        <span className="section-number">01</span>服务与构建
                      </>
                    }
                    action={
                      <button
                        className="link"
                        onClick={() => setDialog({ kind: 'service', value: service })}
                      >
                        编辑配置
                        <Pencil size={14} />
                      </button>
                    }
                  >
                    <button
                      className="service-picker"
                      onClick={() => setDialog({ kind: 'picker' })}
                      aria-haspopup="dialog"
                    >
                      <span className="service-icon">{service.name[0]}</span>
                      <span className="grow">
                        <strong>{service.name}</strong>
                        <small>{service.description}</small>
                      </span>
                      <Search size={18} />
                      <ChevronRight size={17} />
                    </button>
                    <div className="tags">
                      <Badge>{service.jdk}</Badge>
                      <Badge>
                        {service.tool === 'wrapper'
                          ? 'Maven Wrapper'
                          : service.tool === 'auto'
                            ? '自动选择 Maven'
                            : '本地 Maven'}
                      </Badge>
                      {[...new Set(chosen.map((t) => modeLabel(t.mode)))].map((m) => (
                        <Badge key={m}>{m}</Badge>
                      ))}
                    </div>
                    <div className="segments" aria-label="构建方式">
                      <button
                        aria-pressed={build === 'rebuild'}
                        onClick={() => setBuild('rebuild')}
                      >
                        <Wrench size={16} />
                        重新构建
                      </button>
                      <button
                        aria-pressed={build === 'existing'}
                        onClick={() => setBuild('existing')}
                      >
                        <FileArchive size={16} />
                        使用现有 JAR
                      </button>
                    </div>
                    {build === 'rebuild' ? (
                      <>
                        <p className="code">
                          {service.tool === 'wrapper'
                            ? '.\\mvnw.cmd'
                            : service.mavenPath || 'mvn.cmd'}{' '}
                          {service.args}
                          {service.profiles ? ' -P' + service.profiles : ''}
                        </p>
                        <div className="metadata">
                          <span>工作目录：{service.workDir || '.'}</span>
                          <span>JDK 仅作用于构建进程</span>
                        </div>
                        <p className="path">产物：{localJar(service)}</p>
                      </>
                    ) : (
                      <>
                        <ArtifactInfo value={artifact} service={displayService} />
                        <p className="note">
                          {desktop
                            ? '已读取本地文件信息；选择文件或确认部署前会检查 JAR 完整性。'
                            : '浏览器只能读取文件名、大小和修改时间；桌面版将使用系统文件对话框并检查 JAR 有效性。'}
                        </p>
                        <div className="row wrap">
                          <button className="button" onClick={() => void pickJar()}>
                            <FolderOpen size={16} />
                            选择本地 JAR
                          </button>
                          {prototype && db.settings.demoMode && (
                            <Demo>
                              {' '}
                              <button
                                className="link"
                                onClick={() => setArtifact(artifactFor(service))}
                              >
                                使用示例产物
                              </button>
                              <button
                                className="link"
                                onClick={() =>
                                  setArtifact((old) => ({
                                    ...old,
                                    modified: '2026-11-01T08:00:00+08:00',
                                  }))
                                }
                              >
                                查看旧产物提醒
                              </button>
                            </Demo>
                          )}
                        </div>
                      </>
                    )}
                    <p className="branch">
                      <GitBranch size={14} />
                      {displayService.git.branch}
                      <code>{displayService.git.commit}</code>
                      {displayService.git.dirty && <Badge kind="warn">有未提交修改</Badge>}
                      <span>
                        {desktop
                          ? localInfoBusy
                            ? '正在读取本地信息…'
                            : localInfo?.serviceId === serviceId
                              ? /^[a-f0-9]{7,64}$/i.test(displayService.git.commit)
                                ? 'Git 提交：' + fmtTime(displayService.git.time)
                                : '未找到 Git 仓库或本机 Git 不可用'
                              : '等待读取本地信息'
                          : 'Git 示例信息'}
                      </span>
                    </p>
                    {desktop && (
                      <>
                        {localInfo?.serviceId === serviceId && localInfo.artifactError && (
                          <p className="warning" role="status">
                            {localInfo.artifactError}
                          </p>
                        )}
                        {localInfoError && (
                          <p className="warning" role="alert">
                            {localInfoError}
                          </p>
                        )}
                        <div className="row wrap local-info-actions">
                          <button
                            className="button"
                            disabled={localInfoBusy}
                            onClick={() => setInfoRefresh((n) => n + 1)}
                          >
                            <RotateCcw size={15} />
                            刷新 JAR / Git 信息
                          </button>
                          {jarSelection && (
                            <button className="link" onClick={() => setJarSelection(undefined)}>
                              使用配置的产物路径
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </Card>
                  <Card
                    title={
                      <>
                        <span className="section-number">02</span>部署目标
                        <span className="count">
                          {chosen.length} / {targets.length}
                        </span>
                      </>
                    }
                    action={
                      <button className="link" onClick={() => setPage('targets')}>
                        管理目标
                        <ArrowRight size={14} />
                      </button>
                    }
                  >
                    {!targets.length && <p className="empty">还没有部署目标，请先配置。</p>}
                    {targets.map((t) => {
                      const s = db.servers.find((s) => s.id === t.serverId)!;
                      const b = effective(t);
                      const open = expanded.includes(t.id);
                      return (
                        <article
                          className={'target-card ' + (selected.includes(t.id) ? 'checked' : '')}
                          key={t.id}
                        >
                          <div className="target-top">
                            <label className="target-choice">
                              <input
                                type="checkbox"
                                checked={selected.includes(t.id)}
                                onChange={() => toggleTarget(t)}
                                aria-label={'选择' + t.name}
                              />
                              <span>
                                <strong>{t.name}</strong>
                                <span className="target-server">
                                  {s.name} · {serverAddress(s)}
                                </span>
                              </span>
                            </label>
                            <div className="row wrap">
                              <Badge kind={t.production ? 'warn' : ''}>
                                {t.production ? '正式' : '非正式'}
                              </Badge>
                              <Badge>{modeLabel(t.mode)}</Badge>
                              <button
                                className="icon-button"
                                aria-label={'编辑' + t.name}
                                onClick={() => setDialog({ kind: 'target', value: t })}
                              >
                                <Pencil size={15} />
                              </button>
                            </div>
                          </div>
                          <p className="path">{remoteJar(t)}</p>
                          <div className="target-facts">
                            <span>
                              当前版本<code>{t.version}</code>
                            </span>
                            <span>
                              上次部署<em>{t.lastDeploy}</em>
                            </span>
                            <span>
                              健康状态<em>{t.healthState}</em>
                            </span>
                          </div>
                          <div className="target-bottom">
                            <span className="muted">
                              {overrides[t.id] ? '本次覆盖' : '目标默认'} ·{' '}
                              {b.enabled
                                ? '备份' + (b.autoRollback ? '并自动回滚' : '，手动恢复')
                                : '不备份'}
                            </span>
                            <button
                              className="link"
                              aria-expanded={open}
                              onClick={() =>
                                setExpanded((old) =>
                                  open ? old.filter((id) => id !== t.id) : [...old, t.id],
                                )
                              }
                            >
                              {open ? '收起' : '本次策略'}
                            </button>
                          </div>
                          {open && (
                            <div className="target-override">
                              <BackupFields value={b} onChange={(x) => changeBackup(t.id, x)} />
                              {!b.enabled && (
                                <p className="warning">未启用备份，失败时不能依赖本次备份恢复。</p>
                              )}
                              <button
                                className="link"
                                onClick={() =>
                                  setOverrides((old) => {
                                    const next = { ...old };
                                    delete next[t.id];
                                    return next;
                                  })
                                }
                              >
                                恢复该目标默认策略
                              </button>
                            </div>
                          )}
                        </article>
                      );
                    })}
                    <p className="note">
                      <ShieldCheck size={15} />
                      先上传并校验，再停止服务；一个服务只构建一次。
                    </p>
                  </Card>
                </div>
                <aside className="summary">
                  <Card title="本次部署">
                    <dl>
                      <dt>服务</dt>
                      <dd>{service.name}</dd>
                      <dt>目标</dt>
                      <dd>{chosen.length} 个，按顺序执行</dd>
                      <dt>构建</dt>
                      <dd>{build === 'rebuild' ? '重新构建一次' : '使用指定 JAR'}</dd>
                      <dt>备份</dt>
                      <dd>
                        {chosen.filter((t) => effective(t).enabled).length} / {chosen.length} 个目标
                      </dd>
                    </dl>
                    <hr />
                    <Field label="某个目标失败后">
                      <select
                        value={failureOverride ?? db.settings.failurePolicy}
                        onChange={(e) =>
                          setFailureOverride(
                            e.target.value as Database['settings']['failurePolicy'],
                          )
                        }
                      >
                        <option value="stop">停止后续目标</option>
                        <option value="continue">继续其他目标</option>
                      </select>
                    </Field>
                    {failureOverride !== null && (
                      <div className="row wrap">
                        <Badge>本次覆盖</Badge>
                        <button className="link" onClick={() => setFailureOverride(null)}>
                          恢复默认
                        </button>
                      </div>
                    )}
                    {chosen.some((t) => t.production) && (
                      <p className="warning">包含正式环境，需要额外确认。</p>
                    )}
                    <div className="deploy-actions" aria-label="部署操作">
                      <button
                        className="button primary block"
                        disabled={
                          busy ||
                          !chosen.length ||
                          (!desktop && build === 'existing' && !artifact.exists)
                        }
                        onClick={() => launch()}
                      >
                        <Rocket size={18} />
                        {isActive(task) ? '查看当前任务' : '部署'}
                      </button>
                      {desktop && (
                        <button
                          className="button"
                          disabled={busy || isActive(task) || !chosen.length}
                          onClick={() => void launch(chosen, undefined, true)}
                        >
                          试运行（远程只读）
                        </button>
                      )}
                    </div>
                    <p className="note">
                      {desktop
                        ? '确认后将构建产物并修改勾选目标；正式环境需要输入 DEPLOY。'
                        : '当前为界面原型，不执行真实部署。'}
                    </p>
                    {busy && <p role="status">正在检查本地构建环境和产物…</p>}
                  </Card>
                  <Card title="部署保护">
                    <ul className="check-list">
                      <li>
                        <Check size={15} />
                        独立构建环境
                      </li>
                      <li>
                        <Check size={15} />
                        每个目标独立备份
                      </li>
                      <li>
                        <Check size={15} />
                        临时上传 + 哈希校验
                      </li>
                      <li>
                        <Check size={15} />
                        按实际部署方式检查
                      </li>
                    </ul>
                  </Card>
                </aside>
              </div>
              <section className="recent">
                <div className="section-head">
                  <h2>最近部署</h2>
                  <button className="link" onClick={() => setPage('history')}>
                    全部记录
                    <ArrowRight size={14} />
                  </button>
                </div>
                {historyTable(db.history.slice(0, 3))}
              </section>
            </>
          )}
          {page === 'services' && (
            <>
              {header(
                '服务管理',
                '项目、构建环境和产物路径独立配置。',
                <button
                  className="button primary"
                  onClick={() =>
                    setDialog({
                      kind: 'service',
                      value: {
                        ...newService(),
                        id: uid(),
                        name: '',
                        code: '',
                        root: '',
                        description: '',
                        jarName: 'service.jar',
                        jarDir: 'target',
                      },
                    })
                  }
                >
                  <Plus size={17} />
                  添加服务
                </button>,
              )}
              <div className="card-grid">
                {db.services.map((s) => (
                  <Card
                    key={s.id}
                    title={s.name}
                    action={
                      <Badge>{db.targets.filter((t) => t.serviceId === s.id).length} 个目标</Badge>
                    }
                  >
                    <p className="muted">{s.description}</p>
                    <p className="path">{s.root}</p>
                    <div className="tags">
                      <Badge>{s.jdk}</Badge>
                      <Badge>{s.tool}</Badge>
                      <Badge>工作目录：{s.workDir}</Badge>
                    </div>
                    <p className="code">
                      {s.jarDir}\{s.jarName}
                    </p>
                    <footer className="row end">
                      <button
                        className="button danger"
                        aria-label={'删除服务' + s.name}
                        disabled={isActive(task)}
                        onClick={() => setDialog({ kind: 'delete', entity: 'service', id: s.id })}
                      >
                        删除服务
                      </button>
                      <button
                        className="button"
                        onClick={() => setDialog({ kind: 'service', value: s })}
                      >
                        编辑
                      </button>
                      <button
                        className="button"
                        onClick={() => {
                          selectService(s.id);
                          setPage('targets');
                        }}
                      >
                        配置目标
                      </button>
                      <button
                        className="button primary"
                        onClick={() => {
                          selectService(s.id);
                          setPage('deploy');
                        }}
                      >
                        去部署
                      </button>
                    </footer>
                  </Card>
                ))}
              </div>
            </>
          )}
          {page === 'targets' && (
            <>
              {header(
                '部署目标',
                '每个服务与服务器的部署关系，都有独立的运行规则。',
                <button
                  className="button primary"
                  disabled={!db.servers.length}
                  onClick={() => setDialog({ kind: 'target', value: newTarget() })}
                >
                  <Plus size={17} />
                  添加部署目标
                </button>,
              )}
              <Field label="筛选服务">
                <select value={serviceId} onChange={(e) => selectService(e.target.value)}>
                  {db.services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              {desktop && (
                <Card title="远程任务锁">
                  <p className="note">
                    只有超过阈值、确认原任务已停止，才允许归档旧锁；不会停止或删除运行中的服务。
                  </p>
                  {targets.map((t) => (
                    <button
                      className="button"
                      key={t.id}
                      disabled={isActive(task)}
                      onClick={() =>
                        setNativeDialog({
                          title: t.name + ' · 检查任务锁',
                          server: db.servers.find((s) => s.id === t.serverId),
                          lockTarget: t.id,
                        })
                      }
                    >
                      检查 {t.name} 的锁
                    </button>
                  ))}
                </Card>
              )}
              <div className="stack">
                {targets.map((t) => (
                  <Card
                    key={t.id}
                    title={
                      <span className="row">
                        {t.name}
                        <Badge kind={t.production ? 'warn' : ''}>{modeLabel(t.mode)}</Badge>
                      </span>
                    }
                    action={
                      <div className="row">
                        <button
                          className="button danger"
                          aria-label={'删除目标' + t.name}
                          disabled={isActive(task)}
                          onClick={() => setDialog({ kind: 'delete', entity: 'target', id: t.id })}
                        >
                          删除目标
                        </button>
                        <button
                          className="button"
                          onClick={() => setDialog({ kind: 'target', value: t })}
                        >
                          <Pencil size={15} />
                          编辑目标
                        </button>
                      </div>
                    }
                  >
                    <div className="target-config-grid">
                      <div>
                        <span className="muted">服务器</span>
                        <p>{db.servers.find((s) => s.id === t.serverId)?.name}</p>
                      </div>
                      <div>
                        <span className="muted">远程 JAR</span>
                        <p className="path">{remoteJar(t)}</p>
                      </div>
                      <div>
                        <span className="muted">运行方式</span>
                        <p>
                          {t.mode === 'docker'
                            ? t.container + ' · ' + (t.mount === 'file' ? '单文件绑定' : '目录绑定')
                            : t.restart || t.start}
                        </p>
                      </div>
                      <div>
                        <span className="muted">健康检查</span>
                        <p>
                          {t.health.type === 'none'
                            ? '未配置'
                            : t.health.type.toUpperCase() + ' · ' + t.health.value}
                        </p>
                      </div>
                      <div>
                        <span className="muted">默认备份</span>
                        <p>
                          {t.backup.enabled
                            ? t.backup.directory + ' / ' + t.backup.template
                            : '关闭'}
                        </p>
                      </div>
                      <div>
                        <span className="muted">停止命令非零</span>
                        <p>{t.stopFailure === 'warn' ? '记录警告，继续' : '终止部署'}</p>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}
          {page === 'servers' && (
            <>
              {header(
                '服务器',
                '认证信息集中维护，同一台服务器可关联多个服务。',
                <button
                  className="button primary"
                  onClick={() =>
                    setDialog({
                      kind: 'server',
                      value: {
                        id: uid(),
                        name: '',
                        host: '',
                        port: 22,
                        user: '',
                        auth: 'password',
                        credentialMode: 'ask',
                        alias: '',
                        keyPath: '',
                        note: '',
                      },
                    })
                  }
                >
                  <Plus size={17} />
                  添加服务器
                </button>,
              )}
              <Card>
                {db.servers.map((s) => {
                  const related = db.targets.filter((t) => t.serverId === s.id);
                  return (
                    <div className="list-row" key={s.id}>
                      <ServerIcon size={20} />
                      <div className="grow">
                        <h3>{s.name}</h3>
                        <p className="muted">
                          {serverAddress(s)} ·{' '}
                          {s.auth === 'alias'
                            ? 'SSH Config'
                            : s.auth === 'password'
                              ? '密码认证'
                              : '私钥认证'}
                        </p>
                        <small>
                          关联 {new Set(related.map((t) => t.serviceId)).size} 个服务 /{' '}
                          {related.length} 个部署目标
                        </small>
                      </div>
                      <Badge>未连接</Badge>
                      <button
                        className="button"
                        onClick={() =>
                          desktop
                            ? setNativeDialog({ title: '测试连接 · ' + s.name, server: s })
                            : notify('原型未发起连接。正式版将展示主机指纹及认证结果。')
                        }
                      >
                        测试连接
                      </button>
                      {desktop && s.auth === 'alias' && (
                        <button
                          className="button"
                          onClick={() =>
                            void nativeAction(async () => {
                              await desktop!.save(db);
                              const parsed = await desktop!.resolveAlias(s.id);
                              setNativeDialog({
                                title: s.name + ' · SSH Config 最终地址',
                                content: parsed.user + '@' + parsed.host + ':' + parsed.port,
                              });
                            })
                          }
                        >
                          解析地址
                        </button>
                      )}
                      <button
                        className="icon-button"
                        aria-label={'编辑服务器' + s.name}
                        onClick={() => setDialog({ kind: 'server', value: s })}
                      >
                        <Pencil size={17} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={'删除服务器' + s.name}
                        disabled={!!related.length}
                        onClick={() => {
                          setDb((old) => ({
                            ...old,
                            servers: old.servers.filter((x) => x.id !== s.id),
                          }));
                          notify('服务器已删除');
                        }}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  );
                })}
              </Card>
              <p className="note">
                {desktop
                  ? '被目标引用的服务器不可删除。口令仅使用当前 Windows 用户 DPAPI 加密，导出不包含口令。'
                  : '被目标引用的服务器不可删除。原型不保存或导出密码及私钥口令。'}
              </p>
            </>
          )}
          {page === 'tools' && (
            <>
              {header(
                '构建环境',
                '服务分别选择 JDK、工作目录、Maven、Profiles 和构建参数。',
                <button className="button primary" onClick={() => setDialog({ kind: 'jdk' })}>
                  <Plus size={17} />
                  添加 JDK
                </button>,
              )}
              <Card
                title="本机 JDK"
                action={
                  desktop && (
                    <button
                      className="button"
                      onClick={() =>
                        void nativeAction(async () => {
                          const found = await desktop!.detectJdks();
                          setDb((old) => ({
                            ...old,
                            jdks: [
                              ...old.jdks,
                              ...found.filter(
                                (j) =>
                                  !old.jdks.some(
                                    (x) =>
                                      x.path.toLowerCase() === j.path.toLowerCase() ||
                                      x.name === j.name,
                                  ),
                              ),
                            ],
                          }));
                          notify('检测到 ' + found.length + ' 个完整 JDK；已添加未配置项');
                        })
                      }
                    >
                      扫描本机 JDK
                    </button>
                  )
                }
              >
                {db.jdks.map((j) => (
                  <div className="list-row" key={j.name}>
                    <Coffee size={21} />
                    <div className="grow">
                      <h3>{j.name}</h3>
                      <p className="path">{j.path}</p>
                    </div>
                    <Badge>{desktop ? '本机配置' : '示例安装信息'}</Badge>
                    <button
                      className="button"
                      onClick={() =>
                        desktop
                          ? void nativeAction(async () =>
                              setNativeDialog({
                                title: j.name + ' 检测结果',
                                content: await desktop!.checkTool('jdk', j.path),
                              }),
                            )
                          : notify(
                              '原型不调用 java。正式版将执行 java -version 与 javac -version。',
                            )
                      }
                    >
                      检测
                    </button>
                  </div>
                ))}
              </Card>
              <Card className="mt" title="各服务的 Maven 配置">
                {db.services.map((s) => (
                  <div className="list-row" key={s.id}>
                    <Wrench size={20} />
                    <div className="grow">
                      <h3>{s.name}</h3>
                      <p className="path">
                        {s.tool === 'wrapper'
                          ? s.root + '\\mvnw.cmd'
                          : s.mavenPath || 'PATH 中的 Maven'}
                      </p>
                      <p className="muted">
                        工作目录：{s.workDir} · Profiles：{s.profiles || '无'} · 参数：{s.args}
                      </p>
                    </div>
                    {desktop && (
                      <button
                        className="button"
                        onClick={() =>
                          void nativeAction(async () => {
                            await desktop!.save(db);
                            setNativeDialog({
                              title: s.name + ' · Maven 版本',
                              content: await desktop!.checkTool('maven', s.id),
                            });
                          })
                        }
                      >
                        验证 Maven
                      </button>
                    )}
                    <button
                      className="button"
                      onClick={() => setDialog({ kind: 'service', value: s })}
                    >
                      配置
                    </button>
                  </div>
                ))}
              </Card>
              <p className="note">
                <ShieldCheck size={16} />
                JAVA_HOME 和 PATH 仅注入单次构建进程；不改系统配置。Cordys 固定使用 Wrapper。
              </p>
            </>
          )}
          {page === 'history' && (
            <>
              {header(
                '部署历史',
                desktop
                  ? '任务和目标结果保存在本机数据库，可导出完整日志。'
                  : '真实反映本次原型内完成的每个目标，保留当时配置快照。',
              )}
              {desktop && (
                <Card title="所有任务（含构建失败）">
                  {taskRows.length ? (
                    taskRows.map((t) => (
                      <div className="list-row" key={t.id}>
                        <div className="grow">
                          <strong>{t.service}</strong>
                          <p>
                            {t.id} · {fmtTime(t.started)} · {seconds(t.elapsed)}
                          </p>
                        </div>
                        <Badge>{t.status}</Badge>
                        <button
                          className="button"
                          disabled={isActive(task)}
                          onClick={() =>
                            void nativeAction(async () => {
                              setTaskReturnPage('history');
                              setTask(await desktop!.readTask(t.id));
                              setInspected(0);
                              setPage('task');
                            })
                          }
                        >
                          查看任务
                        </button>
                      </div>
                    ))
                  ) : (
                    <p>尚无执行任务。</p>
                  )}
                </Card>
              )}
              <div className="filters">
                <Field label="结果">
                  <select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value)}>
                    <option value="all">全部结果</option>
                    <option value="success">成功 / 未验证</option>
                    <option value="failed">失败 / 已回滚</option>
                  </select>
                </Field>
                <Field label="服务">
                  <select
                    value={historyService}
                    onChange={(e) => setHistoryService(e.target.value)}
                  >
                    <option value="all">全部服务</option>
                    {db.services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="服务器">
                  <select value={historyServer} onChange={(e) => setHistoryServer(e.target.value)}>
                    <option value="all">全部服务器</option>
                    {db.servers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="环境">
                  <select value={historyEnv} onChange={(e) => setHistoryEnv(e.target.value)}>
                    <option value="all">全部环境</option>
                    {[...new Set(db.history.map((h) => h.target.name))].map((e) => (
                      <option key={e}>{e}</option>
                    ))}
                  </select>
                </Field>
                <Field label="部署日期">
                  <input
                    type="date"
                    value={historyDate}
                    onChange={(e) => setHistoryDate(e.target.value)}
                  />
                </Field>
              </div>
              <Card>{historyTable(filteredHistory)}</Card>
            </>
          )}
          {page === 'settings' && (
            <>
              {header(
                '设置',
                desktop ? '默认行为、构建兼容与本机数据。' : '默认行为、构建兼容与原型本地数据。',
              )}
              <Card title="部署默认行为">
                <Field label="某个目标失败后">
                  <select
                    value={db.settings.failurePolicy}
                    onChange={(e) =>
                      setDb((old) => ({
                        ...old,
                        settings: {
                          ...old.settings,
                          failurePolicy: e.target.value as Database['settings']['failurePolicy'],
                        },
                      }))
                    }
                  >
                    <option value="stop">停止后续目标</option>
                    <option value="continue">继续其他目标</option>
                  </select>
                </Field>
                <Field label="界面主题">
                  <select
                    value={db.settings.theme}
                    onChange={(e) =>
                      setDb((old) => ({
                        ...old,
                        settings: {
                          ...old.settings,
                          theme: e.target.value as Database['settings']['theme'],
                        },
                      }))
                    }
                  >
                    <option value="system">跟随系统</option>
                    <option value="light">浅色</option>
                    <option value="dark">深色</option>
                  </select>
                </Field>
                <Field
                  label="历史保留条数"
                  hint="按目标记录计数（1–10000），同时清理不再引用的本机任务日志和产物；远程备份不会删除"
                >
                  <input
                    type="number"
                    min="1"
                    max="10000"
                    value={db.settings.historyLimit}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (Number.isInteger(value) && value >= 1 && value <= 10000)
                        setDb((old) =>
                          pruneHistory({
                            ...old,
                            settings: { ...old.settings, historyLimit: value },
                          }),
                        );
                    }}
                  />
                </Field>
                {prototype && (
                  <Demo>
                    <Switch
                      label="演示模式"
                      description="显示虚线边框中的演示产物和故障注入控件"
                      checked={db.settings.demoMode}
                      onChange={(demoMode) =>
                        setDb((old) => ({ ...old, settings: { ...old.settings, demoMode } }))
                      }
                    />
                  </Demo>
                )}
                {desktop && (
                  <>
                    <Field label="历史保留天数（0 为不按天清理）">
                      <input
                        type="number"
                        min="0"
                        max="3650"
                        value={db.settings.historyDays ?? 90}
                        onChange={(e) =>
                          setDb((old) => ({
                            ...old,
                            settings: {
                              ...old.settings,
                              historyDays: Math.max(0, Math.min(3650, Number(e.target.value))),
                            },
                          }))
                        }
                      />
                    </Field>
                    <Field label="陈旧锁阈值（分钟）">
                      <input
                        type="number"
                        min="1"
                        max="10080"
                        value={db.settings.staleLockMinutes ?? 120}
                        onChange={(e) =>
                          setDb((old) => ({
                            ...old,
                            settings: {
                              ...old.settings,
                              staleLockMinutes: Math.max(1, Number(e.target.value)),
                            },
                          }))
                        }
                      />
                    </Field>
                    <button className="button" onClick={() => void desktop!.openDataDir()}>
                      打开数据目录
                    </button>
                  </>
                )}
                <Switch
                  label="兼容 Maven 异常非零退出码"
                  description="仅当日志包含 BUILD SUCCESS、产物有效且修改时间晚于本次构建开始时间时允许；默认开启，可关闭"
                  checked={db.settings.allowMavenNonzero}
                  onChange={(v) =>
                    setDb((old) => ({
                      ...old,
                      settings: { ...old.settings, allowMavenNonzero: v },
                    }))
                  }
                />
                <p className="note">
                  {desktop
                    ? '默认开启以兼容现有脚本；只有成功标记、新产物时间和完整 JAR 校验全部满足时才接受。'
                    : '原型不执行 Maven；此选项定义正式实现的构建接受条件。'}
                </p>
              </Card>
              <Card title="配置导入导出" className="mt">
                <p className="muted">
                  {desktop
                    ? 'SQLite 保存配置和历史，完整日志独立保存。导出不包含认证口令。'
                    : '原型通过当前浏览器本地存储保存配置和历史。导出不包含认证口令。'}
                </p>
                <div className="row wrap mt">
                  <button
                    className="button"
                    onClick={() =>
                      desktop
                        ? void nativeAction(async () => {
                            await desktop!.save(db);
                            await desktop!.exportConfig();
                          })
                        : download(
                            'deploy-center-config-v3.json',
                            safeConfigJson(db),
                            'application/json',
                          )
                    }
                  >
                    <Download size={16} />
                    导出配置
                  </button>
                  <button
                    className="button"
                    onClick={() => (desktop ? void importNative() : importRef.current?.click())}
                    disabled={isActive(task)}
                  >
                    <Upload size={16} />
                    导入配置
                  </button>
                </div>
                <p className="note">
                  {desktop
                    ? '数据目录：' + boot?.dataDir
                    : '正式桌面版改用本地数据库及 Windows 加密凭据，安装与数据目录分离。'}
                </p>
              </Card>
            </>
          )}
          {page === 'task' && task && (
            <>
              {header(
                task.dryRun
                  ? '试运行报告（远程只读）'
                  : task.operation === 'rollback'
                    ? '恢复历史版本'
                    : '部署任务',
                task.id + ' · ' + task.service.name,
                <div className="task-heading-actions">
                  <button className="button" onClick={() => setPage(taskReturnPage)}>
                    <ArrowLeft size={16} />
                    {taskReturnPage === 'history' ? '返回部署历史' : '返回部署'}
                  </button>
                  <Badge
                    kind={
                      task.status === 'success' ? 'good' : task.status === 'failed' ? 'warn' : ''
                    }
                  >
                    {task.status === 'cancelling'
                      ? '取消中 · 等待安全边界'
                      : task.status === 'running'
                        ? '执行中'
                        : task.status === 'success'
                          ? '任务完成'
                          : task.status === 'partial'
                            ? '部分成功'
                            : task.status === 'cancelled'
                              ? '任务已取消'
                              : task.status === 'interrupted'
                                ? '执行结果待核实'
                                : '部署失败'}
                  </Badge>
                </div>,
              )}
              <TaskView
                task={task}
                inspected={Math.min(inspected, task.targets.length - 1)}
                setInspected={setInspected}
                onCancel={() => setDialog({ kind: 'cancel' })}
                demoMode={prototype && !desktop && db.settings.demoMode}
                onFailure={(kind) => {
                  setTask((t) => (t ? requestFailure(t, kind) : null));
                  notify('将在当前目标启动或健康检查阶段触发模拟故障。');
                }}
                onRetry={retry}
                onCopy={copy}
                onLog={(text) =>
                  desktop
                    ? setNativeDialog({
                        title: '容器日志',
                        logs: task.targets[inspected].target.id,
                      })
                    : setDialog({
                        kind: 'history',
                        value: {
                          id: 'logs',
                          taskId: task.id,
                          operation: task.operation,
                          service: snapshotService(task.service),
                          target: snapshotTarget(task.targets[inspected].target),
                          server: snapshotServer(task.targets[inspected].server),
                          artifact: task.artifact,
                          build: task.build,
                          status: task.targets[inspected].status,
                          time: task.started,
                          elapsed: task.elapsed,
                          logs: [text],
                          backupCreated: false,
                          steps: [],
                        },
                      })
                }
              />
            </>
          )}
        </main>
        <footer className="workspace-footer">
          <span>
            YOTOO 部署中心 · {desktop ? '桌面版 ' + (boot?.version || '1.1.0') : '界面原型 v0.3'}
          </span>
          <span>先校验，再切换；每个目标独立记录。</span>
        </footer>
      </div>
      <input
        hidden
        type="file"
        accept=".jar"
        ref={fileRef}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            setArtifact({
              name: f.name,
              path: f.name + '（浏览器不提供完整路径）',
              size: f.size,
              modified: new Date(f.lastModified).toISOString(),
              exists: f.size > 0,
              source: 'file',
            });
            e.target.value = '';
          }
        }}
      />
      <input
        hidden
        type="file"
        accept=".json"
        ref={importRef}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            if (!validDatabase(data)) throw new Error('配置版本或引用关系无效');
            setDb(pruneHistory(JSON.parse(safeConfigJson(data))));
            setRecovery(undefined);
            setServiceId(data.services[0].id);
            setSelected([]);
            setOverrides({});
            setArtifact(artifactFor(data.services[0]));
            notify('配置已导入，正式环境仍需手动选择');
          } catch (error) {
            notify('导入失败：' + (error as Error).message);
          }
          e.target.value = '';
        }}
      />
      {dialog?.kind === 'service' && (
        <Modal title="服务与构建配置" onClose={() => setDialog(null)} wide>
          <ServiceForm
            initial={dialog.value}
            db={db}
            onClose={() => setDialog(null)}
            onSave={(s) => {
              setDb((old) => ({ ...old, services: upsert(old.services, s) }));
              if (s.id === serviceId) {
                setArtifact((desktop ? initialArtifact : artifactFor)(s));
                setJarSelection(undefined);
                setLocalInfo(null);
                setInfoRefresh((n) => n + 1);
              }
              setDialog(null);
              notify('服务配置已保存');
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'server' && (
        <Modal title="服务器配置" onClose={() => setDialog(null)} wide>
          <ServerForm
            initial={dialog.value}
            db={db}
            encryptionAvailable={boot?.encryptionAvailable}
            onClose={() => setDialog(null)}
            onSave={(s) => {
              setDb((old) => ({ ...old, servers: upsert(old.servers, s) }));
              setDialog(null);
              notify('服务器配置已保存；选择本机加密时，将在下次认证后保存输入的口令。');
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'target' && (
        <Modal title="部署目标配置" onClose={() => setDialog(null)} wide>
          <TargetForm
            initial={dialog.value}
            db={db}
            onClose={() => setDialog(null)}
            onSave={saveTarget}
          />
        </Modal>
      )}
      {dialog?.kind === 'picker' && (
        <Modal title="选择服务" onClose={() => setDialog(null)}>
          <ServicePicker
            db={db}
            onChoose={(id) => {
              selectService(id);
              setDialog(null);
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'confirm' && (
        <Modal
          title={
            dialog.task.dryRun
              ? '确认试运行（远程只读）'
              : dialog.task.operation === 'rollback'
                ? '确认回滚'
                : '确认部署'
          }
          onClose={() => setDialog(null)}
          wide
        >
          <Confirm
            task={dialog.task}
            onClose={() => setDialog(null)}
            saved={saved}
            onStart={async (t, values, approval) => {
              if (desktop) {
                const started = await desktop!.start(dialog.token!, values, approval);
                setTask(started);
              } else {
                credentials.current.set(values);
                setTask(startTask(t));
              }
              setFailureOverride(null);
              setTaskReturnPage('deploy');
              setInspected(0);
              setPage('task');
              setDialog(null);
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'cancel' && task && (
        <Modal title="取消当前任务？" onClose={() => setDialog(null)}>
          <p>
            当前阶段：
            {task.buildPhase < 3
              ? '构建与产物准备'
              : task.targets[task.active]?.steps[task.targets[task.active]?.phase]?.label ||
                '任务收尾'}
          </p>
          <p className="warning">
            {task.buildPhase >= 3 &&
            task.targets[task.active]?.steps[task.targets[task.active].phase]?.critical
              ? '已经进入服务切换阶段。请求取消后会完成当前目标的检查或回滚，再停止后续目标，不会强制中断替换。'
              : '将在下一个安全边界停止，清理本任务临时上传文件。当前运行版本保持不变。'}
          </p>
          <footer className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              继续部署
            </button>
            <button
              className="button danger"
              onClick={() => {
                if (desktop) void nativeAction(() => desktop!.cancel(task.id));
                else setTask((t) => (t ? cancelTask(t) : null));
                setDialog(null);
              }}
            >
              请求取消
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === 'history' && (
        <Modal
          title={dialog.value.id === 'logs' ? '容器日志' : '部署记录详情'}
          onClose={() => setDialog(null)}
          wide
        >
          <HistoryDetail
            value={dialog.value}
            canRollback={canRollback(dialog.value)}
            taskRecord={db.taskHistory[dialog.value.taskId]}
            onRollback={() => {
              const h = dialog.value;
              const current = db.targets.find((t) => t.id === h.target.id);
              if (current && canRollback(h)) {
                setDialog(null);
                launch([current], h);
              }
            }}
            onExport={() =>
              desktop
                ? void nativeAction(() =>
                    desktop!.exportLogs(dialog.value.taskId, dialog.value.target.id),
                  )
                : download(
                    'deploy-' + dialog.value.taskId + '.log',
                    historyLogs(db, dialog.value).join('\n'),
                  )
            }
          />
          <footer className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              <ArrowLeft size={16} />
              返回
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === 'delete' && (
        <Modal
          title={dialog.entity === 'service' ? '删除服务配置？' : '删除目标配置？'}
          onClose={() => setDialog(null)}
        >
          <p className="warning">
            {dialog.entity === 'service'
              ? '将删除服务及其所有部署目标配置。服务器和历史快照继续保留。'
              : '将删除这个目标的配置。服务器和历史快照继续保留。'}
            不会停止或删除服务器上的应用，也不会删除远程备份。
          </p>
          <footer className="modal-actions">
            <button className="button" onClick={() => setDialog(null)}>
              取消
            </button>
            <button
              className="button danger"
              onClick={async () => {
                const removed = new Set(
                  db.targets
                    .filter((t) =>
                      dialog.entity === 'service' ? t.serviceId === dialog.id : t.id === dialog.id,
                    )
                    .map((t) => t.id),
                );
                const services =
                  dialog.entity === 'service'
                    ? db.services.filter((s) => s.id !== dialog.id)
                    : db.services;
                const current = services.find((s) => s.id === serviceId) || services[0];
                const next = {
                  ...db,
                  services,
                  targets: db.targets.filter((t) => !removed.has(t.id)),
                  lastService: current?.id || '',
                  lastTargets: db.lastTargets.filter((id) => !removed.has(id)),
                };
                try {
                  if (desktop) await desktop.save(next);
                  if (!services.length) {
                    window.location.reload();
                    return;
                  }
                  setDb(next);
                  setServiceId(current.id);
                  setSelected((old) => old.filter((id) => !removed.has(id)));
                  setArtifact((desktop ? initialArtifact : artifactFor)(current));
                  setDialog(null);
                  notify('配置已删除，历史和远程文件保留');
                } catch (e) {
                  notify(String(e));
                }
              }}
            >
              删除配置
            </button>
          </footer>
        </Modal>
      )}
      {dialog?.kind === 'jdk' && (
        <Modal title="添加 JDK" onClose={() => setDialog(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const values = new FormData(e.currentTarget);
              const name = String(values.get('name')).trim(),
                path = String(values.get('path')).trim();
              if (db.jdks.some((j) => j.name === name)) {
                notify('JDK 名称已存在');
                return;
              }
              setDb((old) => ({ ...old, jdks: [...old.jdks, { name, path }] }));
              setDialog(null);
            }}
          >
            <Field label="显示名称">
              <input required name="name" placeholder="JDK 11" />
            </Field>
            <Field label="JDK 安装目录">
              <input required name="path" placeholder="E:\dev\jdk\jdk11" />
            </Field>
            <p className="note">
              {desktop
                ? '保存后可在构建环境页检测 java 与 javac。'
                : '本原型保存配置，不执行 java 检测。'}
            </p>
            <footer className="modal-actions">
              <button className="button primary">保存</button>
            </footer>
          </form>
        </Modal>
      )}
      {nativeDialog && (
        <Modal title={nativeDialog.title} wide onClose={() => setNativeDialog(null)}>
          {nativeDialog.lock && (
            <LockTakeover
              {...nativeDialog.lock}
              onDone={() => {
                setNativeDialog(null);
                notify('陈旧锁已归档，请重新试运行');
              }}
            />
          )}
          {nativeDialog.content && <pre className="terminal">{nativeDialog.content}</pre>}
          {nativeDialog.logs && <ContainerLogs targetId={nativeDialog.logs} />}
          {(nativeDialog.server || nativeDialog.recover) && (
            <CredentialPrompt
              saved={saved}
              servers={
                nativeDialog.server
                  ? [nativeDialog.server]
                  : nativeDialog
                      .recover!.targets.filter((r) => r.remote && r.remote.phase !== 'complete')
                      .map((r) => r.server)
              }
              label={nativeDialog.recover ? '核实原任务' : '测试连接'}
              onSubmit={async (values) => {
                if (nativeDialog.server && nativeDialog.lockTarget) {
                  const lock = await desktop!.inspectLock(
                    nativeDialog.lockTarget,
                    values[nativeDialog.server.id],
                  );
                  setNativeDialog({ title: '检查陈旧任务锁', lock });
                } else if (nativeDialog.server) {
                  const content = await desktop!.testConnection(
                    nativeDialog.server.id,
                    values[nativeDialog.server.id],
                  );
                  setNativeDialog({ title: '连接结果', content });
                } else {
                  setTask(await desktop!.recover(nativeDialog.recover!.id, values));
                  setPage('task');
                  setNativeDialog(null);
                }
              }}
            />
          )}
        </Modal>
      )}
      {trust && <TrustDialog key={trust.id} request={trust} onClose={() => setTrust(undefined)} />}
      {message && (
        <div className="toast" role="status">
          {message}
          <button aria-label="关闭提示" onClick={() => setMessage('')}>
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function ServicePicker({ db, onChoose }: { db: Database; onChoose: (id: string) => void }) {
  const [query, setQuery] = useState('');
  return (
    <>
      <Field label="搜索服务">
        <input
          data-autofocus
          placeholder="服务名称、标识或项目目录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Field>
      <div className="stack">
        {db.services
          .filter((s) =>
            [s.name, s.code, s.root].join(' ').toLowerCase().includes(query.toLowerCase()),
          )
          .map((s) => {
            const h = db.history.find((h) => h.service.id === s.id);
            return (
              <button className="service-result" key={s.id} onClick={() => onChoose(s.id)}>
                <span className="service-icon">{s.name[0]}</span>
                <span className="grow">
                  <strong>{s.name}</strong>
                  <small>{s.root}</small>
                  <small>
                    {h ? `上次 ${fmtTime(h.time)} · ${statusLabel[h.status]}` : '尚未部署'}
                  </small>
                </span>
                <ChevronRight size={17} />
              </button>
            );
          })}
      </div>
    </>
  );
}
function Confirm({
  task: initial,
  onStart,
  onClose,
  saved = [],
}: {
  saved?: string[];
  task: Task;
  onStart: (
    t: Task,
    credentials: Record<string, string>,
    approval: Approval,
  ) => void | Promise<void>;
  onClose: () => void;
}) {
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
  return (
    <>
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
      </div>
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
      <ArtifactInfo value={initial.artifact} service={initial.service} />
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
        <code>{initial.service.git.commit}</code>
      </p>
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
      <div className="stack">
        {initial.targets.map((r) => (
          <div className="confirm-target" key={r.target.id}>
            <div className="row spread">
              <h3>{r.target.name}</h3>
              <Badge kind={r.target.production ? 'warn' : ''}>{modeLabel(r.target.mode)}</Badge>
            </div>
            <p className="muted">
              {r.server.name} · {serverAddress(r.server)}
            </p>
            <p className="path">远程文件：{remoteJar(r.target)}</p>
            {r.target.mode === 'docker' && (
              <p className="muted">
                容器：{r.target.container} · {r.target.containerJar}
              </p>
            )}
            <p className="muted">
              健康检查：
              {r.target.health.type === 'none'
                ? '未配置，结果将标记健康未验证'
                : r.target.health.type.toUpperCase() + ' · ' + r.target.health.value}
            </p>
            {initial.operation === 'deploy' &&
              (r.backup.enabled ? (
                <p className="path">
                  {r.target.hasOldJar
                    ? '备份预览：' + r.plannedBackupPath
                    : '首次部署无旧 JAR，跳过备份'}
                </p>
              ) : (
                <p className="warning">不备份：无法依赖本次备份自动恢复。</p>
              ))}
            {r.target.createDirectory && (
              <p className="warning">已允许创建缺失目录：{r.target.directory}</p>
            )}
          </div>
        ))}
      </div>
      <p className="note">
        失败策略：{initial.failurePolicy === 'stop' ? '停止后续目标' : '继续其他目标'}。
        {desktop
          ? initial.dryRun
            ? '本次仅执行只读检查，不上传或修改远程文件。'
            : '确认后将执行真实部署。'
          : '所有执行均为本地模拟。'}
      </p>
      {degraded && (
        <label className="check-row warning">
          <input
            type="checkbox"
            checked={fallback}
            onChange={(e) => setFallback(e.target.checked)}
          />
          确认允许缺少 SHA-256 工具时仅校验字节数（较弱校验）
        </label>
      )}
      {servers.map((s) => (
        <div className="confirm-target mt" key={s.id}>
          <h3>{s.name} · 本次认证</h3>
          {s.credentialMode === 'windows' && (
            <p className="warning">
              {desktop
                ? saved.includes(s.id)
                  ? '已保存本机 DPAPI 加密凭据；留空复用，输入新值将更新。'
                  : '输入后使用当前 Windows 用户的 DPAPI 加密保存到本机。'
                : 'Windows 凭据管理器是正式版能力。原型仍需本次输入，不会保存。'}
            </p>
          )}
          <Field
            label={
              (s.auth === 'password' ? '登录密码' : '私钥口令（未加密可留空）') + ' · ' + s.name
            }
            hint="仅保留在当前任务内存，任务结束清除，不进入配置、日志或导出"
          >
            <input
              type="password"
              autoComplete="off"
              value={credentials[s.id] || ''}
              onChange={(e) => setCredentials((old) => ({ ...old, [s.id]: e.target.value }))}
            />
          </Field>
        </div>
      ))}
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {production && (
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
      <footer className="modal-actions">
        <button className="button" onClick={onClose}>
          返回检查
        </button>
        <button
          className="button primary"
          disabled={
            starting ||
            (production && word !== 'DEPLOY') ||
            (degraded && !fallback) ||
            servers.some(
              (s) =>
                s.auth === 'password' &&
                !credentials[s.id] &&
                !(desktop && s.credentialMode === 'windows' && saved.includes(s.id)),
            )
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
              await onStart(task, credentials, {
                productionWord: word,
                allowWeak: fallback,
                protectCurrent: protect,
              });
              setCredentials({});
            } catch (e) {
              setError(String(e));
            } finally {
              setStarting(false);
            }
          }}
        >
          <Rocket size={17} />
          {initial.dryRun ? '开始试运行' : initial.operation === 'rollback' ? '回滚' : '部署'}
        </button>
      </footer>
    </>
  );
}
function TaskView({
  task,
  inspected,
  setInspected,
  onCancel,
  onFailure,
  demoMode,
  onRetry,
  onCopy,
  onLog,
}: {
  task: Task;
  inspected: number;
  setInspected: (v: number) => void;
  onCancel: () => void;
  onFailure: (kind?: 'application' | 'containerHash') => void;
  demoMode: boolean;
  onRetry: (failed: boolean) => void;
  onCopy: (s: string) => void;
  onLog: (s: string) => void;
}) {
  const r = task.targets[inspected],
    active = isActive(task);
  const allLogs = [...task.buildLogs, ...r.logs];
  const completed = task.targets.filter(
    (r) => !['pending', 'running', 'rollingback'].includes(r.status),
  ).length;
  const commands = diagnostics(r.server, r.target);
  return (
    <>
      <Card>
        <div className="row spread wrap">
          <div>
            <h2>构建与产物准备</h2>
            <p className="muted">
              {task.buildPhase < 3
                ? [
                    '检查本地环境',
                    task.build === 'rebuild' ? '构建 JAR' : '准备指定 JAR',
                    '校验任务快照',
                  ][task.buildPhase]
                : '产物已就绪，同一份 JAR 按顺序部署'}{' '}
              · {seconds(task.elapsed)}
            </p>
          </div>
          <Badge>
            {completed} / {task.targets.length} 目标已结束
          </Badge>
        </div>
        <div
          className="progress"
          role="progressbar"
          aria-label="任务总体进度"
          aria-valuenow={Math.round(
            ((Math.min(task.buildPhase, 3) +
              task.targets.reduce((sum, r) => sum + (r.phase / r.steps.length) * 3, 0)) /
              (3 + task.targets.length * 3)) *
              100,
          )}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span
            style={{
              width:
                ((Math.min(task.buildPhase, 3) +
                  task.targets.reduce((sum, r) => sum + (r.phase / r.steps.length) * 3, 0)) /
                  (3 + task.targets.length * 3)) *
                  100 +
                '%',
            }}
          />
        </div>
      </Card>
      <Card title="构建阶段耗时" className="mt">
        <Steps
          labels={task.buildSteps.map((s) => s.label)}
          details={task.buildSteps}
          current={task.buildPhase}
          finished={task.buildPhase === task.buildSteps.length}
        />
      </Card>
      <div className="task-layout mt">
        <aside className="stack">
          {task.targets.map((r, i) => (
            <button
              key={r.target.id}
              className={'task-target ' + (inspected === i ? 'selected' : '')}
              onClick={() => setInspected(i)}
            >
              <span className="row spread">
                <strong>{r.target.name}</strong>
                <span>{seconds(r.elapsed)}</span>
              </span>
              <small>{r.server.name}</small>
              <Badge
                kind={
                  r.status === 'success' ? 'good' : failedStatuses.includes(r.status) ? 'warn' : ''
                }
              >
                {statusLabel[r.status]}
              </Badge>
              <div className="progress">
                <span style={{ width: (r.phase / r.steps.length) * 100 + '%' }} />
              </div>
            </button>
          ))}
        </aside>
        <Card
          title={
            <span className="row">
              {r.target.name}
              <Badge>{modeLabel(r.target.mode)}</Badge>
            </span>
          }
        >
          <p className="path">{remoteJar(r.target)}</p>
          <Steps
            labels={r.steps.map((s) => s.label)}
            details={r.steps}
            current={r.phase}
            failed={['failed', 'rollingback', 'rolledback'].includes(r.status)}
            cancelled={
              ['cancelled', 'skipped', 'pending'].includes(r.status) || task.buildPhase < 3
            }
            finished={['success', 'unverified'].includes(r.status)}
          />
          {r.upload.bytes > 0 && (
            <p className="note" aria-label="模拟上传进度">
              {desktop ? '上传：' : '模拟上传：'}
              {r.upload.percent}% · {(r.upload.speed / 1024 / 1024).toFixed(1)} MB/s ·{' '}
              {niceSize(r.upload.bytes)} / {niceSize(r.upload.total)}
            </p>
          )}
          {r.error && (
            <p className="warning" role="alert">
              {r.error}
              <br />
              {r.recovery || '正在按配置尝试自动回滚。'}
            </p>
          )}
          {task.status === 'cancelling' && (
            <p className="warning" role="status">
              取消中：等待当前目标到达安全边界，不强制中断替换。
            </p>
          )}
        </Card>
      </div>
      <div className="task-actions">
        <div className="row wrap">
          {active ? (
            <>
              <button className="button" onClick={onCancel} disabled={task.status === 'cancelling'}>
                取消任务
              </button>
              {prototype && demoMode && (
                <Demo>
                  <button
                    className="link"
                    onClick={() => onFailure()}
                    disabled={task.status === 'cancelling' || !!task.targets[task.active]?.fail}
                  >
                    模拟当前目标启动 / 健康检查失败
                  </button>
                  {task.targets[task.active]?.target.mode === 'docker' && (
                    <button
                      className="link"
                      onClick={() => onFailure('containerHash')}
                      disabled={
                        task.status === 'cancelling' || !!task.targets[task.active]?.hashMismatch
                      }
                    >
                      模拟容器内哈希不一致
                    </button>
                  )}
                </Demo>
              )}
            </>
          ) : (
            <>
              <button className="button" onClick={() => onRetry(false)}>
                <RotateCcw size={15} />
                重新部署本次目标
              </button>
              <button
                className="button"
                onClick={() => onRetry(true)}
                disabled={!task.targets.some((r) => failedStatuses.includes(r.status))}
              >
                只重试失败目标
              </button>
            </>
          )}
        </div>
        <button className="button" onClick={() => onCopy(commands)}>
          <Copy size={15} />
          复制排查命令
        </button>
        {r.target.mode === 'docker' && (
          <button
            className="button"
            onClick={() =>
              onLog(
                `[模拟容器日志] ${r.target.container}\n服务初始化中…\n请在正式版本连接服务器后获取实际输出。`,
              )
            }
          >
            <Terminal size={15} />
            容器日志
          </button>
        )}
      </div>
      <Card
        title="执行日志"
        action={
          <div className="row">
            <button
              className="link"
              onClick={() =>
                desktop
                  ? void desktop!.readLogs(task.id, r.target.id).then((value) => {
                      if (value.truncated) {
                        void desktop!.exportLogs(task.id, r.target.id);
                      } else onCopy([...value.build, ...value.target].join('\n'));
                    })
                  : onCopy(allLogs.join('\n'))
              }
            >
              <Copy size={15} />
              复制
            </button>
            <button
              className="link"
              onClick={() =>
                desktop
                  ? void desktop!.exportLogs(task.id, r.target.id)
                  : download(task.id + '.log', allLogs.join('\n'))
              }
            >
              <Download size={15} />
              导出
            </button>
          </div>
        }
      >
        {desktop ? (
          <NativeLogs
            key={task.id + r.target.id}
            taskId={task.id}
            targetId={r.target.id}
            initial={allLogs}
          />
        ) : (
          <LogViewer lines={allLogs} />
        )}
      </Card>
    </>
  );
}
function HistoryDetail({
  value: h,
  canRollback,
  taskRecord,
  onRollback,
  onExport,
}: {
  value: History;
  canRollback: boolean;
  taskRecord?: TaskRecord;
  onRollback: () => void;
  onExport: () => void;
}) {
  const [nativeLog, setNativeLog] = useState<{
    build: string[];
    target: string[];
    truncated: boolean;
  }>();
  useEffect(() => {
    if (desktop) void desktop.readLogs(h.taskId, h.target.id).then(setNativeLog);
  }, [h.taskId, h.target.id]);
  return (
    <>
      <dl className="detail-list">
        <dt>服务 / 环境</dt>
        <dd>
          {h.service.name} / {h.target.name}
        </dd>
        <dt>结果</dt>
        <dd>{statusLabel[h.status]}</dd>
        <dt>目标文件</dt>
        <dd className="path">{remoteJar(h.target)}</dd>
        <dt>Git</dt>
        <dd>
          {h.service.git.branch} · {h.service.git.commit}
        </dd>
        <dt>整体任务</dt>
        <dd>{seconds(taskRecord?.elapsed ?? h.elapsed)}</dd>
        <dt>时间 / 目标耗时</dt>
        <dd>
          {fmtTime(h.time)} / {seconds(h.elapsed)}
        </dd>
        <dt>备份</dt>
        <dd className="path">{h.backupPath || '本记录没有可恢复的备份'}</dd>
      </dl>
      {h.error && (
        <p className="warning">
          {h.error}
          <br />
          {h.recovery}
        </p>
      )}
      <h3>构建日志</h3>
      <LogViewer lines={nativeLog?.build || taskRecord?.buildLogs || []} />
      <h3 className="mt">目标日志</h3>
      <LogViewer lines={nativeLog?.target || h.logs} />
      {nativeLog?.truncated && <p className="note">仅展示日志尾部，导出可取得完整文件。</p>}
      <h3 className="mt">构建步骤耗时</h3>
      <TimingTable steps={taskRecord?.buildSteps || []} />
      <h3 className="mt">目标步骤耗时</h3>
      <TimingTable steps={h.steps} />
      {!canRollback && h.id !== 'logs' && (
        <p className="note">
          {h.backupPath
            ? '当前目标配置或服务器身份已变化，禁止直接使用旧记录回滚。'
            : '无有效备份，不能发起历史回滚。'}
        </p>
      )}
      <footer className="modal-actions">
        <button className="button" onClick={onExport}>
          <Download size={15} />
          导出日志
        </button>
        {h.id !== 'logs' && (
          <button className="button primary" disabled={!canRollback} onClick={onRollback}>
            <RotateCcw size={15} />
            回滚到此备份
          </button>
        )}
      </footer>
    </>
  );
}

function TimingTable({ steps }: { steps: import('./model').Step[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>步骤</th>
            <th>开始时间</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key}>
              <td>{s.label}</td>
              <td>
                {s.startedAt === undefined
                  ? '未执行'
                  : fmtTime(new Date(s.startedAt).toISOString())}
              </td>
              <td>{seconds(s.elapsed || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 空数据库先完成第一项配置，再进入工作台；首次启动不生成示例服务器。 */
export default function App({ boot }: { boot?: Startup } = {}) {
  const [current, setCurrent] = useState(boot),
    [error, setError] = useState('');
  if (!desktop || (current && current.database.services.length))
    return <Workspace boot={current} />;
  const db = current?.database || emptyDatabase();
  return (
    <main className="welcome">
      <img src={brandIcon} alt="" width="64" height="64" />
      <h1>YOTOO 部署中心</h1>
      <p>添加第一个服务，或导入已有配置。不会自动连接任何服务器。</p>
      {error && (
        <p role="alert" className="warning">
          {error}
        </p>
      )}
      {current?.recovery && (
        <div className="warning">
          <p>配置无法读取，原始数据已保留。请先下载原文后确认恢复。</p>
          <button
            className="button"
            onClick={() => download('original-config.json', current.recovery!.raw)}
          >
            下载原始数据
          </button>
          <button
            className="button"
            onClick={() =>
              void desktop!
                .confirmRecovery()
                .then(() => setCurrent({ ...current, recovery: undefined }))
            }
          >
            确认恢复为空配置
          </button>
        </div>
      )}
      {!current?.recovery && (
        <>
          <button
            className="button"
            onClick={() =>
              void desktop!
                .importConfig()
                .then(async (value) => {
                  if (value) setCurrent(await desktop!.load());
                })
                .catch((e) => setError(String(e)))
            }
          >
            导入配置
          </button>
          <ServiceForm
            initial={newService()}
            db={db}
            onClose={() => setError('可以先填写项目目录与服务名称；JDK 可稍后配置。')}
            onSave={async (service) => {
              try {
                await desktop!.save({ ...db, services: [service], lastService: service.id });
                setCurrent(await desktop!.load());
              } catch (e) {
                setError(String(e));
              }
            }}
          />
        </>
      )}
    </main>
  );
}
