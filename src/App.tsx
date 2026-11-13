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
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  RotateCcw,
  X,
  Download,
  Upload,
  ChevronRight,
  ShieldCheck,
  GitBranch,
  FileArchive,
  Pencil,
  Coffee,
  Loader2,
  FolderOpen,
  BookOpen,
  Code2,
  Info,
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
import { Badge, Card, Field, Switch, Modal, Demo, download } from './ui';
import { ServiceForm, ServerForm, TargetForm, BackupFields } from './forms';
import './style.css';
import { DataSettings, LegacyArtifactReview } from './DataSettings';
import type { SnapshotAvailability } from './features';
import { DirectorySettings } from './DirectorySettings';
import {
  confirmProduction,
  productionNames,
  knownCommit,
  healthLabels,
  toolLabels,
  taskResult,
  deploymentTime,
  cloneService,
  cloneTarget,
  deletionReason,
} from './presentation';
import { deploymentBlockReason, HashValue, PrecheckPanel, VersionFacts } from './DeployDetails';
import type { LocalPrecheck } from './features';
import { RemoteBackups, BackupAudit } from './RemoteBackups';
import { WorkbenchReviewPanel } from './WorkbenchReview';
import { PresetShelf, FirstGuide } from './WorkspaceHome';
import { preparePreset, type WorkspacePage } from './workspace-model';
import { TaskHistory } from './TaskHistory';
import { MoreMenu, DeleteEntity } from './EntityActions';
import { BuildEnvironment } from './BuildEnvironment';
import { TargetConfiguration } from './TargetConfiguration';
import { DateRangeFilter } from './DateRangeFilter';
import { withinDateRange, type DateRange } from './date-range';
import { taskProgress, readExpandedTargets, saveExpandedTargets } from './layout-state';
import { EntityWorkspace, EntityDetail, WorkspaceTabs, Disclosure } from './WorkspaceLayout';
import { DiagnosticPanel } from './TaskExtras';
import { TaskView } from './TaskView';
import { AppUpdateSettings } from './AppUpdateSettings';
import type { DiagnosticKind } from './features';
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
  ContainerLogs,
  LockTakeover,
} from './DesktopViews';

