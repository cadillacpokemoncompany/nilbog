export type DeviceStatus = "connected" | "offline" | "unauthorized";

export interface AdbDevice {
  id: string;
  status: DeviceStatus;
  label: string;
  selected: boolean;
}

export type DeviceRuntimePhase =
  | "connected"
  | "offline"
  | "unauthorized"
  | "routing"
  | "on_stream"
  | "clicking"
  | "parked"
  | "home"
  | "failed"
  | "unknown";

export interface DeviceRuntimeState {
  id: string;
  label: string;
  status: DeviceStatus;
  selected: boolean;
  phase: DeviceRuntimePhase;
  targetStreamer: string | null;
  targetUrl: string | null;
  lastSeenAt: string;
  lastActionAt: string | null;
  lastAction: string | null;
  lastError: string | null;
}

export type StreamStatus = "empty" | "resolving" | "offline" | "live" | "unknown" | "error";

export interface StreamCard {
  slot: number;
  streamer: string;
  clickTargetX: number;
  clickTargetY: number;
  clickIntervalMs: number;
  status: StreamStatus;
  resolvedUrl: string | null;
  streamUuid: string | null;
  title: string | null;
  currentItem: string | null;
  giveawayName: string | null;
  entryCount: number | null;
  viewerCount: number | null;
  thumbnailImageDataUrl: string | null;
  streamPreviewImageDataUrl: string | null;
  lastResolvedAt: string | null;
  error: string | null;
}

export interface FollowingFeedLiveStream {
  streamId: string;
  streamUrl: string;
  matchText: string;
  isLive: boolean;
  lifecycleState: "online" | "offline" | "unknown";
  lifecycleStatus: string | null;
  viewerCount: number | null;
  hostId: string | null;
  username: string | null;
  normalizedUsername: string | null;
  thumbnailImageDataUrl: string | null;
  streamer?: string;
}

export interface GiveawayState {
  active: boolean;
  giveawayId: string | null;
  giveawayName: string | null;
  source: "WS_PRIMARY" | "BROWSER_APOLLO" | "DOM_SCRAPE";
  confidence: number;
  updatedAt: string;
}

export type AutopilotRuntimeState = "OFF" | "READY" | "NO_PROFILE" | "NO_DEVICE" | "NO_MATCH" | "PARKED" | "MATCHED" | "DRY_RUN";

export interface RuleHitPreview {
  slot: number;
  ruleId: number;
  streamer: string;
  giveawayName: string;
  score: number;
  phrase: string;
}

export interface ActivityLogEntry {
  at: string;
  text: string;
}

export interface AdbHealth {
  connected: number;
  unauthorized: number;
  offline: number;
  selectedConnected: number;
  lastTapAt: string | null;
  lastTapDevice: string | null;
  lastEnteredSlot: number | null;
  lastTapOk: boolean | null;
  lastError: string | null;
}

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloaded" | "pending" | "installing" | "error" | "disabled";

export interface UpdateHealth {
  currentVersion: string;
  latestVersion: string | null;
  status: UpdateStatus;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  pendingInstaller: string | null;
}

export interface AutoClickerSettings {
  enabled: boolean;
  autoNavEnabled: boolean;
  dryRun: boolean;
  intervalMs: number;
  jitterMs: number;
  targetX: number;
  targetY: number;
  activeDeviceProfile: "2024" | "2025";
  profiles: Record<"2024" | "2025", { targetX: number; targetY: number; intervalMs: number }>;
  activeSlot: number | null;
  parkCooldownMs: number;
  maxMatchAgeMs: number;
  lastParkedAt: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
  nextScanAt: string | null;
  runtimeState: AutopilotRuntimeState;
  runtimeDetail: string | null;
  matchedRuleId: number | null;
  matchedScore: number | null;
  ruleHits: RuleHitPreview[];
  activityLog: {
    currentTask: ActivityLogEntry[];
    enteredStream: ActivityLogEntry[];
    enteredGiveaway: ActivityLogEntry[];
  };
  adbHealth: AdbHealth;
  deviceRuntime: DeviceRuntimeState[];
  updateHealth: UpdateHealth;
}

export interface FocusRoutingState {
  watchDate: string | null;
  novaBaselineUuid: string | null;
  novaAcceptedUuid: string | null;
  novaSawOffline: boolean;
}

export interface KeywordScoreRule {
  id: number;
  words: string;
  score: number;
  omitWords: string;
}

export interface AppSnapshot {
  cards: StreamCard[];
  devices: AdbDevice[];
  autoClicker: AutoClickerSettings;
  focusRouting: FocusRoutingState;
  keywordScoring: {
    rules: KeywordScoreRule[];
  };
  browser: {
    launched: boolean;
    authenticated: boolean;
    profilePath: string;
    currentUrl: string | null;
    feedImageDataUrl: string | null;
    lastFeedAt: string | null;
    launchStatus: "idle" | "launching" | "open" | "error";
    launchError: string | null;
  };
  scanner: {
    running: boolean;
    lastTickAt: string | null;
  };
}

export const createEmptyCards = (): StreamCard[] =>
  ["KrakenDrips", "KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "TraderBea", "VendturesVault", "Woosleys"].map((streamer, index) => ({
    slot: index,
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

export const createDefaultKeywordRules = (): KeywordScoreRule[] =>
  [
    { id: 1, words: "massive", score: 100, omitWords: "streamer:NovaTCG" },
    { id: 2, words: "etb, elite trainer", score: 75, omitWords: "streamer:any" },
    { id: 3, words: "booster bundle", score: 50, omitWords: "streamer:any" },
    { id: 4, words: "premium collection", score: 50, omitWords: "streamer:any" },
    { id: 5, words: "upc, ultra premium", score: 250, omitWords: "streamer:any" },
    { id: 6, words: "first partner", score: 25, omitWords: "streamer:any" },
    { id: 7, words: "100 amazon", score: 100, omitWords: "streamer:any" },
    { id: 8, words: "250 amazon", score: 250, omitWords: "streamer:any" },
    { id: 9, words: "500 amazon", score: 500, omitWords: "streamer:any" },
    { id: 10, words: "1000 amazon", score: 1000, omitWords: "streamer:any" },
    { id: 11, words: "playstation 5, ps5", score: 500, omitWords: "streamer:any" },
    { id: 12, words: "booster box", score: 25, omitWords: "streamer:VendturesVault" },
    { id: 13, words: "booster box", score: 500, omitWords: "streamer:KrakenHits" },
    { id: 14, words: "booster box", score: 25, omitWords: "streamer:NovaTCG" }
  ];
