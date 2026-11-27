import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  utilityProcess,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { LogSessions, observeTask } from './observation';
import { OnlineLogs, onlineSearchSchema } from './online-logs';
import { Storage } from './storage';
import { AppUpdater } from './app-updater';
import { createUpdateFetch } from './update-network';
import { launchInstallerAfterExit } from './update-installer';
import { DesktopPreferenceStore, fitWindow, preferencesSchema } from './desktop-preferences';
import { createTrayPanel } from './tray-panel';
import { backgroundUpdates } from './background-updates';
import type { DesktopPreferences, UpdatePolicy } from '../src/desktop-preferences';
import { cleanCompletedInstallerBackups, dataPaths, DirectoryLocator } from './data-paths';
import { plainPath } from './managed-path';
import { allowedProjectLink } from '../src/update-links';
import { prepareDataHome, recoverDataHome, testLocator } from './data-home';
import { singleInstance } from './single-instance';
import { windowsRoot } from './system-paths';
import { migrationDestination, DataDirectory } from './data-directory';
import { BackupManager } from './backup-manager';
import { WorkbenchRecovery } from './workbench-recovery';
import { workbenchHeader, workbenchPath, workbenchScope } from './workbench';
import { ReleaseScheduler, validScheduleTime, scheduleConfiguration, schedulePins } from './scheduler';
import { SerialRelease } from './serial-release';
import { pendingSchedule } from '../src/schedules';
import { ServiceOperations } from './service-operations';
import { confirmProduction } from '../src/presentation';
import { parseApproval } from './validate';
import { Controller } from './controller';
import { detectJdks, inspectJar, checkJdk, resolveBuild, serviceInfo } from './files';
import { runBatch, runProcess } from './process';
import { ImageJobs, imageBuildSchema, imageDistributions, imageEngineSchema, imageIdSchema, imageSourceSchema, probeImageEngine } from './images';
import { checkImageImport } from './image-import';
import type { ImageCheck, ImageSource } from '../src/images';
import { validateDatabase, parseServer } from './validate';
import {
  aliases,
  diagnose,
  localDifferences,
  localPrecheck,
  sameServer,
  toolInfo,
} from './workspace';
import { MemoryCredentials } from './native-capabilities';
import { taskNotice, taskProgress, taskWindowTitle } from '../src/presentation';
import { HistorySearch } from './history-services';
import { deploymentReport } from '../src/report';
import { createTransport, systemSsh, mustExec } from './ssh';
import { shellQuote, safeConfigJson, validDatabase } from '../src/model';
import type { DesktopEvent } from '../src/platform';
import type { WorkerMessage } from './contracts';

app.setName('YOTOO 部署中心');
const windowsAppId = 'local.deploycenter.desktop';
if (process.platform === 'win32') app.setAppUserModelId(windowsAppId);
const defaultDataDir = path.resolve(
  process.env.DEPLOY_CENTER_DATA_DIR ||
    path.join(app.getPath('appData'), app.isPackaged ? 'DeployCenter' : 'DeployCenter-Development'),
);
const legacySettingsDir = process.env.DEPLOY_CENTER_DATA_DIR
  ? path.resolve(
      process.env.DEPLOY_CENTER_SETTINGS_DIR ||
        path.join(path.dirname(defaultDataDir), 'settings-' + path.basename(defaultDataDir)),
    )
  : path.join(
      process.env.LOCALAPPDATA || app.getPath('appData'),
      app.isPackaged ? 'DeployCenter' : 'DeployCenter-Development',
      'Settings',
    );
const nativeHelper = path.join(
  app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'dist-electron'),
  app.isPackaged ? 'update-handoff.exe' : 'update-helper.exe',
);
const isolated = process.env.DEPLOY_CENTER_TESTING === '1' || process.platform !== 'win32';
const locator = isolated
  ? testLocator(legacySettingsDir)
  : new DirectoryLocator(nativeHelper, !app.isPackaged);
const home = (() => {
  while (true) {
    try {
      const value = prepareDataHome(
        defaultDataDir,
        legacySettingsDir,
        locator,
        isolated
          ? []
          : [
              {
                source: path.join(path.dirname(legacySettingsDir), 'InstallerLogs'),
                target: path.join('logs', 'installer', 'legacy'),
              },
              {
                source: path.join(path.dirname(legacySettingsDir), 'InstallerRollback'),
                target: path.join('installer-backups', 'legacy'),
              },
              ...(app.isPackaged
                ? [
                    {
                      source: path.join(
                        process.env.LOCALAPPDATA || app.getPath('appData'),
                        'deploy-center-updater',
                      ),
                      target: 'Updates',
                      installerCache: true,
                    },
                  ]
                : []),
            ],
      );
      if (
        value.configured &&
        !fs.existsSync(path.join(value.directory, 'deploy-center.sqlite')) &&
        !fs.existsSync(path.join(value.runtimeRoot, 'deploy-center.sqlite'))
      )
        throw new Error('指定目录不可访问或缺少已有数据库：' + value.directory);
      for (const dir of [
        dataPaths(value.runtimeRoot).runtime,
        dataPaths(value.runtimeRoot).temp,
        dataPaths(value.runtimeRoot).crashes,
      ])
        fs.mkdirSync(dir, { recursive: true });
      return value;
    } catch (error) {
      if (isolated) throw error;
      const selected = spawnSync(
        nativeHelper,
        ['--choose-data-directory', Buffer.from(String(error), 'utf8').toString('base64')],
        { windowsHide: true, encoding: 'utf8' },
      );
      if (selected.status !== 0) {
        app.exit(selected.status === 2 ? 0 : 1);
        throw error;
      }
      try {
        locator.write(
          recoverDataHome(Buffer.from(selected.stdout.trim(), 'base64').toString('utf8')),
        );
      } catch (recoveryError) {
        dialog.showErrorBox('所选目录无法恢复，原数据已保留', String(recoveryError));
      }
    }
  }
})();
let dataDir = home.directory;
const directories = new DataDirectory(
  home.paths.control,
  defaultDataDir,
  [
    ...(process.platform === 'win32' ? [windowsRoot()] : []),
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(
      (value): value is string => !!value,
    ),
    path.dirname(app.getPath('exe')),
  ],
  true,
  home.directory,
);
const runtimePaths = dataPaths(home.runtimeRoot);
for (const directory of [runtimePaths.runtime, runtimePaths.temp, runtimePaths.crashes])
  fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', runtimePaths.runtime);
app.setPath('sessionData', runtimePaths.runtime);
app.setPath('temp', runtimePaths.temp);
app.setPath('crashDumps', runtimePaths.crashes);
app.setAppLogsPath(runtimePaths.applicationLogs);
// 只修改当前进程环境，子进程临时文件跟随数据目录，不修改系统环境变量。
process.env.TEMP = runtimePaths.temp;
process.env.TMP = runtimePaths.temp;
let migrating = false,
  pendingRestart = false,
  dataNotice: string | undefined;
const readOnlyDuringMigration = new Set([
  'load',
  'release-state',
  'operations-list',
  'startup-painted',
  'data-directory',
  'migration-state',
  'cancel-migration',
  'restart',
  'read-task',
  'list-schedules',
  'list-tasks',
  'read-logs',
  'open-data-dir',
  'help',
  'about',
  'update-state',
  'desktop-preferences',
  'open-update-cache',
  'copy-text',
  'open-update-link',
  'cancel-update',
]);
let instance: Awaited<ReturnType<typeof singleInstance>> | undefined;
let activationPending = false;
let activateWindow: (() => void) | undefined;
const activate = () => {
  if (activateWindow) activateWindow();
  else activationPending = true;
};
const startup = async () => {
  if (process.platform === 'win32') {
    instance = await singleInstance(
      process.env.DEPLOY_CENTER_TESTING === '1'
        ? legacySettingsDir
        : app.isPackaged
          ? 'production'
          : 'development',
      activate,
    );
    if (!instance.primary) {
      app.quit();
      return;
    }
  } else if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  home.prepareProfile();
  await boot();
};
void startup().catch(async (error) => {
  await app.whenReady();
  await dialog.showMessageBox({
    type: 'error',
    message: '数据目录无法初始化，原数据已保留',
    detail: String(error),
  });
  app.quit();
});
let win: BrowserWindow | undefined, storage: Storage, controller: Controller;
let confirmedScheduleExit = false;
let scheduler: ReleaseScheduler | undefined;
let updater: AppUpdater | undefined;
let trayPanel: ReturnType<typeof createTrayPanel> | undefined;
let setBackgroundUpdatePolicy: ((policy: UpdatePolicy, checkOnStartup?: boolean) => void) | undefined;
let explicitExit = false;
let backups: BackupManager;
let workbench: WorkbenchRecovery;
const approvedJars = new Set<string>();
const historySearch = new HistorySearch();
const pendingLocks = new Map<
  string,
  { targetId: string; owner: string; created: number; credential?: string; until: number }
>();
let observeAfter:
  | ((task: import('../src/model').Task, credentials: Record<string, string>) => void)
  | undefined;
let onSchedulesChanged: (() => void) | undefined;
const mainWindowTitle = (title = 'YOTOO 部署中心') =>
  app.isPackaged ? title : '开发版 · ' + title;
