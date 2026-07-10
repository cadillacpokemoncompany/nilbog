import { contextBridge, ipcRenderer } from "electron";
import type { AppSnapshot, AutoClickerSettings, KeywordScoreRule, StreamCard } from "./types.js";

contextBridge.exposeInMainWorld("nilbog", {
  getSnapshot: () => ipcRenderer.invoke("snapshot:get") as Promise<AppSnapshot>,
  launchBrowser: () => ipcRenderer.invoke("browser:launch") as Promise<AppSnapshot>,
  minimizeApp: () => ipcRenderer.invoke("app:minimize") as Promise<void>,
  updateCard: (slot: number, patch: Partial<StreamCard>) =>
    ipcRenderer.invoke("card:update", slot, patch) as Promise<AppSnapshot>,
  updateAutoClicker: (patch: Partial<AutoClickerSettings>) =>
    ipcRenderer.invoke("autoclicker:update", patch) as Promise<AppSnapshot>,
  updateKeywordScoring: (rules: KeywordScoreRule[]) =>
    ipcRenderer.invoke("keyword-scoring:update", rules) as Promise<AppSnapshot>,
  sendCardToDevices: (slot: number) => ipcRenderer.invoke("card:send-to-devices", slot) as Promise<AppSnapshot>,
  onSnapshot: (listener: (snapshot: AppSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot);
    ipcRenderer.on("snapshot", wrapped);
    return () => ipcRenderer.off("snapshot", wrapped);
  },
  onStreamPreviewFrame: (listener: (frame: { streamId: string; imageDataUrl: string | null }) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, frame: { streamId: string; imageDataUrl: string | null }) => listener(frame);
    ipcRenderer.on("stream-preview-frame", wrapped);
    return () => ipcRenderer.off("stream-preview-frame", wrapped);
  }
});
