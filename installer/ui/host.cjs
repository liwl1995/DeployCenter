const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('original-fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// NSIS 在本次安装专属的私有目录中交换状态。渲染进程只发送固定动作。
const argument = process.argv.find((value) => value.startsWith('--yotoo-installer-ui='));
const channel = argument?.slice('--yotoo-installer-ui='.length);
if (!channel || !path.isAbsolute(channel)) process.exit(1);

const read = (name) => fs.readFileSync(path.join(channel, name), 'utf16le').replace(/^\uFEFF/, '');
const send = (name, lines) => {
  const temporary = path.join(channel, `${name}.tmp`);
  fs.writeFileSync(temporary, lines.join('\r\n') + '\r\n', 'utf16le');
  fs.renameSync(temporary, path.join(channel, name));
};
const [mode, from, to, installPath, required, desktop, chooseDirectory, back, logDirectory, executable, parentPid, payloadSize] = read('session.txt').split(/\r?\n/);
const initial = { mode, from, to, installPath, required: Number(required), desktop: desktop === '1', chooseDirectory: chooseDirectory === '1', back: back === '1' };
const entry = path.join(__dirname, 'index.html');
const entryUrl = pathToFileURL(entry).href;
const staging = path.join(channel, '..', '7z-out');
app.setPath('userData', path.join(channel, 'profile'));
app.commandLine.appendSwitch('lang', 'zh-CN');

async function stagedBytes() {
  const files = await fs.promises.readdir(staging, { recursive: true, withFileTypes: true });
  let bytes = 0;
  for (const file of files) {
    if (!file.isFile()) continue;
    bytes += (await fs.promises.stat(path.join(file.parentPath, file.name))).size;
  }
  return bytes;
}

app.whenReady().then(async () => {
  // 暂存区已包含向导运行时，采样时只计算随后写入的程序载荷。
  const bootstrapBytes = Number(payloadSize) > 0
    ? await stagedBytes().catch((error) => error.code === 'ENOENT' ? 0 : null) : null;
  let phase = 'welcome';
  let pending = false;
  let allowClose = false;
  let engineExited = false;
  let targetDirectory = installPath;
  let nextStatus = 1;
  let extraction;
  const win = new BrowserWindow({
    width: 540, height: 400, useContentSize: true, frame: false, transparent: true,
    resizable: false, maximizable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const command = (action, ...values) => send('command.txt', [action, ...values]);

  function close(launch = false) {
    if (phase === 'progress' || pending) return;
    if (!engineExited) command(phase === 'done' ? 'finish' : 'cancel', launch ? '1' : '0');
    allowClose = true;
    win.close();
  }

  function retry(backToLocation) {
    if (phase !== 'failed' || mode === 'uninstall') return;
    const args = [`/YOTOORetryFrom=${parentPid}`];
    if (backToLocation && mode === 'fresh') args.push('/YOTOOFAILUREBACK');
    // /D= 必须位于最后，NSIS 会完整读取后面的带空格目录。
    args.push(`/D=${targetDirectory}`);
    const child = spawn(executable, args, {
      detached: true, stdio: 'ignore', windowsVerbatimArguments: true, argv0: `"${executable}"`,
    });
    child.once('spawn', () => { child.unref(); close(); });
    child.once('error', () => dialog.showErrorBox('无法重试', '请重新打开安装程序。'));
  }

  ipcMain.handle('installer:request', async (event, action, value) => {
    if (event.sender !== win.webContents || event.senderFrame?.url !== entryUrl) return;
    switch (action) {
      case 'initial': return initial;
      case 'space': {
        if (typeof value !== 'string' || !/^[A-Z]:$/.test(value)) return null;
        try {
          const { bavail, bsize } = await fs.promises.statfs(`${value}\\`, { bigint: true });
          return { free: Number(bavail * bsize / 1048576n) };
        } catch { return null; }
      }
      case 'browse': {
        if (pending || phase === 'progress') return;
        const result = await dialog.showOpenDialog(win, { title: '选择安装目录', properties: ['openDirectory'],
          defaultPath: typeof value === 'string' ? value : installPath });
        return result.filePaths[0];
      }
      case 'start':
        if (!['welcome', 'running-check', 'invalid'].includes(phase) || pending ||
            typeof value?.directory !== 'string' || value.directory.length > 900 || /[\r\n\0]/.test(value.directory)) return;
        targetDirectory = chooseDirectory === '1' ? value.directory : installPath;
        command('start', targetDirectory, value.desktop === true ? '1' : '0', value.downgrade === true ? '1' : '0', value.purge === true ? '1' : '0');
        pending = true;
        break;
      case 'confirmPurge': if (phase === 'confirm-purge' && !pending) { command('confirm-purge'); pending = true; } break;
      case 'declinePurge': if (phase === 'confirm-purge' && !pending) { command('decline-purge'); pending = true; } break;
      case 'openLog': return phase === 'failed' && await shell.openPath(logDirectory);
      case 'retry': retry(value === true); break;
      case 'finish': if (phase === 'done') close(value === true); break;
      case 'minimize': win.minimize(); break;
      case 'close': close(); break;
    }
  });
  win.on('close', (event) => {
    if (allowClose) return;
    event.preventDefault();
    close();
  });
  win.on('closed', () => { clearInterval(timer); app.quit(); });
  win.webContents.on('render-process-gone', () => app.exit(1));

  async function measureExtraction(sample) {
    if (sample.reading || Date.now() - sample.lastRead < 240) return;
    sample.reading = true;
    sample.lastRead = Date.now();
    try {
      const bytes = await stagedBytes() - bootstrapBytes;
      if (extraction !== sample || bytes <= sample.bytes || bytes >= Number(payloadSize) || win.isDestroyed()) return;
      const now = Date.now();
      const throughput = (bytes - sample.bytes) / Math.max(0.001, (now - sample.lastChange) / 1000);
      sample.rate = sample.rate ? sample.rate * 0.7 + throughput * 0.3 : throughput;
      sample.lastChange = now;
      sample.bytes = bytes;
      win.webContents.send('installer:status', {
        phase: 'progress', progress: Math.min(67, 8 + 60 * bytes / Number(payloadSize)),
        indeterminate: false, eta: bytes / Number(payloadSize) >= 0.05 ? (Number(payloadSize) - bytes) / sample.rate : null,
      });
    } catch {
      // 文件尚未准备好时保留阶段状态，下一次定时检查再采样。
    } finally { sample.reading = false; }
  }
  const timer = setInterval(() => {
    if (engineExited) return;
    try { process.kill(Number(parentPid), 0); } catch (error) {
      if (error.code !== 'ESRCH') return;
      engineExited = true;
      pending = false;
      phase = 'failed';
      win.webContents.send('installer:status', { phase, reason: '安装程序意外退出，请查看日志核实结果。', recovery: '操作结果未确认。' });
      return;
    }
    let status;
    // 一次取到最新已发布状态，避免 UI 重读旧进度或漏掉完成通知。
    for (;;) {
      try { status = read(`status.${nextStatus}.txt`); }
      catch (error) {
        if (!['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        break;
      }
      nextStatus++;
    }
    if (status === undefined) {
      if (extraction) void measureExtraction(extraction);
      return;
    }
    const [next, numeric = '0', reason, recovery, purged] = status.split(/\r?\n/);
    let message = reason;
    if (next === 'confirm-purge') {
      const directories = read('purge.txt').split(/\r?\n/);
      message = ['当前数据目录', '待切换目录', '旧副本', '位置记录'].map((label, index) =>
        directories[index] ? `${label}：${directories[index]}` : '').filter(Boolean).join('\n');
    }
    phase = next;
    extraction = next === 'progress' && numeric === '8?' && bootstrapBytes !== null
      ? { bytes: 0, lastChange: Date.now(), lastRead: 0 } : undefined;
    pending = false;
    win.webContents.send('installer:status', { phase, progress: Number(numeric.replace(/\?$/, '')), indeterminate: numeric.endsWith('?'), reason: message, recovery, purged: purged === '1' });
  }, 80);
  await win.loadFile(entry);
  win.show();
  send('ready.txt', [String(process.pid)]);
}).catch((error) => {
  try { send('startup-error.txt', [error.message]); } finally { app.exit(1); }
});