const emit = (event: DesktopEvent) => {
  if (event.kind === 'schedules') {
    try { onSchedulesChanged?.(); } catch { /* 系统通知失败不能改变已保存的计划或部署结果。 */ }
  }
  if (win && !win.isDestroyed()) {
    if (event.kind === 'task') {
      win.setTitle(mainWindowTitle(taskWindowTitle(event.task)));
      win.setProgressBar(taskProgress(event.task), {
        mode: event.task.status === 'cancelling' ? 'paused' : 'normal',
      });
    }
    win.webContents.send('deploy:event', event);
  }
  if (event.kind === 'task' || event.kind === 'schedules' || event.kind === 'database' || event.kind === 'desktop-preferences')
    trayPanel?.refresh();
};
const sessions = new LogSessions(emit);
const onlineLogs = new OnlineLogs(sessions, emit, async (name) => {
  if (!win || win.isDestroyed()) throw new Error('请打开主窗口后下载日志。');
  const result = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
  });
  return result.canceled ? undefined : result.filePath;
});
const notified = new Set<string>();
const finishedTask = (task: import('../src/model').Task, credentials: Record<string, string>) => {
  if (
    !win ||
    win.isDestroyed() ||
    win.isFocused() ||
    process.platform !== 'win32' ||
    process.env.DEPLOY_CENTER_TESTING === '1'
  )
    return;
  const key = task.id + ':' + task.status + ':' + task.endedAt;
  if (notified.has(key)) return;
  notified.add(key);
  win.flashFrame(true);
  if (storage.database().settings.notifications === false || !Notification.isSupported()) return;
  const redactor = new MemoryCredentials(credentials);
  const body = taskNotice(task, (text) => redactor.redact(text));
  redactor.clear();
  const notification = new Notification({
    title: 'YOTOO 部署中心',
    body,
    silent: storage.database().settings.notificationSound === false,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
  });
  notification.on('click', () => {
    activate();
    emit({ kind: 'open-task', taskId: task.id });
  });
  notification.show();
};
const text = (v: unknown, max = 32760) => z.string().max(max).parse(v);
const id = (v: unknown) =>
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,150}$/)
    .parse(v);
