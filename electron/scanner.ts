import { BrowserWindow } from "electron";
import { AdbService } from "./adbService.js";
import { BrowserService } from "./browserService.js";
import { ConfigStore } from "./configStore.js";
import { WhatnotResolver } from "./whatnotResolver.js";
import type { AdbDevice, AppSnapshot, DeviceRuntimeState, FollowingFeedLiveStream, GiveawayState, GiveawayWinnerState, StreamCard } from "./types.js";

export type RuntimeNotification = {
  kind: "navigation" | "parking";
  streamer: string;
  detail: string;
};

const DEVICE_SCAN_MS = 2_500;
const FEED_CYCLE_MS = 30_000;
const FEED_SETTLE_MS = 5_000;
const FEED_HARD_REFRESH_MS = 150_000;
// A transient empty/partial followed-feed scrape must not eject a valid live target.
// At the 2.5s scanner cadence this provides roughly one minute for the feed to recover.
const OFFLINE_GRACE = 24;
const PARKING_PRIORITY = ["krakendrips", "krakenhits"];
const routeVerifyDelayMsFromEnv = Number(process.env.NILBOG_ROUTE_VERIFY_DELAY_MS);
const routeRetryVerifyDelayMsFromEnv = Number(process.env.NILBOG_ROUTE_RETRY_VERIFY_DELAY_MS);
const ROUTE_VERIFY_DELAY_MS = Number.isFinite(routeVerifyDelayMsFromEnv) ? Math.max(0, routeVerifyDelayMsFromEnv) : 700;
const ROUTE_RETRY_VERIFY_DELAY_MS = Number.isFinite(routeRetryVerifyDelayMsFromEnv) ? Math.max(0, routeRetryVerifyDelayMsFromEnv) : 900;
const WHATNOT_PACKAGE = "com.whatnot_mobile";
const FIXED_AUTOPILOT_RULES: Array<{
  id: number;
  score: number;
  streamers: "any" | string[];
  phrases: string[];
}> = [
  { id: 1, score: 100, streamers: ["novatcg"], phrases: ["massive"] },
  { id: 2, score: 75, streamers: "any", phrases: ["etb", "elite trainer"] },
  { id: 3, score: 50, streamers: "any", phrases: ["booster bundle"] },
  { id: 4, score: 50, streamers: "any", phrases: ["premium collection"] },
  { id: 5, score: 250, streamers: "any", phrases: ["upc", "ultra premium"] },
  { id: 6, score: 25, streamers: "any", phrases: ["first partner"] },
  { id: 7, score: 100, streamers: "any", phrases: ["100 amazon", "amazon 100", "$100 amazon", "amazon $100"] },
  { id: 8, score: 250, streamers: "any", phrases: ["250 amazon", "amazon 250", "$250 amazon", "amazon $250"] },
  { id: 9, score: 500, streamers: "any", phrases: ["500 amazon", "amazon 500", "$500 amazon", "amazon $500"] },
  { id: 10, score: 1000, streamers: "any", phrases: ["1000 amazon", "amazon 1000", "$1000 amazon", "amazon $1000"] },
  { id: 11, score: 500, streamers: "any", phrases: ["playstation 5", "ps5"] },
  { id: 12, score: 25, streamers: ["vendturesvault"], phrases: ["booster box"] },
  { id: 13, score: 500, streamers: ["krakenhits"], phrases: ["booster box"] },
  { id: 14, score: 25, streamers: ["novatcg"], phrases: ["booster box"] },
  { id: 15, score: 25, streamers: "any", phrases: ["25 amazon", "amazon 25", "$25 amazon", "amazon $25"] },
  { id: 16, score: 50, streamers: "any", phrases: ["50 amazon", "amazon 50", "$50 amazon", "amazon $50"] },
  { id: 17, score: 100, streamers: ["traderbea", "traderbeaplus"], phrases: ["sponsored", "upgraded"] }
];
const normalizeStreamerName = (value: string | null | undefined): string =>
  (value ?? "").trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const cleanGiveawayName = (value: string | null | undefined): string | null => {
  const normalized = (value ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (/^(new|used|sealed|ship only|rip only|rip or ship)$/i.test(normalized)) return null;
  if (/^\d+\s*-\s*#\d+\b/i.test(normalized)) return null;
  return normalized;
};

const mergeDeviceRuntime = (
  devices: AdbDevice[],
  previous: DeviceRuntimeState[],
  nowIso: string
): DeviceRuntimeState[] => {
  const previousById = new Map(previous.map((device) => [device.id, device]));
  const seenIds = new Set(devices.map((device) => device.id));
  const active = devices.map((device) => {
    const saved = previousById.get(device.id);
    return {
      id: device.id,
      label: device.label,
      status: device.status,
      selected: device.selected,
      phase:
        device.status === "connected"
          ? (saved?.phase && !["offline", "unauthorized", "unknown"].includes(saved.phase) ? saved.phase : "connected")
          : device.status,
      targetStreamer: saved?.targetStreamer ?? null,
      targetUrl: saved?.targetUrl ?? null,
      lastSeenAt: nowIso,
      lastActionAt: saved?.lastActionAt ?? null,
      lastAction: saved?.lastAction ?? null,
      lastError: device.status === "connected" ? saved?.lastError ?? null : device.status
    } satisfies DeviceRuntimeState;
  });

  const disappeared = previous
    .filter((device) => !seenIds.has(device.id))
    .map((device) => ({
      ...device,
      status: "offline" as const,
      selected: false,
      phase: "offline" as const,
      lastError: "not listed by adb"
    }));

  return [...active, ...disappeared].sort((left, right) => left.label.localeCompare(right.label));
};

const patchDeviceRuntime = (
  runtime: DeviceRuntimeState[],
  deviceIds: string[],
  patch: Partial<Omit<DeviceRuntimeState, "id" | "label" | "status" | "selected" | "lastSeenAt">>,
  nowIso: string
): DeviceRuntimeState[] => {
  const ids = new Set(deviceIds);
  return runtime.map((device) =>
    ids.has(device.id)
      ? {
          ...device,
          ...patch,
          lastActionAt: nowIso
        }
      : device
  );
};

const easternDateAndHour = (date = new Date()): { dateKey: string; hour: number } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    dateKey: `${value("year")}-${value("month")}-${value("day")}`,
    hour: Number(value("hour"))
  };
};

