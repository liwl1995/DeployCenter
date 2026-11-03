import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
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
import { LineRedactor } from './log-redactor';
import { Storage } from './storage';
import { Controller } from './controller';
import { detectJdks, inspectJar, checkJdk, resolveBuild } from './files';
import { runBatch, runProcess } from './process';
import { validateDatabase } from './validate';
import { createTransport, systemSsh, mustExec, type Transport, type Channel } from './ssh';
import { shellQuote, safeConfigJson, validDatabase } from '../src/model';
import type { DesktopEvent } from '../src/platform';
import type { WorkerMessage } from './contracts';

app.setName('YOTOO 部署中心');
if (process.platform === 'win32') app.setAppUserModelId('local.deploycenter.desktop');
const dataDir = path.resolve(
  process.env.DEPLOY_CENTER_DATA_DIR ||
    path.join(app.getPath('appData'), app.isPackaged ? 'DeployCenter' : 'DeployCenter-Development'),
);
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  void boot();
}
let win: BrowserWindow | undefined, storage: Storage, controller: Controller;
const approvedJars = new Set<string>();
const pendingLocks = new Map<
  string,
  { targetId: string; owner: string; created: number; credential?: string; until: number }
>();
const logs = new Map<string, { transport: Transport; channel: Channel }>();
const emit = (event: DesktopEvent) => {
  if (win && !win.isDestroyed()) win.webContents.send('deploy:event', event);
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
    storage.markInterrupted();
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
    );
    const page = path.join(__dirname, '..', 'dist', 'index.html');
    const url = pathToFileURL(page).href;
    const smoke = process.argv.includes('--smoke');
    win = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 840,
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
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
        !storage.tasks().some((t) => t.artifact.path === request.jarPath)
      )
        throw new Error('请通过系统对话框选择 JAR，或使用服务配置的产物');
      return controller.prepare(value);
    });
    handle('start', (token, values, approval) =>
      controller.start(text(token, 100), values, approval),
    );
    handle('cancel', (value) => controller.cancel(id(value)));
    handle('recover', (value, creds) => controller.recover(id(value), creds));
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
        const lock = target.directory.replace(/\/$/, '') + '/.deploy-center.lock',
          job = target.directory.replace(/\/$/, '') + '/.deploy-center/' + entry.owner;
        if (!/^[A-Za-z0-9_-]+$/.test(entry.owner)) throw new Error('锁持有者无效，请人工核实');
        await mustExec(
          transport,
          `set -eu
lock=${shellQuote(lock)}
[ "$(cat "$lock/owner")" = ${shellQuote(entry.owner)} ] && [ "$(cat "$lock/created")" = ${shellQuote(String(entry.created))} ] || { printf '锁已变化，拒绝接管' >&2; exit 1; }
[ $(( $(date +%s) - ${entry.created} )) -ge ${(storage.database().settings.staleLockMinutes || 120) * 60} ] || exit 1
pid=$(cat ${shellQuote(job + '/pid')} 2>/dev/null || true)
case "$pid" in ''|*[!0-9]*) :;; *) if kill -0 "$pid" 2>/dev/null; then printf '原任务进程仍在运行，禁止接管' >&2; exit 1; fi;; esac
mkdir "$lock/takeover" || exit 1
mv -- "$lock" ${shellQuote(lock + '.stale.' + token)}
`,
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
    handle('read-logs', (task, target) => storage.readLogs(id(task), id(target)));
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
    handle('follow-logs', async (value, supplied) => {
      const target = storage.database().targets.find((t) => t.id === id(value));
      if (!target || target.mode !== 'docker') throw new Error('该目标不是 Docker 部署');
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
      await transport.connect();
      const channel = await transport.channel(
        'docker logs --tail 200 -f -- ' + shellQuote(target.container),
      );
      const sessionId = randomUUID();
      logs.set(sessionId, { transport, channel });
      channel.input.end();
      const redactors = [
        new LineRedactor({ active: credential || '' }),
        new LineRedactor({ active: credential || '' }),
      ];
      const send = (index: number) => (data: Buffer) => {
        try {
          const text = redactors[index].write(data);
          if (text) emit({ kind: 'container-log', id: sessionId, text });
        } catch (e) {
          channel.stop();
          emit({ kind: 'container-log', id: sessionId, text: String(e) });
        }
      };
      channel.output.on('data', send(0));
      channel.error.on('data', send(1));
      void channel.done
        .catch(() => -1)
        .then(() => {
          for (const redactor of redactors) {
            const text = redactor.end();
            if (text) emit({ kind: 'container-log', id: sessionId, text });
          }
          emit({ kind: 'container-log', id: sessionId, text: '\n[日志连接已结束]\n' });
          logs.delete(sessionId);
          transport.close();
        });
      return sessionId;
    });
    handle('stop-logs', (value) => {
      const entry = logs.get(text(value, 100));
      entry?.channel.stop();
      entry?.transport.close();
      logs.delete(String(value));
    });
    handle('open-data-dir', () => shell.openPath(dataDir));
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: '文件',
          submenu: [
            { label: '数据目录', click: () => void shell.openPath(dataDir) },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
        { role: 'editMenu', label: '编辑' },
        { role: 'viewMenu', label: '视图' },
        {
          label: '帮助',
          submenu: [
            {
              label: '使用说明',
              click: () =>
                void shell.openPath(
                  app.isPackaged
                    ? path.join(process.resourcesPath, 'README.md')
                    : path.join(__dirname, '..', 'README.md'),
                ),
            },
            {
              label: '关于 YOTOO 部署中心',
              click: () =>
                void dialog.showMessageBox(win!, {
                  message: 'YOTOO 部署中心 ' + app.getVersion(),
                  detail: 'Windows 本地 Java 服务部署工具\n数据目录：' + dataDir,
                }),
            },
          ],
        },
      ]),
    );
    win.on('close', (event) => {
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
  for (const entry of logs.values()) {
    entry.channel.stop();
    entry.transport.close();
  }
  storage?.close();
});
