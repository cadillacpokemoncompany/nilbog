const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nilbog", {
  getSnapshot: () => ipcRenderer.invoke("snapshot:get"),
  launchBrowser: () => ipcRenderer.invoke("browser:launch"),
  minimizeApp: () => ipcRenderer.invoke("app:minimize"),
  updateCard: (slot, patch) => ipcRenderer.invoke("card:update", slot, patch),
  updateAutoClicker: (patch) => ipcRenderer.invoke("autoclicker:update", patch),
  updateKeywordScoring: (rules) => ipcRenderer.invoke("keyword-scoring:update", rules),
  sendCardToDevices: (slot) => ipcRenderer.invoke("card:send-to-devices", slot),
  installLatestUpdate: () => ipcRenderer.invoke("update:install-latest"),
  onSnapshot: (listener) => {
    const wrapped = (_event, snapshot) => listener(snapshot);
    ipcRenderer.on("snapshot", wrapped);
    return () => ipcRenderer.off("snapshot", wrapped);
  },
  onStreamPreviewFrame: (listener) => {
    const wrapped = (_event, frame) => listener(frame);
    ipcRenderer.on("stream-preview-frame", wrapped);
    return () => ipcRenderer.off("stream-preview-frame", wrapped);
  }
});