type RouteResult =
  | { deviceId: string; ok: true; retried: boolean }
  | { deviceId: string; ok: false; message: string; retried: boolean };

const routeDevicesParallel = async (
  adb: AdbService,
  devices: AdbDevice[],
  url: string,
  forceFresh = false
): Promise<RouteResult[]> => {
  const expectedUuid = url.match(/\/live\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase() ?? null;
  const firstPass = await Promise.all(
    devices.map(async (device): Promise<RouteResult> => {
      try {
        if (forceFresh) await adb.openUrlFresh(device.id, url);
        else await adb.openUrl(device.id, url);
        return { deviceId: device.id, ok: true, retried: false };
      } catch (error) {
        return {
          deviceId: device.id,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          retried: false
        };
      }
    })
  );

  await new Promise((resolve) => setTimeout(resolve, ROUTE_VERIFY_DELAY_MS));
  const verifyResults = await Promise.all(
    devices.map(async (device): Promise<RouteResult | null> => {
      const first = firstPass.find((result) => result.deviceId === device.id);
      if (first && !first.ok) return first;
      const foreground = await adb.getForegroundPackage(device.id).catch(() => null);
      const currentUuid = expectedUuid ? await adb.getCurrentWhatnotStreamUuid(device.id).catch(() => null) : null;
      const uuidMatches = !expectedUuid || !currentUuid || currentUuid === expectedUuid;
      return foreground === WHATNOT_PACKAGE && uuidMatches
        ? { deviceId: device.id, ok: true, retried: false }
        : {
            deviceId: device.id,
            ok: false,
            message: foreground !== WHATNOT_PACKAGE
              ? `Whatnot not foreground after route (${foreground ?? "unknown"})`
              : `Wrong stream UUID after route (${currentUuid ?? "unknown"}; expected ${expectedUuid})`,
            retried: false
          };
    })
  );
  const retryDevices = devices.filter((device) => verifyResults.some((result) => result && !result.ok && result.deviceId === device.id));
  if (!retryDevices.length) return verifyResults.filter((result): result is RouteResult => Boolean(result));

  await Promise.allSettled(retryDevices.map((device) => adb.openUrlFresh(device.id, url)));
  await new Promise((resolve) => setTimeout(resolve, ROUTE_RETRY_VERIFY_DELAY_MS));
  const retryResults = await Promise.all(
    retryDevices.map(async (device): Promise<RouteResult> => {
    try {
      const foreground = await adb.getForegroundPackage(device.id).catch(() => null);
      const currentUuid = expectedUuid ? await adb.getCurrentWhatnotStreamUuid(device.id).catch(() => null) : null;
      const uuidMatches = !expectedUuid || !currentUuid || currentUuid === expectedUuid;
      return foreground === WHATNOT_PACKAGE && uuidMatches
        ? { deviceId: device.id, ok: true, retried: true }
        : {
            deviceId: device.id,
            ok: false,
            message: foreground !== WHATNOT_PACKAGE
              ? `Whatnot not foreground after retry (${foreground ?? "unknown"})`
              : `Wrong stream UUID after retry (${currentUuid ?? "unknown"}; expected ${expectedUuid})`,
            retried: true
          };
    } catch (error) {
      return {
        deviceId: device.id,
        ok: false,
        message: error instanceof Error ? error.message : String(error),
        retried: true
      };
    }
    })
  );
  const retryByDevice = new Map(retryResults.map((result) => [result.deviceId, result]));
  return verifyResults.map((result) => {
    if (!result || result.ok) return result;
    return retryByDevice.get(result.deviceId) ?? result;
  }).filter((result): result is RouteResult => Boolean(result));
};

export class Scanner {
  private persistQueue: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | null = null;
  private feedCycleStartedAt = 0;
  private lastFeedHardRefreshAt = 0;
  private missingStreamCounts = new Map<string, number>();
  private ticking = false;
  private tickStartedAt: number | null = null;
  private lastAutoNavKey: string | null = null;
  private lastAutoNavAt = 0;

  constructor(
    private snapshot: AppSnapshot,
    private readonly adb: AdbService,
    private readonly browser: BrowserService,
    private readonly resolver: WhatnotResolver,
    private readonly store: ConfigStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly notify?: (notification: RuntimeNotification) => void | Promise<void>
  ) {}

  get state(): AppSnapshot {
    return this.snapshot;
  }

  async setState(
    next: AppSnapshot,
    options: { persistLockedStreamers?: boolean; allowStreamerClear?: boolean; persistKeywordRules?: boolean } = {}
  ): Promise<void> {
    this.snapshot = next;
    await this.persistAndBroadcast(options);
  }

  start(): void {
    if (this.timer) return;
    this.snapshot = {
      ...this.snapshot,
      scanner: { ...this.snapshot.scanner, running: true }
    };
    this.timer = setInterval(() => void this.tick(), DEVICE_SCAN_MS);
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.snapshot = {
      ...this.snapshot,
      scanner: { ...this.snapshot.scanner, running: false }
    };
    void this.persistAndBroadcast();
  }

  forceRestart(reason: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.ticking = false;
    this.tickStartedAt = null;
    this.feedCycleStartedAt = 0;
    this.snapshot = {
      ...this.snapshot,
      scanner: { ...this.snapshot.scanner, running: true },
      autoClicker: {
        ...this.snapshot.autoClicker,
        activityLog: this.appendActivityLog(this.snapshot.autoClicker.activityLog, "currentTask", `SCANNER WATCHDOG: ${reason}`),
        lastAction: `Scanner watchdog restarted scanner: ${reason}`,
        lastActionAt: new Date().toISOString()
      }
    };
    this.timer = setInterval(() => void this.tick(), DEVICE_SCAN_MS);
    void this.persistAndBroadcast();
    void this.tick();
  }

  get health(): { running: boolean; ticking: boolean; tickStartedAt: number | null; lastTickAt: string | null } {
    return {
      running: Boolean(this.timer),
      ticking: this.ticking,
      tickStartedAt: this.tickStartedAt,
      lastTickAt: this.snapshot.scanner.lastTickAt
    };
  }

  applyGiveawayState(streamId: string, state: GiveawayState): void {
    let changed = false;
    const nextGiveawayName = state.active ? cleanGiveawayName(state.giveawayName) : null;
    this.snapshot = {
      ...this.snapshot,
      cards: this.snapshot.cards.map((card) => {
        if (card.streamUuid !== streamId) return card;
        if (nextGiveawayName === card.giveawayName) {
          if (!state.active || !nextGiveawayName) return card;
          changed = true;
          return {
            ...card,
            lastResolvedAt: new Date().toISOString()
          };
        }
        changed = true;
        return {
          ...card,
          giveawayName: nextGiveawayName,
          lastResolvedAt: new Date().toISOString()
        };
      })
    };

    if (changed) {
      void this.persistAndBroadcast();
    }
  }

  applyGiveawayWinner(streamId: string, winner: GiveawayWinnerState): void {
    let changed = false;
    this.snapshot = {
      ...this.snapshot,
      cards: this.snapshot.cards.map((card) => {
        if (card.streamUuid !== streamId) return card;
        changed = true;
        return {
          ...card,
          lastWinner: winner.winnerUsername,
          lastWonItem: winner.prizeName,
          lastWinnerAt: winner.wonAt
        };
      })
    };
    if (changed) void this.persistAndBroadcast();
  }

  applyStreamPreviewFrame(streamId: string, imageDataUrl: string | null): void {
    let changed = false;
    this.snapshot = {
      ...this.snapshot,
      cards: this.snapshot.cards.map((card) => {
        if (card.streamUuid !== streamId || card.streamPreviewImageDataUrl === imageDataUrl) return card;
        changed = true;
        return {
          ...card,
          streamPreviewImageDataUrl: imageDataUrl
        };
      })
    };

    if (changed) {
      this.getWindow()?.webContents.send("snapshot", this.snapshot);
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    this.tickStartedAt = Date.now();

    try {
      const now = Date.now();
      const baseCards = this.snapshot.cards;
      const controlsRunning = this.snapshot.autoClicker.enabled || this.snapshot.autoClicker.autoNavEnabled;
      const devices = controlsRunning ? await this.adb.listDevices(this.snapshot.devices) : this.snapshot.devices;
      let cards = baseCards;
      let liveStreams: FollowingFeedLiveStream[] = [];
      const cycleElapsed = now - this.feedCycleStartedAt;
      const hardRefreshElapsed = now - this.lastFeedHardRefreshAt;

      if (!this.lastFeedHardRefreshAt || hardRefreshElapsed >= FEED_HARD_REFRESH_MS) {
        this.lastFeedHardRefreshAt = now;
        this.feedCycleStartedAt = now;
        await this.browser.reloadFollowingFeed();
      }

      if (!this.feedCycleStartedAt || cycleElapsed >= FEED_CYCLE_MS) {
        this.feedCycleStartedAt = now;
        await this.browser.resetFeedScroll();
      }

      const activeCycleElapsed = now - this.feedCycleStartedAt;
      const isFeedScanWindow = activeCycleElapsed >= FEED_SETTLE_MS;

      if (isFeedScanWindow) {
      liveStreams = await this.browser.scrapeFollowingFeedLiveStreams();
      if (liveStreams.length) {
        const replacedStreamIds: string[] = [];
        cards = await Promise.all(
          cards.map(async (card) => {
            if (!card.streamer.trim()) return card;
            const resolvedCard = await this.resolver.resolve(card, liveStreams);
            if (
              resolvedCard.status === "live" &&
              resolvedCard.streamUuid &&
              card.streamUuid &&
              card.streamUuid !== resolvedCard.streamUuid
            ) {
              replacedStreamIds.push(card.streamUuid);
              this.missingStreamCounts.delete(card.streamUuid);
              this.missingStreamCounts.delete(resolvedCard.streamUuid);
              return {
                ...resolvedCard,
                giveawayName: null,
                streamPreviewImageDataUrl: null
              };
            }
            const existingLooksLikeSameStreamer =
              normalizeStreamerName(card.title) === normalizeStreamerName(card.streamer) ||
              normalizeStreamerName(card.currentItem).includes(normalizeStreamerName(card.streamer));
            if (card.status === "live" && card.streamUuid && resolvedCard.status === "offline" && existingLooksLikeSameStreamer) {
              return card;
            }
            return resolvedCard;
          })
        );
        if (replacedStreamIds.length) {
          await this.browser.closeStreamPages([...new Set(replacedStreamIds)]);
        }
        await this.browser.logFeedMatches(cards.filter((card) => card.streamer.trim()).map((card) => card.streamer), liveStreams);
        const streamPagesToOpen: FollowingFeedLiveStream[] = [];
        cards
          .filter((card) => card.status === "live" && card.streamUuid && card.resolvedUrl)
          .forEach((card) => {
            const liveStream = liveStreams.find((stream) => stream.streamId === card.streamUuid);
            if (!liveStream) return;
            streamPagesToOpen.push({
              ...liveStream,
              streamer: card.streamer
            });
          });
        await this.browser.openStreamPages(streamPagesToOpen).catch(() => undefined);
        const liveStreamIds = new Set(liveStreams.map((stream) => stream.streamId));
        const offlineStreamIds: string[] = [];

        cards = cards.map((card) => {
          if (!card.streamUuid || card.status !== "live") return card;
          if (liveStreamIds.has(card.streamUuid)) {
            this.missingStreamCounts.delete(card.streamUuid);
            return card;
          }

          const missingCount = (this.missingStreamCounts.get(card.streamUuid) ?? 0) + 1;
          this.missingStreamCounts.set(card.streamUuid, missingCount);
          if (missingCount < OFFLINE_GRACE) return card;

          offlineStreamIds.push(card.streamUuid);
          this.missingStreamCounts.delete(card.streamUuid);
          return {
            ...card,
            status: "offline" as const,
            resolvedUrl: null,
            streamUuid: null,
            currentItem: null,
            giveawayName: null,
            entryCount: null,
            viewerCount: null,
            thumbnailImageDataUrl: card.thumbnailImageDataUrl,
            lastResolvedAt: new Date().toISOString()
          };
        });

        if (offlineStreamIds.length) {
          await this.browser.closeStreamPages(offlineStreamIds);
        }
      } else {
        const offlineStreamIds: string[] = [];
        cards = cards.map((card) => {
          if (!card.streamUuid || card.status !== "live") return card;
          const missingCount = (this.missingStreamCounts.get(card.streamUuid) ?? 0) + 1;
          this.missingStreamCounts.set(card.streamUuid, missingCount);
          if (missingCount < OFFLINE_GRACE) return card;

          offlineStreamIds.push(card.streamUuid);
          this.missingStreamCounts.delete(card.streamUuid);
          return {
            ...card,
            status: "offline" as const,
            resolvedUrl: null,
            streamUuid: null,
            currentItem: null,
            giveawayName: null,
            entryCount: null,
            viewerCount: null,
            thumbnailImageDataUrl: card.thumbnailImageDataUrl,
            lastResolvedAt: new Date().toISOString()
          };
        });

        if (offlineStreamIds.length) {
          await this.browser.closeStreamPages(offlineStreamIds);
        }
      }
      await this.browser.scrollFeedPage();
    }

    const feed = await this.browser.captureFeed();
    const giveawayStates = this.browser.getGiveawayStates();
    const latestBySlot = new Map(this.snapshot.cards.map((card) => [card.slot, card]));
    const baseBySlot = new Map(baseCards.map((card) => [card.slot, card]));
    const mergedCards = cards.map((scannedCard) => {
      const latestCard = latestBySlot.get(scannedCard.slot) ?? scannedCard;
      const baseCard = baseBySlot.get(scannedCard.slot) ?? scannedCard;
      const giveawayState = scannedCard.streamUuid ? giveawayStates.get(scannedCard.streamUuid) : undefined;

      if (latestCard.streamer !== baseCard.streamer) {
        return latestCard;
      }

      return {
        ...latestCard,
        ...scannedCard,
        streamer: latestCard.streamer,
        clickTargetX: latestCard.clickTargetX,
        clickTargetY: latestCard.clickTargetY,
        clickIntervalMs: latestCard.clickIntervalMs,
        thumbnailImageDataUrl: scannedCard.thumbnailImageDataUrl ?? latestCard.thumbnailImageDataUrl,
        lastWinner: latestCard.lastWinner,
        lastWonItem: latestCard.lastWonItem,
        lastWinnerAt: latestCard.lastWinnerAt,
        giveawayName: giveawayState?.active
          ? (cleanGiveawayName(giveawayState.giveawayName) ?? cleanGiveawayName(scannedCard.giveawayName))
          : scannedCard.status === "offline" || scannedCard.status === "empty"
            ? null
            : (cleanGiveawayName(latestCard.giveawayName) ?? cleanGiveawayName(scannedCard.giveawayName)),
        streamPreviewImageDataUrl: latestCard.streamPreviewImageDataUrl
      };
    });

      const snapshotAt = new Date().toISOString();
      this.snapshot = {
      ...this.snapshot,
      devices,
      cards: mergedCards,
      autoClicker: {
        ...this.snapshot.autoClicker,
        nextScanAt: new Date(this.feedCycleStartedAt + FEED_CYCLE_MS).toISOString(),
        adbHealth: {
          ...this.snapshot.autoClicker.adbHealth,
          connected: devices.filter((device) => device.status === "connected").length,
          unauthorized: devices.filter((device) => device.status === "unauthorized").length,
          offline: devices.filter((device) => device.status === "offline").length,
          selectedConnected: devices.filter((device) => device.selected && device.status === "connected").length
        },
        deviceRuntime: mergeDeviceRuntime(devices, this.snapshot.autoClicker.deviceRuntime, snapshotAt)
      },
      browser: {
        ...this.snapshot.browser,
        launched: this.browser.launched,
        authenticated: this.browser.isAuthenticated,
        currentUrl: feed.currentUrl,
        feedImageDataUrl: this.browser.isFeedBlocked ? null : (feed.imageDataUrl ?? this.snapshot.browser.feedImageDataUrl),
        lastFeedAt: feed.imageDataUrl ? new Date().toISOString() : this.snapshot.browser.lastFeedAt,
        launchStatus: this.browser.isAuthorizationInProgress ? "launching" : (this.browser.launched ? "open" : this.snapshot.browser.launchStatus),
        launchError: this.browser.isAuthorizationInProgress
          ? "Close login window when done"
          : this.browser.isFeedBlocked
            ? "Authorize browser"
            : (this.browser.launched ? null : this.snapshot.browser.launchError)
      },
      scanner: {
        running: true,
        lastTickAt: snapshotAt
      }
    };
      this.updateFocusRouting(baseCards);
      await this.navigateAutoTarget(devices);
      await this.persistAndBroadcast();
    } finally {
      this.ticking = false;
      this.tickStartedAt = null;
    }
  }

  private async navigateAutoTarget(devices: AdbDevice[]): Promise<void> {
    const decision = this.pickScoredAutopilotTarget();

    if (!this.snapshot.autoClicker.enabled) {
      this.lastAutoNavKey = null;
      this.updateRuntime("OFF", decision.ruleHits.length ? "Match found, autoplay off" : "Autopilot is off", decision);
      return;
    }

    const fallbackTarget = PARKING_PRIORITY
      .map((streamer) => this.snapshot.cards.find((card) => normalizeStreamerName(card.streamer) === streamer && card.status === "live" && card.resolvedUrl))
      .find((card): card is StreamCard => Boolean(card)) ?? null;
    const target = decision.card ?? fallbackTarget;
    const targetIsFallback = !decision.card && Boolean(fallbackTarget);
    const connectedDevices = devices.filter((device) => device.status === "connected");

    if (!target?.resolvedUrl || !connectedDevices.length) {
      if (!connectedDevices.length) {
        this.lastAutoNavKey = null;
        this.updateRuntime("NO_DEVICE", "No connected device", decision);
      } else {
        this.lastAutoNavKey = null;
        this.updateRuntime(this.snapshot.autoClicker.dryRun ? "DRY_RUN" : "NO_MATCH", `${decision.detail}; parking streams not live yet`, decision);
      }
      this.snapshot = {
        ...this.snapshot,
        autoClicker: {
          ...this.snapshot.autoClicker,
          activeSlot: null
        }
      };
      return;
    }

    const runtimeState = this.snapshot.autoClicker.dryRun ? "DRY_RUN" : targetIsFallback ? "NO_MATCH" : "MATCHED";
    const runtimeDetail = targetIsFallback ? `${decision.detail}; staying on ${target.streamer}` : decision.detail;
    const nextKey = [target.slot, target.resolvedUrl, targetIsFallback ? "fallback" : "match"].join(":");
    const targetChanged = nextKey !== this.lastAutoNavKey;
    const routeCandidates = this.snapshot.autoClicker.dryRun || targetChanged ? connectedDevices : [];
    const skippedAlreadyOnTarget = connectedDevices.length - routeCandidates.length;

    let routedCount = this.snapshot.autoClicker.dryRun ? routeCandidates.length : 0;
    if (!this.snapshot.autoClicker.dryRun && routeCandidates.length) {
      const routeStartedAt = new Date().toISOString();
      this.snapshot = {
        ...this.snapshot,
        autoClicker: {
          ...this.snapshot.autoClicker,
          deviceRuntime: patchDeviceRuntime(
            this.snapshot.autoClicker.deviceRuntime,
            routeCandidates.map((device) => device.id),
            {
              phase: "routing",
              targetStreamer: target.streamer,
              targetUrl: target.resolvedUrl,
              lastAction: `routing to ${target.streamer}`,
              lastError: null
            },
            routeStartedAt
          )
        }
      };
      const routeResults = await routeDevicesParallel(this.adb, routeCandidates, target.resolvedUrl, targetChanged);
      routedCount = routeResults.filter((result) => result.ok).length;
      const routeCompletedAt = new Date().toISOString();
      const okIds = routeResults.filter((result) => result.ok).map((result) => result.deviceId);
      const failedResults = routeResults.filter((result) => !result.ok);
      let nextDeviceRuntime = patchDeviceRuntime(
        this.snapshot.autoClicker.deviceRuntime,
        okIds,
        {
          phase: "on_stream",
          targetStreamer: target.streamer,
          targetUrl: target.resolvedUrl,
          lastAction: `on ${target.streamer}`,
          lastError: null
        },
        routeCompletedAt
      );
      for (const failed of failedResults) {
        nextDeviceRuntime = patchDeviceRuntime(
          nextDeviceRuntime,
          [failed.deviceId],
          {
            phase: "failed",
            targetStreamer: target.streamer,
            targetUrl: target.resolvedUrl,
            lastAction: `failed route to ${target.streamer}`,
            lastError: failed.message
          },
          routeCompletedAt
        );
      }
      this.snapshot = {
        ...this.snapshot,
        autoClicker: {
          ...this.snapshot.autoClicker,
          deviceRuntime: nextDeviceRuntime
        }
      };
    }
    if (routeCandidates.length || nextKey !== this.lastAutoNavKey) {
      this.lastAutoNavKey = nextKey;
      this.lastAutoNavAt = Date.now();
    }
    const routeSummary = routeCandidates.length
      ? `Sent ${routedCount}/${routeCandidates.length} phone(s) to ${target.streamer}${skippedAlreadyOnTarget ? `; skipped ${skippedAlreadyOnTarget} already there` : ""}`
      : `Already on ${target.streamer} (${skippedAlreadyOnTarget}/${connectedDevices.length})`;
    const routedAction = this.snapshot.autoClicker.dryRun
      ? `Dry run ${targetIsFallback ? "fallback" : "matched"} ${target.streamer}`
      : routeSummary;
    if (!this.snapshot.autoClicker.dryRun && routeCandidates.length) {
      void this.notify?.({
        kind: targetIsFallback ? "parking" : "navigation",
        streamer: target.streamer,
        detail: [
          targetIsFallback ? `No match; parked in ${target.streamer}` : `Navigated due to "${decision.detail}"`,
          `Routed ${routedCount}/${routeCandidates.length} phones${skippedAlreadyOnTarget ? `; skipped ${skippedAlreadyOnTarget} already there` : ""}`,
          target.giveawayName ?? ""
        ].filter(Boolean).join("\n")
      });
    }
    const streamLog = this.snapshot.autoClicker.dryRun || !routeCandidates.length
      ? this.snapshot.autoClicker.activityLog
      : this.appendActivityLog(this.snapshot.autoClicker.activityLog, "enteredStream", `${target.streamer} ${target.resolvedUrl}`);
    const nextActivityLog = this.appendActivityLog(streamLog, "currentTask", `${targetIsFallback ? "NO_MATCH" : "MATCHED"}: ${routedAction}`);
    this.snapshot = {
      ...this.snapshot,
      autoClicker: {
        ...this.snapshot.autoClicker,
        activeSlot: target.slot,
        runtimeState,
        runtimeDetail,
        matchedRuleId: decision.ruleId,
        matchedScore: decision.score,
        ruleHits: decision.ruleHits,
        activityLog: nextActivityLog,
        lastAction: targetIsFallback ? `No match; staying on ${target.streamer}` : routedAction,
        lastActionAt: new Date().toISOString()
      }
    };
  }

  private pickScoredAutopilotTarget(): {
    card: StreamCard | null;
    score: number | null;
    ruleId: number | null;
    detail: string;
    ruleHits: AppSnapshot["autoClicker"]["ruleHits"];
  } {
    const now = Date.now();
    const liveCards = this.snapshot.cards.filter((card) => card.status === "live" && card.resolvedUrl && card.giveawayName);
    let best: { card: StreamCard; score: number; ruleId: number; phrase: string; resolvedAtMs: number; viewerRank: number } | null = null;
    const ruleHits: AppSnapshot["autoClicker"]["ruleHits"] = [];

    for (const card of liveCards) {
      const resolvedAtMs = card.lastResolvedAt ? Date.parse(card.lastResolvedAt) : now;
      const viewerRank = card.viewerCount === null || card.viewerCount === undefined ? Number.POSITIVE_INFINITY : card.viewerCount;
      const title = card.giveawayName?.toLowerCase() ?? "";
      const streamer = normalizeStreamerName(card.streamer);
      for (const rule of FIXED_AUTOPILOT_RULES) {
        if (rule.streamers !== "any" && !rule.streamers.includes(streamer)) continue;
        const phrase = rule.phrases.find((candidate) => title.includes(candidate));
        if (!phrase) continue;
        ruleHits.push({
          slot: card.slot,
          ruleId: rule.id,
          streamer: card.streamer,
          giveawayName: card.giveawayName ?? "",
          score: rule.score,
          phrase
        });
        if (
          !best ||
          rule.score > best.score ||
          (rule.score === best.score && viewerRank < best.viewerRank) ||
          (rule.score === best.score && viewerRank === best.viewerRank && resolvedAtMs > best.resolvedAtMs) ||
          (rule.score === best.score && viewerRank === best.viewerRank && resolvedAtMs === best.resolvedAtMs && card.slot < best.card.slot)
        ) {
          best = { card, score: rule.score, ruleId: rule.id, phrase, resolvedAtMs, viewerRank };
        }
      }
    }

    if (!best) {
      return {
        card: null,
        score: null,
        ruleId: null,
        detail: liveCards.length ? "No fixed keyword match" : "No live giveaway title to score",
        ruleHits
      };
    }

    return {
      card: best.card,
      score: best.score,
      ruleId: best.ruleId,
      detail: `${best.card.streamer}: ${best.phrase} +${best.score}${best.card.viewerCount !== null && best.card.viewerCount !== undefined ? ` (${best.card.viewerCount} viewers)` : ""}`,
      ruleHits
    };
  }

  private updateRuntime(
    runtimeState: AppSnapshot["autoClicker"]["runtimeState"],
    detail: string,
    decision: { ruleId: number | null; score: number | null; ruleHits: AppSnapshot["autoClicker"]["ruleHits"] } | null,
    action?: string
  ): void {
    const nextTask = action ?? detail;
    const nextActivityLog = this.appendActivityLog(this.snapshot.autoClicker.activityLog, "currentTask", `${runtimeState}: ${nextTask}`);
    this.snapshot = {
      ...this.snapshot,
      autoClicker: {
        ...this.snapshot.autoClicker,
        runtimeState,
        runtimeDetail: detail,
        matchedRuleId: decision?.ruleId ?? null,
        matchedScore: decision?.score ?? null,
        ruleHits: decision?.ruleHits ?? this.snapshot.autoClicker.ruleHits,
        activityLog: nextActivityLog,
        lastAction: action ?? this.snapshot.autoClicker.lastAction,
        lastActionAt: action ? new Date().toISOString() : this.snapshot.autoClicker.lastActionAt
      }
    };
  }

  private appendActivityLog(
    log: AppSnapshot["autoClicker"]["activityLog"],
    key: keyof AppSnapshot["autoClicker"]["activityLog"],
    text: string
  ): AppSnapshot["autoClicker"]["activityLog"] {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) return log;
    const current = log[key] ?? [];
    const nextEntry = { at: new Date().toISOString(), text: trimmed };
    const nextList = current[0]?.text === trimmed ? [nextEntry, ...current.slice(1)] : [nextEntry, ...current].slice(0, 8);
    return {
      ...log,
      [key]: nextList
    };
  }

  private updateFocusRouting(previousCards: StreamCard[]): void {
    const { dateKey, hour } = easternDateAndHour();
    const nova = this.snapshot.cards.find((card) => normalizeStreamerName(card.streamer) === "novatcg");
    const previousNova = previousCards.find((card) => normalizeStreamerName(card.streamer) === "novatcg");
    const novaLiveUuid = nova?.status === "live" ? nova.streamUuid : null;
    const previousNovaUuid = previousNova?.streamUuid ?? null;
    let routing = this.snapshot.focusRouting;

    if (routing.watchDate !== dateKey) {
      routing = {
        watchDate: dateKey,
        novaBaselineUuid: previousNovaUuid ?? novaLiveUuid,
        novaAcceptedUuid: null,
        novaSawOffline: !novaLiveUuid
      };
    }

    if (hour < 22) {
      routing = {
        watchDate: dateKey,
        novaBaselineUuid: novaLiveUuid ?? routing.novaBaselineUuid,
        novaAcceptedUuid: null,
        novaSawOffline: false
      };
    } else if (!novaLiveUuid) {
      routing = {
        ...routing,
        novaSawOffline: true
      };
    } else if (
      routing.novaAcceptedUuid === novaLiveUuid ||
      (routing.novaBaselineUuid === null && routing.novaSawOffline) ||
      (routing.novaBaselineUuid !== null && novaLiveUuid !== routing.novaBaselineUuid)
    ) {
      routing = {
        ...routing,
        novaAcceptedUuid: novaLiveUuid
      };
    }

    this.snapshot = {
      ...this.snapshot,
      focusRouting: routing
    };
  }

  private async persistAndBroadcast(options: { persistLockedStreamers?: boolean; allowStreamerClear?: boolean } = {}): Promise<void> {
    const operation = this.persistQueue
      .catch(() => undefined)
      .then(async () => {
        await this.store.save(this.snapshot, options);
        this.getWindow()?.webContents.send("snapshot", this.snapshot);
      });
    this.persistQueue = operation.catch(() => undefined);
    await operation;
  }
}
