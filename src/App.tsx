import { ReleaseSchedules } from './ReleaseSchedules';
import type { ReleaseSchedule } from './schedules';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Rocket,
  Activity,
  Box,
  CalendarClock,
  ChevronDown,
  Settings as SettingsIcon,
  Server as ServerIcon,
  Wrench,
  History as HistoryIcon,
  SlidersHorizontal,
  Plus,
  AlertTriangle,
  ArrowLeft,
  RotateCcw,
  X,
  Download,
  ChevronRight,
  GitBranch,
  FileArchive,
  Pencil,
  Loader2,
  FolderOpen,
  Container,
  ScrollText,
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
import { copyText } from './clipboard';
import { createTask, startTask, tick, cancelTask, requestFailure } from './engine';
import { recordTask, pruneHistory, canRollback as rollbackAllowed, historyLogs } from './records';
import { CredentialSession, credentialServers } from './credentials';
import { Badge, Card, Field, FieldHelp, Switch, Modal, Demo, download, hasOpenModal } from './ui';
import { ServiceForm, ServerForm, TargetForm, BackupFields } from './forms';
import './style.css';
import { LegacyArtifactReview } from './DataSettings';
import { SettingsWorkspace, settingsLabels, type SettingsSection } from './SettingsWorkspace';
import { TutorialGuide } from './TutorialGuide';
import { desktopPreferenceDefaults } from './desktop-preferences';
import { newerVersion } from './app-update';
import { applyDocumentTheme } from './document-theme';
import { LogWrapContext } from './log-wrap';
import type { SnapshotAvailability } from './features';
import {
  confirmProduction,
  productionNames,
  knownCommit,
  healthLabels,
  deploymentTime,
  cloneService,
  cloneTarget,
  deletionReason,
} from './presentation';
import { deploymentBlockReason, HashValue, PrecheckPanel, VersionFacts } from './DeployDetails';
import type { LocalPrecheck } from './features';
import { RemoteBackups, BackupAudit } from './RemoteBackups';
import { WorkbenchReviewPanel } from './WorkbenchReview';
import { PresetShelf, EmptyServiceWorkspace } from './WorkspaceHome';
import { preparePreset, type WorkspacePage } from './workspace-model';
import { TaskHistory, type HistoryViewState } from './TaskHistory';
import { useWorkspaceNavigation } from './workspace-navigation';
import { MoreMenu, DeleteEntity } from './EntityActions';
import { BuildEnvironment, useBuildEnvironmentChecks } from './BuildEnvironment';
import { ServersWorkspace, serverIdentity } from './ServersWorkspace';
import { TargetsWorkspace } from './TargetsWorkspace';
import { ServicesWorkspace } from './ServicesWorkspace';
import { DateRangeFilter } from './DateRangeFilter';
import { withinDateRange, type DateRange } from './date-range';
import { taskProgress, readExpandedTargets, saveExpandedTargets } from './layout-state';
import { Disclosure } from './WorkspaceLayout';
import { DiagnosticPanel } from './TaskExtras';
import { TaskView } from './TaskView';
import type { DiagnosticKind } from './features';
import { AppPageHeader } from './design/shell/AppPageHeader';
import { ServiceSidebar } from './design/shell/ServiceSidebar';
import { sidebarServices } from './sidebar-services';
import { Button } from './design/ui/button';
import { HoverTip } from './design/ui/hover-tip';
import { Checkbox } from './design/ui/checkbox';
import { PageTabs } from './design/ui/page-tabs';
import { BuildArtifactChoice } from './BuildArtifactChoice';
import { SegmentedControl } from './design/ui/segmented-control';
import { CompactStatus } from './compact-list';
import { workspacePages } from './workspace-model';
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
  LockTakeover,
} from './DesktopViews';
import { OnlineLogsWorkspace } from './OnlineLogsWorkspace';
import { OperationsWorkspace } from './OperationsWorkspace';
import type { OperationStatus } from './operations';

type Page = WorkspacePage;
const fixture = prototype && !desktop;
type Dialog =
  | { kind: 'service'; value: Service }
  | { kind: 'server'; value: Server }
  | { kind: 'target'; value: Target; initialTab?: '健康检查' }
  | { kind: 'picker' | 'presets' }
  | { kind: 'confirm'; task: Task; token?: string; returnFocus?: HTMLElement; schedule?: boolean; plan?: ReleaseSchedule; reschedule?: boolean }
  | { kind: 'cancel' }
  | { kind: 'history'; value: History }
  | { kind: 'delete'; entity: 'service' | 'target' | 'server' | 'jdk'; id: string }
  | { kind: 'jdk' }
  | null;
const nav = [
  { page: 'deploy', name: '一键部署', icon: Rocket },
  { page: 'targets', name: '部署目标', icon: SlidersHorizontal },
  { page: 'servers', name: '服务器', icon: ServerIcon },
  { page: 'tools', name: '构建环境', icon: Wrench },
  { page: 'history', name: '部署历史', icon: HistoryIcon },
] as const;
const ImageWorkspace = lazy(() => import('./ImageWorkspace').then((module) => ({ default: module.ImageWorkspace })));
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
        {fixture ? '模拟任务日志 · 未连接服务器' : '执行日志'}
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
function ConfirmWarning({ label, text }: { label: string; text: string }) {
  return (
    <HoverTip content={<span className="confirm-warning-text">{text}</span>} disableHoverableContent>
      <Button type="button" size="icon-compact" className="confirm-warning-icon" aria-label={label}>
        <AlertTriangle size={15} aria-hidden="true" />
      </Button>
    </HoverTip>
  );
}

