import type { AppSnapshot, AutoClickerSettings, KeywordScoreRule, StreamCard } from "../electron/types";

declare global {
  interface Window {
    nilbog: {
      getSnapshot: () => Promise<AppSnapshot>;
      launchBrowser: () => Promise<AppSnapshot>;
      minimizeApp: () => Promise<void>;
      updateCard: (slot: number, patch: Partial<StreamCard>) => Promise<AppSnapshot>;
      updateAutoClicker: (patch: Partial<AutoClickerSettings>) => Promise<AppSnapshot>;
      updateKeywordScoring: (rules: KeywordScoreRule[]) => Promise<AppSnapshot>;
      sendCardToDevices: (slot: number) => Promise<AppSnapshot>;
      installLatestUpdate: () => Promise<AppSnapshot>;
      onSnapshot: (listener: (snapshot: AppSnapshot) => void) => () => void;
      onStreamPreviewFrame: (listener: (frame: { streamId: string; imageDataUrl: string | null }) => void) => () => void;
    };
  }
}
