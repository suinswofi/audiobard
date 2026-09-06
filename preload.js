'use strict';
// Runs sandboxed: only `electron` may be required here, everything else goes through IPC.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booklark', {
  env: () => ipcRenderer.invoke('env'),
  pickBook: () => ipcRenderer.invoke('pick-book'),
  pickAudio: () => ipcRenderer.invoke('pick-audio'),
  pickOutDir: (current) => ipcRenderer.invoke('pick-outdir', current),
  saveRecording: (samples, rate) => ipcRenderer.invoke('save-recording', samples, rate),
  installClone: () => ipcRenderer.invoke('install-clone'),
  preview: (opts) => ipcRenderer.invoke('preview', opts),
  start: (job) => ipcRenderer.invoke('start', job),
  cancel: () => ipcRenderer.invoke('cancel'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  onEvent: (cb) => ipcRenderer.on('worker-event', (_e, msg) => cb(msg)),
  onInstallLog: (cb) => ipcRenderer.on('install-log', (_e, line) => cb(line)),
});
