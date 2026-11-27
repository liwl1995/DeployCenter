import { TargetObservationOverride } from './TargetObservationOverride';
import { DeploymentTargetRow } from './DeploymentTargetRow';
import { DeployFailurePolicy } from './DeployFailurePolicy';
import { ArtifactInfo, niceSize } from './ArtifactInfo';
import { Confirm } from './Confirm';
import { HistoryDetail } from './HistoryDetail';
import { ServicePicker } from './ServicePicker';
import { ReleaseSchedules, type ScheduleViewState } from './ReleaseSchedules';
import { ReleaseManifest, type ReleaseDraft } from './ReleaseManifest';
import type { ReleaseRun } from './serial-release';
import type { ReleaseSchedule } from './schedules';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Rocket,
  Activity,
  Box,
  CalendarClock,
  ListOrdered,
  ChevronDown,
  Settings as SettingsIcon,
  Server as ServerIcon,
  Wrench,
  History as HistoryIcon,
  SlidersHorizontal,
  Plus,
  ArrowLeft,
  RotateCcw,
  X,
  GitBranch,
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
  serverAddress,
  statusLabel,
  fmtTime,
  seconds,
  snapshotService,
  snapshotTarget,
  snapshotServer,
  type Database,
  type Service,
  type Server,
  type Target,
  type Backup,
  type Artifact,
  type Task,
  type History,
  type EntityIcon,
} from './model';
import { copyText } from './clipboard';
import { createTask, startTask, tick, cancelTask, requestFailure } from './engine';
import { recordTask, pruneHistory, canRollback as rollbackAllowed, historyLogs } from './records';
import { CredentialSession } from './credentials';
import { Badge, Card, Field, Modal, Demo, download, hasOpenModal } from './ui';
import { ServiceForm, ServerForm, TargetForm } from './forms';
import { IconPicker } from './IconPicker';
import { EntityIcon as EntityIconView, type EntityIconKind } from './entity-icons';
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
  knownCommit,
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
import { releaseHistoryView, TaskHistory, type HistoryViewState } from './TaskHistory';
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
import { PageTabs } from './design/ui/page-tabs';
import { BuildArtifactChoice } from './BuildArtifactChoice';
import { SegmentedControl } from './design/ui/segmented-control';
import { workspacePages } from './workspace-model';
import { newService, newTargetTemplate, emptyDatabase, prototype } from './defaults';
import {
  desktop,
  initialArtifact,
  mergedDatabase,
  type Startup,
  type TrustRequest,
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
  const { page, returnPage: taskReturnPage, navigate: setPage, openTask: navigateToTask, returnFromTask, mainRef, serviceScrollRef } = useWorkspaceNavigation(initialPage);
  const [historySnapshot, setHistorySnapshot] = useState<History>();
  const [viewedTask, setViewedTask] = useState<Task>();
  const openTask = (
    source?: Parameters<typeof navigateToTask>[0],
    detail?: { history: History } | { task: Task },
  ) => {
    setHistorySnapshot(detail && 'history' in detail ? detail.history : undefined);
    setViewedTask(detail && 'task' in detail ? detail.task : undefined);
    navigateToTask(source);
  };
  const [buildEnvironmentOpened, setBuildEnvironmentOpened] = useState(page === 'tools');
  useEffect(() => {
    if (page === 'tools') setBuildEnvironmentOpened(true);
  }, [page]);
  const buildEnvironmentChecks = useBuildEnvironmentChecks(desktop, db, page === 'tools' || buildEnvironmentOpened);
  const historyViews = useRef(new Map<string, HistoryViewState>());
  const scheduleView = useRef<ScheduleViewState>(undefined);
  const rememberScheduleView = useCallback((view: ScheduleViewState) => {
    scheduleView.current = view;
  }, []);
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
  const [iconPicker, setIconPicker] = useState<{ kind: EntityIconKind; id: string } | null>(null);
  const iconPickerEntity = iconPicker
    ? iconPicker.kind === 'service'
      ? db.services.find((s) => s.id === iconPicker.id)
      : iconPicker.kind === 'server'
        ? db.servers.find((s) => s.id === iconPicker.id)
        : db.targets.find((t) => t.id === iconPicker.id)
    : undefined;
  const pickIcon = (kind: EntityIconKind, id: string) => setIconPicker({ kind, id });
  const setEntityIcon = (icon: EntityIcon | undefined) => {
    if (!iconPicker) return;
    const { kind, id } = iconPicker;
    setDb((old) => {
      if (kind === 'service')
        return { ...old, services: old.services.map((s) => (s.id === id ? { ...s, icon } : s)) };
      if (kind === 'server')
        return { ...old, servers: old.servers.map((s) => (s.id === id ? { ...s, icon } : s)) };
      return { ...old, targets: old.targets.map((t) => (t.id === id ? { ...t, icon } : t)) };
    });
  };
  const [currentTask, setTask] = useState<Task | null>(boot?.task || null);
  const task = page === 'task' && viewedTask && viewedTask.id !== currentTask?.id ? viewedTask : currentTask;
  const taskRunning = isActive(currentTask);
  const [releaseRun, setReleaseRun] = useState<ReleaseRun | null>(boot?.releaseRun ?? null);
  const [releaseShowRun, setReleaseShowRun] = useState(!!boot?.releaseRun);
  const [releaseDraft, setReleaseDraft] = useState<ReleaseDraft>([]);
  const [releasePolicy, setReleasePolicy] = useState<Database['settings']['failurePolicy'] | null>(null);
  const releasing = releaseRun?.state === 'running' || releaseRun?.state === 'cancelling';
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
  const serviceHistoryRows = useMemo(
    () => taskRows.filter((row) => row.serviceId === serviceId),
    [taskRows, serviceId],
  );
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
    if (!fixture || !taskRunning) return;
    const timer = setInterval(() => setTask((current) => (current ? tick(current) : null)), 850);
    return () => clearInterval(timer);
  }, [currentTask?.id, taskRunning]);
  useEffect(() => {
    if (!fixture || !currentTask || taskRunning) return;
    credentials.current.clear();
    if (recorded.current.has(currentTask.id)) return;
    recorded.current.add(currentTask.id);
    setDb((old) => recordTask(old, currentTask));
  }, [currentTask, taskRunning]);
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
    let sawReleaseEvent = false;
    const unsubscribe = desktop!.onEvent((event) => {
      if (event.kind === 'show-install-tutorial') showInstalledTutorial(event.id);
      if (event.kind === 'native-theme') setNativeDark(event.dark);
      if (event.kind === 'update') {
        updateRevision++;
        setUpdate(event.update);
      }
      if (event.kind === 'schedules') setSchedules(event.schedules);
      if (event.kind === 'release-run') {
        sawReleaseEvent = true;
        setReleaseRun(event.run);
      }
      if (event.kind === 'open-schedules') setPage('schedules');
      if (event.kind === 'desktop-preferences') setDesktopPreferences(event.preferences);
      if (event.kind === 'open-settings') {
        setSettingsSection('general');
        setPage('settings');
      }
      if (event.kind === 'open-service') traySelectService.current(event.serviceId);
      if (event.kind === 'maintenance') refresh();
      if (event.kind === 'task') {
        setViewedTask((old) => old?.id === event.task.id ? event.task : old);
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
        void nativeAction(async () => {
          const value = await desktop!.readTask(event.taskId);
          setInspected(-1);
          openTask('history', { task: value });
        });
      } else if (event.kind === 'database') {
        setDb((old) => mergedDatabase(old, event.database));
        void desktop!.listTasks().then(setTaskRows).catch(() => {});
      } else if (event.kind === 'trust') setTrust(event.request);
      else if (event.kind === 'trust-closed')
        setTrust((old) => (old?.id === event.id ? undefined : old));
    });
    void desktop.releaseState?.().then((run) => {
      if (!sawReleaseEvent) setReleaseRun(run);
    }).catch(() => {});
    return () => { sawReleaseEvent = true; unsubscribe(); };
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
    if (!desktop || recovery || !db.services.length || page !== 'deploy' || taskRunning) return;
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
  }, [preflightKey, page, recovery, taskRunning]);
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
    desktop && !taskRunning
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
    if (releasing && !taskRunning) {
      setPage('release-manifest');
      notify('发布清单正在执行，请等待清单结束。');
      return;
    }
    if (taskRunning) {
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
    if (!task || !desktop || taskRunning || isActive(task) || releasing) return;
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
    if (!task || releasing) return;
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
    if (taskRunning) return '任务执行或取消中，不能删除配置。';
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
          setSelected(t.production ? [] : [t.id]);
          setEnvironment('all');
          setExpanded((old) => old.includes(t.id) ? old : [...old, t.id]);
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
                  disabled: taskRunning,
                  reason: taskRunning ? '请先等待当前任务结束' : undefined,
                  onClick: () =>
                    setNativeDialog({
                      title: t.name + ' · 核实远程工作台',
                      server: db.servers.find((s) => s.id === t.serverId),
                      workbenchTarget: t.id,
                    }),
                },
                {
                  label: '检查或接管任务锁',
                  disabled: taskRunning,
                  reason: taskRunning ? '任务执行中不能接管锁' : undefined,
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
    if (taskRunning || busy) {
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
      disabled={busy || taskRunning}
      pinnedOnly={pinnedOnly}
    />
  );
  const changeBackup = (id: string, b: Backup) => setOverrides((old) => ({ ...old, [id]: b }));
  const renderHistory = (scoped = false) => {
    const scope = scoped ? 'service:' + serviceId : 'all';
    return (
    desktop ? (
                <TaskHistory
                  showStatistics={!scoped}
                  initialView={historyViews.current.get(scope)}
                  onViewChange={(view) => historyViews.current.set(scope, view)}
                  onMaintenance={setBackupAudit}
                  rows={scoped ? serviceHistoryRows : taskRows}
                  db={db}
                  api={desktop}
                  busy={taskRunning}
                  onCopy={(value) => void copy(value)}
                  onHistory={(value) => openTask(scoped ? 'deploy' : 'history', { history: value })}
                  onOpen={(id, targetId) =>
                    void nativeAction(async () => {
                      const next = await desktop!.readTask(id);
                      setInspected(
                        Math.max(
                          0,
                          next.targets.findIndex((r) => r.target.id === targetId),
                        ),
                      );
                      openTask(scoped ? 'deploy' : 'history', { task: next });
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
          taskRunning ||
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
        task={taskRunning && currentTask && <button className="sidebar-link sidebar-task"
          aria-current={page === 'task' && !historySnapshot && task?.id === currentTask.id ? 'page' : undefined}
          onClick={() => {
            setInspected(-1);
            openTask();
          }} aria-label="当前任务">
          <Activity size={16} aria-hidden="true" /><span>当前任务</span><small>{taskProgress(currentTask)}%</small>
        </button>}
        global={[
          ...nav.filter((n) => n.page !== 'deploy').map((n) => ({ ...n })),
          ...(desktop ? [{ page: 'schedules' as const, name: '发布计划', icon: CalendarClock }] : []),
          ...(desktop ? [{ page: 'release-manifest' as const, name: '发布清单', icon: ListOrdered }] : []),
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
            icon={page === 'deploy' && db.services.length ? <EntityIconView kind="service" icon={service.icon} size={20} strokeWidth={1.5} /> : page === 'settings' ? <SettingsIcon size={18} strokeWidth={1.5} /> : undefined}
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
        <main ref={mainRef} className={page === 'task' || page === 'images' ? 'main-task' : page === 'deploy' || page === 'release-manifest' ? 'main-service' : 'main-page'}>
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
                  disabled={taskRunning}
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
                    blocked={taskRunning ? '有部署或回滚正在执行，请等待结束。' : undefined}
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
                        const toggleDetails = () => setExpanded((old) => open ? old.filter((id) => id !== t.id) : [...old, t.id]);
                        return <DeploymentTargetRow key={t.id} target={t} server={s}
                          checked={selected.includes(t.id)} onChecked={() => toggleTarget(t)} open={open} onOpen={toggleDetails}
                          backup={b} onBackup={(value) => changeBackup(t.id, value)} overridden={!!overrides[t.id]}
                          onRestore={() => setOverrides((old) => { const next = { ...old }; delete next[t.id]; return next; })}
                          onCopy={(value) => void copy(value)} onEdit={() => setDialog({ kind: 'target', value: t })}
                          onLogs={desktop ? () => openOperations(t, true) : undefined}>
                          {desktop && <TargetObservationOverride target={t} override={observationOverrides[t.id]}
                            onChange={(value) => setObservationOverrides((old) => {
                              const next = { ...old };
                              if (value) next[t.id] = value;
                              else delete next[t.id];
                              return next;
                            })} />}
                        </DeploymentTargetRow>;
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
                    <DeployFailurePolicy value={failureOverride} fallback={db.settings.failurePolicy} onChange={setFailureOverride} />
                    {desktop && <Button variant="neutral" disabled={busy || taskRunning || !!blockReason || !chosen.length} onClick={() => void launch(chosen, undefined, true)}>试运行（远程只读）</Button>}
                    <Button disabled={busy || (!taskRunning && (!!blockReason || !chosen.length || (!desktop && build === 'existing' && !artifact.exists)))} onClick={() => void launch()}>
                      <Rocket size={15} />{taskRunning ? '查看当前任务' : '部署'}
                    </Button>
                    {desktop && <MoreMenu iconOnly label="发布选项" trigger={<ChevronDown size={15} />} actions={[
                      { label: '定时发布', disabled: busy || taskRunning || !!blockReason || !chosen.length, onClick: () => void launch(chosen, undefined, false, true) },
                      { label: '部署预设', onClick: () => setDialog({ kind: 'presets' }) },
                    ]} />}
                  </div>
                </>}
            </section>
          )}
          {page === 'schedules' && desktop && (
            <ReleaseSchedules
              plans={schedules}
              services={db.services}
              busy={busy || taskRunning}
              initialView={scheduleView.current}
              onViewChange={rememberScheduleView}
              onOpen={(id, planId) =>
                void nativeAction(async () => {
                  const value = currentTask?.id === id ? currentTask : await desktop!.readTask(id);
                  if (scheduleView.current) scheduleView.current = { ...scheduleView.current, openedPlan: planId };
                  setInspected(-1);
                  openTask('schedules', { task: value });
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
          {page === 'services' && <ServicesWorkspace db={db} taskRows={taskRows} onAdd={() => setDialog({ kind: 'service', value: { ...newService(), id: uid() } })} onPickIcon={(id) => pickIcon('service', id)} renderActions={serviceActions} />}
          {page === 'targets' && <TargetsWorkspace db={db} serviceId={serviceId} runtime={runtime} onService={selectService} onAdd={() => setDialog({ kind: 'target', value: newTarget() })} onPickIcon={(id) => pickIcon('target', id)} renderActions={targetActions} />}
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
              onPickIcon={(id) => pickIcon('server', id)}
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
          {page === 'release-manifest' && desktop && (
            <ReleaseManifest api={desktop} db={db} run={releaseRun} liveTask={currentTask} showRun={releaseShowRun} setShowRun={setReleaseShowRun}
              draft={releaseDraft} setDraft={setReleaseDraft} saved={saved} board={serviceScrollRef}
              policy={releasePolicy} onPolicy={setReleasePolicy}
              blocked={busy || taskRunning || !!recovery || unfinished.length > 0}
              onCopy={(value) => void copy(value)}
              onHistory={(releaseId) => {
                historyViews.current.set('all', releaseHistoryView(releaseId));
                setPage('history');
              }}
              onEditTarget={(value) => setDialog({ kind: 'target', value })}
              onTask={(id) => void nativeAction(async () => {
                const value = currentTask?.id === id ? currentTask : await desktop!.readTask(id);
                setInspected(-1);
                openTask('release-manifest', { task: value });
              })} />
          )}
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
              migrationBlock={taskRunning ? '任务执行或取消中，不能迁移数据目录。' : unfinished.length ? '有未处理的中断任务，请先核实结果再迁移。' : undefined}
              busy={taskRunning}
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
          {page === 'task' && historySnapshot && (
            <section className="task-page history-snapshot-page">
              <header className="task-page-header">
                <div className="task-title">
                  <h1>{historySnapshot.service.name} · {historySnapshot.target.name} · 历史记录</h1>
                </div>
                <Button variant="neutral" size="compact" onClick={returnFromTask}>
                  <ArrowLeft size={15} />{taskReturnPage === 'deploy' ? '返回发布记录' : '返回部署历史'}
                </Button>
              </header>
              {db.history.filter((record) => record.taskId === historySnapshot.taskId).length > 1 && (
                <div className="task-target-tabs" role="group" aria-label="选择任务目标">
                  {db.history.filter((record) => record.taskId === historySnapshot.taskId).map((record) =>
                    <Button key={record.id} variant="neutral" size="compact"
                      aria-pressed={record.id === historySnapshot.id}
                      onClick={() => setHistorySnapshot(record)}>{record.target.name}</Button>)}
                </div>
              )}
              <div className="history-snapshot-scroll" key={historySnapshot.id}>
                <HistoryDetail value={historySnapshot} fullPage
                  taskRecord={db.taskHistory[historySnapshot.taskId]}
                  canRollback={canRollback(historySnapshot)}
                  onRollback={() => {
                    const current = db.targets.find((target) => target.id === historySnapshot.target.id);
                    if (current && canRollback(historySnapshot)) void launch([current], historySnapshot);
                  }}
                  onExport={() => void nativeAction(() => desktop!.exportLogs(historySnapshot.taskId, historySnapshot.target.id))} />
              </div>
            </section>
          )}
          {page === 'task' && task && !historySnapshot && (
                <TaskView
                  key={task.id}
                  task={task}
                  initialFollow={desktopPreferences.followLogs}
                  inspected={viewedTarget}
                  setInspected={setInspected}
                  backLabel={taskReturnPage === 'release-manifest' ? '返回发布清单' : taskReturnPage === 'schedules' ? '返回发布计划' : taskReturnPage === 'history' ? '返回部署历史' : taskReturnPage === 'deploy' ? '返回部署' : '返回'}
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
      {iconPicker && (
        <IconPicker
          kind={iconPicker.kind}
          current={iconPickerEntity?.icon}
          onPick={setEntityIcon}
          onClose={() => setIconPicker(null)}
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
              if (!dialog.plan) {
                setFailureOverride(null);
                setOverrides({});
                setObservationOverrides({});
                if (scheduleView.current)
                  scheduleView.current = { ...scheduleView.current, filter: 'pending', openedPlan: undefined };
              }
              setDialog(null);
              setPage('schedules');
              void desktop.listSchedules().then(setSchedules).catch(() => {
                notify('计划已保存，列表刷新失败。');
              });
              return;
            }
            if (desktop) {
              const started = await desktop!.start(dialog.token!, values, approval);
              setTask(started);
            } else if (fixture) {
              credentials.current.set(values);
              setTask(startTask(t));
            }
            if (!t.dryRun && t.operation === 'deploy') {
              setFailureOverride(null);
              setOverrides({});
              setObservationOverrides({});
            }
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
                  const recovered = await desktop!.recover(nativeDialog.recover!.id, values);
                  setTask(recovered);
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

/** 首次配置与日常工作共用同一外壳，空配置不生成示例服务器。 */
export default function App({ boot }: { boot?: Startup } = {}) {
  return <Workspace boot={boot} />;
}