function OldArtifactWarning({ value, service, compact }: { value: Artifact; service: ServiceSnapshot; compact?: boolean }) {
  if (!value.exists || !(new Date(value.modified) < new Date(service.git.time))) return null;
  const text = 'JAR 早于当前 Git 提交，请确认是否需要重新构建。';
  if (compact) return <ConfirmWarning label="产物版本提示" text={text} />;
  return (
    <p className="warning">
      <AlertTriangle size={15} />
      {text}
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
  const { page, returnPage: taskReturnPage, navigate: setPage, openTask, returnFromTask, mainRef, serviceScrollRef } = useWorkspaceNavigation(initialPage);
  const [buildEnvironmentOpened, setBuildEnvironmentOpened] = useState(page === 'tools');
  useEffect(() => {
    if (page === 'tools') setBuildEnvironmentOpened(true);
  }, [page]);
  const buildEnvironmentChecks = useBuildEnvironmentChecks(desktop, db, page === 'tools' || buildEnvironmentOpened);
  const historyViews = useRef(new Map<string, HistoryViewState>());
  const [serviceTab, setServiceTab] = useState('deploy');
  const [logTarget, setLogTarget] = useState('');
  const [showOperationLogs, setShowOperationLogs] = useState(false);
  const [runtime, setRuntime] = useState<Record<string, OperationStatus>>({});
  const rememberRuntime = useCallback((id: string, status: OperationStatus) => {
    setRuntime((current) => ({ ...current, [id]: status }));
  }, []);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const [desktopPreferences, setDesktopPreferences] = useState(boot?.preferences ?? desktopPreferenceDefaults);
  const [tutorialInstallId, setTutorialInstallId] = useState(boot?.tutorialInstallId);
  const [tutorialOpen, setTutorialOpen] = useState(!!boot?.tutorialInstallId);
  const acknowledgedTutorial = useRef<string | undefined>(undefined);
  const [nativeDark, setNativeDark] = useState(boot?.darkTheme);
  const [update, setUpdate] = useState(boot?.update);
  function showInstalledTutorial(id: string | undefined) {
    if (!id || id === acknowledgedTutorial.current) return;
    setTutorialInstallId(id);
    setTutorialOpen(true);
  }
  useEffect(() => {
    if (!desktop || !tutorialOpen || !tutorialInstallId || acknowledgedTutorial.current === tutorialInstallId) return;
    acknowledgedTutorial.current = tutorialInstallId;
    void desktop.saveDesktopPreferences({ tutorialInstallId }).then(setDesktopPreferences)
      .catch(() => notify('未能保存教学向导偏好'));
  }, [tutorialInstallId, tutorialOpen]);
  const updateAvailable = !!update?.release && newerVersion(update.release.version, update.currentVersion);
  const sidebarEntries = useMemo(() => sidebarServices(db, desktopPreferences), [db, desktopPreferences]);
  const [savingSidebarOrder, setSavingSidebarOrder] = useState(false);
  const traySelectService = useRef<(id: string) => void>(() => {});
  const [environment, setEnvironment] = useState('all');
  const [density, setDensity] = useState<'compact' | 'comfortable'>(() => {
    try { return localStorage.getItem('deploy-center-density') === 'comfortable' ? 'comfortable' : 'compact'; }
    catch { return 'compact'; }
  });
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
  const [expanded, setExpanded] = useState<string[]>(() =>
    readExpandedTargets(boot?.dataDir || 'prototype'),
  );
  useEffect(
    () => saveExpandedTargets(boot?.dataDir || 'prototype', expanded),
    [expanded, boot?.dataDir],
  );
  const [artifact, setArtifact] = useState<Artifact>(() =>
    (fixture ? artifactFor : initialArtifact)(
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
  const [schedules, setSchedules] = useState<ReleaseSchedule[]>([]);
  const [deployNote, setDeployNote] = useState<string>();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [task, setTask] = useState<Task | null>(boot?.task || null);
  const [busy, setBusy] = useState(false);
  const [trust, setTrust] = useState<TrustRequest | undefined>(boot?.pendingTrust);
  const [saved, setSaved] = useState(boot?.savedCredentials || []);
  const [serverChecks, setServerChecks] = useState<
    Record<string, { ok: boolean; time: string; identity: string }>
  >({});
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
  const selectedLogTarget = targets.find((target) => target.id === logTarget) ||
    targets.find((target) => !target.production) || targets[0];
  const viewingOperationLogs = page === 'deploy' && serviceTab === 'ops' && showOperationLogs;
  const chosen = targets.filter((t) => selected.includes(t.id));
  const effective = (t: Target) => overrides[t.id] || t.backup;
  const notify = (text: string) => setMessage(text);
  async function saveSidebarOrder(sidebarServiceOrder: string[]) {
    if (savingSidebarOrder) return;
    const changes = { sidebarServiceOrder, sortSidebarByDeployment: false };
    setSavingSidebarOrder(true);
    try {
      if (desktop) setDesktopPreferences(await desktop.saveDesktopPreferences(changes));
      else setDesktopPreferences((previous) => ({ ...previous, ...changes }));
    } catch {
      notify('服务顺序保存失败，请重试。');
    } finally {
      setSavingSidebarOrder(false);
    }
  }
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
    if (!fixture) return;
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
  useLayoutEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const update = () => applyDocumentTheme(db.settings.theme, nativeDark);
    update();
    if (nativeDark !== undefined) return;
    media?.addEventListener('change', update);
    return () => media?.removeEventListener('change', update);
  }, [db.settings.theme, nativeDark]);
  useEffect(() => {
    document.documentElement.dataset.density = density;
    try { localStorage.setItem('deploy-center-density', density); } catch { /* 界面偏好仍在本次会话生效。 */ }
  }, [density]);
  useEffect(() => { setEnvironment('all'); }, [serviceId]);
  useEffect(() => {
    if (!fixture || !isActive(task)) return;
    const timer = setInterval(() => setTask((current) => (current ? tick(current) : null)), 850);
    return () => clearInterval(timer);
  }, [task?.id, task?.status]);
  useEffect(() => {
    if (!fixture || !task || isActive(task)) return;
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
    let updateRevision = 0;
    const refresh = () => {
      const revision = updateRevision;
      void desktop!.listTasks().then(setTaskRows);
      void desktop!.listSchedules().then(setSchedules);
      void desktop!.load().then((value) => {
        showInstalledTutorial(value.tutorialInstallId);
        if (revision === updateRevision) setUpdate(value.update);
        setSaved(value.savedCredentials);
        setUnfinished(value.unfinished);
        setTaskIssues(value.taskIssues || []);
      });
    };
    refresh();
    if (!boot?.preferences) void desktop.desktopPreferences?.().then(setDesktopPreferences).catch(() => {});
    return desktop!.onEvent((event) => {
      if (event.kind === 'show-install-tutorial') showInstalledTutorial(event.id);
      if (event.kind === 'native-theme') setNativeDark(event.dark);
      if (event.kind === 'update') {
        updateRevision++;
        setUpdate(event.update);
      }
      if (event.kind === 'schedules') setSchedules(event.schedules);
      if (event.kind === 'open-schedules') setPage('schedules');
      if (event.kind === 'desktop-preferences') setDesktopPreferences(event.preferences);
      if (event.kind === 'open-settings') {
        setSettingsSection('general');
        setPage('settings');
      }
      if (event.kind === 'open-service') traySelectService.current(event.serviceId);
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
          openTask('history');
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
      if (fixture) fileRef.current?.click();
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
    setServiceTab('deploy');
    setShowOperationLogs(false);
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
    setArtifact((fixture ? artifactFor : initialArtifact)(s));
    setOverrides({});
    setDb((old) => ({ ...old, lastService: id }));
  }
  function openOperations(target: Target, logs = false) {
    if (target.serviceId !== serviceId) selectService(target.serviceId);
    setLogTarget(target.id);
    setShowOperationLogs(logs);
    setServiceTab('ops');
    setPage('deploy');
  }
  traySelectService.current = (id) => {
    if (id !== serviceId) selectService(id);
    setServiceTab('deploy');
    setPage('deploy');
  };
  function toggleTarget(t: Target) {
    const next = selected.includes(t.id) ? selected.filter((x) => x !== t.id) : [...selected, t.id];
    setSelected(next);
    setDb((old) => ({
      ...old,
      lastService: serviceId,
      lastTargets: next.filter((id) => !db.targets.find((t) => t.id === id)?.production),
    }));
  }
  async function launch(targetList = chosen, rollback?: History, dryRun = false, schedule = false) {
    if (isActive(task)) {
      openTask();
      notify('请先结束当前任务');
      return;
    }
    if (!targetList.length) {
      notify('请至少选择一个部署目标');
      return;
    }
    if (fixture && build === 'existing' && !artifact.exists && !rollback) {
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
        setDialog({ kind: 'confirm', ...result, returnFocus, schedule });
      } catch (e) {
        setNativeDialog({ title: '部署准备失败', content: String(e) });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!fixture) return;
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
      await copyText(text);
      notify('已复制');
    } catch {
      notify('复制失败，请稍后重试。可先选中文字后按 Ctrl+C 复制。');
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
    setArtifact((fixture ? artifactFor : initialArtifact)(current));
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
  async function saveLogTarget(t: Target) {
    try {
      await desktop!.save({ ...db, targets: upsert(db.targets, t) });
      saveTarget(t);
    } catch (error) {
      notify(String(error));
    }
  }
  const serviceActions = (s: Service) => (
    <div className="entity-actions">
      <Button variant="neutral" size="compact" onClick={() => setDialog({ kind: 'service', value: s })}>
        编辑
      </Button>
      <Button
        variant="default" size="compact"
        onClick={() => {
          selectService(s.id);
          setPage('deploy');
        }}
      >
        去部署
      </Button>
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
    </div>
  );
  const targetActions = (t: Target, detail = false) => (
    <div className="entity-actions">
      {detail && desktop && <Button variant="neutral" size="compact" onClick={() => openOperations(t, true)}>
        <ScrollText size={15} />线上日志
      </Button>}
      <Button variant="neutral" size="compact" onClick={() => setDialog({ kind: 'target', value: t })}>
        <Pencil size={15} />
        编辑
      </Button>
      <Button
        variant="default" size="compact"
        onClick={() => {
          selectService(t.serviceId);
          setSelected([t.id]);
          setPage('deploy');
        }}
      >
        去部署
      </Button>
      <MoreMenu
        label={'更多目标' + t.name + '操作'}
        actions={[
          {
            label: '复制目标',
            onClick: () => setDialog({ kind: 'target', value: cloneTarget(t) }),
          },
          ...(desktop
            ? [
                { label: '运维', onClick: () => openOperations(t) },
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
    </div>
  );
  const serverActions = (s: Server) => (
    <div className="entity-actions">
      <Button
        variant="neutral" size="compact"
        aria-label={'编辑服务器' + s.name}
        onClick={() => setDialog({ kind: 'server', value: s })}
      >
        <Pencil size={15} />
        编辑
      </Button>
      <Button
        variant="default" size="compact"
        onClick={() =>
          fixture
            ? notify('原型未发起连接。正式版将展示主机指纹及认证结果。')
            : setNativeDialog({ title: '测试连接 · ' + s.name, server: s })
        }
      >
        测试连接
      </Button>
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
      />
    </div>
  );
  const cardTime = (value?: string) => (deploymentTime(value) ? fmtTime(value!).slice(5, 16) : '—');
  const header = (_title: string, description: string, action?: ReactNode) => (
    <div className="page-intro">{description}{action}</div>
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
                <Button variant="link" size="compact" onClick={() => setDialog({ kind: 'history', value: h })}>
                  详情
                </Button>
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
        if (!fixture) return;
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
  const renderHistory = (scoped = false) => {
    const scope = scoped ? 'service:' + serviceId : 'all';
    return (
    desktop ? (
                <TaskHistory
                  initialView={historyViews.current.get(scope)}
                  onViewChange={(view) => historyViews.current.set(scope, view)}
                  onMaintenance={setBackupAudit}
                  rows={scoped ? taskRows.filter((row) => row.serviceId === serviceId) : taskRows}
                  db={db}
                  api={desktop}
                  busy={isActive(task)}
                  onCopy={(value) => void copy(value)}
                  onHistory={(value) => setDialog({ kind: 'history', value })}
                  onOpen={(id, targetId) =>
                    void nativeAction(async () => {
                      const next = await desktop!.readTask(id);
                      setTask(next);
                      setInspected(
                        Math.max(
                          0,
                          next.targets.findIndex((r) => r.target.id === targetId),
                        ),
                      );
                      openTask(scoped ? 'deploy' : 'history');
                    })
                  }
                />
              ) : fixture && (
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
                  <Card>{historyTable(scoped ? filteredHistory.filter((row) => row.service.id === serviceId) : filteredHistory)}</Card>
                </>
              )
  );
  };

  return (
    <LogWrapContext.Provider value={desktopPreferences.wrapLogs}>
    <div
      className={desktop ? "app desktop-shell" : "app"}
      data-wrap-logs={desktopPreferences.wrapLogs}
      onDragOver={(e) => {
        if (desktop && e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!desktop || !e.dataTransfer.files.length) return;
        e.preventDefault();
        if (
          hasOpenModal() ||
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
      <ServiceSidebar
        development={boot?.development}
        updateAvailable={updateAvailable}
        services={sidebarEntries}
        onReorder={saveSidebarOrder}
        savingOrder={savingSidebarOrder}
        deployedServices={new Set(db.targets.filter((target) => cardTime(target.lastDeploy) !== '—').map((target) => target.serviceId))}
        current={serviceId}
        page={page}
        onPage={(next) => {
          if (next === 'deploy') setServiceTab('deploy');
          setPage(next);
        }}
        onService={(id) => {
          if (id !== serviceId) selectService(id);
          setServiceTab('deploy');
          setEnvironment('all');
          setPage('deploy');
        }}
        onSearch={() => db.services.length && setDialog({ kind: 'picker' })}
        settingsNavigation={<div id="settings-directory" className="settings-directory" />}
        task={isActive(task) && <button className="sidebar-link sidebar-task" aria-current={page === 'task' ? 'page' : undefined}
          onClick={() => {
            setInspected(-1);
            openTask();
          }} aria-label="当前任务">
          <Activity size={16} aria-hidden="true" /><span>当前任务</span><small>{taskProgress(task!)}%</small>
        </button>}
        global={[
          ...nav.filter((n) => n.page !== 'deploy').map((n) => ({ ...n })),
          ...(desktop ? [{ page: 'schedules' as const, name: '发布计划', icon: CalendarClock }] : []),
          ...(desktop ? [{ page: 'images' as const, name: '镜像工具', icon: Container }] : []),
        ].map(({ page: id, name, icon: Icon }) => (
          <button className="sidebar-link" key={id} aria-label={name} aria-current={page === id ? 'page' : undefined} onClick={() => setPage(id)} title={name}>
            <Icon size={17} strokeWidth={1.6} /><span>{name}</span>
          </button>
        ))}
      />
      <div className="workspace" id="content-area">
        {page !== 'task' && page !== 'images' && (
          <AppPageHeader
            className="desktop-page-header"
            truncateTitle
            icon={page === 'deploy' && db.services.length ? <Box size={20} strokeWidth={1.5} /> : page === 'settings' ? <SettingsIcon size={18} strokeWidth={1.5} /> : undefined}
            title={viewingOperationLogs ? service.name + ' · ' + (selectedLogTarget?.name ?? '') + ' · 线上日志' :
              page === 'deploy' && db.services.length ? service.name :
              page === 'settings' && desktop ? settingsLabels[settingsSection] :
              workspacePages.find((entry) => entry.page === page)?.name || 'YOTOO 部署中心'}
            subtitle={page === 'deploy' && !viewingOperationLogs && service.description ? service.description : undefined}
            actions={viewingOperationLogs ?
              <Button variant="neutral" size="compact" onClick={() => setShowOperationLogs(false)}><ArrowLeft size={15} />返回运维</Button>
              : page === 'deploy' && !!db.services.length ? <>
              <Button variant="quiet" size="compact" onClick={() => setDialog({ kind: 'presets' })}><FolderOpen size={15} />部署预设</Button>
              <Button variant="ghost" size="icon-compact" aria-label="编辑配置" title="编辑服务" onClick={() => setDialog({ kind: 'service', value: service })}><Pencil size={15} /></Button>
              <Button variant="neutral" size="compact" disabled={!db.servers.length} onClick={() => setDialog({ kind: 'target', value: newTarget() })}><Plus size={15} />添加部署目标</Button>
            </> : page === 'schedules' ? <Button size="compact" onClick={() => { setServiceTab('deploy'); setPage('deploy'); }}>选择发布目标</Button> : undefined}
          />
        )}
        <main ref={mainRef} className={page === 'task' || page === 'images' ? 'main-task' : page === 'deploy' ? 'main-service' : 'main-page'}>
          {!!taskIssues.length && (
            <div className="warning" role="alert">
              <strong>有任务元数据无法读取，原始数据与相关文件已保留</strong>
              <p>
                暂时不能确定产物共享关系或远端执行结果。请检查数据目录中的数据库备份，修复后重新打开应用；不会用空配置覆盖原数据。
              </p>
              <Button variant="neutral" size="compact" onClick={() => void desktop?.openDataDir()}>
                打开数据目录
              </Button>
            </div>
          )}
          {desktop && page !== 'task' && observations.some((s) => s.active) && (
            <div className="notice">
              <strong>部署后日志观察</strong>
              <div className="row wrap mt">
                {observations
                  .filter((s) => s.active)
                  .map((s) => (
                    <Button
                      key={s.sessionId}
                      variant="neutral" size="compact"
                      onClick={() =>
                        setNativeDialog({
                          title: '部署后观察 · ' + s.label,
                          logs: s.targetId,
                          logSession: s.sessionId,
                        })
                      }
                    >
                      {s.label} · 查看或停止
                    </Button>
                  ))}
              </div>
            </div>
          )}
          {desktop && page !== 'task' && unfinished.length > 0 && (
            <div className="warning" role="status">
              <strong>存在未结束的部署任务</strong>
              <p>核实只读取原任务状态或清理未启动的上传，不会继续后续目标或重新替换。</p>
              {unfinished.map((t) => (
                <Button
                  variant="neutral" size="compact"
                  key={t.id}
                  disabled={isActive(task)}
                  onClick={() => setNativeDialog({ title: '核实中断任务 · ' + t.id, recover: t })}
                >
                  {t.service.name} · 核实原任务
                </Button>
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
                <Button
                  variant="neutral" size="compact"
                  onClick={() => download('deploy-center-original.txt', recovery.raw)}
                >
                  下载原始数据
                </Button>
                <Button
                  variant="neutral" size="compact"
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
                </Button>
              </div>
            </div>
          )}
          {storageError && storageError !== blockReason && (
            <p className="warning" role="alert">
              {storageError}
            </p>
          )}
          {page === 'deploy' && !db.services.length && (
            <EmptyServiceWorkspace
              onAdd={() => setDialog({ kind: 'service', value: { ...newService(), id: uid() } })}
              onImport={() => void importNative()}
            />
          )}
          {page === 'deploy' && !!db.services.length && (
            <section className="service-workspace" aria-label="服务工作台">
              {!viewingOperationLogs && <PageTabs
                aria-label="服务工作台"
                value={serviceTab}
                onValueChange={(value) => { setShowOperationLogs(false); setServiceTab(value); }}
                items={[
                  { value: 'deploy', label: '部署目标' },
                  { value: 'records', label: '发布记录' },
                  { value: 'build', label: '构建配置' },
                  ...(desktop ? [{ value: 'ops', label: '运维' }] : []),
                ]}
                className="service-workspace-tabs"
              />}
              {serviceTab === 'ops' && desktop ? <>
                <div className="service-workspace-scroll operation-scroll" hidden={viewingOperationLogs}>
                  <OperationsWorkspace api={desktop} targets={targets} servers={db.servers} target={selectedLogTarget}
                    saved={saved} onTarget={setLogTarget} onStatus={rememberRuntime} followLogs={desktopPreferences.followLogs} visible={!viewingOperationLogs}
                    blocked={isActive(task) ? '有部署或回滚正在执行，请等待结束。' : undefined}
                    onLogs={() => setShowOperationLogs(true)}
                    onEdit={() => { if (selectedLogTarget) setDialog({ kind: 'target', value: selectedLogTarget }); }} />
                </div>
                {viewingOperationLogs && <div className="service-workspace-scroll online-log-workspace">
                  <OnlineLogsWorkspace api={desktop} targets={targets}
                    key={selectedLogTarget?.appLogPath}
                    targetId={selectedLogTarget?.id}
                    initialFollow={desktopPreferences.followLogs}
                    onConfigure={() => {
                      if (selectedLogTarget) setDialog({ kind: 'target', value: selectedLogTarget, initialTab: '健康检查' });
                    }} />
                </div>}
              </> : serviceTab === 'records' ? <div ref={serviceScrollRef} className="service-workspace-scroll" key={serviceId}>{renderHistory(true)}</div> :
                serviceTab === 'build' ? <div ref={serviceScrollRef} className="service-workspace-scroll">
                  <ServiceForm key={service.id} initial={service} db={db} onClose={() => setServiceTab('deploy')}
                    onSave={(value) => {
                      setDb((old) => ({ ...old, services: upsert(old.services, value) }));
                      setArtifact((fixture ? artifactFor : initialArtifact)(value));
                      setJarSelection(undefined);
                      setRetrySource(undefined);
                      setLocalInfo(null);
                      setInfoRefresh((n) => n + 1);
                      notify('服务配置已保存');
                    }} />
                </div> : <>
                  <div ref={serviceScrollRef} className="service-workspace-scroll">
                    <BuildArtifactChoice name={build === 'existing' ? artifact.name || service.jarName : service.jarName}
                      summary={build === 'existing'
                        ? artifact.exists ? niceSize(artifact.size) + ' · ' + fmtTime(artifact.modified) : '尚无可用 JAR'
                        : '部署前构建一次，所有目标共用同一份产物'}
                      mode={build} onMode={setBuild} onPick={() => void pickJar()} />
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
                            {fixture
                              ? '测试夹具只提供文件名、大小和修改时间。'
                              : '已读取本地文件信息；选择文件或确认部署前会检查 JAR 完整性。'}
                          </p>
                          <div className="row wrap">
                            {fixture && (
                              <Button variant="neutral" size="compact" onClick={() => void pickJar()}>
                                <FolderOpen size={16} />
                                选择本地 JAR
                              </Button>
                            )}
                            {fixture && db.settings.demoMode && (
                              <Demo>
                                {' '}
                                <Button
                                  variant="link" size="compact"
                                  onClick={() => setArtifact(artifactFor(service))}
                                >
                                  使用示例产物
                                </Button>
                                <Button
                                  variant="link" size="compact"
                                  onClick={() =>
                                    setArtifact((old) => ({
                                      ...old,
                                      modified: '2026-11-01T08:00:00+08:00',
                                    }))
                                  }
                                >
                                  查看旧产物提醒
                                </Button>
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
                            <Button
                              variant="neutral" size="compact"
                              disabled={localInfoBusy}
                              onClick={() => setInfoRefresh((n) => n + 1)}
                            >
                              <RotateCcw size={15} />
                              刷新 JAR / Git 信息
                            </Button>
                            {jarSelection && (
                              <Button variant="link" size="compact" onClick={() => setJarSelection(undefined)}>
                                使用配置的产物路径
                              </Button>
                            )}
                          </div>
                        </>
                      )}
                    </details>

                    <div className="target-toolbar">
                      <SegmentedControl aria-label="环境筛选" size="sm" value={environment} onValueChange={setEnvironment}
                        items={[{ value: 'all', label: '全部目标' }, { value: 'test', label: '非正式' }, { value: 'production', label: '正式' }]} />
                      <span className="muted">{targets.length} 个目标</span>
                      {environment !== 'all' &&
                        chosen.some((target) => target.production !== (environment === 'production')) && (
                          <span className="note">
                            {chosen.filter((target) => target.production !== (environment === 'production')).length} 个已选目标未在当前筛选中显示
                          </span>
                        )}
                      <span className="grow" />
                      {!!expanded.length && <Button size="compact" variant="quiet" onClick={() => setExpanded([])}>全部收起</Button>}
                      {chosen.length > 0 && <Button size="compact" variant="quiet" onClick={() => {
                        setSelected([]);
                        setDb((old) => ({ ...old, lastService: serviceId, lastTargets: [] }));
                      }}>取消选择</Button>}
                    </div>
                    <div className="deployment-targets">
                      {targets.filter((target) => environment === 'all' || target.production === (environment === 'production')).map((t) => {
                        const s = db.servers.find((server) => server.id === t.serverId);
                        const b = effective(t);
                        const open = expanded.includes(t.id);
                        return <article key={t.id} className={'deployment-target' + (selected.includes(t.id) ? ' checked' : '')}>
                          <div className="target-compact deployment-target-main">
                            <Checkbox aria-label={'选择' + t.name} checked={selected.includes(t.id)} onCheckedChange={() => toggleTarget(t)} />
                            <span className="record-icon"><Box size={18} strokeWidth={1.5} /></span>
                            <button className="target-identity" aria-expanded={open} aria-label={(open ? '收起' : '展开') + t.name + '详情'} onClick={() => setExpanded((old) => open ? old.filter((id) => id !== t.id) : [...old, t.id])}>
                              <strong>{t.name} {t.production && <Badge kind="warn">正式</Badge>}</strong>
                              <small>{s ? serverAddress(s) + ' · ' + s.name : '未关联服务器'}</small>
                            </button>
                            <div className="target-artifact">
                              <Badge>{modeLabel(t.mode)}</Badge>
                              <HashValue label="Git 提交" value={t.currentCommit || knownCommit(t.version, t.currentHash)} onCopy={(value) => void copy(value)} />
                            </div>
                            <div className="target-health">
                              <CompactStatus label={t.healthState} tone={/失败/.test(t.healthState) ? 'bad' : /通过/.test(t.healthState) ? 'good' : t.health.type === 'none' ? 'neutral' : 'warn'} />
                              <time>{cardTime(t.lastDeploy)}</time>
                            </div>
                            <div className="target-backup" title={overrides[t.id] ? '本次覆盖' : '目标默认'}>
                              <Switch label={t.name + '备份'} checked={b.enabled} onChange={(enabled) => changeBackup(t.id, { ...b, enabled })} />
                            </div>
                            <div className="deployment-target-actions">
                              {desktop && <Button variant="ghost" size="icon-compact" aria-label={'查看线上日志 · ' + t.name} title="查看线上日志"
                                onClick={() => openOperations(t, true)}><ScrollText size={15} /></Button>}
                              <Button variant="ghost" size="icon-compact" aria-label={'编辑' + t.name} onClick={() => setDialog({ kind: 'target', value: t })}><Pencil size={15} /></Button>
                              <Button variant="ghost" size="icon-compact" aria-label={'本次策略 · ' + t.name} aria-expanded={open}
                                onClick={() => setExpanded((old) => open ? old.filter((id) => id !== t.id) : [...old, t.id])}><ChevronDown size={15} /></Button>
                            </div>
                          </div>
                          {open && <div className="target-override">
                            <p className="path">{remoteJar(t)}</p>
                            <HashValue label="JAR 指纹" value={t.currentHash} onCopy={(value) => void copy(value)} />
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
                                    <Button
                                      variant="link" size="compact"
                                      onClick={() =>
                                        setObservationOverrides((old) => {
                                          const next = { ...old };
                                          delete next[t.id];
                                          return next;
                                        })
                                      }
                                    >
                                      恢复目标默认观察设置
                                    </Button>
                                  )}
                                </>
                              )}

                              {!b.enabled && (
                                <p className="warning">未启用备份，失败时不能依赖本次备份恢复。</p>
                              )}
                              <Button
                                variant="link" size="compact"
                                onClick={() =>
                                  setOverrides((old) => {
                                    const next = { ...old };
                                    delete next[t.id];
                                    return next;
                                  })
                                }
                              >
                                恢复该目标默认策略
                              </Button>

                          </div>}
                        </article>;
                      })}
                      {!targets.length && <div className="empty service-empty"><Box size={25} strokeWidth={1.4} /><strong>还没有部署目标</strong><span>关联服务器后，配置这个服务的远程部署位置。</span>
                        <Button variant="neutral" onClick={() => db.servers.length ? setDialog({kind:'target',value:newTarget()}) : setPage('servers')}>{db.servers.length ? '添加部署目标' : '配置服务器'}</Button></div>}
                      {!!targets.length && !targets.some((t) => environment === 'all' || t.production === (environment === 'production')) && <p className="empty">没有匹配的部署目标。</p>}
                    </div>
                    <Disclosure title="部署预检明细">
                      <PrecheckPanel check={desktop ? preflight : null} pending={preflightBusy} />
                    </Disclosure>
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

                    {chosen.some((t) => t.production) && <p className="warning">包含正式环境，需要逐项输入环境名称确认。</p>}
                    {busy && <p className="note" role="status"><Loader2 size={14} className="spin" />正在检查本地构建环境和产物…</p>}
                  </div>
                  {blockReason && <p className="deployment-block" role="status">{blockReason}</p>}
                  <div className="deployment-footer" aria-label="部署操作">
                    <div className="deployment-count grow"><strong>已选 {chosen.length} 个目标</strong><small>{build === 'rebuild' ? '构建一次' : '使用现有 JAR'} · {chosen.filter((t) => effective(t).enabled).length} 个开启备份</small></div>
                    <div className="failure-policy">
                      <Button variant="link" size="compact" className="failure-policy-reset"
                        hidden={failureOverride === null}
                        onClick={() => setFailureOverride(null)}>恢复默认</Button>
                      <label className="sr-only" htmlFor="deployment-failure-policy">某个目标失败后</label>
                      <select id="deployment-failure-policy" value={failureOverride ?? db.settings.failurePolicy}
                        onChange={(event) => setFailureOverride(event.target.value as Database['settings']['failurePolicy'])}>
                        <option value="stop">失败后停止后续目标</option>
                        <option value="continue">失败后继续其他目标</option>
                      </select>
                      <FieldHelp label="某个目标失败后" text="此处的选择只作用于本次部署。可在「设置 → 部署与构建」修改默认策略。" />
                    </div>
                    {desktop && <Button variant="neutral" disabled={busy || isActive(task) || !!blockReason || !chosen.length} onClick={() => void launch(chosen, undefined, true)}>试运行（远程只读）</Button>}
                    <Button disabled={busy || (!isActive(task) && (!!blockReason || !chosen.length || (!desktop && build === 'existing' && !artifact.exists)))} onClick={() => void launch()}>
                      <Rocket size={15} />{isActive(task) ? '查看当前任务' : '部署'}
                    </Button>
                    {desktop && <MoreMenu iconOnly label="发布选项" trigger={<ChevronDown size={15} />} actions={[
                      { label: '定时发布', disabled: busy || isActive(task) || !!blockReason || !chosen.length, onClick: () => void launch(chosen, undefined, false, true) },
                      { label: '部署预设', onClick: () => setDialog({ kind: 'presets' }) },
                    ]} />}
                  </div>
                </>}
            </section>
          )}
          {page === 'schedules' && desktop && (
            <ReleaseSchedules
              plans={schedules}
              busy={busy || isActive(task)}
              onOpen={(id) =>
                void nativeAction(async () => {
                  const value = await desktop!.readTask(id);
                  setTask(value);
                  setInspected(-1);
                  openTask('schedules');
                })
              }
              onCancel={(id) => void nativeAction(() => desktop!.cancelSchedule(id))}
              onChange={(plan) =>
                setDialog({
                  kind: 'confirm',
                  task: plan.task,
                  schedule: true,
                  plan,
                  reschedule: true,
                })
              }
              onPrepare={(plan) =>
                void nativeAction(async () => {
                  await desktop!.save(db);
                  let jarPath: string | undefined;
                  if (plan.task.build === 'existing') {
                    const snapshot = await desktop!.snapshotAvailability(plan.preparationId);
                    jarPath = snapshot.available
                      ? snapshot.path
                      : (await desktop!.choose('jar')) || undefined;
                    if (!jarPath) return;
                  }
                  const prepared = await desktop!.prepare({
                    serviceId: plan.task.service.id,
                    targetIds: plan.task.targets.map((r) => r.target.id),
                    build: plan.task.build,
                    jarPath,
                    overrides: Object.fromEntries(
                      plan.task.targets.map((r) => [r.target.id, r.backup]),
                    ),
                    failurePolicy: plan.task.failurePolicy,
                    note: plan.task.note,
                  });
                  setDialog({ kind: 'confirm', ...prepared, schedule: true, plan });
                })
              }
            />
          )}
          {page === 'services' && <ServicesWorkspace db={db} taskRows={taskRows} onAdd={() => setDialog({ kind: 'service', value: { ...newService(), id: uid() } })} renderActions={serviceActions} />}
          {page === 'targets' && <TargetsWorkspace db={db} serviceId={serviceId} runtime={runtime} onService={selectService} onAdd={() => setDialog({ kind: 'target', value: newTarget() })} renderActions={targetActions} />}
          {page === 'servers' && (
            <ServersWorkspace
              db={db}
              desktop={!!desktop}
              checks={serverChecks}
              onAdd={() =>
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
                      })}
              renderActions={serverActions}
            />
          )}
          {page === 'tools' && (
            <>
              {header('构建环境', '服务分别选择 JDK、工作目录、Maven、Profiles 和构建参数。')}
                <BuildEnvironment
                  api={desktop}
                  db={db}
                  checks={buildEnvironmentChecks}
                  onEdit={(value) => setDialog({ kind: 'service', value })}
                  onAdd={() => setDialog({ kind: 'jdk' })}
                  onDelete={(name) => setDialog({ kind: 'delete', entity: 'jdk', id: name })}
                  deletionReason={(name) => entityRemovalReason('jdk', name)}
                  onScan={desktop ? () =>
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
                    }) : undefined
                  }
                />
            </>
          )}
          {page === 'history' && renderHistory()}
          {page === 'images' && desktop && (
            <Suspense fallback={<p className="note workspace-panel" role="status">正在打开镜像工具…</p>}>
              <ImageWorkspace api={desktop} db={db} serviceId={serviceId} saved={saved}
                followLogs={desktopPreferences.followLogs} dataDir={boot?.dataDir || ''} />
            </Suspense>
          )}
          {page === 'settings' && (
            <SettingsWorkspace
              updateAvailable={updateAvailable}
              desktop={desktop}
              db={db}
              setDb={setDb}
              section={settingsSection}
              onSection={setSettingsSection}
              density={density}
              onDensity={setDensity}
              migrationBlock={isActive(task) ? '任务执行或取消中，不能迁移数据目录。' : unfinished.length ? '有未处理的中断任务，请先核实结果再迁移。' : undefined}
              busy={isActive(task)}
              version={boot?.version || '2.3.3'}
              preferences={desktopPreferences}
              onPreferences={setDesktopPreferences}
              showDemo={fixture}
              onTutorial={() => setTutorialOpen(true)}
              onImport={() => {
                if (desktop) void importNative();
                else if (fixture) importRef.current?.click();
              }}
              onExport={() => {
                const api = desktop;
                if (api) void nativeAction(async () => { await api.save(db); await api.exportConfig(); });
                else if (fixture) download('deploy-center-config-v3.json', safeConfigJson(db), 'application/json');
              }}
            />
          )}
          {page === 'task' && task && (
                <TaskView
                  key={task.id}
                  task={task}
                  initialFollow={desktopPreferences.followLogs}
                  inspected={viewedTarget}
                  setInspected={setInspected}
                  backLabel={taskReturnPage === 'schedules' ? '返回发布计划' : taskReturnPage === 'history' ? '返回部署历史' : taskReturnPage === 'deploy' ? '返回部署' : '返回'}
                  onBack={returnFromTask}
                  onHealth={db.targets.some((target) => target.id === task.targets[viewedTarget]?.target.id) ? () => {
                    const target = db.targets.find((target) => target.id === task.targets[viewedTarget].target.id)!;
                    setDialog({ kind: 'target', value: target, initialTab: '健康检查' });
                  } : undefined}
                  onRecover={desktop && !task.preparation && unfinished.some((entry) => entry.id === task.id) ? () =>
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
                  demoMode={fixture && db.settings.demoMode}
                  onFailure={(kind) => {
                    if (!fixture) return;
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
                  onRuntimeStatus={desktop ? () => {
                    const target = db.targets.find((entry) => entry.id === task.targets[viewedTarget]?.target.id);
                    if (target) openOperations(target);
                  } : undefined}
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
      </div>
      {fixture && <>
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
            <Button variant="neutral" size="compact" onClick={() => setBackupAudit(undefined)}>
              返回
            </Button>
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
      </>}
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
                  setArtifact((fixture ? artifactFor : initialArtifact)(s));
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
            onSave={desktop && viewingOperationLogs ? saveLogTarget : saveTarget}
          />
        </Modal>
      )}
      {dialog?.kind === 'presets' && (
        <Modal title="部署预设" onClose={() => setDialog(null)} wide>
          {presetShelf()}
        </Modal>
      )}
      {dialog?.kind === 'picker' && (
        <Modal title="选择服务" onClose={() => setDialog(null)}>
          <ServicePicker
            db={db}
            onChoose={(id) => {
              selectService(id);
              setServiceTab('deploy');
              setEnvironment('all');
              setPage('deploy');
              setDialog(null);
            }}
          />
        </Modal>
      )}
      {dialog?.kind === 'confirm' && (
        <Confirm
          task={dialog.task}
          schedule={dialog.schedule}
          scheduledAt={dialog.plan?.scheduledAt}
          onCopy={(value) => void copy(value)}
          returnFocus={dialog.returnFocus}
          onClose={() => setDialog(null)}
          saved={saved}
          onStart={async (t, values, approval, scheduledAt) => {
            if (desktop && dialog.schedule) {
              if (!scheduledAt) throw new Error('请选择发布时间');
              if (dialog.reschedule)
                await desktop.reschedule(dialog.plan!.id, scheduledAt, approval);
              else
                await desktop.createSchedule(
                  dialog.token!,
                  values,
                  approval,
                  scheduledAt,
                  dialog.plan?.id,
                );
              setSchedules(await desktop.listSchedules());
              setDialog(null);
              setPage('schedules');
              return;
            }
            if (desktop) {
              const started = await desktop!.start(dialog.token!, values, approval);
              setTask(started);
            } else if (fixture) {
              credentials.current.set(values);
              setTask(startTask(t));
            }
            setFailureOverride(null);
            setInspected(-1);
            openTask();
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
              ? '已经进入服务切换阶段。请求取消后会完成当前目标的检查，再停止后续目标，不会强制中断替换。'
              : '将在下一个安全边界停止，清理本任务临时上传文件。当前运行版本保持不变。'}
          </p>
          <footer className="modal-actions">
            <Button variant="neutral" size="compact" onClick={() => setDialog(null)}>
              继续部署
            </Button>
            <Button
              variant="danger" size="compact"
              onClick={() => {
                if (desktop) void nativeAction(() => desktop!.cancel(task.id));
                else if (fixture) setTask((t) => (t ? cancelTask(t) : null));
                setDialog(null);
              }}
            >
              请求取消
            </Button>
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
            <Button variant="neutral" size="compact" onClick={() => setDialog(null)}>
              <ArrowLeft size={16} />
              返回
            </Button>
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
              {fixture
                ? '本原型保存配置，不执行 java 检测。'
                : '保存后可在构建环境页检测 java 与 javac。'}
            </p>
            <footer className="modal-actions">
              <Button variant="default" size="compact">保存</Button>
            </footer>
          </form>
        </Modal>
      )}
      {tutorialOpen && (
        <TutorialGuide onClose={() => setTutorialOpen(false)} onNavigate={(destination) => {
          setTutorialOpen(false);
          if (destination === 'deploy') setServiceTab('deploy');
          setPage(destination);
        }} />
      )}
      {nativeDialog && (
        <Modal title={nativeDialog.title} wide onClose={() => {
          if (nativeDialog.logSession) void desktop?.stopLogs(nativeDialog.logSession).catch(() => {});
          setNativeDialog(null);
        }}>
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
            <OnlineLogsWorkspace
              api={desktop!}
              targets={db.targets}
              targetId={nativeDialog.logs}
              initialSession={nativeDialog.logSession}
              initialFollow={desktopPreferences.followLogs}
              onConfigure={() => {
                const target = db.targets.find((target) => target.id === nativeDialog.logs);
                if (!target) return;
                setNativeDialog(null);
                setDialog({ kind: 'target', value: target, initialTab: '健康检查' });
              }}
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
                  setInspected(-1);
                  openTask();
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
    </LogWrapContext.Provider>
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
        <Button variant="neutral" size="compact" onClick={onExport}>
          <Download size={15} />
          导出日志
        </Button>
        {h.id !== 'logs' && (
          <Button variant="default" size="compact" disabled={!canRollback} onClick={onRollback}>
            <RotateCcw size={15} />
            回滚到此备份
          </Button>
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
