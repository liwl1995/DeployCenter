const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wizard', {
  request: (action, value) => ipcRenderer.invoke('installer:request', action, value),
  onStatus: (callback) => ipcRenderer.on('installer:status', (_event, status) => callback(status)),
});