type Page = WorkspacePage;
type Dialog =
  | { kind: 'service'; value: Service }
  | { kind: 'server'; value: Server }
  | { kind: 'target'; value: Target; initialTab?: '健康检查' }
  | { kind: 'picker' }
  | { kind: 'confirm'; task: Task; token?: string; returnFocus?: HTMLElement }
  | { kind: 'cancel' }
  | { kind: 'history'; value: History }
  | { kind: 'delete'; entity: 'service' | 'target' | 'server' | 'jdk'; id: string }
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
function LogViewer({ lines, active = true }: { lines: string[]; active?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (active && follow.current && ref.current && !window.getSelection()?.toString())
      ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, active]);
  return (
    <pre
      className="terminal"
      ref={ref}
      onScroll={(e) => {
        if (!active) return;
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
function OldArtifactWarning({ value, service }: { value: Artifact; service: ServiceSnapshot }) {
  if (!value.exists || !(new Date(value.modified) < new Date(service.git.time))) return null;
  return (
    <p className="warning">
      <AlertTriangle size={15} />
      JAR 早于当前 Git 提交，请确认是否需要重新构建。
    </p>
  );
}
function ArtifactInfo({ value, service }: { value: Artifact; service?: ServiceSnapshot }) {
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
      {service && <OldArtifactWarning value={value} service={service} />}
    </div>
  );
}
function Workspace({ boot, initialPage }: { boot?: Startup; initialPage?: Page } = {}) {
  const [loaded] = useState(
    () => boot || (prototype ? loadDatabase() : { database: emptyDatabase(), recovery: undefined }),
  );
  const [db, setDb] = useState<Database>(loaded.database);
  const [recovery, setRecovery] = useState(loaded.recovery);
  const [taskIssues, setTaskIssues] = useState(boot?.taskIssues || []);
  const [legacyReview, setLegacyReview] = useState(!!boot?.dataUsage?.legacy.pending);
  const credentials = useRef(new CredentialSession());
  const [failureOverride, setFailureOverride] = useState<
    Database['settings']['failurePolicy'] | null
  >(null);
  const [page, setPage] = useState<Page>(initialPage || 'deploy');
  useEffect(() => {
    const content = document.querySelector<HTMLElement>('.workspace > main');
    if (content) content.scrollTop = 0;
  }, [page]);
  const [emptyService] = useState(() => newService());
  const [serviceId, setServiceId] = useState(() =>
    db.services.some((s) => s.id === db.lastService) ? db.lastService : db.services[0]?.id || '',
  );
  const [selected, setSelected] = useState<string[]>(() =>
    db.lastTargets.filter((id) =>
      db.targets.some((t) => t.id === id && t.serviceId === serviceId && !t.production),
    ),
  );
  const [build, setBuild] = useState<Task['build']>('rebuild');
  const [overrides, setOverrides] = useState<Record<string, Backup>>({});
  const compactTargets = db.settings.compactTargets ?? true;
  const setCompactTargets = (value: boolean) =>
    setDb((old) => ({ ...old, settings: { ...old.settings, compactTargets: value } }));
  const [expanded, setExpanded] = useState<string[]>(() =>
    readExpandedTargets(boot?.dataDir || 'prototype'),
  );
  useEffect(
    () => saveExpandedTargets(boot?.dataDir || 'prototype', expanded),
    [expanded, boot?.dataDir],
  );
  const [artifact, setArtifact] = useState<Artifact>(() =>
    (desktop ? initialArtifact : artifactFor)(
      db.services.find((s) => s.id === serviceId) || emptyService,
    ),
  );
  const [jarSelection, setJarSelection] = useState<string>();
  const [retrySource, setRetrySource] = useState<{ id: string; path: string }>();
  const [localInfo, setLocalInfo] = useState<(ServiceInfo & { serviceId: string }) | null>(null);
  const [localInfoBusy, setLocalInfoBusy] = useState(false);
  const [localInfoError, setLocalInfoError] = useState('');
  const [infoRefresh, setInfoRefresh] = useState(0);
  const [preflight, setPreflight] = useState<LocalPrecheck | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [deployNote, setDeployNote] = useState<string>();
  const [taskReturnPage, setTaskReturnPage] = useState<Page>('deploy');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [task, setTask] = useState<Task | null>(boot?.task || null);
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState<TrustRequest | undefined>(boot?.pendingTrust);
  const [saved, setSaved] = useState(boot?.savedCredentials || []);
  const [serverChecks, setServerChecks] = useState<
    Record<string, { ok: boolean; time: string; identity: string }>
  >({});
  const serverIdentity = (s: Server) =>
    JSON.stringify([s.host, s.user, s.port, s.auth, s.alias, s.keyPath, s.sshConfigFile]);
  const [unfinished, setUnfinished] = useState(boot?.unfinished || []);
  const [observations, setObservations] = useState<
    { targetId: string; label: string; sessionId: string; active: boolean }[]
  >([]);
  const [observationOverrides, setObservationOverrides] = useState<
    Record<string, { enabled: boolean; duration: number }>
  >({});
  const [nativeDialog, setNativeDialog] = useState<{
    title: string;
    content?: string;
    server?: Server;
    recover?: Task;
    logs?: string;
    logSession?: string;
    lockTarget?: string;
    workbenchTarget?: string;
    workbench?: import('./features').WorkbenchReview;
    diagnostic?: { target?: Target; server: Server; kind?: DiagnosticKind };
    lock?: { token: string; owner: string; created: number; stale: boolean; message: string };
  } | null>(null);
  const [backupTarget, setBackupTarget] = useState<Target>();
  const [backupAudit, setBackupAudit] = useState<import('./features').MaintenanceRecord>();
  const [taskRows, setTaskRows] = useState<TaskSummary[]>([]);
  const [inspected, setInspected] = useState(-1);
  const viewedTarget = Math.max(0, Math.min(inspected < 0 ? task?.active ?? 0 : inspected, (task?.targets.length || 1) - 1));
  const [message, setMessage] = useState('');
  const [storageError, setStorageError] = useState('');
  const [historyFilter, setHistoryFilter] = useState('all');
  const [historyService, setHistoryService] = useState('all');
  const [historyServer, setHistoryServer] = useState('all');
  const [historyEnv, setHistoryEnv] = useState('all');
  const [historyDate, setHistoryDate] = useState<DateRange>({ from: '', to: '' });
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const recorded = useRef(new Set<string>());
  const service = db.services.find((s) => s.id === serviceId) || emptyService;
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
        void desktop!
          .save(db)
          .then(() => setStorageError(''))
          .catch((e) => setStorageError(String(e)));
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
        setTaskIssues(value.taskIssues || []);
      });
    };
    refresh();
    return desktop!.onEvent((event) => {
      if (event.kind === 'maintenance') refresh();
      if (event.kind === 'task') {
        setTask(event.task);
        if (!['running', 'cancelling'].includes(event.task.status)) {
          refresh();
          setInfoRefresh((n) => n + 1);
        }
      } else if (event.kind === 'observation') {
        setObservations((old) => [
          ...old.filter((s) => s.sessionId !== event.sessionId),
          { ...event, active: true },
        ]);
        setNativeDialog(
          (old) =>
            old || {
              title: '部署后观察 · ' + event.label,
              logs: event.targetId,
              logSession: event.sessionId,
            },
        );
      } else if (event.kind === 'observation-error') {
        notify(event.message);
      } else if (event.kind === 'container-log' && event.active === false) {
        setObservations((old) =>
          old.map((s) => (s.sessionId === event.id ? { ...s, active: false } : s)),
        );
      } else if (event.kind === 'open-task') {
        void desktop!.readTask(event.taskId).then((value) => {
          setTask(value);
          setTaskReturnPage('history');
          setPage('task');
        });
      } else if (event.kind === 'database') setDb((old) => mergedDatabase(old, event.database));
      else if (event.kind === 'trust') setTrust(event.request);
      else if (event.kind === 'trust-closed')
        setTrust((old) => (old?.id === event.id ? undefined : old));
    });
  }, []);
  useEffect(() => {
    if (!desktop || recovery || !db.services.length || page !== 'deploy') return;
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
  const preflightKey = JSON.stringify([
    service,
    db.jdks,
    chosen,
    db.servers,
    saved,
    build,
    jarSelection,
    infoRefresh,
  ]);
  useEffect(() => {
    if (!desktop || recovery || !db.services.length || page !== 'deploy' || isActive(task)) return;
    let alive = true;
    setPreflight(null);
    setPreflightBusy(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          await desktop!.save(db);
          const result = await desktop!.precheck({
            serviceId,
            targetIds: chosen.map((t) => t.id),
            build,
            jarPath: jarSelection,
          });
          if (alive) setPreflight(result);
        } catch (e) {
          if (alive)
            setPreflight({
              checkedAt: new Date().toISOString(),
              items: [
                {
                  key: 'check',
                  label: '本机预检',
                  state: 'fail',
                  reason: String(e),
                  blocking: true,
                },
              ],
            });
        } finally {
          if (alive) setPreflightBusy(false);
        }
      })();
    }, 180);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [preflightKey, page, recovery, task?.status]);
  const invalidObservation = chosen.find((t) => {
    const v = observationOverrides[t.id] || t.observation;
    return (
      v?.enabled &&
      (!Number.isInteger(v.duration) ||
        v.duration < 10 ||
        v.duration > 3600 ||
        (t.mode === 'jar' && !t.appLogPath))
    );
  });
  const blockReason =
    desktop && !isActive(task)
      ? (taskIssues.length ? '有任务元数据无法读取，请先检查数据目录中的数据库备份。' : '') ||
        deploymentBlockReason(preflight, preflightBusy, chosen.length) ||
        (invalidObservation
          ? invalidObservation.name +
            ' 的日志观察配置不完整，请检查应用日志路径和 10–3600 秒的观察时间。'
          : '')
      : '';
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
        setServiceId(data.services[0]?.id || '');
        setSelected([]);
        setOverrides({});
        setArtifact(initialArtifact(data.services[0] || emptyService));
        setJarSelection(undefined);
        setLocalInfo(null);
        setInfoRefresh((n) => n + 1);
      }
    });
  }
  function selectService(id: string) {
    const s = db.services.find((s) => s.id === id);
    if (!s) return;
    setRetrySource(undefined);
    setDeployNote(undefined);
    setObservationOverrides({});
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
      if (page !== 'task') setTaskReturnPage(page);
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
    // 异步准备会暂时禁用发起按钮，先保留关闭确认弹窗后应恢复的焦点。
    const returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (desktop) {
      setBusy(true);
      try {
        await desktop!.save(db);
        const result = await desktop!.prepare({
          serviceId: rollback?.service.id || serviceId,
          targetIds: targetList.map((t) => t.id),
          build,
          jarPath: rollback ? undefined : artifact.path || undefined,
          overrides,
          failurePolicy: failureOverride ?? db.settings.failurePolicy,
          historyId: rollback?.id,
          dryRun,
          note: deployNote ?? displayService.git.message ?? '',
          observationOverrides,
          retryOf:
            !rollback && build === 'existing' && retrySource?.path === artifact.path
              ? retrySource.id
              : undefined,
        });
        setDialog({ kind: 'confirm', ...result, returnFocus });
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
    setDialog({ kind: 'confirm', task: prepared, returnFocus });
  }
  function canRollback(h: History) {
    return rollbackAllowed(db, h);
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
  async function repeatTask(dryRun: boolean) {
    if (!task || !desktop || isActive(task)) return;
    setBusy(true);
    try {
      await desktop.save(db);
      const result = await desktop.prepare({
        serviceId: task.service.id,
        targetIds: task.targets.map((r) => r.target.id),
        build: task.build,
        jarPath: task.build === 'existing' ? task.artifact.path : undefined,
        overrides: Object.fromEntries(task.targets.map((r) => [r.target.id, r.backup])),
        failurePolicy: task.failurePolicy,
        note: task.note,
        dryRun,
        observationOverrides: Object.fromEntries(
          task.targets
            .filter((r) => r.target.observation)
            .map((r) => [r.target.id, r.target.observation!]),
        ),
      });
      selectService(task.service.id);
      setSelected(task.targets.map((r) => r.target.id));
      setBuild(task.build);
      setOverrides(Object.fromEntries(task.targets.map((r) => [r.target.id, r.backup])));
      setFailureOverride(task.failurePolicy);
      setDeployNote(task.note);
      setPage('deploy');
      setDialog({ kind: 'confirm', ...result });
    } catch (e) {
      setNativeDialog({ title: '部署准备失败', content: String(e) });
    } finally {
      setBusy(false);
    }
  }
  async function retry(onlyFailed: boolean) {
    if (!task) return;
    let snapshotPath = task.artifact.path;
    if (desktop) {
      const availability: SnapshotAvailability = await desktop
        .snapshotAvailability(task.id)
        .catch((e) => ({ available: false, reason: String(e) }));
      if (!availability.available) {
        return availability;
      }
      snapshotPath = availability.path || snapshotPath;
    }
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
    setArtifact({ ...task.artifact, path: snapshotPath });
    setJarSelection(snapshotPath);
    if (desktop) setRetrySource({ id: task.id, path: snapshotPath });
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
  function entityRemovalReason(entity: 'service' | 'target' | 'server' | 'jdk', id: string) {
    if (isActive(task)) return '任务执行或取消中，不能删除配置。';
    if (
      unfinished.some((t) =>
        entity === 'service'
          ? t.service.id === id
          : entity === 'jdk'
            ? t.service.jdk === id
            : t.targets.some((r) =>
                entity === 'target' ? r.target.id === id : r.server.id === id,
              ),
      )
    )
      return '有未处理的中断任务引用此配置，请先核实结果。';
    return entity === 'server' || entity === 'jdk' ? deletionReason(db, entity, id) : '';
  }
  async function removeEntity(entity: 'service' | 'target' | 'server' | 'jdk', id: string) {
    const reason = entityRemovalReason(entity, id);
    if (reason) throw new Error(reason);
    const removed = new Set(
      db.targets
        .filter((t) =>
          entity === 'service' ? t.serviceId === id : entity === 'target' && t.id === id,
        )
        .map((t) => t.id),
    );
    const services = entity === 'service' ? db.services.filter((s) => s.id !== id) : db.services,
      current = services.find((s) => s.id === serviceId) || services[0];
    const next = {
      ...db,
      services,
      targets: db.targets.filter((t) => !removed.has(t.id)),
      servers: entity === 'server' ? db.servers.filter((s) => s.id !== id) : db.servers,
      jdks: entity === 'jdk' ? db.jdks.filter((j) => j.name !== id) : db.jdks,
      presets: (db.presets || [])
        .filter((p) => entity !== 'service' || p.serviceId !== id)
        .map((p) => ({ ...p, targetIds: p.targetIds.filter((tid) => !removed.has(tid)) })),
      lastService: current?.id || '',
      lastTargets: db.lastTargets.filter((tid) => !removed.has(tid)),
    };
    if (desktop) await desktop.save(next);
    if (!services.length) {
      window.location.reload();
      return;
    }
    setDb(next);
    setServiceId(current.id);
    setSelected((old) => old.filter((tid) => !removed.has(tid)));
    setArtifact((desktop ? initialArtifact : artifactFor)(current));
    setDialog(null);
    notify('配置已删除，历史和远程文件保留');
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
  const serviceActions = (s: Service) => (
    <div className="entity-actions">
      <MoreMenu
        label={'更多服务' + s.name + '操作'}
        actions={[
          {
            label: '配置目标',
            onClick: () => {
              selectService(s.id);
              setPage('targets');
            },
          },
          {
            label: '复制服务',
            onClick: () => setDialog({ kind: 'service', value: cloneService(s) }),
          },
          {
            label: '删除服务',
            disabled: !!entityRemovalReason('service', s.id),
            reason: entityRemovalReason('service', s.id),
            destructive: true,
            onClick: () => setDialog({ kind: 'delete', entity: 'service', id: s.id }),
          },
        ]}
      />
      <button className="button" onClick={() => setDialog({ kind: 'service', value: s })}>
        编辑
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
    </div>
  );
  const targetActions = (t: Target) => (
    <div className="entity-actions">
      <MoreMenu
        label={'更多目标' + t.name + '操作'}
        actions={[
          {
            label: '复制目标',
            onClick: () => setDialog({ kind: 'target', value: cloneTarget(t) }),
          },
          ...(desktop
            ? [
                {
                  label: '查看并清理远程备份',
                  onClick: () => setBackupTarget(t),
                },
                {
                  label: '只读诊断',
                  onClick: () =>
                    setNativeDialog({
                      title: t.name + ' · 只读诊断',
                      diagnostic: {
                        target: t,
                        server: db.servers.find((s) => s.id === t.serverId)!,
                      },
                    }),
                },
                {
                  label: '核实远程工作台',
                  disabled: isActive(task),
                  reason: isActive(task) ? '请先等待当前任务结束' : undefined,
                  onClick: () =>
                    setNativeDialog({
                      title: t.name + ' · 核实远程工作台',
                      server: db.servers.find((s) => s.id === t.serverId),
                      workbenchTarget: t.id,
                    }),
                },
                {
                  label: '检查或接管任务锁',
                  disabled: isActive(task),
                  reason: isActive(task) ? '任务执行中不能接管锁' : undefined,
                  onClick: () =>
                    setNativeDialog({
                      title: t.name + ' · 检查任务锁',
                      server: db.servers.find((s) => s.id === t.serverId),
                      lockTarget: t.id,
                    }),
                },
              ]
            : []),
          {
            label: '删除目标',
            disabled: !!entityRemovalReason('target', t.id),
            reason: entityRemovalReason('target', t.id),
            destructive: true,
            onClick: () => setDialog({ kind: 'delete', entity: 'target', id: t.id }),
          },
        ]}
      />
      <button className="button" onClick={() => setDialog({ kind: 'target', value: t })}>
        <Pencil size={15} />
        编辑目标
      </button>
      <button
        className="button primary"
        onClick={() => {
          selectService(t.serviceId);
          setSelected([t.id]);
          setPage('deploy');
        }}
      >
        去部署
      </button>
    </div>
  );
  const serverActions = (s: Server) => (
    <div className="entity-actions">
      <button
        className="button"
        aria-label={'编辑服务器' + s.name}
        onClick={() => setDialog({ kind: 'server', value: s })}
      >
        <Pencil size={15} />
        编辑
      </button>
      <MoreMenu
        label={'更多服务器' + s.name + '操作'}
        actions={[
          ...(desktop && s.auth === 'alias'
            ? [
                {
                  label: '查看 SSH 最终地址',
                  onClick: () =>
                    void nativeAction(async () => {
                      await desktop!.save(db);
                      const parsed = await desktop!.resolveAlias(s.id);
                      setNativeDialog({
                        title: s.name + ' · SSH Config 最终地址',
                        content:
                          '系统 SSH 解析后的连接地址，仅用于核对，不会修改配置：\n' +
                          parsed.user +
                          '@' +
                          parsed.host +
                          ':' +
                          parsed.port,
                      });
                    }),
                },
              ]
            : []),
          ...(desktop
            ? [
                {
                  label: '服务器体检（只读）',
                  onClick: () =>
                    setNativeDialog({
                      title: s.name + ' · 服务器体检',
                      diagnostic: { server: s },
                    }),
                },
              ]
            : []),
          {
            label: '删除服务器',
            disabled: !!entityRemovalReason('server', s.id),
            reason: entityRemovalReason('server', s.id),
            destructive: true,
            onClick: () => setDialog({ kind: 'delete', entity: 'server', id: s.id }),
          },
        ]}
      />{' '}
      <button
        className="button primary"
        onClick={() =>
          desktop
            ? setNativeDialog({ title: '测试连接 · ' + s.name, server: s })
            : notify('原型未发起连接。正式版将展示主机指纹及认证结果。')
        }
      >
        测试连接
      </button>
    </div>
  );
  const cardTime = (value?: string) => (deploymentTime(value) ? fmtTime(value!).slice(5, 16) : '—');
  const serviceLastDeploy = (id: string) =>
    db.targets
      .filter((t) => t.serviceId === id && deploymentTime(t.lastDeploy))
      .map((t) => t.lastDeploy)
      .sort()
      .at(-1) ||
    db.history.find(
      (h) =>
        h.service.id === id &&
        ['success', 'unverified', 'rolledback'].includes(h.status) &&
        deploymentTime(h.time),
    )?.time;
  const header = (title: string, description: string, action?: ReactNode) => (
    <header className="page-header">
      <div>
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
      withinDateRange(h.time.slice(0, 10), historyDate),
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
                <VersionFacts
                  target={{
                    version: '',
                    currentCommit:
                      h.deployedCommit ||
                      (h.build === 'rebuild' && !h.service.git.dirty
                        ? knownCommit(h.service.git.commit, h.artifact.sha256)
                        : undefined),
                    currentHash: h.artifact.sha256,
                  }}
                  onCopy={(value) => void copy(value)}
                />
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
  async function loadPreset(p: import('./model').Preset) {
    if (isActive(task) || busy) {
      notify('请先等待当前操作结束');
      return;
    }
    setBusy(true);
    try {
      if (!desktop) {
        selectService(p.serviceId);
        setSelected(p.targetIds);
        setBuild(p.build);
        setOverrides(p.overrides);
        setFailureOverride(p.failurePolicy);
        setPage('deploy');
        return;
      }
      const prepared = await preparePreset(desktop, db, p);
      selectService(p.serviceId);
      setSelected(p.targetIds);
      setBuild(p.build);
      setOverrides(p.overrides);
      setFailureOverride(p.failurePolicy);
      setArtifact(prepared.task.artifact);
      setPage('deploy');
      setDialog({ kind: 'confirm', ...prepared });
    } catch (e) {
      setNativeDialog({ title: '预设无法载入', content: String(e) });
    } finally {
      setBusy(false);
    }
  }
  const presetShelf = (pinnedOnly = false) => (
    <PresetShelf
      db={db}
      choice={
        page === 'deploy' && db.services.length
          ? {
              serviceId,
              targetIds: selected,
              build,
              overrides,
              failurePolicy: failureOverride ?? db.settings.failurePolicy,
            }
          : undefined
      }
      onChange={(presets) => setDb((old) => ({ ...old, presets }))}
      onLoad={(p) => void loadPreset(p)}
      disabled={busy || isActive(task)}
      pinnedOnly={pinnedOnly}
    />
  );
  const changeBackup = (id: string, b: Backup) => setOverrides((old) => ({ ...old, [id]: b }));
  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (desktop && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!desktop || !e.dataTransfer.files.length) return;
        e.preventDefault();
        if (
          document.querySelector('[role="dialog"]') ||
          busy ||
          isActive(task) ||
          !db.services.length
        ) {
          notify('请先结束当前操作并选择服务，再拖入 JAR。');
          return;
        }
        if (e.dataTransfer.files.length !== 1) {
          notify('每次请选择一个 JAR 文件。');
          return;
        }
        const file = e.dataTransfer.files[0];
        void nativeAction(async () => {
          const value = await desktop!.acceptDrop(file);
          setRetrySource(undefined);
          setArtifact(value);
          setJarSelection(value.path);
          setBuild('existing');
          setPage('deploy');
          setInfoRefresh((n) => n + 1);
          notify('已选中 JAR，部署前仍会完整校验。');
        });
      }}
    >
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
        <nav aria-label="主导航">
          <span className="nav-heading">操作</span>
          {nav
            .filter((n) => n.page === 'deploy')
            .map((n) => (
              <button
                key={n.page}
                className={page === n.page ? 'selected' : ''}
                onClick={() => setPage(n.page)}
              >
                <n.icon size={18} />
                {n.name}
              </button>
            ))}
          {isActive(task) && (
            <button className={page === 'task' ? 'selected' : ''}
              onClick={() => {
                if (page !== 'task') setTaskReturnPage(page);
                setInspected(-1);
                setPage('task');
              }}>
              <Loader2 size={18} className="spin" />
              当前任务<small>{task?.status === 'cancelling' ? '取消中' : '执行中'}</small>
            </button>
          )}
          <button
            className={page === 'history' ? 'selected' : ''}
            onClick={() => setPage('history')}
          >
            <HistoryIcon size={18} />
            部署历史
          </button>
          <span className="nav-heading">配置</span>
          {nav
            .filter((n) => !['deploy', 'history'].includes(n.page))
            .map((n) => (
              <button
                key={n.page}
                className={page === n.page ? 'selected' : ''}
                onClick={() => setPage(n.page)}
              >
                <n.icon size={18} />
                {n.name}
              </button>
            ))}
        </nav>
        <div className="sidebar-footer">
          <span className="local-dot" />
          <span>
            本机工作空间<small>数据与安装目录分开保存</small>
          </span>
        </div>
      </aside>
      <div className="workspace">
        <div className="workspace-bar">
          <strong className="row deployment-boundary">
            <ShieldCheck size={16} />
            {desktop ? '真实部署 · 请核对目标' : '界面原型 · 未连接服务器'}
          </strong>
        </div>
        <main>
          {!!taskIssues.length && (
            <div className="warning" role="alert">
              <strong>有任务元数据无法读取，原始数据与相关文件已保留</strong>
              <p>
                暂时不能确定产物共享关系或远端执行结果。请检查数据目录中的数据库备份，修复后重新打开应用；不会用空配置覆盖原数据。
              </p>
              <button className="button" onClick={() => void desktop?.openDataDir()}>
                打开数据目录
              </button>
            </div>
          )}
          {desktop && page !== 'task' && observations.some((s) => s.active) && (
            <div className="notice">
              <strong>部署后日志观察</strong>
              <div className="row wrap mt">
                {observations
                  .filter((s) => s.active)
                  .map((s) => (
                    <button
                      key={s.sessionId}
                      className="button"
                      onClick={() =>
                        setNativeDialog({
                          title: '部署后观察 · ' + s.label,
                          logs: s.targetId,
                          logSession: s.sessionId,
                        })
                      }
                    >
                      {s.label} · 查看或停止
                    </button>
                  ))}
              </div>
            </div>
          )}
          {desktop && page !== 'task' && unfinished.length > 0 && (
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
          {page === 'deploy' && !db.services.length && (
            <>
              {header('一键部署', '添加服务并配置部署目标，或导入已有配置。')}
              <FirstGuide
                db={db}
                tasks={taskRows}
                onPage={setPage}
                onImport={() => void importNative()}
              />
            </>
          )}
          {page === 'deploy' && !!db.services.length && (
            <>
              {header(
                '准备好，发布下一版本',
                '选择服务和目标，确认每次发布的边界。',
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
                      <Badge>{service.jdk || '未选择 JDK'}</Badge>
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
                    {desktop && (
                      <>
                        <p className="build-brief">
                          {service.jdk || '未选择 JDK'} · {toolLabels[service.tool]} ·{' '}
                          {displayService.git.branch} ·{' '}
                          <code title={displayService.git.commit}>
                            {/^[a-f0-9]{7,64}$/i.test(displayService.git.commit)
                              ? displayService.git.commit.slice(0, 7)
                              : '未记录提交'}
                          </code>
                          <span aria-hidden="true"> · </span>
                          JAR：
                          {artifact.exists
                            ? niceSize(artifact.size) + ' · ' + fmtTime(artifact.modified)
                            : '文件不存在或待构建'}
                        </p>
                        {build === 'existing' && (
                          <button className="button" onClick={() => void pickJar()}>
                            <FolderOpen size={16} />
                            选择本地 JAR
                          </button>
                        )}
                      </>
                    )}
                    <details className="build-details">
                      <summary>构建与产物详情</summary>
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
                        <HashValue
                          label="Git 提交"
                          value={displayService.git.commit}
                          onCopy={(value) => void copy(value)}
                        />
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
                    </details>
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
                    <div className="row spread wrap">
                      <Switch
                        label="紧凑目标列表"
                        checked={compactTargets}
                        onChange={setCompactTargets}
                      />
                      {targets.length > 0 && (
                        <button
                          className="link"
                          onClick={() => {
                            const visibleIds = new Set(targets.map((target) => target.id));
                            setExpanded((old) => old.filter((id) => !visibleIds.has(id)));
                            if (!compactTargets) setCompactTargets(true);
                          }}
                        >
                          全部收起
                        </button>
                      )}
                    </div>
                    {targets.map((t) => {
                      const s = db.servers.find((s) => s.id === t.serverId)!;
                      const b = effective(t);
                      const open = expanded.includes(t.id);
                      if (compactTargets && !open)
                        return (
                          <article
                            className={
                              'target-compact ' + (selected.includes(t.id) ? 'checked' : '')
                            }
                            key={t.id}
                          >
                            <label className="compact-choice">
                              <input
                                type="checkbox"
                                checked={selected.includes(t.id)}
                                aria-label={'选择' + t.name}
                                onChange={() => toggleTarget(t)}
                              />
                              <span>
                                <strong title={t.name}>
                                  {t.name}
                                  {t.production ? ' · 正式' : ''}
                                </strong>
                                <small title={s.name}>{s.name}</small>
                              </span>
                            </label>
                            <VersionFacts target={t} onCopy={(value) => void copy(value)} />
                            <span className="compact-health" title={t.healthState}>
                              {t.healthState}
                            </span>
                            <div
                              title={
                                '目标默认：' +
                                (t.backup.enabled ? '备份' : '不备份') +
                                '；' +
                                (overrides[t.id] ? '本次覆盖' : '目标默认')
                              }
                            >
                              <Switch
                                label={t.name + '备份'}
                                checked={b.enabled}
                                onChange={(enabled) => changeBackup(t.id, { ...b, enabled })}
                              />
                            </div>
                            <button
                              className="link"
                              aria-label={'展开' + t.name + '详情'}
                              onClick={() => setExpanded((old) => [...old, t.id])}
                            >
                              详情
                            </button>
                          </article>
                        );
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
                            <VersionFacts
                              target={t}
                              fingerprintFirst
                              onCopy={(value) => void copy(value)}
                            />
                            <span>
                              上次部署<em>{fmtTime(t.lastDeploy)}</em>
                            </span>
                            <span>
                              健康状态<em>{t.healthState}</em>
                            </span>
                          </div>
                          <div className="target-bottom">
                            <Switch
                              label={'本次备份 · ' + t.name}
                              checked={b.enabled}
                              onChange={(enabled) => changeBackup(t.id, { ...b, enabled })}
                              description={'目标默认：' + (t.backup.enabled ? '备份' : '不备份')}
                            />
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
                              {desktop && (
                                <>
                                  <Switch
                                    label="本次成功后观察日志"
                                    disabled={t.mode === 'jar' && !t.appLogPath}
                                    checked={
                                      (observationOverrides[t.id] || t.observation)?.enabled ||
                                      false
                                    }
                                    onChange={(enabled) =>
                                      setObservationOverrides((old) => ({
                                        ...old,
                                        [t.id]: {
                                          duration: (old[t.id] || t.observation)?.duration || 60,
                                          enabled,
                                        },
                                      }))
                                    }
                                    description={
                                      t.mode === 'jar' && !t.appLogPath
                                        ? '启用前需在目标配置中填写应用日志路径。'
                                        : '健康未验证且部署完成时，自动打开只读日志观察。'
                                    }
                                  />
                                  <Field label="本次观察时间（秒）">
                                    <input
                                      type="number"
                                      min="10"
                                      max="3600"
                                      value={
                                        (observationOverrides[t.id] || t.observation)?.duration ??
                                        60
                                      }
                                      onChange={(e) =>
                                        setObservationOverrides((old) => ({
                                          ...old,
                                          [t.id]: {
                                            enabled: (old[t.id] || t.observation)?.enabled || false,
                                            duration: Number(e.target.value),
                                          },
                                        }))
                                      }
                                    />
                                  </Field>
                                  {observationOverrides[t.id] && (
                                    <button
                                      className="link"
                                      onClick={() =>
                                        setObservationOverrides((old) => {
                                          const next = { ...old };
                                          delete next[t.id];
                                          return next;
                                        })
                                      }
                                    >
                                      恢复目标默认观察设置
                                    </button>
                                  )}
                                </>
                              )}

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
                  <Disclosure
                    title="部署预检明细"
                    description="查看本机环境、产物与远端检查状态；阻断原因同时显示在部署按钮下方。"
                  >
                    <PrecheckPanel check={desktop ? preflight : null} pending={preflightBusy} />
                  </Disclosure>
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
                    {desktop && (
                      <details className="deployment-note">
                        <summary>
                          本次备注<span>默认参考最近提交说明</span>
                        </summary>{' '}
                        <Field
                          label="本次内容"
                          hint="默认参考最近一次提交说明，可修改；会写入历史。"
                        >
                          <textarea
                            maxLength={2000}
                            value={deployNote ?? displayService.git.message ?? ''}
                            onChange={(e) => setDeployNote(e.target.value)}
                          />
                        </Field>
                      </details>
                    )}
                    <div className="deploy-actions" aria-label="部署操作">
                      <button
                        className="button primary block"
                        disabled={
                          busy ||
                          !!blockReason ||
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
                          disabled={busy || isActive(task) || !!blockReason || !chosen.length}
                          onClick={() => void launch(chosen, undefined, true)}
                        >
                          试运行（远程只读）
                        </button>
                      )}
                    </div>
                    {blockReason && (
                      <p className="warning" role="status">
                        {blockReason}
                      </p>
                    )}
                    <p className="note">
                      {desktop
                        ? '确认后将构建产物并修改勾选目标；正式环境逐项输入环境名称。'
                        : '当前为界面原型，不执行真实部署。'}
                    </p>
                    {busy && <p role="status">正在检查本地构建环境和产物…</p>}
                  </Card>
                </aside>
              </div>
              <Disclosure title="部署预设" description="保存或载入常用选择，载入后仍需确认。">
                {presetShelf()}
              </Disclosure>
            </>
          )}
          {page === 'services' && (
            <>
              {header('服务管理', '项目、构建环境和产物路径独立配置。')}
              <EntityWorkspace
                actions={
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
                  </button>
                }
                cardActions={serviceActions}
                cardState={(s) => ({
                  good: !!serviceLastDeploy(s.id),
                  label: serviceLastDeploy(s.id) ? '已部署' : '未部署',
                })}
                cardMeta={(s) => (
                  <>
                    <span>{db.targets.filter((t) => t.serviceId === s.id).length} 个目标</span>
                    <time>{cardTime(serviceLastDeploy(s.id))}</time>
                  </>
                )}
                summary={(s) => (
                  <>
                    <span className="path" title={s.root}>
                      {s.root}
                    </span>
                    <span className="tags">
                      <Badge>{s.jdk || '未选择 JDK'}</Badge>
                      <Badge>{toolLabels[s.tool]}</Badge>
                    </span>
                  </>
                )}
                label="服务"
                items={db.services}
                title={(s) => s.name}
                subtitle={(s) => s.description || s.code}
                searchText={(s) => s.code + ' ' + s.root}
              >
                {(s) => (
                  <EntityDetail key={s.id} title={s.name} action={serviceActions(s)}>
                    <p className="muted">{s.description}</p>
                    <p className="path">{s.root}</p>
                    <div className="tags">
                      <Badge>{s.jdk}</Badge>
                      <Badge>{toolLabels[s.tool]}</Badge>
                      {s.workDir && s.workDir !== '.' && <Badge>工作目录：{s.workDir}</Badge>}
                    </div>
                    <p className="code">
                      {s.jarDir}\{s.jarName}
                    </p>
                    <p className="note">
                      {(() => {
                        const last = taskRows.find((r) => r.serviceId === s.id && !r.dryRun);
                        return last
                          ? '上次部署：' + fmtTime(last.started) + ' · ' + taskResult(last)
                          : db.history.find((h) => h.service.id === s.id)
                            ? '上次部署：' + fmtTime(db.history.find((h) => h.service.id === s.id)!.time)
                            : '尚未部署';
                      })()}
                    </p>
                  </EntityDetail>
                )}
              </EntityWorkspace>
            </>
          )}
          {page === 'targets' && (
            <>
              {header('部署目标', '每个服务与服务器的部署关系，都有独立的运行规则。')}
              <EntityWorkspace
                actions={
                  <button
                    className="button primary"
                    disabled={!db.servers.length || !db.services.length}
                    onClick={() => setDialog({ kind: 'target', value: newTarget() })}
                  >
                    <Plus size={17} />
                    添加部署目标
                  </button>
                }
                filters={
                  <div className="target-service-filter">
                    <Field label="筛选服务">
                      <select value={serviceId} onChange={(e) => selectService(e.target.value)}>
                        {db.services.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                }
                cardActions={targetActions}
                cardState={(t) => ({
                  good: !!deploymentTime(t.lastDeploy),
                  label: deploymentTime(t.lastDeploy) ? '已部署' : '未部署',
                })}
                cardMeta={(t) => (
                  <>
                    <span>{t.healthState}</span>
                    <time>{cardTime(t.lastDeploy)}</time>
                  </>
                )}
                summary={(t) => (
                  <>
                    <span className="path" title={remoteJar(t)}>
                      {remoteJar(t)}
                    </span>
                    <span className="tags">
                      <Badge>{modeLabel(t.mode)}</Badge>
                      <Badge kind={t.production ? 'warn' : ''}>{t.production ? '正式' : '非正式'}</Badge>
                    </span>
                  </>
                )}
                key={serviceId}
                label="部署目标"
                items={targets}
                title={(t) => t.name}
                subtitle={(t) => db.servers.find((s) => s.id === t.serverId)?.name || '未关联服务器'}
                searchText={(t) =>
                  [
                    db.services.find((s) => s.id === t.serviceId)?.name,
                    db.servers.find((s) => s.id === t.serverId)?.name,
                    modeLabel(t.mode),
                  ].join(' ')
                }
              >
                {(t) => (
                  <EntityDetail
                    key={t.id}
                    title={
                      <span className="row">
                        {t.name}
                        <Badge kind={t.production ? 'warn' : ''}>{modeLabel(t.mode)}</Badge>
                      </span>
                    }
                    action={targetActions(t)}
                  >
                    <TargetConfiguration
                      target={t}
                      server={db.servers.find((s) => s.id === t.serverId)}
                    />
                  </EntityDetail>
                )}
              </EntityWorkspace>
            </>
          )}
          {page === 'servers' && (
            <>
              {header('服务器', '认证信息集中维护，同一台服务器可关联多个服务。')}
              <EntityWorkspace
                actions={
                  <button
                    className={'button' + (!db.servers.length ? ' primary' : '')}
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
                  </button>
                }
                cardActions={serverActions}
                cardState={(s) => ({
                  good: serverChecks[s.id]?.identity === serverIdentity(s) && serverChecks[s.id].ok,
                  label:
                    serverChecks[s.id]?.identity === serverIdentity(s)
                      ? serverChecks[s.id].ok
                        ? '连接正常'
                        : '检查失败'
                      : '未检查',
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
                        {s.auth === 'alias'
                          ? 'SSH 别名'
                          : s.auth === 'password'
                            ? '密码认证'
                            : '私钥认证'}
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
          )}
          {page === 'tools' && (
            <>
              {header(
                '构建环境',
                '服务分别选择 JDK、工作目录、Maven、Profiles 和构建参数。',
                !desktop && (
                  <button className="button primary" onClick={() => setDialog({ kind: 'jdk' })}>
                    <Plus size={17} />
                    添加 JDK
                  </button>
                ),
              )}
              {desktop ? (
                <BuildEnvironment
                  api={desktop}
                  db={db}
                  onEdit={(value) => setDialog({ kind: 'service', value })}
                  onAdd={() => setDialog({ kind: 'jdk' })}
                  onDelete={(name) => setDialog({ kind: 'delete', entity: 'jdk', id: name })}
                  deletionReason={(name) => entityRemovalReason('jdk', name)}
                  onScan={() =>
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
                                  x.name === j.name ||
                                  x.path.toLowerCase() === j.path.toLowerCase(),
                              ),
                          ),
                        ],
                      }));
                      notify('检测到 ' + found.length + ' 个完整 JDK，已添加未配置项');
                    })
                  }
                />
              ) : (
                <>
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
                    JAVA_HOME 和 PATH 仅注入单次构建进程；不改系统配置。
                  </p>
                </>
              )}
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
              {desktop ? (
                <TaskHistory
                  onMaintenance={setBackupAudit}
                  rows={taskRows}
                  db={db}
                  api={desktop}
                  busy={isActive(task)}
                  onCopy={(value) => void copy(value)}
                  onHistory={(value) => setDialog({ kind: 'history', value })}
                  onOpen={(id, targetId) =>
                    void nativeAction(async () => {
                      const next = await desktop!.readTask(id);
                      setTaskReturnPage('history');
                      setTask(next);
                      setInspected(
                        Math.max(
                          0,
                          next.targets.findIndex((r) => r.target.id === targetId),
                        ),
                      );
                      setPage('task');
                    })
                  }
                />
              ) : (
                <>
                  <div className="filters">
                    <Field label="结果">
                      <select
                        value={historyFilter}
                        onChange={(e) => setHistoryFilter(e.target.value)}
                      >
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
                      <select
                        value={historyServer}
                        onChange={(e) => setHistoryServer(e.target.value)}
                      >
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
                      <DateRangeFilter value={historyDate} onChange={setHistoryDate} />
                    </Field>
                  </div>
                  <Card>{historyTable(filteredHistory)}</Card>
                </>
              )}
            </>
          )}
          {page === 'settings' && (
            <>
              {header(
                '设置',
                desktop ? '默认行为、构建兼容与本机数据。' : '默认行为、构建兼容与原型本地数据。',
              )}
              {desktop ? (
                <WorkspaceTabs
                  label="设置分类"
                  sections={[
                    {
                      id: 'general',
                      label: '外观与提醒',
                      description: '界面偏好和后台任务提醒，修改后自动保存。',
                      content: (
                        <div className="stack">
                          <Card title="界面外观">
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
                          </Card>
                          <Card title="后台提醒">
                            <Switch
                              label="Windows 系统通知"
                              checked={db.settings.notifications !== false}
                              onChange={(notifications) =>
                                setDb((old) => ({
                                  ...old,
                                  settings: { ...old.settings, notifications },
                                }))
                              }
                              description="窗口在后台时，任务完成或失败会提醒，点击通知回到任务。"
                            />
                            <Switch
                              label="通知提示音"
                              checked={db.settings.notificationSound !== false}
                              onChange={(notificationSound) =>
                                setDb((old) => ({
                                  ...old,
                                  settings: { ...old.settings, notificationSound },
                                }))
                              }
                            />
                          </Card>
                        </div>
                      ),
                    },
                    {
                      id: 'deploy',
                      label: '部署与构建',
                      description: '这里设置全局默认值，部署页仍可单次覆盖。',
                      content: (
                        <div className="stack">
                          <Card title="部署默认行为">
                            <div className="settings-fields">
                              <Field label="某个目标失败后">
                                <select
                                  value={db.settings.failurePolicy}
                                  onChange={(e) =>
                                    setDb((old) => ({
                                      ...old,
                                      settings: {
                                        ...old.settings,
                                        failurePolicy: e.target
                                          .value as Database['settings']['failurePolicy'],
                                      },
                                    }))
                                  }
                                >
                                  <option value="stop">停止后续目标</option>
                                  <option value="continue">继续其他目标</option>
                                </select>
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
                            </div>
                          </Card>
                          <Card title="构建兼容性">
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
                          </Card>
                        </div>
                      ),
                    },
                    {
                      id: 'data',
                      label: '数据与存储',
                      description: '查看占用、管理数据位置及保留规则。清理与迁移均需明确确认。',
                      content: (
                        <div className="stack data-storage-sections">
                          <DataSettings
                            section="usage"
                            api={desktop}
                            policy={db.settings.artifactPolicy}
                            onPolicy={(policy) =>
                              setDb((old) => ({
                                ...old,
                                settings: { ...old.settings, artifactPolicy: policy },
                              }))
                            }
                          />
                          <DirectorySettings
                            api={desktop}
                            beforeMigrate={() => desktop!.save(db)}
                            blocked={
                              isActive(task)
                                ? '任务执行或取消中，不能迁移数据目录。'
                                : unfinished.length
                                  ? '有未处理的中断任务，请先核实结果再迁移。'
                                  : undefined
                            }
                            onManage={() =>
                              document
                                .querySelector('.storage-usage')
                                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                            }
                          />
                          <DataSettings
                            section="retention"
                            historyFields={
                              <div className="retention-history">
                                <h3>部署历史</h3>
                                <div className="settings-fields">
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
                                            historyDays: Math.max(
                                              0,
                                              Math.min(3650, Number(e.target.value)),
                                            ),
                                          },
                                        }))
                                      }
                                    />
                                  </Field>
                                </div>
                              </div>
                            }
                            api={desktop}
                            policy={db.settings.artifactPolicy}
                            onPolicy={(policy) =>
                              setDb((old) => ({
                                ...old,
                                settings: { ...old.settings, artifactPolicy: policy },
                              }))
                            }
                          />
                        </div>
                      ),
                    },
                    {
                      id: 'help',
                      label: '配置与帮助',
                      description: '检查软件更新、备份配置或查看使用说明。',
                      content: (
                        <div className="help-settings">
                          <AppUpdateSettings api={desktop} version={boot?.version || '1.5.3'} active={isActive(task)} />
                          <Card className="help-settings-section">
                            <div className="help-section-row">
                              <div>
                                <h2>配置备份</h2>
                                <p className="muted">导出服务、服务器和目标配置，不包含认证口令；完整日志单独保存。</p>
                              </div>
                              <div className="row wrap">
                                <button
                                  className="button"
                                  onClick={() =>
                                    desktop
                                      ? void nativeAction(async () => {
                                          await desktop!.save(db);
                                          await desktop!.exportConfig();
                                        })
                                      : download('deploy-center-config-v3.json', safeConfigJson(db), 'application/json')
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
                            </div>
                          </Card>
                          <Card className="help-settings-section">
                            <h2>帮助与项目</h2>
                            <div className="help-resource-list">
                              <button
                                className="help-resource-row"
                                aria-label="使用说明"
                                disabled={!desktop}
                                onClick={() => void desktop?.help()}
                              >
                                <span className="help-resource-icon">
                                  <BookOpen size={18} />
                                </span>
                                <span className="help-resource-copy">
                                  <strong>使用说明</strong>
                                  <span>配置、部署、回滚与常见问题</span>
                                </span>
                                <ChevronRight size={16} aria-hidden="true" />
                              </button>
                              <a
                                className="help-resource-row"
                                aria-label="查看版本与源码"
                                href="https://github.com/liwl1995/DeployCenter/releases"
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                <span className="help-resource-icon">
                                  <Code2 size={18} />
                                </span>
                                <span className="help-resource-copy">
                                  <strong>版本与源码</strong>
                                  <span>发布记录、安装包与项目源码</span>
                                </span>
                                <ChevronRight size={16} aria-hidden="true" />
                              </a>
                              <button
                                className="help-resource-row"
                                aria-label="关于 YOTOO 部署中心"
                                disabled={!desktop}
                                onClick={() => void desktop?.about()}
                              >
                                <span className="help-resource-icon">
                                  <Info size={18} />
                                </span>
                                <span className="help-resource-copy">
                                  <strong>关于应用</strong>
                                  <span>YOTOO 部署中心 · 本地部署工作台</span>
                                </span>
                                <ChevronRight size={16} aria-hidden="true" />
                              </button>
                            </div>
                          </Card>
                        </div>
                      ),
                    },
                  ]}
                />
              ) : (
                <>
                  {desktop && (
                    <Card title="后台提醒">
                      <Switch
                        label="Windows 系统通知"
                        checked={db.settings.notifications !== false}
                        onChange={(notifications) =>
                          setDb((old) => ({ ...old, settings: { ...old.settings, notifications } }))
                        }
                        description="窗口在后台时，任务完成或失败会提醒，点击通知回到任务。"
                      />
                      <Switch
                        label="通知提示音"
                        checked={db.settings.notificationSound !== false}
                        onChange={(notificationSound) =>
                          setDb((old) => ({
                            ...old,
                            settings: { ...old.settings, notificationSound },
                          }))
                        }
                      />
                    </Card>
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
                              failurePolicy: e.target
                                .value as Database['settings']['failurePolicy'],
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
                  {desktop && (
                    <DataSettings
                      api={desktop}
                      policy={db.settings.artifactPolicy}
                      onPolicy={(policy) =>
                        setDb((old) => ({
                          ...old,
                          settings: { ...old.settings, artifactPolicy: policy },
                        }))
                      }
                    />
                  )}
                  {desktop && (
                    <DirectorySettings
                      api={desktop}
                      beforeMigrate={() => desktop!.save(db)}
                      blocked={
                        isActive(task)
                          ? '任务执行或取消中，不能迁移数据目录。'
                          : unfinished.length
                            ? '有未处理的中断任务，请先核实结果再迁移。'
                            : undefined
                      }
                      onManage={() =>
                        document
                          .querySelector('.storage-usage')
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                      }
                    />
                  )}
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
            </>
          )}
          {page === 'task' && task && (
                <TaskView
                  key={task.id}
                  task={task}
                  inspected={viewedTarget}
                  setInspected={setInspected}
                  backLabel={taskReturnPage === 'history' ? '返回部署历史' : taskReturnPage === 'deploy' ? '返回部署' : '返回'}
                  onBack={() => setPage(taskReturnPage)}
                  onHealth={db.targets.some((target) => target.id === task.targets[viewedTarget]?.target.id) ? () => {
                    const target = db.targets.find((target) => target.id === task.targets[viewedTarget].target.id)!;
                    setDialog({ kind: 'target', value: target, initialTab: '健康检查' });
                  } : undefined}
                  onRecover={desktop && unfinished.some((entry) => entry.id === task.id) ? () =>
                    setNativeDialog({ title: '核实中断任务', recover: task }) : undefined}
                  onObserve={observations.some((entry) => entry.active && entry.targetId === task.targets[viewedTarget]?.target.id) ? () => {
                    const entry = observations.find((entry) => entry.active && entry.targetId === task.targets[viewedTarget].target.id)!;
                    setNativeDialog({ title: '部署后观察 · ' + entry.label, logs: entry.targetId, logSession: entry.sessionId });
                  } : undefined}
                  onBackups={desktop && (task.targets[viewedTarget]?.backup.keepLast || 0) > 0 &&
                    db.targets.some((target) => target.id === task.targets[viewedTarget]?.target.id)
                    ? () => setBackupTarget(db.targets.find((target) => target.id === task.targets[viewedTarget]?.target.id))
                    : undefined}
                  onCancel={() => setDialog({ kind: 'cancel' })}
                  demoMode={prototype && !desktop && db.settings.demoMode}
                  onFailure={(kind) => {
                    setTask((t) => (t ? requestFailure(t, kind) : null));
                    notify('将在当前目标启动或健康检查阶段触发模拟故障。');
                  }}
                  onRetry={retry}
                  onPromote={desktop ? () => void repeatTask(false) : undefined}
                  onRecheck={desktop ? () => void repeatTask(true) : undefined}
                  onDiagnose={(kind) => {
                    const target = db.targets.find(
                      (t) => t.id === task.targets[viewedTarget]?.target.id,
                    );
                    const server = target && db.servers.find((s) => s.id === target.serverId);
                    if (target && server)
                      setNativeDialog({ title: '只读诊断', diagnostic: { target, server, kind } });
                  }}
                  onIdentity={() => setPage('servers')}
                  onReport={
                    desktop
                      ? () => void nativeAction(() => desktop!.exportReport(task.id))
                      : undefined
                  }
                  onRollback={(() => {
                    const h = db.history.find((h) => h.taskId === task.id && h.target.id === task.targets[viewedTarget]?.target.id);
                    const target = h && db.targets.find((entry) => entry.id === h.target.id);
                    return desktop && h && target && rollbackAllowed(db, h) ? () => void launch([target], h) : undefined;
                  })()}
                  onPrepareAgain={(onlyFailed) => {
                    if (!task) return;
                    selectService(task.service.id);
                    setSelected(
                      task.targets
                        .filter((r) => !onlyFailed || failedStatuses.includes(r.status))
                        .map((r) => r.target.id),
                    );
                    setBuild('rebuild');
                    setRetrySource(undefined);
                    setPage('deploy');
                  }}
                  onCopy={copy}
                  onLog={(text) =>
                    desktop
                      ? setNativeDialog({
                          title: '应用日志',
                          logs: task.targets[viewedTarget].target.id,
                        })
                      : setDialog({
                          kind: 'history',
                          value: {
                            id: 'logs',
                            taskId: task.id,
                            operation: task.operation,
                            service: snapshotService(task.service),
                            target: snapshotTarget(task.targets[viewedTarget].target),
                            server: snapshotServer(task.targets[viewedTarget].server),
                            artifact: task.artifact,
                            build: task.build,
                            status: task.targets[viewedTarget].status,
                            time: task.started,
                            elapsed: task.elapsed,
                            logs: [text],
                            backupCreated: false,
                            steps: [],
                          },
                        })
                  }
                />
          )}
        </main>
        <footer className="workspace-footer" aria-label="应用状态">
          <span className="footer-version">
            {desktop ? 'v' + (boot?.version || '1.5.3') : '界面原型 v0.3'}
          </span>
          <button
            className="footer-directory"
            title={boot?.dataDir || '浏览器本地数据'}
            disabled={!desktop}
            onClick={() => void desktop?.openDataDir()}
          >
            数据目录：{boot?.dataDir || '浏览器本地数据'}
          </button>
          <button
            className="footer-task"
            disabled={!task}
            onClick={() => {
              if (page !== 'task') setTaskReturnPage(page);
              setPage('task');
            }}
            title={task?.service.name}
          >
            {task
              ? task.service.name + ' · ' + taskResult(task) + ' · ' + taskProgress(task) + '%'
              : '当前无任务'}
          </button>
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
      {desktop && backupTarget && (
        <RemoteBackups
          api={desktop}
          target={backupTarget}
          server={db.servers.find((s) => s.id === backupTarget.serverId)!}
          onClose={() => setBackupTarget(undefined)}
        />
      )}
      {backupAudit && (
        <Modal title="备份清理详情" onClose={() => setBackupAudit(undefined)} wide>
          <BackupAudit value={backupAudit} />
          <div className="modal-actions">
            <button className="button" onClick={() => setBackupAudit(undefined)}>
              返回
            </button>
          </div>
        </Modal>
      )}
      {desktop && legacyReview && boot?.dataUsage && (
        <LegacyArtifactReview
          api={desktop}
          usage={boot.dataUsage}
          onClose={() => setLegacyReview(false)}
        />
      )}
      {dialog?.kind === 'service' && (
        <Modal title="服务与构建配置" onClose={() => setDialog(null)} wide>
          <ServiceForm
            initial={dialog.value}
            db={db}
            onClose={() => setDialog(null)}
            onSave={(s) => {
              const apply = () => {
                setDb((old) => ({ ...old, services: upsert(old.services, s) }));
                if (s.id === serviceId || !db.services.length) {
                  setServiceId(s.id);
                  setArtifact((desktop ? initialArtifact : artifactFor)(s));
                  setJarSelection(undefined);
                  setLocalInfo(null);
                  setInfoRefresh((n) => n + 1);
                }
                setDialog(null);
                notify('服务配置已保存');
              };
              if (desktop && !db.services.length)
                void nativeAction(async () => {
                  await desktop!.save({ ...db, services: [s], lastService: s.id });
                  apply();
                });
              else apply();
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
            onTestResult={(server, result) =>
              setServerChecks((old) => ({
                ...old,
                [server.id]: { ok: result.ok, time: result.time, identity: serverIdentity(server) },
              }))
            }
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
            initialTab={dialog.initialTab}
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
        <Confirm
          task={dialog.task}
          returnFocus={dialog.returnFocus}
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
            if (page !== 'task') setTaskReturnPage(page);
            setInspected(-1);
            setPage('task');
            setDialog(null);
          }}
        />
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
        <DeleteEntity
          key={dialog.entity + dialog.id}
          name={
            dialog.entity === 'service'
              ? db.services.find((s) => s.id === dialog.id)?.name || ''
              : dialog.entity === 'target'
                ? db.targets.find((t) => t.id === dialog.id)?.name || ''
                : dialog.entity === 'server'
                  ? db.servers.find((s) => s.id === dialog.id)?.name || ''
                  : dialog.id
          }
          kind={{ service: '服务', target: '目标', server: '服务器', jdk: 'JDK' }[dialog.entity]}
          hasHistory={
            dialog.entity === 'service'
              ? taskRows.some((t) => t.serviceId === dialog.id) ||
                db.history.some((h) => h.service.id === dialog.id)
              : dialog.entity === 'target'
                ? taskRows.some((t) => t.targets?.some((r) => r.id === dialog.id)) ||
                  db.history.some((h) => h.target.id === dialog.id)
                : dialog.entity === 'server'
                  ? taskRows.some((t) => t.targets?.some((r) => r.serverId === dialog.id)) ||
                    db.history.some((h) => h.server.id === dialog.id)
                  : taskRows.length > 0 || db.history.length > 0
          }
          reason={entityRemovalReason(dialog.entity, dialog.id)}
          description={
            dialog.entity === 'service'
              ? '同时移除该服务关联的目标和部署预设；共享服务器继续保留。'
              : '仅移除所选配置。'
          }
          onClose={() => setDialog(null)}
          onDelete={() => removeEntity(dialog.entity, dialog.id)}
        />
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
          {nativeDialog.workbench && (
            <WorkbenchReviewPanel
              key={nativeDialog.workbench.token}
              review={nativeDialog.workbench}
              onDone={(result) => {
                setNativeDialog(null);
                notify(result);
                void desktop!.load().then((state) => setUnfinished(state.unfinished)).catch(() => {});
                void desktop!.listTasks().then(setTaskRows).catch(() => {});
              }}
            />
          )}
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
          {nativeDialog.diagnostic && (
            <DiagnosticPanel
              api={desktop!}
              {...nativeDialog.diagnostic}
              initial={nativeDialog.diagnostic.kind}
              saved={saved}
            />
          )}
          {nativeDialog.logs && (
            <ContainerLogs
              key={nativeDialog.logs + (nativeDialog.logSession || '')}
              targetId={nativeDialog.logs}
              initialSession={nativeDialog.logSession}
            />
          )}
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
              label={
                nativeDialog.recover
                  ? '核实原任务'
                  : nativeDialog.workbenchTarget
                    ? '读取远程工作台'
                    : '测试连接'
              }
              onSubmit={async (values) => {
                if (nativeDialog.server && nativeDialog.workbenchTarget) {
                  const workbench = await desktop!.inspectWorkbench(
                    nativeDialog.workbenchTarget,
                    values[nativeDialog.server.id],
                  );
                  setNativeDialog({ title: nativeDialog.title, workbench });
                } else if (nativeDialog.server && nativeDialog.lockTarget) {
                  const lock = await desktop!.inspectLock(
                    nativeDialog.lockTarget,
                    values[nativeDialog.server.id],
                  );
                  setNativeDialog({ title: '检查陈旧任务锁', lock });
                } else if (nativeDialog.server) {
                  const server = nativeDialog.server;
                  try {
                    const content = await desktop!.testConnection(server.id, values[server.id]);
                    setServerChecks((old) => ({
                      ...old,
                      [server.id]: {
                        ok: true,
                        time: new Date().toISOString(),
                        identity: serverIdentity(server),
                      },
                    }));
                    setNativeDialog({ title: '连接结果', content });
                  } catch (e) {
                    setServerChecks((old) => ({
                      ...old,
                      [server.id]: {
                        ok: false,
                        time: new Date().toISOString(),
                        identity: serverIdentity(server),
                      },
                    }));
                    throw e;
                  }
                } else {
                  setTask(await desktop!.recover(nativeDialog.recover!.id, values));
                  if (page !== 'task') setTaskReturnPage(page);
                  setInspected(-1);
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
  returnFocus,
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
  returnFocus?: HTMLElement;
}) {
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
    s.auth === 'password' &&
    !(desktop && s.credentialMode === 'windows' && saved.includes(s.id));
  const firstPassword = servers.find(needsPassword);
  const title = initial.dryRun
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
        <button
          className="button"
          data-autofocus={(!production && !firstPassword && !degraded) || undefined}
          onClick={onClose}
        >
          返回检查
        </button>
        <button
          data-confirm
          className="button primary"
          disabled={
            starting ||
            (production && (desktop ? !confirmProduction(initial, names) : word !== 'DEPLOY')) ||
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
              await onStart(task, credentials, {
                productionWord: word,
                productionNames: names,
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
      </div>
    </>
  );
  return (
    <Modal title={title} onClose={onClose} wide footer={actions} returnFocus={returnFocus}>
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
      <p className="confirm-brief">
        {initial.targets.length} 个目标 · {initial.artifact.name} ·{' '}
        {initial.failurePolicy === 'stop' ? '失败后停止后续目标' : '失败后继续其他目标'}
      </p>
      {initial.note && <p className="note">本次内容：{initial.note}</p>}
      <OldArtifactWarning value={initial.artifact} service={initial.service} />
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
              <h3>{r.target.name}</h3>
              <Badge kind={r.target.production ? 'warn' : ''}>
                {r.target.production && '正式 · '}
                {modeLabel(r.target.mode)}
              </Badge>
            </div>
            <p className="muted">
              {r.server.name} · {serverAddress(r.server)}
            </p>
            <p className="path">远程文件：{remoteJar(r.target)}</p>
            {initial.operation === 'deploy' &&
              initial.artifact.sha256 &&
              initial.artifact.sha256 === r.target.currentHash && (
                <p className="warning">
                  与线上相同：JAR 指纹一致，仍可继续部署以重新启动。
                  {initial.build === 'rebuild' ? '本次重新构建后会再次校验产物。' : ''}
                </p>
              )}
            {initial.operation === 'deploy' &&
              (r.backup.enabled ? (
                <p className="muted">
                  {r.target.hasOldJar
                    ? r.backup.autoRollback
                      ? '备份并自动回滚'
                      : '备份，失败后手动恢复'
                    : '首次部署无旧 JAR，跳过备份'}
                </p>
              ) : (
                <p className="warning">不备份：无法依赖本次备份自动恢复。</p>
              ))}
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
            {r.target.createDirectory && (
              <p className="warning">已允许创建缺失目录：{r.target.directory}</p>
            )}
          </div>
        ))}
      </div>
      <p className="note">
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
            data-autofocus={(!production && !firstPassword) || undefined}
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
              data-autofocus={(!production && firstPassword?.id === s.id) || undefined}
              autoComplete="off"
              value={credentials[s.id] || ''}
              onChange={(e) => setCredentials((old) => ({ ...old, [s.id]: e.target.value }))}
            />
          </Field>
        </div>
      ))}
      {production && desktop && (
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
      {production && !desktop && (
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
          <HashValue
            label="Git 提交"
            value={initial.service.git.commit}
            onCopy={(value) => {
              void navigator.clipboard.writeText(value);
            }}
          />
        </p>
      </Disclosure>
    </Modal>
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
      {h.cleanupWarning && <p className="warning">{h.cleanupWarning}</p>}
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

/** 首次配置与日常工作共用同一外壳，空配置不生成示例服务器。 */
export default function App({ boot }: { boot?: Startup } = {}) {
  return <Workspace boot={boot} />;
}
