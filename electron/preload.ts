import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, DesktopEvent } from '../src/platform';
const invoke = (name: string, ...args: unknown[]) => ipcRenderer.invoke('deploy:' + name, ...args);
const api: DesktopAPI = {
  load: () => invoke('load'),
  save: (db) => invoke('save', db),
  confirmRecovery: () => invoke('confirm-recovery'),
  prepare: (value) => invoke('prepare', value),
  start: (token, values, approval) => invoke('start', token, values, approval),
  cancel: (id) => invoke('cancel', id),
  recover: (id, values) => invoke('recover', id, values),
  choose: (kind) => invoke('choose', kind),
  inspectJar: (file) => invoke('inspect-jar', file),
  detectJdks: () => invoke('detect-jdks'),
  checkTool: (kind, value) => invoke('check-tool', kind, value),
  resolveAlias: (id) => invoke('resolve-alias', id),
  inspectLock: (id, value) => invoke('inspect-lock', id, value),
  takeoverLock: (token, word) => invoke('takeover-lock', token, word),
  testConnection: (id, value) => invoke('test-connection', id, value),
  trust: (id, accepted, confirmation) => invoke('trust', id, accepted, confirmation),
  saveCredential: (id, value) => invoke('save-credential', id, value),
  deleteCredential: (id) => invoke('delete-credential', id),
  exportConfig: () => invoke('export-config'),
  importConfig: () => invoke('import-config'),
  readLogs: (id, target) => invoke('read-logs', id, target),
  exportLogs: (id, target) => invoke('export-logs', id, target),
  followLogs: (id, value) => invoke('follow-logs', id, value),
  stopLogs: (id) => invoke('stop-logs', id),
  listTasks: () => invoke('list-tasks'),
  readTask: (id) => invoke('read-task', id),
  openDataDir: () => invoke('open-data-dir'),
  onEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => callback(value);
    ipcRenderer.on('deploy:event', listener);
    return () => ipcRenderer.removeListener('deploy:event', listener);
  },
};
contextBridge.exposeInMainWorld('deployCenter', Object.freeze(api));
