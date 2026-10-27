const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('atlasLauncher', {
  status: () => ipcRenderer.invoke('launcher:status'),
  launch: () => ipcRenderer.invoke('launcher:launch'),
  install: () => ipcRenderer.invoke('launcher:install'),
  selfUpdate: () => ipcRenderer.invoke('launcher:self-update'),
  openRelease: () => ipcRenderer.invoke('launcher:open-release'),
  onProgress: (callback) => ipcRenderer.on('launcher:progress', (_event, payload) => callback(payload))
});
