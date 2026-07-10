import { app } from "electron";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultKeywordRules, createEmptyCards, type AppSnapshot, type KeywordScoreRule, type StreamCard } from "./types.js";

interface LockedStreamersFile {
  version: 1;
  streamers: Array<{
    slot: number;
    streamer: string;
    clickTargetX?: number;
    clickTargetY?: number;
    clickIntervalMs?: number;
  }>;
}

interface SaveOptions {
  persistLockedStreamers?: boolean;
  allowStreamerClear?: boolean;
  persistKeywordRules?: boolean;
}

interface KeywordScoringFile {
  version: 1;
  rules: KeywordScoreRule[];
}

const mergeCards = (savedCards: StreamCard[] | undefined): StreamCard[] => {
  const savedBySlot = new Map((savedCards ?? []).map((card) => [card.slot, card]));
  const savedByStreamer = new Map(
    (savedCards ?? []).map((card) => [card.streamer.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, ""), card])
  );
  return createEmptyCards().map((emptyCard) => {
    const emptyStreamer = emptyCard.streamer.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const savedBySameSlot = savedBySlot.get(emptyCard.slot);
    const savedCard =
      savedBySameSlot && savedBySameSlot.streamer.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "") === emptyStreamer
        ? savedBySameSlot
        : savedByStreamer.get(emptyStreamer);
    if (!savedCard) {
      return emptyCard;
    }
    const normalizedStreamer = emptyStreamer;
    const normalizedTitle = (savedCard.title ?? "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const normalizedItem = (savedCard.currentItem ?? "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const liveDataMatchesStreamer =
      savedCard.status !== "live" ||
      normalizedTitle === normalizedStreamer ||
      normalizedItem.includes(normalizedStreamer);
    if (!liveDataMatchesStreamer) {
      return emptyCard;
    }
    return {
      ...emptyCard,
      ...savedCard,
      slot: emptyCard.slot,
      streamer: emptyCard.streamer
    };
  });
};

const defaultSnapshot = (profilePath: string): AppSnapshot => ({
  cards: createEmptyCards(),
  devices: [],
  autoClicker: {
    enabled: false,
    autoNavEnabled: false,
    dryRun: false,
    intervalMs: 3000,
    jitterMs: 0,
    targetX: 580,
    targetY: 280,
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
    parkCooldownMs: 120_000,
    maxMatchAgeMs: 120_000,
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
      connected: 0,
      unauthorized: 0,
      offline: 0,
      selectedConnected: 0,
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
    profilePath,
        currentUrl: null,
        feedImageDataUrl: null,
        lastFeedAt: null,
        launchStatus: "idle",
        launchError: null
  },
  scanner: {
    running: false,
    lastTickAt: null
  }
});

const normalizeKeywordRules = (rules: KeywordScoreRule[] | undefined): KeywordScoreRule[] => {
  return (rules ?? [])
    .filter((rule) => typeof rule?.words === "string")
    .map((rule, index) => ({
      id: Number.isFinite(rule.id) ? Number(rule.id) : index + 1,
      words: rule.words,
      score: Number.isFinite(rule.score) ? Number(rule.score) : 0,
      omitWords: typeof rule.omitWords === "string" ? rule.omitWords : ""
    }));
};