async function boot() {
  await app.whenReady();
  try {
    while (true) {
      try {
        const location = await directories.locate();
        dataDir = location.directory;
        dataNotice = location.notice;
        break;
      } catch (error) {
        const choice = await dialog.showMessageBox({
          type: 'warning',
          title: '选择数据目录恢复方式',
          message: '原数据位置无法读取，不会自动创建空配置',
          detail: String(error),
          buttons: ['重新指定已有数据目录', '明确改用默认目录', '退出'],
          defaultId: 2,
          cancelId: 2,
        });
        if (choice.response === 2) {
          app.quit();
          return;
        }
        if (choice.response === 0) {
          const selected = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: '选择包含现有数据库的数据目录',
          });
          if (selected.canceled) continue;
          try {
            directories.selectExisting(selected.filePaths[0]);
          } catch (e) {
            await dialog.showMessageBox({
              type: 'error',
              message: '该目录不可用',
              detail: String(e),
            });
          }
        } else {
          directories.selectExisting(directories.defaultDir, true);
          dataDir = directories.defaultDir;
          dataNotice = '已按明确选择使用默认目录；原自定义目录未删除。';
          break;
        }
      }
    }
    if (dataDir !== home.runtimeRoot) {
      // 恢复对话框选择了其他位置，须重新启动后再初始化浏览器会话，避免写回旧目录。
      directories.rehome(dataDir);
      locator.write(dataDir);
      app.relaunch(); app.quit(); return;
    }
    directories.rehome(dataDir);
    storage = new Storage(dataDir, {
      async encrypt(value) {
        if (!(await safeStorage.isAsyncEncryptionAvailable()))
          throw new Error('Windows 加密不可用，无法保存口令；请选择每次询问');
        return safeStorage.encryptStringAsync(value);
      },
      async decrypt(value) {
        try {
          return (await safeStorage.decryptStringAsync(value)).result;
        } catch {
          throw new Error('已存凭据无法解密，请重新输入并保存');
        }
      },
    });
    directories.markOwned(dataDir);
    dataNotice = [dataNotice, home.complete(dataDir)].filter(Boolean).join('；') || undefined;
    storage.markInterrupted();
    if (app.isPackaged && process.platform === 'win32')
      void cleanCompletedInstallerBackups(dataDir).catch((error) => console.warn('安装备份清理失败', error));
    await storage.maintainStartup();
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
    const imageJobs = new ImageJobs(dataDir, {
      job: (job) => emit({ kind: 'image-job', job }),
      log: (id, chunks) => emit({ kind: 'image-log', id, chunks }),
    });
    const approvedImagePaths = new Map<string, Set<string>>();
    let operations: ServiceOperations;
    let release: SerialRelease | undefined;
    const releaseBusy = () => release?.active() === true;
    controller = new Controller(
      storage,
      (onMessage, onExit) => {
        const child = utilityProcess.fork(path.join(__dirname, 'worker.cjs'), [], {
          stdio: 'pipe',
          serviceName: 'YOTOO 部署中心 Engine',
        });
        child.on('message', (value) => onMessage(value as WorkerMessage));
        child.on('exit', onExit);
        child.stderr?.on('data', () => {});
        return { send: (value) => child.postMessage(value), close: () => child.kill() };
      },
      (event) => {
        if (event.kind === 'task' && event.committed) release?.observe(event.task);
        emit(event);
      },
      {
        releaseActive: releaseBusy,
        operationBlock: (task) =>
          operations?.isBusy() ? '服务运维正在执行，请等待结束' :
            task.dryRun ? undefined : task.targets.map((run) => operations?.reason(workbenchScope(run.target, run.server))).find(Boolean),
        onFinished: (task, credentials) => {
          try {
            finishedTask(task, credentials);
          } finally {
            observeAfter?.(task, credentials);
          }
        },
      },
    );
    backups = new BackupManager(
      storage,
      (server, credential) =>
        createTransport(server, {
          credential,
          pins: storage.pins(),
          trust: (r, k) => controller.trust.request(r, k),
        }),
      (record) => {
        emit({ kind: 'maintenance', record });
        emit({ kind: 'database', database: storage.database() });
      },
    );
    workbench = new WorkbenchRecovery(
      storage,
      (server, credential) => createTransport(server, {
        credential,
        pins: storage.pins(),
        trust: (r, k) => controller.trust.request(r, k),
      }),
      () => !controller.active() && !releaseBusy() && !backups.isBusy() && !storage.artifacts.isBusy(),
    );
    operations = new ServiceOperations(
      storage,
      async (server, supplied, signal) => {
        const secret = supplied || (server.credentialMode === 'windows' ? await storage.credential(server.id) : '') || '';
        if (server.auth === 'password' && !secret) throw new Error('请输入登录密码');
        return {
          secret,
          transport: createTransport(server, {
            credential: secret, signal, pins: storage.pins(),
            trust: (request, key) => controller.trust.request(request, key),
          }),
        };
      },
      () => controller.active() || releaseBusy() || scheduler?.isDispatching() ? '有部署、回滚或定时发布任务正在执行' :
        migrating || pendingRestart || backups.isBusy() || workbench.isBusy() ? '其他远程维护或数据迁移正在进行' :
        storage.recovery || storage.hasUnreadableTasks() || storage.unfinished().length ? '请先核实中断部署或恢复记录' :
        undefined,
      (record) => emit({ kind: 'operation', record: { ...record } }),
    );
    const assertNoRelease = () => {
      if (releaseBusy()) throw new Error('串行发布清单正在执行，请等待或取消清单');
    };
    const prepareDeployment = (value: unknown, owned = false) => {
      const request = z.object({ jarPath: z.string().optional() }).passthrough().parse(value);
      if (
        request.jarPath &&
        !approvedJars.has(path.resolve(request.jarPath)) &&
        !storage.database().services.some(
          (s) => path.resolve(s.root, s.jarDir, s.jarName) === path.resolve(request.jarPath!),
        ) &&
        !storage.artifacts.sources().some((s) => s.path === request.jarPath)
      )
        throw new Error('请通过系统对话框选择 JAR，或使用服务配置的产物');
      return controller.prepare(value, owned);
    };
    release = new SerialRelease({
      prepare: prepareDeployment,
      start: (token, credentials, approval, releaseId, beforeLaunch) =>
        controller.start(token, credentials, approval, undefined, releaseId, beforeLaunch),
      cancel: (taskId) => controller.cancel(taskId),
      readTask: (taskId) => storage.task(taskId),
      active: () => controller.active(),
      unfinished: () => storage.unfinished().length > 0,
      blocked: () =>
        migrating || pendingRestart ? '请先完成数据迁移并重启' :
        updater?.isInstalling() ? '正在准备安装更新' :
        scheduler?.isDispatching() ? '定时发布正在启动，请稍后再操作' :
        imageJobs.busy() || backups.isBusy() || workbench.isBusy() || operations.isBusy() || storage.artifacts.isBusy()
          ? '请等待镜像任务、远程维护或本地清理结束' : undefined,
    }, (run) => storage.saveReleaseRun(run), (run) => emit({ kind: 'release-run', run }), storage.releaseRun());
    const scheduleNotices = new Map<string, string>();
    const scheduleChanged = () => {
      const plans = storage.schedules();
      for (const plan of plans) {
        const previous = scheduleNotices.get(plan.id);
        scheduleNotices.set(plan.id, plan.state);
        if (
          previous &&
          previous !== plan.state &&
          ['failed', 'missed', 'confirmation', 'ready'].includes(plan.state) &&
          process.env.DEPLOY_CENTER_TESTING !== '1' &&
          storage.database().settings.notifications !== false &&
          Notification.isSupported()
        ) {
          const notification = new Notification({
            title: 'YOTOO 部署中心',
            body:
              plan.state === 'ready'
                ? '定时发布产物已准备完成'
                : '定时发布需要处理，请查看发布计划',
            silent: storage.database().settings.notificationSound === false,
          });
          notification.on('click', () => {
            activate();
            emit({ kind: 'open-schedules' });
          });
          notification.show();
        }
      }
    };
    onSchedulesChanged = scheduleChanged;
    const publishSchedules = () => emit({ kind: 'schedules', schedules: storage.schedules() });
    const confirmScheduleExit = async () => {
      if (confirmedScheduleExit || !storage.schedules().some(pendingSchedule)) return true;
      const choice = await dialog.showMessageBox(win!, {
        type: 'warning',
        message: '仍有待发布计划',
        detail: '退出或重启后暂停定时调度，错过时间不会自动补发。',
        buttons: ['继续运行', '退出或重启'],
        defaultId: 0,
        cancelId: 0,
      });
      confirmedScheduleExit = choice.response === 1;
      return confirmedScheduleExit;
    };
    scheduler = new ReleaseScheduler(
      storage,
      controller,
      () =>
        migrating ||
        pendingRestart ||
        releaseBusy() ||
        !!updater?.isInstalling() ||
        imageJobs.usingMaven() ||
        backups.isBusy() ||
        workbench.isBusy() ||
        operations.isBusy() ||
        storage.artifacts.isBusy(),
      publishSchedules,
    );
    scheduler.start();
    powerMonitor.on('suspend', () => scheduler?.suspend());
    powerMonitor.on('resume', () => scheduler?.resume());
    const page = path.join(__dirname, '..', 'dist', 'index.html');
    const url = pathToFileURL(page).href;
    const smoke = process.argv.includes('--smoke');
    const toolbarColor = () => nativeTheme.shouldUseDarkColors ? '#e4e4e7' : '#18181b';
    const windowsChrome = process.platform === 'win32';
    const icon = path.join(__dirname, '..', 'assets', 'icon.ico');
    const executable = app.getPath('exe');
    const installed = app.isPackaged && windowsChrome && process.arch === 'x64' &&
      fs.existsSync(path.join(path.dirname(executable), 'Uninstall ' + path.basename(executable)));
    const testing = process.env.DEPLOY_CENTER_TESTING === '1' || smoke;
    const login = { path: executable, args: ['--login-start'] };
    const preferences = new DesktopPreferenceStore(dataDir);
    let tutorialInstallId: string | undefined;
    if (!smoke && (installed || testing)) {
      try {
        const marker = plainPath(path.join(dataPaths(dataDir).control, 'install-tutorial.id'));
        tutorialInstallId = preferencesSchema.shape.tutorialInstallId.parse(fs.readFileSync(marker, 'utf8'));
      } catch { /* 没有新安装标记时，教学向导仍可从设置打开。 */ }
    }
    const pendingTutorial = () => tutorialInstallId !== preferences.preferences.tutorialInstallId
      ? tutorialInstallId : undefined;
    if (installed && !testing)
      preferences.preferences.launchAtLogin = app.getLoginItemSettings(login).openAtLogin;
    const savedWindow = preferences.preferences.rememberWindow ? preferences.window : undefined;
    const bounds = savedWindow && fitWindow(savedWindow, screen.getDisplayMatching(savedWindow).workArea);
    const startInTray = !testing && process.argv.includes('--login-start') && preferences.preferences.closeToTray;
    nativeTheme.themeSource = storage.database().settings.theme;
    win = new BrowserWindow({
      width: 1000,
      height: 650,
      ...bounds,
      minWidth: 900,
      autoHideMenuBar: true,
      minHeight: 600,
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
      title: mainWindowTitle(),
      ...(windowsChrome ? {
        opacity: smoke ? 1 : 0,
        titleBarStyle: 'hidden',
        titleBarOverlay: { color: '#00000000', symbolColor: toolbarColor(), height: 52 },
      } : {}),
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        zoomFactor: preferences.preferences.zoom / 100,
        devTools: !app.isPackaged,
      },
    });
    // 开发版窗口标题由主进程维护，避免页面加载时用静态标题覆盖标记。
    if (!app.isPackaged) win.on('page-title-updated', (event) => event.preventDefault());
    if (process.platform === 'win32' && app.isPackaged) {
      const executable = app.getPath('exe');
      const installedIcon = path.join(path.dirname(executable), 'deploy-center.ico');
      win.setAppDetails({
        appId: windowsAppId,
        appIconPath: fs.existsSync(installedIcon) ? installedIcon : executable,
        appIconIndex: 0,
        relaunchCommand: '"' + executable + '"',
        relaunchDisplayName: app.name,
      });
    }
    let restoreMaximized = Boolean(savedWindow?.maximized && !smoke);
    let startupPainted = false;
    let showOnStartup = !smoke && (!startInTray || activationPending);
    const foreground = () => {
      if (!win || win.isDestroyed()) return;
      if (!startupPainted && !smoke) {
        showOnStartup = true;
        return;
      }
      if (win.isMinimized()) win.restore();
      if (restoreMaximized) {
        restoreMaximized = false;
        win.maximize();
      }
      if (!win.isVisible() && !win.isMaximized()) {
        const current = win.getBounds();
        const visible = fitWindow(current, screen.getDisplayMatching(current).workArea);
        if (current.x !== visible.x || current.y !== visible.y ||
            current.width !== visible.width || current.height !== visible.height)
          win.setBounds(visible);
      }
      win.show();
      win.focus();
      const notice = startInTray ? pendingTutorial() : undefined;
      if (notice) emit({ kind: 'show-install-tutorial', id: notice });
    };
    activateWindow = foreground;
    const applyZoom = () => win?.webContents.setZoomFactor(preferences.preferences.zoom / 100);
    win.webContents.on('did-finish-load', applyZoom);
    let saveBoundsTimer: ReturnType<typeof setTimeout> | undefined;
    const captureBounds = () => {
      if (!preferences.preferences.rememberWindow || migrating || pendingRestart || smoke || !win || win.isDestroyed() || win.isMinimized()) return;
      try { preferences.save(preferences.preferences, { ...win.getNormalBounds(), maximized: win.isMaximized() }); }
      catch (error) { console.warn('写入窗口位置失败', error); }
    };
    const queueBoundsSave = () => {
      clearTimeout(saveBoundsTimer);
      saveBoundsTimer = setTimeout(captureBounds, 300);
    };
    win.on('move', queueBoundsSave);
    win.on('resize', queueBoundsSave);
    win.on('maximize', queueBoundsSave);
    win.on('unmaximize', queueBoundsSave);
    const savePreferences = (value: unknown) => {
      const previous = preferences.preferences;
      const next: DesktopPreferences = { ...previous, ...preferencesSchema.partial().parse(value) };
      if (next.launchAtLogin !== previous.launchAtLogin) {
        if (!installed || testing) throw new Error('开机启动仅在正式 Windows 安装版中可设置');
        app.setLoginItemSettings({ ...login, openAtLogin: next.launchAtLogin });
        if (app.getLoginItemSettings(login).openAtLogin !== next.launchAtLogin)
          throw new Error('Windows 未保存开机启动设置');
      }
      try { preferences.save(next); }
      catch (error) {
        if (next.launchAtLogin !== previous.launchAtLogin)
          app.setLoginItemSettings({ ...login, openAtLogin: previous.launchAtLogin });
        throw error;
      }
      if (next.rememberWindow && !previous.rememberWindow) captureBounds();
      if (next.zoom !== previous.zoom) applyZoom();
      if (next.updatePolicy !== previous.updatePolicy) setBackgroundUpdatePolicy?.(next.updatePolicy);
      emit({ kind: 'desktop-preferences', preferences: next });
      return next;
    };
    if (windowsChrome && !smoke) {
      try {
        trayPanel = createTrayPanel(icon, () => {
          const db = storage.database();
          const task = storage.latestTask();
          const upcoming = storage.schedules().filter(pendingSchedule)
            .sort((a, b) => a.scheduledAt - b.scheduledAt)[0];
          const recent = new Set([db.lastService, ...db.history.map((item) => item.service.id)]);
          return {
            dark: nativeTheme.shouldUseDarkColors,
            closeToTray: preferences.preferences.closeToTray,
            task: task && controller.active()
              ? { id: task.id, name: task.service.name, progress: Math.max(0, Math.round(taskProgress(task) * 100)) }
              : undefined,
            schedule: upcoming ? { name: upcoming.task.service.name, at: upcoming.scheduledAt } : undefined,
            services: [...recent].map((id) => db.services.find((item) => item.id === id))
              .filter((item) => item !== undefined).slice(0, 5)
              .map(({ id, name, icon }) => ({ id, name, icon })),
          };
        }, (action, id) => {
          if (action === 'toggle') {
            try {
              if (migrating || pendingRestart) throw new Error('请等待数据迁移完成并重启');
              if (updater?.isInstalling()) throw new Error('正在准备安装更新，请稍候');
              const next = savePreferences({ closeToTray: !preferences.preferences.closeToTray });
              if (!next.closeToTray) foreground();
            } catch (error) {
              foreground();
              void dialog.showMessageBox(win!, { type: 'warning', message: String(error) });
            }
            return;
          }
          foreground();
          if (action === 'quit') app.quit();
          if (action === 'settings') emit({ kind: 'open-settings' });
          if (action === 'schedules') emit({ kind: 'open-schedules' });
          if (action === 'service' && id) emit({ kind: 'open-service', serviceId: id });
          if (action === 'task') {
            const latest = storage.latestTask();
            if (latest) emit({ kind: 'open-task', taskId: latest.id });
          }
        });
      } catch (error) { console.warn('无法创建托盘', error); }
    }
    if (!smoke && !trayPanel) showOnStartup = true;
    const syncToolbar = () => {
      if (windowsChrome && win && !win.isDestroyed()) win.setTitleBarOverlay({ symbolColor: toolbarColor() });
      trayPanel?.refresh();
      emit({ kind: 'native-theme', dark: nativeTheme.shouldUseDarkColors });
    };
    nativeTheme.on('updated', syncToolbar);
    win.once('closed', () => nativeTheme.removeListener('updated', syncToolbar));
    win.on('focus', () => win?.flashFrame(false));
    win.webContents.setWindowOpenHandler(({ url: destination }) => {
      // 仅将配置与帮助里的固定仓库链接交给系统浏览器，外部页面不进入桌面窗口。
      if (destination === 'https://github.com/liwl1995/DeployCenter/releases')
        void shell.openExternal(destination).catch(() => {});
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, dest) => {
      if (dest.split('#')[0] !== url) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    const blockedDuringRelease = new Set([
      'prepare', 'start', 'recover', 'create-schedule', 'reschedule',
      'resolve-workbench', 'apply-backups', 'reconcile-backup', 'takeover-lock',
      'operations-run', 'operations-settle', 'image-start-build', 'image-start-import',
      'import-config', 'preview-cleanup', 'apply-cleanup', 'preview-history-retention', 'apply-history-retention',
      'migrate-directory', 'restart', 'remove-old-data',
    ]);
    const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
      ipcMain.handle('deploy:' + name, (event, ...args) => {
        if (
          !win ||
          event.sender.id !== win.webContents.id ||
          event.senderFrame !== win.webContents.mainFrame ||
          event.senderFrame.url.split('#')[0] !== url
        )
          throw new Error('拒绝不受信任的界面请求');
        if (updater?.isInstalling() && name !== 'update-state')
          throw new Error('正在准备安装更新，请勿执行其他操作');
        if ((migrating || pendingRestart) && !readOnlyDuringMigration.has(name))
          throw new Error(
            pendingRestart
              ? '数据迁移已完成，请先重启后再修改配置或部署。'
              : '正在迁移数据，暂时不能执行其他操作。',
          );
        if (blockedDuringRelease.has(name)) assertNoRelease();
        if (storage.artifacts.isBusy() && ['prepare', 'start', 'recover', 'create-schedule', 'reschedule'].includes(name))
          throw new Error('正在整理本地产物，请完成后重新准备部署');
        if (imageJobs.usingMaven() && ['prepare', 'start', 'create-schedule', 'reschedule'].includes(name))
          throw new Error('镜像任务正在使用本地项目构建，请等待完成后再部署');
        if (
          workbench?.isBusy() &&
          ['save', 'prepare', 'start', 'recover', 'takeover-lock', 'import-config',
            'migrate-directory', 'restart', 'remove-old-data', 'apply-cleanup', 'apply-history-retention',
            'apply-backups', 'reconcile-backup', 'create-schedule', 'reschedule'].includes(name)
        )
          throw new Error('正在核实远程工作台，请等待结果后再操作');
        if (
          backups?.isBusy() &&
          [
            'save',
            'prepare',
            'start',
            'create-schedule',
            'reschedule',
            'recover',
            'takeover-lock',
            'import-config',
            'migrate-directory',
            'restart',
            'remove-old-data',
            'apply-cleanup',
            'apply-history-retention',
          ].includes(name)
        )
          throw new Error('正在处理远程备份，请等待结果后再操作');
        if (scheduler?.isDispatching() && !readOnlyDuringMigration.has(name) && !['trust', 'cancel', 'cancel-schedule'].includes(name))
          throw new Error('定时发布正在启动，请稍后再操作');
        if (operations.isBusy() && [
          'prepare', 'start', 'recover', 'create-schedule', 'reschedule', 'takeover-lock',
          'resolve-workbench', 'apply-backups', 'migrate-directory', 'restart', 'import-config',
        ].includes(name)) throw new Error('服务运维正在执行，请等待结束');
        return fn(...args);
      });
    handle('copy-text', (value) => {
      const content = text(value, 16 * 1024 * 1024);
      if (content.includes('\0')) throw new Error('复制内容含有无效字符');
      return clipboard.writeText(content);
    });
    handle('desktop-preferences', () => preferences.preferences);
    handle('startup-painted', async () => {
      if (startupPainted) return;
      startupPainted = true;
      const window = win!;
      if (showOnStartup) {
        foreground();
        if (windowsChrome) {
          // 让 Chromium 先提交窗口画面，再解除透明，避免 Windows 先显示纯色底面。
          try { await window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 }); }
          catch (error) { console.warn('启动画面提交失败', error); }
        }
      }
      if (window.isDestroyed()) return;
      if (windowsChrome && !smoke) window.setOpacity(1);
      if (showOnStartup) await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    });
    handle('save-desktop-preferences', savePreferences);
    updater = new AppUpdater({
      currentVersion: app.getVersion(),
      directory: dataPaths(dataDir).updates,
      fetch: createUpdateFetch((options) => net.request(options)),
      cacheProtection: {
        protect: async (value) => {
          if (!(await safeStorage.isAsyncEncryptionAvailable()))
            throw new Error('无法保存下载校验记录');
          return safeStorage.encryptStringAsync(value);
        },
        unprotect: async (value) => (await safeStorage.decryptStringAsync(value)).result,
      },
      emit: (update) => emit({ kind: 'update', update }),
      installBlocked: () => {
        if (!installed)
          return '请在 Windows x64 安装版中安装更新';
        if (controller.active() || releaseBusy() || storage.unfinished().length)
          return '请先等待部署结束，并核实尚未结束的任务，再安装更新';
        if (migrating || pendingRestart) return '请先完成数据迁移并重启，再安装更新';
        if (imageJobs.busy()) return '镜像任务正在执行，请等待完成后再安装更新';
        if (onlineLogs.isExporting()) return '线上日志正在下载，请完成或取消后再安装更新';
        if (backups.isBusy() || workbench.isBusy() || operations.isBusy() || storage.artifacts.isBusy())
          return '远程维护或本地清理尚未结束，请等待后再安装更新';
        if (scheduler?.isDispatching()) return '定时发布正在启动，请稍后再安装更新';
        return undefined;
      },
      launch: async (file, hash, version) => {
        if (!(await confirmScheduleExit())) throw new Error('已取消安装更新，继续等待发布计划');
        try {
          await launchInstallerAfterExit(
            file,
            hash,
            path.dirname(app.getPath('exe')),
            dataPaths(dataDir).updateLogs,
            nativeHelper,
            runtimePaths.runtime,
            { version, executable },
          );
        } catch (error) {
          confirmedScheduleExit = false;
          throw error;
        }
        // 助手已持有本进程句柄，只会在正常退出后启动安装器。
        setImmediate(() => app.quit());
      },
    });
    if (installed && !testing) {
      setBackgroundUpdatePolicy = backgroundUpdates({
        isBusy: () => updater!.isBusy() || migrating || pendingRestart,
        restore: () => updater!.restore(),
        check: () => updater!.check(),
        download: () => updater!.download(),
      }, (error) => console.warn('后台检查更新失败', error));
    }
    await fsp.mkdir(dataPaths(dataDir).updates, { recursive: true });
    handle('update-state', () => updater!.restore());
    handle('open-update-cache', async () => {
      const location = await updater!.location();
      if (location.file) shell.showItemInFolder(location.file);
      else {
        const error = await shell.openPath(location.directory);
        if (error) throw new Error(error);
      }
    });
    handle('open-update-link', async (value) => {
      const url = text(value, 4096);
      if (!allowedProjectLink(url)) throw new Error('更新说明链接不属于本项目');
      await shell.openExternal(url);
    });
    handle('check-update', () => updater!.check());
    handle('download-update', () => updater!.download());
    handle('cancel-update', () => updater!.cancel());
    handle('install-update', () => updater!.install());
    handle('load', async () => ({
      database: storage.database(),
      version: app.getVersion(),
      development: !app.isPackaged,
      tutorialInstallId: showOnStartup || win?.isVisible() ? pendingTutorial() : undefined,
      recovery: storage.recovery,
      task: storage.latestTask(),
      unfinished: storage.unfinished(),
      deploymentActive: controller.active(),
      dataDir,
      savedCredentials: storage.credentialIds(),
      encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      pendingTrust: controller.trust.current(),
      dataNotice,
      dataUsage: storage.artifacts.usage(),
      taskIssues: storage.taskIssues,
      dataLocation: directories.state(),
      darkTheme: nativeTheme.shouldUseDarkColors,
      preferences: preferences.preferences,
      update: updater?.state(),
      releaseRun: release.get(),
    }));
    handle('save', (value) => {
      const config = validateDatabase(value);
      const saved = storage.saveConfig(config);
      onlineLogs.reconcile(config);
      nativeTheme.themeSource = config.settings.theme;
      return saved;
    });
    handle('confirm-recovery', () => storage.confirmRecovery());
    handle('prepare', (value) => prepareDeployment(value));
    handle('release-state', () => release.get());
    handle('release-import-legacy', (value) => release.importLegacy(text(value, 5 * 1024 * 1024)));
    handle('release-preview', (requests) => release.preview(requests));
    handle('release-start', (token, credentials, approval, policy, resume) =>
      release.begin(text(token, 100), credentials, approval, policy, z.boolean().parse(resume)));
    handle('release-check', () => release.check());
    handle('release-cancel', () => release.cancel());
    handle('release-end', () => release.end());
    handle('start', (token, values, approval) =>
      controller.start(text(token, 100), values, approval),
    );
    handle('list-schedules', () => storage.schedules());
    handle('create-schedule', async (token, values, approval, at, replaces) => {
      const task = await controller.start(text(token, 100), values, approval, {
        at: z.number().int().parse(at),
        replaces: replaces === undefined ? undefined : id(replaces),
      });
      return storage.schedules().find((p) => p.id === task.scheduleId)!;
    });
    handle('cancel-schedule', (value) => {
      const plan = storage.schedules().find((p) => p.id === id(value));
      if (!plan) throw new Error('计划不存在');
      if (plan.state === 'executing') throw new Error('请在关联部署任务中请求安全取消');
      if (plan.state === 'preparing') controller.cancel(plan.preparationId);
      plan.state = 'cancelled';
      plan.reason = '用户已取消计划';
      storage.saveSchedule(plan);
      publishSchedules();
    });
    handle('reschedule', async (value, at, rawApproval) => {
      const scheduledAt = z.number().int().parse(at);
      validScheduleTime(scheduledAt);
      const plan = storage.schedules().find((p) => p.id === id(value));
      if (!plan || ['executing', 'preparing'].includes(plan.state))
        throw new Error('请等待当前准备或部署结束');
      const approval = parseApproval(rawApproval);
      if (
        !confirmProduction(plan.task, approval.productionNames || {}) ||
        (plan.task.targets.some((r) => r.target.hashPolicy === 'size-confirm') &&
          !approval.allowWeak)
      )
        throw new Error('请重新确认正式环境及弱校验策略');
      if (
        scheduleConfiguration(storage.database(), plan.task) !== plan.configuration ||
        schedulePins(plan.task, storage.pins()) !== plan.pins ||
        plan.state === 'confirmation'
      )
        throw new Error('配置、信任或线上基线需要重新核实，请使用重新准备并确认');
      const artifact = await inspectJar(plan.task.artifact.path);
      if (artifact.sha256 !== plan.task.artifact.sha256 || !plan.task.scheduleBaselines)
        throw new Error('没有有效的准备产物，请重新准备');
      // 校验期间计划可能已被触发或取消，禁止覆盖新的状态。
      const current = storage.schedules().find((p) => p.id === plan.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(plan))
        throw new Error('计划状态已变化，请刷新后重试');
      plan.scheduledAt = scheduledAt;
      plan.approval = approval;
      plan.state = 'ready';
      plan.reason = '已重新确认发布时间';
      // 已有真实部署结果不能重用任务身份，再次发布请创建新计划。
      if (plan.taskId && !storage.task(plan.taskId)?.preparation)
        throw new Error('此计划已执行，请重新创建计划');
      storage.saveSchedule(plan);
      publishSchedules();
    });
    handle('cancel', (value) => {
      const taskId = id(value);
      return release.ownsTask(taskId) ? release.cancel() : controller.cancel(taskId);
    });
    handle('recover', (value, creds) => controller.recover(id(value), creds));
    const backupCredential = async (targetId: string, supplied: unknown) => {
      const target = storage.database().targets.find((t) => t.id === targetId),
        server = storage.database().servers.find((s) => s.id === target?.serverId);
      if (!server) throw new Error('目标服务器不存在');
      const credential = supplied
        ? text(supplied, 8192)
        : server.credentialMode === 'windows'
          ? (await storage.credential(server.id)) || ''
          : '';
      if (server.auth === 'password' && !credential) throw new Error('请输入服务器密码');
      return credential;
    };
    handle('inspect-workbench', async (value, supplied) => {
      const targetId = id(value);
      return workbench.inspect(targetId, await backupCredential(targetId, supplied));
    });
    handle('resolve-workbench', async (token, confirmation) => {
      const message = await workbench.resolve(text(token, 100), text(confirmation));
      emit({ kind: 'database', database: storage.database() });
      return message;
    });
    handle('cancel-workbench-review', (token) => workbench.cancel(text(token, 100)));
    handle('preview-backups', async (value, supplied) => {
      const targetId = id(value);
      return backups.preview(targetId, await backupCredential(targetId, supplied));
    });
    handle('cancel-backup-plan', (token) => backups.cancel(text(token, 100)));
    handle('backup-audits', (value) =>
      storage.remoteBackups.audits(value === undefined ? undefined : id(value)),
    );
    handle('apply-backups', (token, ids, word) => {
      if (controller.active()) throw new Error('请等待部署任务结束后再清理远程备份');
      return backups.apply(
        text(token, 100),
        z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(100)
          .parse(ids),
        text(word, 200),
      );
    });
    handle('reconcile-backup', async (value, supplied) => {
      const auditId = id(value),
        audit = storage.remoteBackups.audits().find((r) => r.id === auditId);
      if (!audit) throw new Error('清理记录不存在');
      return backups.reconcile(auditId, await backupCredential(audit.targetId, supplied));
    });
    handle('local-differences', () => {
      if (controller.active()) throw new Error('任务执行中暂不读取本地差异');
      return localDifferences(storage.database());
    });
    handle('search-history', (query) =>
      historySearch.search(dataDir, z.string().trim().min(1).max(200).parse(query)),
    );
    handle('cancel-search', () => historySearch.stop());
    handle('export-report', async (value) => {
      const task = storage.task(id(value));
      if (!task) throw new Error('任务记录不存在');
      const choice = await dialog.showSaveDialog(win!, {
        defaultPath: task.id + '-部署报告.md',
        filters: [{ name: 'Markdown 报告', extensions: ['md'] }],
      });
      if (choice.canceled || !choice.filePath) return false;
      if (!/\.md$/i.test(choice.filePath)) throw new Error('请选择 .md 文件保存 Markdown 报告');
      const targets: Record<string, string[]> = {},
        build = storage.readLogs(task.id, task.targets[0]?.target.id || 'none').build;
      for (const run of task.targets)
        targets[run.target.id] = storage.readLogs(task.id, run.target.id).target;
      const secrets: Record<string, string> = {};
      for (const key of storage.credentialIds())
        try {
          secrets[key] = (await storage.credential(key)) || '';
        } catch {
          /* 任务原始日志在写入前已脱敏，不把凭据本身加入报告。 */
        }
      const redactor = new MemoryCredentials(secrets);
      try {
        await fsp.writeFile(
          choice.filePath,
          deploymentReport(task, { build, targets }, (text) => redactor.redact(text)),
          { encoding: 'utf8', mode: 0o600 },
        );
      } finally {
        redactor.clear();
      }
      return true;
    });
    handle('list-tasks', () => storage.summaries());
    handle('read-task', (value) => {
      const task = storage.task(id(value));
      if (!task) throw new Error('任务记录不存在');
      return task;
    });
    handle('choose', async (value) => {
      const kind = z.enum(['directory', 'jar', 'key', 'maven', 'dockerfile', 'image-archive']).parse(value);
      const result = await dialog.showOpenDialog(
        win!,
        kind === 'directory'
          ? { properties: ['openDirectory'] }
          : {
              properties: ['openFile'],
              filters:
                kind === 'jar'
                  ? [{ name: 'Java JAR', extensions: ['jar'] }]
                  : kind === 'maven'
                    ? [{ name: 'Maven', extensions: ['cmd', 'bat', 'exe'] }]
                    : kind === 'image-archive'
                      ? [{ name: 'Docker 镜像包', extensions: ['tar', 'gz'] }]
                      : [{ name: kind === 'dockerfile' ? 'Dockerfile' : 'SSH 私钥', extensions: ['*'] }],
            },
      );
      if (result.canceled) return null;
      if (kind === 'jar') approvedJars.add(path.resolve(result.filePaths[0]));
      if (kind === 'dockerfile' || kind === 'directory' || kind === 'image-archive') {
        const approved = approvedImagePaths.get(kind) || new Set<string>();
        approved.add(path.resolve(result.filePaths[0]));
        approvedImagePaths.set(kind, approved);
      }
      return result.filePaths[0];
    });
    handle('inspect-jar', (value) => {
      const file = path.resolve(text(value));
      if (
        !approvedJars.has(file) &&
        !storage.database().services.some((s) => path.resolve(s.root, s.jarDir, s.jarName) === file)
      )
        throw new Error('请选择服务产物或通过系统对话框选择文件');
      return inspectJar(file);
    });
    handle('service-info', (value, selected) => {
      const service = storage.database().services.find((s) => s.id === id(value));
      if (!service) throw new Error('服务不存在');
      const file = selected === undefined ? undefined : path.resolve(text(selected));
      if (
        file &&
        !approvedJars.has(file) &&
        path.resolve(service.root, service.jarDir, service.jarName) !== file &&
        !storage.artifacts.sources().some((s) => path.resolve(s.path) === file)
      )
        throw new Error('请选择服务产物或通过系统对话框选择文件');
      return serviceInfo(service, file);
    });
    handle('approve-dropped-jar', async (value) => {
      const file = text(value);
      if (!path.isAbsolute(file))
        throw new Error('拖入的文件没有可读取的本机路径，请使用选择本地 JAR');
      const artifact = await inspectJar(file);
      approvedJars.add(path.resolve(file));
      return artifact;
    });
    handle('precheck', async (value) => {
      const request = z
        .object({
          serviceId: z.string(),
          targetIds: z.array(z.string()).max(100),
          build: z.enum(['existing', 'rebuild']),
          jarPath: z.string().optional(),
        })
        .parse(value);
      const db = storage.database(),
        service = db.services.find((s) => s.id === request.serviceId);
      if (!service) throw new Error('服务不存在');
      if (
        request.jarPath &&
        !approvedJars.has(path.resolve(request.jarPath)) &&
        path.resolve(service.root, service.jarDir, service.jarName) !==
          path.resolve(request.jarPath) &&
        !storage.artifacts.sources().some((s) => s.path === path.resolve(request.jarPath!))
      )
        throw new Error('请先选择或拖入本地 JAR');
      return localPrecheck(db, request, storage.credentialIds(), path.join(dataDir, 'tmp'));
    });
    handle('tool-info', (value) => {
      if (controller.active()) throw new Error('请等待当前任务结束后再检测构建工具版本');
      return toolInfo(storage.database(), id(value), path.join(dataDir, 'tmp'), true);
    });
    handle('ssh-aliases', (file) => aliases(file === undefined ? undefined : text(file)));
    handle('detect-jdks', () => detectJdks());
    handle('check-tool', async (kind, value) => {
      if (kind === 'jdk') {
        const jdk = storage.database().jdks.find((j) => j.path === text(value));
        if (!jdk) throw new Error('请先保存 JDK 配置');
        return checkJdk(jdk.path);
      }
      if (kind !== 'maven') throw new Error('未知工具');
      const db = storage.database(),
        service = db.services.find((s) => s.id === id(value));
      if (!service) throw new Error('服务不存在');
      const resolved = await resolveBuild(service, db.jdks, path.join(dataDir, 'tmp'));
      const result = await runBatch(resolved.tool, ['--version'], path.join(dataDir, 'tmp'), {
        cwd: resolved.cwd,
        env: resolved.env,
        timeout: 60000,
      });
      if (result.code) throw new Error(result.stderr || result.stdout);
      return result.stdout + result.stderr;
    });
    const getServer = (value: unknown) => {
      const server = storage.database().servers.find((s) => s.id === id(value));
      if (!server) throw new Error('服务器不存在');
      return server;
    };
    const imageSource = (value: unknown) => {
      const source = imageSourceSchema.parse(value);
      if ('file' in source && !approvedImagePaths.get('image-archive')?.has(path.resolve(source.file)))
        throw new Error('请先通过文件选择器选择本机镜像包');
      return source;
    };
    const connectImage = async (server: import('../src/model').Server, supplied: string) => {
      const credential = supplied || (server.credentialMode === 'windows' ? await storage.credential(server.id) : undefined);
      if (server.auth === 'password' && !credential) throw new Error('请输入 SSH 登录密码');
      return {
        credential,
        transport: createTransport(server, {
          credential,
          pins: storage.pins(),
          trust: (request, key) => controller.trust.request(request, key),
        }),
      };
    };
    handle('image-distributions', () => imageDistributions());
    handle('image-probe-engine', (value) => probeImageEngine(imageEngineSchema.parse(value)));
    handle('image-list', async () => ({ directory: imageJobs.directory, jobs: await imageJobs.list() }));
    handle('image-logs', (value) => imageJobs.logs(imageIdSchema.parse(value)));
    handle('image-cancel-upload', (value) => imageJobs.cancelUpload(imageIdSchema.parse(value)));
    handle('image-cancel-build', (value) => imageJobs.cancelBuild(imageIdSchema.parse(value)));
    handle('image-inspect', (value) => imageJobs.archive(imageSource(value)));
    handle('image-start-build', (value) => {
      const parsed = imageBuildSchema.safeParse(value);
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const request = parsed.data;
      const db = storage.database();
      const service = db.services.find((entry) => entry.id === request.serviceId);
      if (!service) throw new Error('请选择已保存的服务');
      const fromPicker = (kind: string, file: string, fallback: string) =>
        path.resolve(file) === fallback || approvedImagePaths.get(kind)?.has(path.resolve(file));
      if (!fromPicker('directory', request.context, path.resolve(service.root)) ||
          !fromPicker('dockerfile', request.dockerfile, path.resolve(service.root, 'Dockerfile')))
        throw new Error('请使用浏览按钮选择 Dockerfile 和构建目录');
      if (request.jarPath && (request.mode !== 'existing' || !approvedJars.has(path.resolve(request.jarPath))))
        throw new Error('请通过「选择本地 JAR」选择本次构建的现有产物');
      if (controller.active() && request.mode === 'build') throw new Error('请等待部署完成后再构建 JAR');
      return imageJobs.build(request, service, db);
    });
    type ImageApproval = { check: ImageCheck; source: ImageSource; server: ReturnType<typeof getServer>; expires: number };
    let imageApproval: (ImageApproval & { token: string }) | undefined;
    handle('image-check-import', async (value, serverId, supplied) => {
      imageApproval = undefined;
      const source = imageSource(value);
      const server = getServer(serverId);
      const archive = await imageJobs.archive(source);
      const { transport, credential } = await connectImage(server, text(supplied, 8192));
      const secret = new MemoryCredentials({ image: credential || '' });
      try {
        await transport.connect();
        const check = await checkImageImport(transport, server.name, archive);
        const token = randomUUID();
        check.uploadFile = check.remoteDirectory + '/' + token + (/\.gz$/i.test(archive.name) ? '/image.tar.gz' : '/image.tar');
        imageApproval = { token, source, server, check, expires: Date.now() + 15 * 60_000 };
        return { ...check, token };
      } catch (error) {
        throw new Error(secret.redact(error instanceof Error ? error.message : String(error)));
      } finally {
        transport.close();
        secret.clear();
      }
    });
    handle('image-start-import', (value, supplied) => {
      const token = imageIdSchema.parse(value);
      const approved = imageApproval;
      if (!approved || approved.token !== token || approved.expires < Date.now())
        throw new Error('检查已过期，请重新执行导入前检查');
      const server = getServer(approved.server.id);
      if (!sameServer(approved.server, server)) throw new Error('服务器配置已变化，请重新检查');
      const credential = text(supplied, 8192);
      const job = imageJobs.import(token, approved.source, server.name, () => connectImage(server, credential), approved.check);
      imageApproval = undefined;
      return job;
    });
    const readOnly = async (
      server: import('../src/model').Server,
      kind: import('../src/features').DiagnosticKind,
      supplied: unknown,
      target?: import('../src/model').Target,
    ) => {
      if (controller.active()) throw new Error('部署进行中，请先等待任务结束');
      const stored = storage.database().servers.find((s) => s.id === server.id);
      const credential = supplied
        ? text(supplied, 8192)
        : stored && sameServer(stored, server) && server.credentialMode === 'windows'
          ? await storage.credential(server.id)
          : undefined;
      if (server.auth === 'password' && !credential) throw new Error('请输入登录密码');
      const transport = createTransport(server, {
        credential,
        pins: storage.pins(),
        trust: (r, k) => controller.trust.request(r, k),
      });
      const redactor = new MemoryCredentials({ active: credential || '' });
      try {
        await transport.connect();
        return await diagnose(transport, kind, target, credential);
      } catch (e) {
        throw new Error(redactor.redact(String(e)));
      } finally {
        transport.close();
        redactor.clear();
      }
    };
    handle('test-draft', (value, supplied) => readOnly(parseServer(value), 'server', supplied));
    handle('server-health', (value, supplied) => readOnly(getServer(value), 'server', supplied));
    handle('diagnose', (value, rawKind, supplied) => {
      const kind = z
        .enum(['directory', 'disk', 'container', 'logs', 'process', 'lock'])
        .parse(rawKind);
      const target = storage.database().targets.find((t) => t.id === id(value));
      if (!target) throw new Error('目标不存在');
      return readOnly(getServer(target.serverId), kind, supplied, target);
    });
    handle('save-credential', async (value, secret) => {
      const server = getServer(value);
      const string = text(secret, 8192);
      if (string) await storage.saveCredential(server.id, string);
      else storage.deleteCredential(server.id);
    });
    handle('delete-credential', (value) => storage.deleteCredential(id(value)));
    handle('trust', (value, accepted, confirmation) =>
      controller.trust.answer(
        text(value, 100),
        z.boolean().parse(accepted),
        confirmation === undefined ? '' : text(confirmation, 20),
      ),
    );
    const resolveAlias = async (serverId: unknown) => {
      const server = getServer(serverId);
      if (server.auth !== 'alias') throw new Error('该服务器未使用别名');
      const result = await runProcess(
        systemSsh(),
        [...(server.sshConfigFile ? ['-F', server.sshConfigFile] : []), '-G', '--', server.alias],
        { timeout: 15000 },
      );
      if (result.code) throw new Error(result.stderr);
      const fields = Object.fromEntries(
        result.stdout.split(/\r?\n/).map((l) => {
          const i = l.indexOf(' ');
          return [l.slice(0, i), l.slice(i + 1)];
        }),
      );
      return { host: fields.hostname, user: fields.user, port: Number(fields.port) };
    };
    handle('resolve-alias', resolveAlias);
    handle('inspect-lock', async (targetId, supplied) => {
      if (controller.active()) throw new Error('任务执行期间不可接管锁');
      const target = storage.database().targets.find((t) => t.id === id(targetId));
      if (!target) throw new Error('部署目标不存在');
      const server = getServer(target.serverId),
        credential = supplied
          ? text(supplied, 8192)
          : server.credentialMode === 'windows'
            ? await storage.credential(server.id)
            : undefined;
      const transport = createTransport(server, {
        credential,
        pins: storage.pins(),
        trust: (r, k) => controller.trust.request(r, k),
      });
      try {
        await transport.connect();
        const lock = target.directory.replace(/\/$/, '') + '/.deploy-center.lock';
        const result = await mustExec(
          transport,
          'if [ -d ' +
            shellQuote(lock) +
            ' ]; then cat ' +
            shellQuote(lock + '/owner') +
            '; printf "\\n"; cat ' +
            shellQuote(lock + '/created') +
            '; printf "\\n"; date +%s; else printf NONE; fi',
        );
        if (result.trim() === 'NONE') throw new Error('该目标没有任务锁');
        const [owner, created, now] = result.trim().split(/\r?\n/);
        const age = Number(now) - Number(created);
        if (!Number.isFinite(age)) throw new Error('锁时间无效，需要人工核实远端文件');
        const stale = age >= (storage.database().settings.staleLockMinutes || 120) * 60,
          token = randomUUID();
        pendingLocks.set(token, {
          targetId: target.id,
          owner,
          created: Number(created),
          credential,
          until: Date.now() + 300000,
        });
        setTimeout(() => pendingLocks.delete(token), 300000).unref();
        return {
          token,
          owner,
          created: Number(created),
          stale,
          message: stale
            ? '超过配置阈值。请确认原任务已停止；接管会归档旧锁，不会删除备份。'
            : '锁未超过陈旧阈值，禁止接管',
        };
      } finally {
        transport.close();
      }
    });
    handle('takeover-lock', async (rawToken, word) => {
      if (controller.active() || text(word, 30) !== 'TAKEOVER')
        throw new Error('必须先确认原任务已停止并输入 TAKEOVER');
      const token = text(rawToken, 100),
        entry = pendingLocks.get(token);
      if (!entry || entry.until < Date.now()) throw new Error('锁检查已过期，请重新检查');
      pendingLocks.delete(token);
      const target = storage.database().targets.find((t) => t.id === entry.targetId);
      if (!target) throw new Error('目标已删除');
      const server = getServer(target.serverId),
        transport = createTransport(server, {
          credential: entry.credential,
          pins: storage.pins(),
          trust: (r, k) => controller.trust.request(r, k),
        });
      try {
        await transport.connect();
        assertNoRelease();
        if (!/^[A-Za-z0-9_-]+$/.test(entry.owner)) throw new Error('锁持有者无效，请人工核实');
        await mustExec(
          transport,
          'bash -s',
          workbenchHeader(target, entry.owner) + [
            'dc_lock; dc_path "$JOB"; exec 9<"$LOCK"; flock -n 9',
            'dc_lock; [ "$(stat -Lc "%d:%i" -- "$LOCK")" = "$(stat -Lc "%d:%i" /proc/$$/fd/9)" ]',
            '[ "$(dc_value "$LOCK/created")" = ' + shellQuote(String(entry.created)) + ' ]',
            '[ $(( $(date +%s) - ' + entry.created + ' )) -ge ' +
              (storage.database().settings.staleLockMinutes || 120) * 60 + ' ]',
            'if dc_workspace || dc_file "$LOCK/pid"; then',
            '  if dc_file "$LOCK/pid"; then JOB="$LOCK"; fi',
            '  alive=0; dc_alive || alive=$?',
            '  [ "$alive" = 1 ] || { [ ! -e "$JOB/pid" ] && [ ! -L "$JOB/pid" ]; }',
            'else',
            '  legacy="$JOB/$OWNER"; dc_path "$legacy"',
            '  pid="$(dc_value "$legacy/pid" || true)"',
            '  case "$pid" in ""|*[!0-9]*) :;; *) [ ! -e "/proc/$pid/stat" ] || exit 1;; esac',
            'fi',
            'mkdir "$LOCK/takeover"',
            'mv -- "$LOCK" ' + shellQuote(workbenchPath(target) + '/.deploy-center.lock.stale.' + token),
          ].join('\n'),
        );
      } finally {
        entry.credential = undefined;
        transport.close();
      }
    });
    handle('test-connection', async (value, supplied) => {
      if (controller.active()) throw new Error('部署期间请等待当前连接步骤结束后再测试其他服务器');
      const server = getServer(value),
        secret = supplied === undefined ? undefined : text(supplied, 8192);
      const credential =
        secret ||
        (server.credentialMode === 'windows' ? await storage.credential(server.id) : undefined);
      if (server.auth === 'password' && !credential) throw new Error('请输入登录密码');
      const transport = createTransport(server, {
        credential,
        pins: storage.pins(),
        trust: (request, key) => controller.trust.request(request, key),
      });
      try {
        await transport.connect();
        const resolved = server.auth === 'alias' ? await resolveAlias(server.id) : undefined;
        const output =
          (resolved ? `最终地址：${resolved.user}@${resolved.host}:${resolved.port}\n` : '') +
          (await mustExec(
            transport,
            'command -v bash >/dev/null || { printf "命令不可用：bash\\n" >&2; exit 127; }; printf "SSH 连接成功\\n"; uname -a; id',
          ));
        if (server.credentialMode === 'windows' && secret)
          await storage.saveCredential(server.id, secret);
        return output;
      } finally {
        transport.close();
      }
    });
    handle('export-config', async () => {
      const result = await dialog.showSaveDialog(win!, {
        defaultPath: 'deploy-center-config.json',
        filters: [{ name: '配置 JSON', extensions: ['json'] }],
      });
      if (result.canceled || !result.filePath) return false;
      const value = JSON.stringify(
        {
          application: 'deploy-center',
          format: 1,
          dataStorageNote:
            '配置导出不包含数据目录位置指针、完整产物、日志和凭据。更换数据目录请使用设置中的完整迁移；本文件不能替代数据目录备份。',
          created: new Date().toISOString(),
          database: JSON.parse(safeConfigJson(storage.database())),
        },
        null,
        2,
      );
      await fsp.writeFile(result.filePath, value, { encoding: 'utf8', mode: 0o600 });
      return true;
    });
    handle('import-config', async () => {
      if (controller.active()) throw new Error('任务执行期间不能导入配置');
      const result = await dialog.showOpenDialog(win!, {
        filters: [{ name: '配置 JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (result.canceled) return null;
      const item = await fsp.stat(result.filePaths[0]);
      if (item.size > 32 * 1024 * 1024) throw new Error('配置文件超过 32 MB');
      const raw = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
      const real = raw.application === 'deploy-center' && raw.format === 1;
      const value = real ? raw.database : raw;
      if (!validDatabase(value)) throw new Error('配置字段或版本无效，请保留原文件');
      validateDatabase(value);
      const confirmation = await dialog.showMessageBox(win!, {
        type: 'question',
        buttons: ['取消', '导入'],
        defaultId: 0,
        cancelId: 0,
        message: `将导入 ${value.services.length} 个服务、${value.servers.length} 台服务器和 ${value.targets.length} 个部署目标`,
        detail: [
          `文件：${path.basename(result.filePaths[0])}`,
          real ? '导入配置及部署历史。' : '此次仅导入配置。',
          '请确认文件来源可信。同标识的配置会更新，导入前会备份当前数据库。',
        ].join('\n'),
      });
      if (confirmation.response !== 1) return null;
      assertNoRelease();
      storage.importDatabase(value, real);
      onlineLogs.reconcile(value);
      emit({ kind: 'database', database: storage.database() });
      return storage.database();
    });
    handle('read-logs', (task, target, before) =>
      storage.readLogs(
        id(task),
        id(target),
        before === undefined
          ? undefined
          : z
              .object({
                build: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
                target: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
              })
              .parse(before),
      ),
    );
    handle('export-logs', async (taskId, targetId) => {
      const task = id(taskId),
        target = targetId === undefined ? undefined : id(targetId);
      const result = await dialog.showSaveDialog(win!, { defaultPath: task + '.log' });
      if (result.canceled || !result.filePath) return false;
      const files = [
        storage.logPath(task),
        ...(target
          ? [storage.logPath(task, target)]
          : storage.task(task)?.targets.map((r) => storage.logPath(task, r.target.id)) || []),
      ];
      const destination = await fsp.open(result.filePath, 'w', 0o600);
      try {
        const database = target && !storage.task(task) ? storage.database() : undefined;
        const saved = database && [
          database.taskHistory[task]?.buildLogs,
          database.history.find((record) => record.taskId === task && record.target.id === target)?.logs,
        ];
        for (const [index, file] of files.entries()) {
          await destination.write('\n=== ' + path.basename(file) + ' ===\n');
          if (fs.existsSync(file))
            for await (const chunk of fs.createReadStream(file))
              await destination.writeFile(chunk as Buffer);
          else if (saved?.[index]?.length)
            await destination.write(saved[index]!.join('\n') + '\n');
        }
      } finally {
        await destination.close();
      }
      return true;
    });
    const logTarget = (value: unknown) => {
      const target = storage.database().targets.find((t) => t.id === id(value));
      if (!target) throw new Error('目标不存在');
      const server = getServer(target.serverId);
      return { target, server };
    };
    const followLogs = async (value: unknown, supplied?: unknown, duration?: number) => {
      const { target, server } = logTarget(value);
      const credential = supplied
        ? text(supplied, 8192)
        : controller.credentialFor(server.id) ||
          (server.credentialMode === 'windows' ? await storage.credential(server.id) : undefined);
      if (server.auth === 'password' && !credential) throw new Error('请先输入登录密码或保存凭据');
      const transport = createTransport(server, {
        credential,
        pins: storage.pins(),
        trust: (request, key) => controller.trust.request(request, key),
      });
      const session = await onlineLogs.start(target, server, transport, credential, duration);
      onlineLogs.reconcile(storage.database());
      return session;
    };
    handle('follow-logs', (value, supplied) => followLogs(value, supplied));
    handle('stop-logs', (value) => sessions.stop(text(value, 100)));
    handle('read-log-session', (value) => sessions.read(text(value, 100)));
    handle('online-log-source', (value) => {
      const { target, server } = logTarget(value);
      return {
        ...onlineLogs.source(target, server),
        credentialAvailable: !!controller.credentialFor(server.id) ||
          (server.credentialMode === 'windows' && storage.credentialIds().includes(server.id)),
      };
    });
    handle('online-log-search', (session, request) => onlineLogs.search(text(session, 100), onlineSearchSchema.parse(request)));
    handle('online-log-sessions', () => onlineLogs.list());
    handle('operations-list', (target) => operations.list(id(target)));
    const inspectService = async <T>(inspect: () => Promise<T>) => {
      const release = sessions.reserve();
      try { return await inspect(); }
      finally { release(); }
    };
    handle('operations-status', (target, supplied) =>
      inspectService(() => operations.status(id(target), text(supplied, 8192))));
    handle('operations-prepare', (target, action) =>
      operations.prepare(id(target), z.enum(['start', 'stop', 'restart']).parse(action)));
    handle('operations-run', (token, confirmation, stopped, supplied) =>
      operations.run(text(token, 100), text(confirmation, 1000), z.boolean().parse(stopped), text(supplied, 8192)));
    handle('operations-settle', (target, record, confirmation, supplied) =>
      inspectService(() => operations.settle(id(target), id(record), text(confirmation, 1000), text(supplied, 8192))));
    handle('online-log-download-prepare', (session) => onlineLogs.prepare(text(session, 100)));
    handle('online-log-download-save', (token) => onlineLogs.download(text(token, 100)));
    handle('online-log-download-cancel', (token) => onlineLogs.cancel(text(token, 100)));
    handle('online-log-save-loaded', (session) => onlineLogs.saveLoaded(text(session, 100)));
    observeAfter = (task, credentials) => {
      void observeTask(
        task,
        credentials,
        async (run, secret, duration) => {
          const db = storage.database(),
            target = db.targets.find((t) => t.id === run.target.id),
            server = target && db.servers.find((s) => s.id === target.serverId);
          if (
            !target ||
            !server ||
            !sameServer(server, run.server) ||
            target.directory !== run.target.directory ||
            target.fileName !== run.target.fileName ||
            (target.mode === 'jar' && target.appLogPath !== run.target.appLogPath) ||
            target.mode !== run.target.mode ||
            target.container !== run.target.container
          )
            throw new Error('目标配置已变化，请核对后手动查看日志');
          return followLogs(target.id, secret, duration);
        },
        emit,
      );
    };
    handle('open-data-dir', () => shell.openPath(dataDir));
    Menu.setApplicationMenu(null);
    win.setMenuBarVisibility(false);
    handle('help', () =>
      shell.openPath(
        app.isPackaged
          ? path.join(process.resourcesPath, 'README.md')
          : path.join(__dirname, '..', 'README.md'),
      ),
    );
    handle('about', () =>
      dialog.showMessageBox(win!, {
        title: '关于',
        message: 'YOTOO 部署中心 ' + app.getVersion(),
        detail: '本地 Java 服务部署工具\n数据目录：' + dataDir,
        buttons: ['确定'],
      }),
    );
    handle('data-usage', () => storage.artifacts.usage());
    handle('snapshot-availability', (value) => storage.artifacts.availability(id(value)));
    handle('preview-cleanup', (kind, policy) => {
      if (controller.active()) throw new Error('请等待当前任务结束后再预览清理');
      return storage.artifacts.preview(
        z.enum(['policy', 'artifacts', 'temporary', 'legacy-success']).parse(kind),
        policy as import('../src/model').ArtifactPolicy | undefined,
      );
    });
    handle('apply-cleanup', async (token, confirmed) => {
      if (controller.active()) throw new Error('任务执行中不能清理');
      const result = await storage.artifacts.apply(text(token, 100), z.boolean().parse(confirmed));
      if (result.policy) storage.applyArtifactPolicy(result.policy);
      emit({ kind: 'database', database: storage.database() });
      return result;
    });
    handle('preview-history-retention', (value) => {
      if (controller.active()) throw new Error('请等待当前任务结束后再预览清理');
      return storage.previewHistoryRetention(z.object({
        historyLimit: z.number().int().min(1).max(10000),
        historyDays: z.number().int().min(0).max(3650),
      }).parse(value));
    });
    handle('apply-history-retention', (value, confirmed) => {
      if (controller.active()) throw new Error('任务执行中不能清理');
      storage.applyHistoryRetention(text(value, 100), z.boolean().parse(confirmed));
      emit({ kind: 'database', database: storage.database() });
    });
    handle('data-directory', () => directories.info());
    handle('inspect-directory', (value) => directories.inspect(migrationDestination(text(value))));
    handle('migration-state', () => directories.progress);
    let migrationCancelled = false;
    handle('cancel-migration', () => {
      migrationCancelled = true;
      directories.cancel();
    });
    handle('migrate-directory', async (value) => {
      if (migrating || pendingRestart) throw new Error('已有迁移或待重启切换');
      if (imageJobs.busy()) throw new Error('镜像任务正在执行，请等待完成后再迁移数据目录');
      if (onlineLogs.isExporting()) throw new Error('线上日志正在下载，请完成或取消后再迁移数据目录');
      if (updater?.isBusy()) throw new Error('正在检查或下载更新，请完成或取消后再迁移数据目录');
      migrating = true;
      migrationCancelled = false;
      try {
        const destination = migrationDestination(text(value));
        directories.progress = {
          state: 'preparing',
          copied: 0,
          total: 0,
          files: 0,
          totalFiles: 0,
          message: '正在准备迁移，原目录保留。',
          target: destination,
        };
        emit({ kind: 'migration', progress: directories.progress });
        await historySearch.stop();
        await storage.settle();
        if (migrationCancelled) {
          directories.progress = {
            state: 'cancelled',
            copied: 0,
            total: 0,
            files: 0,
            totalFiles: 0,
            message: '迁移已取消，继续使用原目录。',
          };
          emit({ kind: 'migration', progress: directories.progress });
          throw new Error('迁移已取消，继续使用原目录。');
        }
        if (storage.artifacts.isBusy()) throw new Error('正在清理文件，请稍后迁移');
        return await directories.migrate(
          destination,
          () =>
            storage.hasUnreadableTasks()
              ? '有任务元数据无法读取，请先检查数据库备份'
              : controller.active()
                ? '任务执行或取消中，不能迁移'
                : storage.unfinished().length
                  ? '存在未处理的中断任务，不能迁移'
                  : storage.recovery
                    ? '请先处理损坏配置恢复'
                    : undefined,
          () => storage.pause(),
          () => storage.resume(),
          (progress) => emit({ kind: 'migration', progress }),
        );
      } catch (error) {
        if (!['failed', 'cancelled'].includes(directories.progress.state)) {
          directories.progress = {
            ...directories.progress,
            state: migrationCancelled ? 'cancelled' : 'failed',
            message: String(error) + '；继续使用原目录。',
          };
          emit({ kind: 'migration', progress: directories.progress });
        }
        throw error;
      } finally {
        migrating = false;
        pendingRestart = directories.progress.state === 'pending';
      }
    });
    handle('restart', async () => {
      if (migrating || controller.active() || operations.isBusy() || imageJobs.busy() || onlineLogs.isExporting()) throw new Error('请等待任务、下载或迁移结束');
      if (!(await confirmScheduleExit())) return;
      app.relaunch();
      app.quit();
    });
    handle('keep-old-data', () => directories.keepPrevious());
    handle('remove-old-data', async (value) => {
      if (controller.active() || storage.unfinished().length)
        throw new Error('任务未处理完，不能清理旧目录');
      return directories.removePrevious(text(value));
    });
    if (app.isPackaged)
      win.webContents.on('before-input-event', (event, input) => {
        if (
          input.key === 'F12' ||
          (input.control && input.shift && input.key.toLowerCase() === 'i')
        )
          event.preventDefault();
      });
    win.on('close', (event) => {
      const exiting = explicitExit;
      explicitExit = false;
      captureBounds();
      if (!exiting && trayPanel && preferences.preferences.closeToTray && !updater?.isInstalling()) {
        event.preventDefault();
        win?.hide();
        return;
      }
      if (imageJobs.busy()) {
        event.preventDefault();
        void dialog.showMessageBox(win!, { message: '镜像任务仍在执行，请等待完成后再退出', buttons: ['返回'] });
        return;
      }
      if (onlineLogs.isExporting()) {
        event.preventDefault();
        void dialog.showMessageBox(win!, { message: '线上日志正在下载，请完成或取消后再退出', buttons: ['返回'] });
        return;
      }
      if (operations.isBusy()) {
        event.preventDefault();
        void dialog.showMessageBox(win!, { message: '服务运维正在执行，请等待结果后再退出', buttons: ['返回'] });
        return;
      }
      if (migrating || backups.isBusy() || workbench.isBusy()) {
        event.preventDefault();
        void dialog.showMessageBox(win!, {
          message: workbench.isBusy() ? '远程工作台正在核实，请等待结果' : backups.isBusy() ? '远程备份操作正在进行，请等待结果' : '数据迁移正在进行',
          detail: '请等待迁移结束，或在设置页取消迁移后再关闭。',
          buttons: ['返回'],
        });
        return;
      }
      if (!controller.active() && !releaseBusy() && !confirmedScheduleExit && storage.schedules().some(pendingSchedule)) {
        event.preventDefault();
        void confirmScheduleExit().then((confirmed) => { if (confirmed) app.quit(); });
        return;
      }
      if (controller.active() || releaseBusy()) {
        event.preventDefault();
        void dialog
          .showMessageBox(win!, {
            type: 'warning',
            buttons: ['继续运行', '请求取消任务'],
            defaultId: 0,
            message: releaseBusy() ? '串行发布清单仍在执行' : '部署仍在执行',
            detail: '切换期间不会强制结束远端任务。可请求安全取消，完成后再关闭软件。',
          })
          .then((result) => {
            if (result.response === 1) {
              if (releaseBusy()) { void release.cancel(); return; }
              const task = storage.latestTask();
              if (task) controller.cancel(task.id);
            }
          });
      }
    });
    app.on('second-instance', () => {
      foreground();
    });
    win.once('closed', () => {
      clearTimeout(saveBoundsTimer);
      trayPanel?.close();
      trayPanel = undefined;
    });
    // Windows 上页面的媒体查询可能晚于原生主题更新，用首帧参数直接设置骨架。
    await win.loadFile(page, { hash: nativeTheme.shouldUseDarkColors ? 'startup-dark' : '' });
    setBackgroundUpdatePolicy?.(preferences.preferences.updatePolicy, preferences.preferences.checkUpdatesOnStartup);
    const updateError = path.join(dataPaths(dataDir).updateLogs, 'last-update-error.txt');
    try {
      const details = await fsp.readFile(updateError, 'utf8');
      await fsp.unlink(updateError);
      foreground();
      void dialog.showMessageBox(win!, { type: 'error', message: '上次更新未完成', detail: details.slice(0, 2000) });
    } catch { /* 没有上次更新失败的记录。 */ }
    if (smoke) {
      const plaintext = 'smoke-' + randomUUID();
      await storage.saveCredential('smoke', plaintext);
      const restored = await storage.credential('smoke');
      if (restored !== plaintext) throw new Error('DPAPI 往返检查失败');
      storage.deleteCredential('smoke');
      await fsp.writeFile(
        path.join(dataDir, 'smoke-result.json'),
        JSON.stringify({
          ok: true,
          appVersion: app.getVersion(),
          dataDir,
          electron: process.versions.electron,
          node: process.versions.node,
          sqlite: fs.existsSync(path.join(dataDir, 'deploy-center.sqlite')),
          encrypted: true,
          rendererLoaded: true,
        }),
      );
      app.quit();
    }
  } catch (e) {
    if (process.argv.includes('--smoke')) {
      await fsp.writeFile(
        path.join(dataDir, 'smoke-result.json'),
        JSON.stringify({ ok: false, error: String(e) }),
      );
      app.quit();
      return;
    }
    await dialog.showMessageBox({
      type: 'error',
      message: 'YOTOO 部署中心 启动失败',
      detail: e instanceof Error ? e.message : String(e),
    });
    app.quit();
  }
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { explicitExit = true; });
app.on('will-quit', () => {
  setBackgroundUpdatePolicy?.('manual');
  scheduler?.close();
  instance?.close();
  updater?.dispose();
  void historySearch.stop();
  backups?.close();
  sessions.closeAll();
  storage?.close();
});
