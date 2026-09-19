const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("atlas", {
  // Conexão do PC
  getState: () => ipcRenderer.invoke("atlas:get-state"),
  connect: (data) => ipcRenderer.invoke("atlas:connect", data),
  skip: (data) => ipcRenderer.invoke("atlas:skip", data),
  openSite: () => ipcRenderer.invoke("atlas:open-site"),
  openSetup: () => ipcRenderer.invoke("atlas:open-setup"),
  openUpdates: () => ipcRenderer.invoke("atlas:open-updates"),
  onStatus: (cb) => ipcRenderer.on("atlas:status", (_e, status) => cb(status)),

  // Atualização automática
  getUpdate: () => ipcRenderer.invoke("atlas:get-update"),
  installUpdate: () => ipcRenderer.invoke("atlas:install-update"),
  dismissUpdate: () => ipcRenderer.invoke("atlas:dismiss-update"),
  checkUpdate: () => ipcRenderer.invoke("atlas:check-update"),
  onUpdateAvailable: (cb) => ipcRenderer.on("atlas:update-available", (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on("atlas:update-progress", (_e, p) => cb(p)),
});
