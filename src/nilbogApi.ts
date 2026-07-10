import { createDefaultKeywordRules, type AppSnapshot, type AutoClickerSettings, type KeywordScoreRule, type StreamCard } from "../electron/types";

const createCards = (): StreamCard[] =>
  ["KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "VendturesVault", "WestCoastCards", "Woosleys"].map((streamer, slot) => ({
    slot,
    streamer,
    clickTargetX: 0,
    clickTargetY: 0,
    clickIntervalMs: 0,
    status: "empty",
    resolvedUrl: null,
    streamUuid: null,
    title: null,
    currentItem: null,
    giveawayName: null,
    entryCount: null,
    viewerCount: null,
    thumbnailImageDataUrl: null,
    streamPreviewImageDataUrl: null,
    lastResolvedAt: null,
    error: null
  }));

const createPreviewApi = () => {
  let snapshot: AppSnapshot = {
    cards: createCards(),
    devices: [
      {
        id: "preview-device",
        label: "Preview ADB",
        selected: true,
        status: "connected"
      }
    ],
    autoClicker: {
      enabled: false,
      autoNavEnabled: false,
      dryRun: false,
      intervalMs: 0,
      jitterMs: 0,
      targetX: 0,
      targetY: 0,
      selectedProfile: null,
      profiles: {
      "2024": {
        targetX: 580,
        targetY: 305,
        intervalMs: 3000,
        jitterMs: 0
      },
      "2025": {
        targetX: 580,
        targetY: 280,
        intervalMs: 3000,
        jitterMs: 0
      }
      },
      activeSlot: null,
      parkCooldownMs: 120000,
      maxMatchAgeMs: 120000,
      lastParkedAt: null,
      lastAction: null,
      lastActionAt: null,
      nextScanAt: null,
      runtimeState: "OFF",
      runtimeDetail: null,
      matchedRuleId: null,
      matchedScore: null,
      ruleHits: [],
      activityLog: {
        currentTask: [],
        enteredStream: [],
        enteredGiveaway: []
      },
      adbHealth: {
        connected: 1,
        unauthorized: 0,
        offline: 0,
        selectedConnected: 1,
        lastTapAt: null,
        lastTapDevice: null,
        lastEnteredSlot: null,
        lastTapOk: null,
        lastError: null
      }
    },
    focusRouting: {
      watchDate: null,
      novaBaselineUuid: null,
      novaAcceptedUuid: null,
      novaSawOffline: false
    },
    keywordScoring: {
      rules: createDefaultKeywordRules()
    },
    browser: {
      launched: false,
      authenticated: false,
      profilePath: "Preview mode",
      currentUrl: null,
      feedImageDataUrl: null,
      lastFeedAt: null,
      launchStatus: "idle",
      launchError: null
    },
    scanner: {
      running: true,
      lastTickAt: new Date().toISOString()
    }
  };

  const listeners = new Set<(next: AppSnapshot) => void>();
  const commit = (next: AppSnapshot) => {
    snapshot = next;
    listeners.forEach((listener) => listener(snapshot));
    return Promise.resolve(snapshot);
  };

  return {
    getSnapshot: () => Promise.resolve(snapshot),
    launchBrowser: () =>
      commit({
        ...snapshot,
        browser: { ...snapshot.browser, launched: true, launchStatus: "open", launchError: null }
      }),
    minimizeApp: () => Promise.resolve(),
    updateCard: (slot: number, patch: Partial<StreamCard>) =>
      commit({
        ...snapshot,
        cards: snapshot.cards.map((card) =>
          card.slot === slot
            ? {
                ...card,
                ...patch,
                status: patch.streamer?.trim() ? "resolving" : (patch.status ?? card.status)
              }
            : card
        )
      }),
    updateAutoClicker: (patch: Partial<AutoClickerSettings>) =>
      commit({
        ...snapshot,
        autoClicker: { ...snapshot.autoClicker, ...patch }
      }),
    updateKeywordScoring: (rules: KeywordScoreRule[]) =>
      commit({
        ...snapshot,
        keywordScoring: { rules }
      }),
    sendCardToDevices: () => Promise.resolve(snapshot),
    onSnapshot: (listener: (next: AppSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStreamPreviewFrame: () => () => undefined
  };
};

export const isElectronApiAvailable = Boolean(window.nilbog);

export const nilbogApi = window.nilbog ?? createPreviewApi();
