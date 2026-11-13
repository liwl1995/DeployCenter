import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  safeStorage,
  shell,
  utilityProcess,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LogSessions, observeTask } from './observation';
import { Storage } from './storage';
import { migrationDestination, DataDirectory } from './data-directory';
import { BackupManager } from './backup-manager';
import { WorkbenchRecovery } from './workbench-recovery';
import { workbenchHeader, workbenchPath } from './workbench';
import { Controller } from './controller';
import { detectJdks, inspectJar, checkJdk, resolveBuild, serviceInfo } from './files';
import { runBatch, runProcess } from './process';
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
if (process.platform === 'win32') app.setAppUserModelId('local.deploycenter.desktop');
let dataDir = path.resolve(
  process.env.DEPLOY_CENTER_DATA_DIR ||
    path.join(app.getPath('appData'), app.isPackaged ? 'DeployCenter' : 'DeployCenter-Development'),
);
const settingsDir = process.env.DEPLOY_CENTER_DATA_DIR
  ? path.resolve(
      process.env.DEPLOY_CENTER_SETTINGS_DIR ||
        path.join(path.dirname(dataDir), 'settings-' + path.basename(dataDir)),
    )
  : path.join(
      process.env.LOCALAPPDATA || app.getPath('appData'),
      app.isPackaged ? 'DeployCenter' : 'DeployCenter-Development',
      'Settings',
    );
const directories = new DataDirectory(settingsDir, dataDir, [
  process.env.SystemRoot || 'C:\\Windows',
  process.env.ProgramFiles || 'C:\\Program Files',
  process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
  path.dirname(app.getPath('exe')),
]);
fs.mkdirSync(settingsDir, { recursive: true });
// 单实例锁使用稳定的控制目录，不随用户数据迁移改变身份。
app.setPath('userData', settingsDir);
let migrating = false,
  pendingRestart = false,
  dataNotice: string | undefined;