const normalizeAutoClicker = (saved: Partial<AppSnapshot>["autoClicker"], profilePath: string): AppSnapshot["autoClicker"] => {
  const defaults = defaultSnapshot(profilePath).autoClicker;
  const profile2024 = saved?.profiles?.["2024"];
  const profile2025 = saved?.profiles?.["2025"];
  const normalizeProfile = (
    savedProfile: Partial<AppSnapshot["autoClicker"]["profiles"]["2024"]> | undefined,
    fallback: AppSnapshot["autoClicker"]["profiles"]["2024"]
  ) => ({
    targetX: Number.isFinite(savedProfile?.targetX) ? Number(savedProfile?.targetX) : fallback.targetX,
    targetY: Number.isFinite(savedProfile?.targetY) ? Number(savedProfile?.targetY) : fallback.targetY,
    intervalMs: Number.isFinite(savedProfile?.intervalMs) && Number(savedProfile?.intervalMs) > 0 ? Number(savedProfile?.intervalMs) : fallback.intervalMs,
    jitterMs: 0
  });
  const profiles = {
    "2024": normalizeProfile(profile2024, defaults.profiles["2024"]),
    "2025": normalizeProfile(profile2025, {
      targetX: Number.isFinite(saved?.targetX) && saved!.targetX > 0 ? saved!.targetX : defaults.profiles["2025"].targetX,
      targetY: Number.isFinite(saved?.targetY) && saved!.targetY > 0 ? saved!.targetY : defaults.profiles["2025"].targetY,
      intervalMs: Number.isFinite(saved?.intervalMs) && saved!.intervalMs > 0 ? saved!.intervalMs : defaults.profiles["2025"].intervalMs,
      jitterMs: 0
    })
  };
  const selectedProfile = saved?.selectedProfile === "2024" || saved?.selectedProfile === "2025" ? saved.selectedProfile : null;
  const activeProfile = selectedProfile ? profiles[selectedProfile] : null;
  const merged = {
    ...defaults,
    ...saved,
    enabled: false,
    autoNavEnabled: false,
    dryRun: Boolean(saved?.dryRun),
    selectedProfile,
    profiles,
    parkCooldownMs: Number.isFinite(saved?.parkCooldownMs) ? Number(saved?.parkCooldownMs) : defaults.parkCooldownMs,
    maxMatchAgeMs: Number.isFinite(saved?.maxMatchAgeMs) ? Number(saved?.maxMatchAgeMs) : defaults.maxMatchAgeMs,
    lastParkedAt: saved?.lastParkedAt ?? null,
    lastAction: saved?.lastAction ?? null,
    lastActionAt: saved?.lastActionAt ?? null,
    nextScanAt: saved?.nextScanAt ?? null,
    runtimeState: saved?.runtimeState ?? defaults.runtimeState,
    runtimeDetail: saved?.runtimeDetail ?? null,
    matchedRuleId: saved?.matchedRuleId ?? null,
    matchedScore: saved?.matchedScore ?? null,
    ruleHits: Array.isArray(saved?.ruleHits) ? saved.ruleHits : [],
    activityLog: {
      currentTask: Array.isArray(saved?.activityLog?.currentTask) ? saved.activityLog.currentTask : [],
      enteredStream: Array.isArray(saved?.activityLog?.enteredStream) ? saved.activityLog.enteredStream : [],
      enteredGiveaway: Array.isArray(saved?.activityLog?.enteredGiveaway) ? saved.activityLog.enteredGiveaway : []
    },
    adbHealth: {
      ...defaults.adbHealth,
      ...saved?.adbHealth
    }
  };

  return {
    ...merged,
    targetX: activeProfile ? activeProfile.targetX : 0,
    targetY: activeProfile ? activeProfile.targetY : 0,
    intervalMs: activeProfile ? activeProfile.intervalMs : 0,
    jitterMs: activeProfile ? activeProfile.jitterMs : 0
  };
};

