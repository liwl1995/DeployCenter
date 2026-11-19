import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('deployTray', {
  snapshot: () => ipcRenderer.invoke('tray:snapshot'),
  action: (action: string, id?: string) => ipcRenderer.invoke('tray:action', action, id),
  refresh: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('tray:refresh', listener);
    return () => { ipcRenderer.removeListener('tray:refresh', listener); };
  },
});