const readOnlyDuringMigration = new Set([
  'load',
  'data-directory',
  'migration-state',
  'cancel-migration',
  'restart',
  'read-task',
  'list-tasks',
  'read-logs',
  'open-data-dir',
  'help',
  'about',
]);
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  void boot();
}
let win: BrowserWindow | undefined, storage: Storage, controller: Controller;
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
const emit = (event: DesktopEvent) => {
  if (win && !win.isDestroyed()) {
    if (event.kind === 'task') {
      win.setTitle(taskWindowTitle(event.task));
      win.setProgressBar(taskProgress(event.task), {
        mode: event.task.status === 'cancelling' ? 'paused' : 'normal',
      });
    }
    win.webContents.send('deploy:event', event);
  }
};
const sessions = new LogSessions(emit);
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
    win?.show();
    win?.focus();
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
    storage.markInterrupted();
    await storage.maintainStartup();
    await fsp.mkdir(path.join(dataDir, 'tmp'), { recursive: true });
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
      emit,
      {
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
      () => !controller.active() && !backups.isBusy() && !storage.artifacts.isBusy(),
    );
    const page = path.join(__dirname, '..', 'dist', 'index.html');
    const url = pathToFileURL(page).href;
    const smoke = process.argv.includes('--smoke');
    win = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 1000,
      autoHideMenuBar: true,
      minHeight: 620,
      show: !smoke,
      backgroundColor: '#f5f7f9',
      title: 'YOTOO 部署中心',
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
        devTools: !app.isPackaged,
      },
    });
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
    const handle = (name: string, fn: (...args: unknown[]) => unknown) =>
      ipcMain.handle('deploy:' + name, (event, ...args) => {
        if (
          !win ||
          event.sender.id !== win.webContents.id ||
          event.senderFrame !== win.webContents.mainFrame ||
          event.senderFrame.url.split('#')[0] !== url
        )
          throw new Error('拒绝不受信任的界面请求');
        if ((migrating || pendingRestart) && !readOnlyDuringMigration.has(name))
          throw new Error(
            pendingRestart
              ? '数据迁移已完成，请先重启后再修改配置或部署。'
              : '正在迁移数据，暂时不能执行其他操作。',
          );
        if (storage.artifacts.isBusy() && ['prepare', 'start', 'recover'].includes(name))
          throw new Error('正在整理本地产物，请完成后重新准备部署');
        if (
          workbench?.isBusy() &&
          ['save', 'prepare', 'start', 'recover', 'takeover-lock', 'import-config',
            'migrate-directory', 'restart', 'remove-old-data', 'apply-cleanup',
            'apply-backups', 'reconcile-backup'].includes(name)
        )
          throw new Error('正在核实远程工作台，请等待结果后再操作');
        if (
          backups?.isBusy() &&
          [
            'save',
            'prepare',
            'start',
            'recover',
            'takeover-lock',
            'import-config',
            'migrate-directory',
            'restart',
            'remove-old-data',
            'apply-cleanup',
          ].includes(name)
        )
          throw new Error('正在处理远程备份，请等待结果后再操作');
        return fn(...args);
      });
    handle('load', async () => ({
      database: storage.database(),
      version: app.getVersion(),
      recovery: storage.recovery,
      task: storage.latestTask(),
      unfinished: storage.unfinished(),
      dataDir,
      savedCredentials: storage.credentialIds(),
      encryptionAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      pendingTrust: controller.trust.current(),
      dataNotice,
      dataUsage: storage.artifacts.usage(),
      taskIssues: storage.taskIssues,
      dataLocation: directories.state(),
    }));
    handle('save', (value) => storage.saveConfig(validateDatabase(value)));
    handle('confirm-recovery', () => storage.confirmRecovery());
    handle('prepare', (value) => {
      const request = z.object({ jarPath: z.string().optional() }).passthrough().parse(value);
      if (
        request.jarPath &&
        !approvedJars.has(path.resolve(request.jarPath)) &&
        !storage
          .database()
          .services.some(
            (s) => path.resolve(s.root, s.jarDir, s.jarName) === path.resolve(request.jarPath!),
          ) &&
        !storage.artifacts.sources().some((s) => s.path === request.jarPath)
      )
        throw new Error('请通过系统对话框选择 JAR，或使用服务配置的产物');
      return controller.prepare(value);
    });
    handle('start', (token, values, approval) =>
      controller.start(text(token, 100), values, approval),
    );
    handle('cancel', (value) => controller.cancel(id(value)));
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
      const kind = z.enum(['directory', 'jar', 'key', 'maven']).parse(value);
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
                    : [{ name: 'SSH 私钥', extensions: ['*'] }],
            },
      );
      if (result.canceled) return null;
      if (kind === 'jar') approvedJars.add(path.resolve(result.filePaths[0]));
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
        message: `将导入 ${value.services.length} 个服务、${value.servers.length} 台服务器`,
        detail:
          JSON.stringify(
            {
              services: value.services.map((s) => ({
                name: s.name,
                root: s.root,
                workDir: s.workDir,
                maven: s.mavenPath,
                args: s.args,
                jarDir: s.jarDir,
              })),
              servers: value.servers.map((s) => ({
                name: s.name,
                host: s.host,
                alias: s.alias,
                key: s.keyPath,
              })),
              targets: value.targets.map((t) => ({
                name: t.name,
                directory: t.directory,
                start: t.start,
                stop: t.stop,
                restart: t.restart,
                health: t.health,
              })),
            },
            null,
            2,
          ) +
          '\n\n请确认上述导入路径和命令，导入后才启用。\n' +
          (real
            ? '包含部署历史；不包含认证口令。'
            : '检测到原型或普通配置，只导入配置，不导入模拟历史。') +
          '当前数据库会先备份。',
      });
      if (confirmation.response !== 1) return null;
      storage.importDatabase(value, real);
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
        for (const file of files) {
          await destination.write('\n=== ' + path.basename(file) + ' ===\n');
          if (fs.existsSync(file))
            for await (const chunk of fs.createReadStream(file))
              await destination.writeFile(chunk as Buffer);
        }
      } finally {
        await destination.close();
      }
      return true;
    });
    const followLogs = async (value: unknown, supplied?: unknown, duration?: number) => {
      const target = storage.database().targets.find((t) => t.id === id(value));
      if (!target) throw new Error('目标不存在');
      const server = getServer(target.serverId);
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
      let command: string;
      if (target.mode === 'docker')
        command = 'docker logs --tail 200 -f -- ' + shellQuote(target.container);
      else {
        if (!target.appLogPath?.startsWith('/') || /[\r\n\0]/.test(target.appLogPath))
          throw new Error('请先在目标配置中填写应用日志的绝对路径');
        command = 'tail -n 200 -f -- ' + shellQuote(target.appLogPath);
      }
      const mask = new MemoryCredentials({ active: credential || '' });
      try {
        return await sessions.start(transport, command, target.id, credential, duration);
      } catch (e) {
        throw new Error(mask.redact(String(e)));
      } finally {
        mask.clear();
      }
    };
    handle('follow-logs', (value, supplied) => followLogs(value, supplied));
    handle('stop-logs', (value) => sessions.stop(text(value, 100)));
    handle('read-log-session', (value) => sessions.read(text(value, 100)));
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
    handle('restart', () => {
      if (migrating || controller.active()) throw new Error('请等待任务或迁移结束');
      app.relaunch();
      app.quit();
    });
    handle('keep-old-data', () => directories.keepPrevious());
    handle('remove-old-data', async (value) => {
      if (controller.active() || storage.unfinished().length)
        throw new Error('任务未处理完，不能清理旧目录');
      await directories.removePrevious(text(value));
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
      if (migrating || backups.isBusy() || workbench.isBusy()) {
        event.preventDefault();
        void dialog.showMessageBox(win!, {
          message: workbench.isBusy() ? '远程工作台正在核实，请等待结果' : backups.isBusy() ? '远程备份操作正在进行，请等待结果' : '数据迁移正在进行',
          detail: '请等待迁移结束，或在设置页取消迁移后再关闭。',
          buttons: ['返回'],
        });
        return;
      }
      if (controller.active()) {
        event.preventDefault();
        void dialog
          .showMessageBox(win!, {
            type: 'warning',
            buttons: ['继续运行', '请求取消任务'],
            defaultId: 0,
            message: '部署仍在执行',
            detail: '切换期间不会强制结束远端任务。可请求安全取消，完成后再关闭软件。',
          })
          .then((result) => {
            if (result.response === 1) {
              const task = storage.latestTask();
              if (task) controller.cancel(task.id);
            }
          });
      }
    });
    app.on('second-instance', () => {
      win?.show();
      win?.focus();
    });
    await win.loadFile(page);
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
app.on('will-quit', () => {
  void historySearch.stop();
  backups?.close();
  sessions.closeAll();
  storage?.close();
});
