import { BrowserWindow, ipcMain, screen, Tray, type Rectangle } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EntityIcon } from '../src/model';

export type TraySnapshot = {
  dark: boolean;
  closeToTray: boolean;
  task?: { id: string; name: string; progress: number };
  schedule?: { name: string; at: number };
  services: { id: string; name: string; icon?: EntityIcon }[];
};
export type TrayAction = 'open' | 'settings' | 'task' | 'schedules' | 'service' | 'toggle' | 'quit';

export function panelBounds(anchor: Rectangle, area: Rectangle, preferredHeight = 374) {
  const width = Math.min(324, area.width), height = Math.min(preferredHeight, area.height);
  return {
    width, height,
    x: Math.max(area.x, Math.min(anchor.x + anchor.width - width, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(
      anchor.y >= area.y + area.height / 2 ? anchor.y - height : anchor.y + anchor.height,
      area.y + area.height - height,
    )),
  };
}

export function createTrayPanel(
  icon: string,
  snapshot: () => TraySnapshot,
  action: (name: TrayAction, id?: string) => void,
) {
  const tray = new Tray(icon);
  const file = path.join(__dirname, '..', 'dist', 'src', 'tray', 'index.html');
  const url = pathToFileURL(file).href;
  let panel: BrowserWindow | undefined;
  let disposed = false;
  let opening = false;
  tray.setToolTip('YOTOO 部署中心');
  const owns = (event: Electron.IpcMainInvokeEvent) =>
    panel && !panel.isDestroyed() && event.sender === panel.webContents &&
    event.senderFrame === panel.webContents.mainFrame && event.senderFrame.url === url;
  ipcMain.handle('tray:snapshot', (event) => {
    if (owns(event)) return snapshot();
  });
  ipcMain.handle('tray:action', (event, name: unknown, id: unknown) => {
    if (!owns(event)) return;
    if (name === 'hide') { panel?.hide(); return; }
    if (name === 'service' && (typeof id !== 'string' || !snapshot().services.some((item) => item.id === id))) return;
    if (name === 'open' || name === 'settings' || name === 'task' || name === 'schedules' ||
        name === 'service' || name === 'toggle' || name === 'quit') {
      if (name !== 'toggle') panel?.hide();
      action(name, typeof id === 'string' ? id : undefined);
      if (name === 'toggle') return snapshot();
    }
  });
  tray.on('click', () => { panel?.hide(); action('open'); });
  tray.on('right-click', (_event, bounds) => {
    if (opening || disposed) return;
    if (panel?.isVisible()) { panel.hide(); return; }
    const anchor = bounds.width ? bounds : tray.getBounds();
    opening = true;
    void (async () => {
      if (!panel) {
        panel = new BrowserWindow({
          show: false, frame: false, skipTaskbar: true, resizable: false, alwaysOnTop: true,
          backgroundColor: snapshot().dark ? '#242428' : '#ffffff',
          webPreferences: {
            preload: path.join(__dirname, 'tray-preload.cjs'), sandbox: true, contextIsolation: true,
          },
        });
        panel.on('blur', () => panel?.hide());
        panel.once('closed', () => { panel = undefined; });
        panel.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        panel.webContents.on('will-navigate', (event) => event.preventDefault());
        await panel.loadFile(file);
      }
      if (disposed || !panel || panel.isDestroyed()) return;
      const state = snapshot();
      const taskRows = (state.task ? 54 : 36) + (state.schedule ? 54 : 0);
      const serviceRows = Math.max(state.services.length, 1) * 36;
      panel.setBounds(panelBounds(anchor, screen.getDisplayMatching(anchor).workArea, 194 + Math.max(taskRows, serviceRows)));
      panel.webContents.send('tray:refresh');
      panel.show();
      panel.focus();
    })().catch(() => {
      if (!disposed) {
        panel?.destroy();
        action('open');
      }
    }).finally(() => { opening = false; });
  });
  return {
    refresh() { if (panel?.isVisible()) panel.webContents.send('tray:refresh'); },
    close() {
      disposed = true;
      ipcMain.removeHandler('tray:snapshot');
      ipcMain.removeHandler('tray:action');
      panel?.destroy();
      tray.destroy();
    },
  };
}