const writeJsonAtomic = async (path: string, value: unknown): Promise<void> => {
  const payload = JSON.stringify(value, null, 2);
  const tempPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await writeFile(tempPath, payload, "utf8");
      await rename(tempPath, path);
      return;
    } catch (error) {
      if (attempt === 4) {
        await writeFile(path, payload, "utf8");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
};

export class ConfigStore {
  readonly appDataDir = join(app.getPath("userData"));
  readonly browserProfilePath = join(this.appDataDir, "chromium-profile");
  private readonly configPath = join(this.appDataDir, "nilbog-config.json");
  private readonly lockedStreamersPath = join(this.appDataDir, "locked-streamers.json");
  private readonly keywordScoringPath = join(this.appDataDir, "keyword-scoring.json");

  async load(): Promise<AppSnapshot> {
    await mkdir(this.appDataDir, { recursive: true });
    await mkdir(this.browserProfilePath, { recursive: true });

    try {
      const raw = await readFile(this.configPath, "utf8");
      const saved = JSON.parse(raw) as Partial<AppSnapshot>;
      const lockedStreamers = await this.loadLockedStreamers(saved.cards);
      const keywordRules = await this.loadKeywordRules(saved.keywordScoring?.rules);
      return {
        ...defaultSnapshot(this.browserProfilePath),
        ...saved,
        autoClicker: normalizeAutoClicker(saved.autoClicker, this.browserProfilePath),
        focusRouting: {
          ...defaultSnapshot(this.browserProfilePath).focusRouting,
          ...saved.focusRouting
        },
        keywordScoring: {
          rules: keywordRules
        },
        cards: this.applyLockedStreamers(mergeCards(saved.cards), lockedStreamers),
        browser: {
          launched: false,
          authenticated: saved.browser?.authenticated ?? false,
          profilePath: this.browserProfilePath,
          currentUrl: saved.browser?.currentUrl ?? null,
          feedImageDataUrl: null,
          lastFeedAt: saved.browser?.lastFeedAt ?? null,
          launchStatus: "idle",
          launchError: null
        },
        scanner: {
          running: false,
          lastTickAt: null
        }
      };
    } catch {
      const snapshot = defaultSnapshot(this.browserProfilePath);
      const keywordRules = await this.loadKeywordRules(snapshot.keywordScoring.rules);
      return {
        ...snapshot,
        keywordScoring: {
          rules: keywordRules
        },
        cards: this.applyLockedStreamers(snapshot.cards, await this.loadLockedStreamers())
      };
    }
  }

  async save(snapshot: AppSnapshot, options: SaveOptions = {}): Promise<void> {
    const toSave: AppSnapshot = {
      ...snapshot,
      browser: {
        launched: false,
        authenticated: snapshot.browser.authenticated,
        profilePath: this.browserProfilePath,
        currentUrl: snapshot.browser.currentUrl,
        feedImageDataUrl: null,
        lastFeedAt: snapshot.browser.lastFeedAt,
        launchStatus: "idle",
        launchError: null
      },
      scanner: {
        running: false,
        lastTickAt: snapshot.scanner.lastTickAt
      }
    };
    await writeJsonAtomic(this.configPath, toSave);
    if (options.persistKeywordRules) {
      await this.saveKeywordRules(snapshot.keywordScoring.rules);
    }

    if (options.persistLockedStreamers) {
      await this.saveLockedStreamers(snapshot.cards, options);
    }
  }

  private async loadLockedStreamers(fallbackCards?: StreamCard[]): Promise<Map<number, Partial<StreamCard>>> {
    try {
      const raw = await readFile(this.lockedStreamersPath, "utf8");
      const saved = JSON.parse(raw) as LockedStreamersFile;
      return new Map(
        saved.streamers.map((entry) => [
          entry.slot,
          {
            streamer: entry.streamer,
            clickTargetX: entry.clickTargetX,
            clickTargetY: entry.clickTargetY,
            clickIntervalMs: entry.clickIntervalMs
          }
        ])
      );
    } catch {
      return new Map(
        (fallbackCards ?? []).map((card) => [
          card.slot,
          {
            streamer: card.streamer,
            clickTargetX: card.clickTargetX,
            clickTargetY: card.clickTargetY,
            clickIntervalMs: card.clickIntervalMs
          }
        ])
      );
    }
  }

  private async loadKeywordRules(fallbackRules?: KeywordScoreRule[]): Promise<KeywordScoreRule[]> {
    return normalizeKeywordRules(createDefaultKeywordRules().length ? createDefaultKeywordRules() : fallbackRules);
  }

  private async saveKeywordRules(rules: KeywordScoreRule[]): Promise<void> {
    const payload: KeywordScoringFile = {
      version: 1,
      rules: normalizeKeywordRules(rules)
    };
    await writeJsonAtomic(this.keywordScoringPath, payload);
  }

  private applyLockedStreamers(cards: StreamCard[], lockedStreamers: Map<number, Partial<StreamCard>>): StreamCard[] {
    const fixedStreamers = ["KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "VendturesVault", "WestCoastCards", "Woosleys"];
    return cards.map((card) => {
      const locked = lockedStreamers.get(card.slot);
      const streamer = fixedStreamers[card.slot] ?? card.streamer;
      const streamerChanged = card.streamer.trim().toLowerCase() !== streamer.trim().toLowerCase();
      const baseCard = streamerChanged
        ? {
            ...card,
            status: "empty" as const,
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
          }
        : card;
      return locked === undefined
        ? { ...baseCard, streamer }
        : {
            ...baseCard,
            streamer,
            clickTargetX: locked.clickTargetX ?? baseCard.clickTargetX,
            clickTargetY: locked.clickTargetY ?? baseCard.clickTargetY,
            clickIntervalMs: locked.clickIntervalMs ?? baseCard.clickIntervalMs,
            status: streamer ? baseCard.status : "empty"
          };
    });
  }

  private async saveLockedStreamers(cards: StreamCard[], options: SaveOptions): Promise<void> {
    const existing = await this.loadLockedStreamers(cards);
    const payload: LockedStreamersFile = {
      version: 1,
      streamers: cards
        .map((card) => {
          const existingCard = existing.get(card.slot);
          const existingStreamer = existingCard?.streamer?.trim() ?? "";
          const nextStreamer = card.streamer.trim();

          return {
            slot: card.slot,
            streamer: nextStreamer || (options.allowStreamerClear ? "" : existingStreamer),
            clickTargetX: Number.isFinite(card.clickTargetX) ? card.clickTargetX : existingCard?.clickTargetX,
            clickTargetY: Number.isFinite(card.clickTargetY) ? card.clickTargetY : existingCard?.clickTargetY,
            clickIntervalMs: Number.isFinite(card.clickIntervalMs) ? card.clickIntervalMs : existingCard?.clickIntervalMs
          };
        })
    };

    try {
      await copyFile(this.lockedStreamersPath, `${this.lockedStreamersPath}.bak`);
    } catch {
      // No existing durable streamer file yet.
    }

    await writeJsonAtomic(this.lockedStreamersPath, payload);
  }
}
