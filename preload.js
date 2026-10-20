const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('socialAtlasUpdater', {
  check: () => ipcRenderer.invoke('updates:check'),
  apply: () => ipcRenderer.invoke('updates:apply')
});
