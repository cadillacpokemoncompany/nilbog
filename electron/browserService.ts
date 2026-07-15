import { app } from "electron";
import { BrowserContext, Page, chromium } from "playwright";
import { ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FollowingFeedLiveStream, GiveawayState, GiveawayWinnerState } from "./types.js";

const chromiumChannels = ["chrome"] as const;
const whatnotHomeUrl = "https://www.whatnot.com/";
const whatnotFollowingFeedUrl = "https://www.whatnot.com/?feedId=FOLLOWING_FEED";

const browserCandidates = [
  { name: "Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Chrome", path: "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Edge", path: "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" },
  { name: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }
];

interface StreamSignalHealth {
  streamer: string | null;
  streamUrl: string;
  lastAttachedAt: number;
  lastWsFrameAt: number | null;
  lastGiveawayFrameAt: number | null;
  lastGraphqlAt: number | null;
  lastApolloAt: number | null;
  lastStateAt: number | null;
  lastStateNameAt: number | null;
  lastSelfHealAt: number | null;
}

const packagedChromiumPath = () => {
  const resourcesPath = process.resourcesPath ?? "";
  const candidates = [
    join(resourcesPath, "ms-playwright", "chromium-1208", "chrome-win64", "chrome.exe"),
    join(resourcesPath, "ms-playwright", "chromium-1208", "chrome-win", "chrome.exe")
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

export class BrowserService {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private streamPages = new Map<string, Page>();
  private giveawayStates = new Map<string, GiveawayState>();
  private giveawayNamesByStreamAndId = new Map<string, Map<string, string>>();
  private streamSignalHealth = new Map<string, StreamSignalHealth>();
  private loggedGiveawayStateKeys = new Map<string, string>();
  private apolloRetryTimers = new Map<string, NodeJS.Timeout>();
  private streamSignalWatchdogTimers = new Map<string, NodeJS.Timeout>();
  private giveawayDomTimers = new Map<string, NodeJS.Timeout>();
  private wsHookedStreamIds = new Set<string>();
  private cdpHookedStreamIds = new Set<string>();
  private graphqlHookedStreamIds = new Set<string>();
  private giveawayDebugEvents = new Set<string>();
  private giveawayWsObservedFrames = new Set<string>();
  private streamPreviewTimers = new Map<string, NodeJS.Timeout>();
  private authenticated = false;
  private loginMonitor: Promise<void> | null = null;
  private onBrowserEvent: ((message: string) => void) | null = null;
  private onStreamPreviewFrame: ((streamId: string, imageDataUrl: string | null) => void) | null = null;
  private onGiveawayState: ((streamId: string, state: GiveawayState) => void) | null = null;
  private onGiveawayWinner: ((streamId: string, winner: GiveawayWinnerState) => void) | null = null;
  private emittedGiveawayWinners = new Set<string>();
  private feedBlocked = false;
  private authorizationInProgress = false;
  private authorizationProcess: ChildProcess | null = null;
  private feedCaptureAllowed = false;

  constructor(private readonly profilePath: string) {}

  setLogger(logger: (message: string) => void): void {
    this.onBrowserEvent = logger;
  }

  setStreamPreviewSink(sink: (streamId: string, imageDataUrl: string | null) => void): void {
    this.onStreamPreviewFrame = sink;
  }

  setGiveawayStateSink(sink: (streamId: string, state: GiveawayState) => void): void {
    this.onGiveawayState = sink;
  }

  setGiveawayWinnerSink(sink: (streamId: string, winner: GiveawayWinnerState) => void): void {
    this.onGiveawayWinner = sink;
  }

  setAuthenticated(authenticated: boolean): void {
    this.authenticated = authenticated;
  }

  get launched(): boolean {
    return this.context !== null;
  }

  get currentUrl(): string | null {
    return this.page?.url() ?? null;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  get isFeedBlocked(): boolean {
    return this.feedBlocked;
  }

  get isAuthorizationInProgress(): boolean {
    return this.authorizationInProgress;
  }

  async launch(): Promise<boolean> {
    this.feedCaptureAllowed = true;
    await this.ensureFeedPage();
    if (this.page && !this.page.isClosed()) {
      await this.ensureFollowingFeedHealthy("launch");
    }
    if (!this.authenticated && this.feedBlocked && !this.authorizationInProgress) {
      await this.openSystemBrowserForLogin();
    }
    return this.authenticated;
  }

  async getPage(): Promise<Page> {
    await this.ensureFeedPage();
    if (!this.page) {
      throw new Error("Browser page was not created.");
    }
    return this.page;
  }

  async close(): Promise<void> {
    this.feedCaptureAllowed = false;
    const authorizationProcess = this.authorizationProcess;
    this.authorizationProcess = null;
    this.authorizationInProgress = false;
    if (authorizationProcess?.pid) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(authorizationProcess.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
        killer.once("exit", () => resolve());
        killer.once("error", () => resolve());
      });
    }
    await this.context?.close();
    this.context = null;
    this.page = null;
    this.streamPreviewTimers.forEach((timer) => clearInterval(timer));
    this.streamPreviewTimers.clear();
    this.apolloRetryTimers.forEach((timer) => clearInterval(timer));
    this.apolloRetryTimers.clear();
    this.streamSignalWatchdogTimers.forEach((timer) => clearInterval(timer));
    this.streamSignalWatchdogTimers.clear();
    this.giveawayDomTimers.forEach((timer) => clearInterval(timer));
    this.giveawayDomTimers.clear();
    this.streamPages.clear();
    this.giveawayStates.clear();
    this.giveawayNamesByStreamAndId.clear();
    this.streamSignalHealth.clear();
    this.loggedGiveawayStateKeys.clear();
    this.wsHookedStreamIds.clear();
    this.cdpHookedStreamIds.clear();
    this.graphqlHookedStreamIds.clear();
    this.giveawayDebugEvents.clear();
    this.giveawayWsObservedFrames.clear();
  }

  private isTransientBrowserError(message: string): boolean {
    return /(?:disconnect|connection.*(?:reset|termination|terminated|closed)|closed.*(?:page|context|browser)|before headers|net::|ERR_|ECONNRESET|EPIPE|Target page, context or browser has been closed)/i.test(
      message
    );
  }

  private clearStreamPageState(): void {
    this.streamPreviewTimers.forEach((timer) => clearInterval(timer));
    this.streamPreviewTimers.clear();
    this.apolloRetryTimers.forEach((timer) => clearInterval(timer));
    this.apolloRetryTimers.clear();
    this.streamSignalWatchdogTimers.forEach((timer) => clearInterval(timer));
    this.streamSignalWatchdogTimers.clear();
    this.giveawayDomTimers.forEach((timer) => clearInterval(timer));
    this.giveawayDomTimers.clear();
    this.streamPages.clear();
    this.wsHookedStreamIds.clear();
    this.cdpHookedStreamIds.clear();
    this.graphqlHookedStreamIds.clear();
  }

  private async recreateFeedCapture(reason: string, detail: string): Promise<void> {
    this.onBrowserEvent?.(`feed browser self-heal during ${reason}: ${detail}`);
    const context = this.context;
    this.context = null;
    this.page = null;
    this.clearStreamPageState();
    await context?.close().catch(() => undefined);
    this.feedBlocked = false;
    if (this.feedCaptureAllowed) {
      await this.ensureFeedPage();
    }
  }

  private clearStreamRuntime(streamId: string, clearState: boolean): void {
    const previewTimer = this.streamPreviewTimers.get(streamId);
    if (previewTimer) clearInterval(previewTimer);
    this.streamPreviewTimers.delete(streamId);
    const apolloTimer = this.apolloRetryTimers.get(streamId);
    if (apolloTimer) clearInterval(apolloTimer);
    this.apolloRetryTimers.delete(streamId);
    const watchdogTimer = this.streamSignalWatchdogTimers.get(streamId);
    if (watchdogTimer) clearInterval(watchdogTimer);
    this.streamSignalWatchdogTimers.delete(streamId);
    const domTimer = this.giveawayDomTimers.get(streamId);
    if (domTimer) clearInterval(domTimer);
    this.giveawayDomTimers.delete(streamId);
    this.wsHookedStreamIds.delete(streamId);
    this.cdpHookedStreamIds.delete(streamId);
    this.graphqlHookedStreamIds.delete(streamId);
    if (clearState) {
      this.giveawayStates.delete(streamId);
      this.giveawayNamesByStreamAndId.delete(streamId);
      this.streamSignalHealth.delete(streamId);
    }
  }

  async captureFeed(): Promise<{ imageDataUrl: string | null; currentUrl: string | null }> {
    await this.ensureFeedPage();

    if (!this.page || this.page.isClosed()) {
      return { imageDataUrl: null, currentUrl: this.currentUrl };
    }

    const healthy = await this.ensureFollowingFeedHealthy("capture");
    if (!healthy) {
      return { imageDataUrl: null, currentUrl: this.currentUrl };
    }

    try {
      const bytes = await this.page.screenshot({
        type: "jpeg",
        quality: 42,
        timeout: 5_000
      });

      return {
        imageDataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
        currentUrl: this.page.url()
      };
    } catch {
      return { imageDataUrl: null, currentUrl: this.currentUrl };
    }
  }

  async scrollFeedPage(): Promise<void> {
    await this.ensureFeedPage();
    if (!this.page || this.page.isClosed()) return;
    const healthy = await this.ensureFollowingFeedHealthy("scroll");
    if (!healthy) return;

    await this.page
      .evaluate(() => {
        const nearBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 32;
        if (nearBottom) {
          window.scrollTo({ top: 0, behavior: "smooth" });
          return;
        }
        window.scrollBy({ top: Math.max(55, Math.round(window.innerHeight * 0.18)), behavior: "smooth" });
      })
      .catch(() => undefined);
  }

  async resetFeedScroll(): Promise<void> {
    await this.ensureFeedPage();
    if (!this.page || this.page.isClosed()) return;

    await this.ensureFollowingFeedHealthy("reset");

    await this.page
      .evaluate(() => {
        window.scrollTo({ top: 0, behavior: "instant" });
      })
      .catch(() => undefined);
    this.onBrowserEvent?.("feed scan cycle reset to top; waiting 5 seconds");
  }

  async reloadFollowingFeed(): Promise<void> {
    await this.ensureFeedPage();
    if (!this.page || this.page.isClosed()) return;

    await this.page.goto(whatnotFollowingFeedUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
    await this.ensureFollowingFeedHealthy("hard refresh");
    await this.page
      .evaluate(() => {
        window.scrollTo({ top: 0, behavior: "instant" });
      })
      .catch(() => undefined);
    this.onBrowserEvent?.("followed feed hard refreshed; waiting 5 seconds");
  }

  async scrapeFollowingFeedLiveStreams(): Promise<FollowingFeedLiveStream[]> {
    await this.ensureFeedPage();
    if (!this.page || this.page.isClosed()) return [];

    const healthy = await this.ensureFollowingFeedHealthy("scrape");
    if (!healthy) return [];

    const result = await this.page
      .evaluate(() => {
        const livePathPattern = /^\/live\/([^/?#]+)/i;
        const liveUrlPattern = /^https:\/\/www\.whatnot\.com\/live\/([^/?#]+)/i;
        const normalizeStreamId = (streamId: string) => (/^[0-9a-f-]{24,}$/i.test(streamId) ? streamId.toLowerCase() : streamId);
        const normalizeKey = (value: string) => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
        const normalizeUrl = (href: string) => {
          const trimmedHref = href.trim();
          const url = trimmedHref.startsWith("/live/")
            ? new URL(trimmedHref, "https://www.whatnot.com")
            : new URL(trimmedHref);
          const streamId = normalizeStreamId(url.pathname.replace(/^\/live\//i, "").split("/")[0] ?? "");

          return {
            streamId,
            streamUrl: `https://www.whatnot.com/live/${streamId}`
          };
        };
        const streamFromText = (value: string) => {
          const decoded = value.replace(/\\u002F/g, "/").replace(/&quot;/g, "\"");
          const match = decoded.match(/(?:https:\/\/www\.whatnot\.com)?\/live\/([a-z0-9-]+)/i);
          if (!match) return null;
          const streamId = normalizeStreamId(match[1]);
          return {
            streamId,
            streamUrl: `https://www.whatnot.com/live/${streamId}`
          };
        };
        const streamFromFeedDataForUsername = (username: string, apolloCacheText: string) => {
          const normalizedUsername = normalizeKey(username);
          const usernamePattern = username.trim().replace(/^@/, "").toLowerCase();
          const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
          const decodeDataText = (value: string) =>
            value
              .replace(/\\u002F/g, "/")
              .replace(/\\\//g, "/")
              .replace(/&quot;/g, "\"")
              .replace(/&#x27;/g, "'")
              .replace(/&amp;/g, "&");
          const scriptText = Array.from(document.querySelectorAll("script"))
            .map((script) => script.textContent ?? "")
            .filter((text) => /live|stream|viewer|username|FOLLOWING_FEED/i.test(text))
            .join(" ");
          const sources = [
            apolloCacheText,
            scriptText,
            document.documentElement.outerHTML.slice(0, 1_500_000)
          ].map(decodeDataText);
          const findInWindow = (windowText: string) => {
            const liveish =
              /\b(liveStream|livestream|live_stream|isLive|viewer_count|viewerCount)\b/i.test(windowText) ||
              /\b(status|lifecycleStatus|streamStatus)\s*[:=]\s*["']?LIVE\b/i.test(windowText) ||
              /\bendedAt\s*[:=]\s*(null|undefined)\b/i.test(windowText) ||
              /\bLive\b.{0,32}\d+(?:[,.]\d+)?\s*[kKmM]?\b/i.test(windowText);
            if (!liveish) return null;

            const liveUrlMatch = windowText.match(new RegExp(`(?:https://www\\.whatnot\\.com)?/live/(${uuidPattern})`, "i"));
            const fieldMatch = windowText.match(
              new RegExp(`(?:liveStream|livestream|live_stream|stream|streamId|stream_id|liveStreamId|live_stream_id)["']?\\s*[:=]\\s*["']?(${uuidPattern})`, "i")
            );
            const streamId = liveUrlMatch?.[1] ?? fieldMatch?.[1];
            if (!streamId) return null;

            return {
              streamId: normalizeStreamId(streamId),
              streamUrl: `https://www.whatnot.com/live/${normalizeStreamId(streamId)}`
            };
          };

          for (const source of sources) {
            if (!source) continue;
            const lowerSource = source.toLowerCase();
            const normalizedSource = normalizeKey(source);
            if (!lowerSource.includes(usernamePattern) && !normalizedSource.includes(normalizedUsername)) continue;

            let index = lowerSource.indexOf(usernamePattern);
            while (index >= 0) {
              const windowText = source.slice(Math.max(0, index - 12_000), index + 12_000);
              const stream = findInWindow(windowText);
              if (stream) return stream;
              index = lowerSource.indexOf(usernamePattern, index + usernamePattern.length);
            }

            const normalizedIndex = normalizedSource.indexOf(normalizedUsername);
            if (normalizedIndex >= 0) {
              const stream = findInWindow(source);
              if (stream) return stream;
            }
          }

          return null;
        };
        const streamFromElement = (element: Element) => {
          const attributeNames = ["href", "data-href", "data-url", "to", "src"];
          let node: Element | null = element;

          for (let depth = 0; node && depth < 8; depth += 1) {
            const anchor = node.matches("a[href]") ? node : node.querySelector("a[href]");
            const anchorHref = anchor?.getAttribute("href");
            if (anchorHref) {
              const stream = streamFromText(anchorHref);
              if (stream) return stream;
            }

            const descendants = [node, ...Array.from(node.querySelectorAll("*")).slice(0, 80)];
            for (const candidate of descendants) {
              for (const attributeName of attributeNames) {
                const stream = streamFromText(candidate.getAttribute(attributeName) ?? "");
                if (stream) return stream;
              }
            }

            const stream = streamFromText(node.outerHTML.slice(0, 60_000));
            if (stream) return stream;
            node = node.parentElement;
          }

          return null;
        };
        const readApolloText = () => {
          const values: string[] = [];
          const seen = new WeakSet<object>();
          const collect = (value: unknown, depth: number) => {
            if (depth > 6 || value == null) return;
            if (typeof value === "string") {
              if (/live|endedAt|viewer|username|host|stream/i.test(value)) values.push(value);
              return;
            }
            if (typeof value === "number" || typeof value === "boolean") {
              values.push(String(value));
              return;
            }
            if (typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
              if (/live|endedAt|viewer|username|host|stream|status|id/i.test(key)) values.push(`${key}:${String(entry)}`);
              collect(entry, depth + 1);
            });
          };

          Object.entries(window as unknown as Record<string, unknown>).forEach(([key, value]) => {
            if (/apollo|graphql|relay|next|urql|cache|store/i.test(key)) collect(value, 0);
          });

          document.querySelectorAll("script").forEach((script) => {
            const text = script.textContent ?? "";
            if (/liveStream|isLive|endedAt|FOLLOWING_FEED|viewer_count|viewerCount/i.test(text)) {
              values.push(text.slice(0, 300_000));
            }
          });

          return values.join(" ");
        };
        const getAnchorContextText = (anchor: HTMLElement, maxDepth: number) => {
          const textParts = [
            anchor.textContent,
            anchor.getAttribute("aria-label"),
            anchor.getAttribute("title")
          ];
          let node: HTMLElement | null = anchor;

          for (let depth = 0; node && depth < maxDepth; depth += 1) {
            const text = node.textContent?.replace(/\s+/g, " ").trim();
            if (text) textParts.push(text);

            const labelledText = [
              node.getAttribute("aria-label"),
              node.getAttribute("title"),
              node.getAttribute("data-testid")
            ].filter(Boolean);
            textParts.push(...labelledText);

            node = node.parentElement;
          }

          return [...new Set(textParts.filter(Boolean).map((part) => part!.replace(/\s+/g, " ").trim()))]
            .join(" ")
            .slice(0, 4000);
        };
        const parseViewerCount = (text: string) => {
          const match = text.match(/(\d+(?:[,.]\d+)?)\s*([kKmM]?)(?:\s*(viewers?|watching))?/i);
          if (!match) return null;
          const base = Number(match[1].replace(",", "."));
          const suffix = match[2]?.toLowerCase();
          if (Number.isNaN(base)) return null;
          if (suffix === "k") return Math.round(base * 1000);
          if (suffix === "m") return Math.round(base * 1_000_000);
          return base;
        };
        const hasVisibleLiveBadge = (element: Element) => {
          return Array.from(element.querySelectorAll("*"))
            .slice(0, 160)
            .some((candidate) => {
              const text = candidate.textContent?.trim() ?? "";
              if (text.toUpperCase() !== "LIVE") return false;
              const style = window.getComputedStyle(candidate);
              const colorBlob = `${style.backgroundColor} ${style.color} ${style.borderColor}`.toLowerCase();
              return /rgb\(\s*(1[4-9]\d|2[0-5]\d)\s*,\s*([0-9]|[1-8]\d|9\d)\s*,\s*([0-9]|[1-8]\d|9\d)\s*\)/.test(colorBlob) || true;
            });
        };
        const lifecycleFromText = (text: string) => {
          if (/\b(status|lifecycleStatus|streamStatus)\s*[:=]\s*["']?LIVE\b/i.test(text)) return "LIVE";
          if (/\bisLive\s*[:=]\s*true\b/i.test(text)) return "LIVE";
          if (/\bliveStream\s*[:=]\s*\{|\blive now\b|\bcurrently live\b/i.test(text)) return "LIVE";
          if (/\bendedAt\s*[:=]\s*(null|undefined)\b/i.test(text)) return "LIVE";
          if (/\b(status|lifecycleStatus|streamStatus)\s*[:=]\s*["']?(ENDED|OFFLINE|CANCELLED|CANCELED)\b/i.test(text)) return "OFFLINE";
          if (/\bendedAt\s*[:=]\s*["']?\d{4}-\d{2}-\d{2}/i.test(text)) return "OFFLINE";
          if (/\b(stream ended|show ended|not live|offline|upcoming|replay)\b/i.test(text)) return "OFFLINE";
          return null;
        };
        const extractUsername = (text: string) => {
          const usernameMatch = text.match(/(?:username|sellerUsername|hostUsername)\s*[:=]\s*["']?([a-z0-9_.-]+)/i);
          if (usernameMatch) return usernameMatch[1];
          const atMatch = text.match(/@([a-z0-9_.-]{2,})/i);
          return atMatch?.[1] ?? null;
        };
        const extractHostId = (text: string) => {
          const hostMatch = text.match(/(?:hostId|host_id|sellerId|userId)\s*[:=]\s*["']?([a-z0-9-]+)/i);
          return hostMatch?.[1] ?? null;
        };
        const thumbnailFromElement = (element: Element) => {
          const containerText = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
          if (!/\blive\b/i.test(containerText) || !/\d+(?:[,.]\d+)?\s*[kKmM]?\b/i.test(containerText)) return null;
          const images = Array.from(element.querySelectorAll<HTMLImageElement>("img[src], img[srcset]"))
            .map((image) => {
              const rect = image.getBoundingClientRect();
              const src = image.currentSrc || image.src;
              return {
                src,
                area: rect.width * rect.height,
                isAvatarLike: rect.width > 0 && rect.height > 0 && Math.abs(rect.width - rect.height) <= 8 && rect.width <= 80,
                isUseful: rect.width >= 80 && rect.height >= 50 && !/avatar|profile|user|account/i.test(src)
              };
            })
            .filter((image) => image.src && image.isUseful && !image.isAvatarLike)
            .sort((left, right) => right.area - left.area);
          return images[0]?.src ?? null;
        };
        const thumbnailForStream = (streamId: string, sourceElement?: Element | null) => {
          const normalizedStreamId = streamId.toLowerCase();
          const exactLinkSelector = `a[href*="/live/${normalizedStreamId}" i], [href*="/live/${normalizedStreamId}" i], [data-href*="/live/${normalizedStreamId}" i], [data-url*="/live/${normalizedStreamId}" i], [to*="/live/${normalizedStreamId}" i]`;
          const exactLink =
            sourceElement?.closest?.(exactLinkSelector) ??
            sourceElement?.querySelector?.(exactLinkSelector) ??
            document.querySelector(exactLinkSelector);
          let node: Element | null = exactLink ?? sourceElement ?? null;

          for (let depth = 0; node && depth < 8; depth += 1) {
            const html = node.outerHTML.toLowerCase();
            if (html.includes(`/live/${normalizedStreamId}`)) {
              const thumbnail = thumbnailFromElement(node);
              if (thumbnail) return thumbnail;
            }
            node = node.parentElement;
          }

          return null;
        };
        const apolloText = (() => {
          try {
            return readApolloText();
          } catch {
            return "";
          }
        })();
        const streams = new Map<string, FollowingFeedLiveStream>();
        let rawLiveLinks = 0;
        let onlineCount = 0;
        let offlineCount = 0;
        let unknownCount = 0;

        const upsertStream = (stream: { streamId: string; streamUrl: string }, matchText: string, lifecycleText: string, forcedLiveStatus?: string) => {
          const lifecycleStatus = forcedLiveStatus ?? lifecycleFromText(lifecycleText);
          const viewerCount = parseViewerCount(lifecycleText);
          const lifecycleState = lifecycleStatus === "LIVE" ? "online" : lifecycleStatus === "OFFLINE" ? "offline" : "unknown";
          const isLive = lifecycleState === "online";
          if (lifecycleState === "online") onlineCount += 1;
          if (lifecycleState === "offline") offlineCount += 1;
          if (lifecycleState === "unknown") unknownCount += 1;

          streams.set(stream.streamId, {
            ...stream,
            matchText,
            isLive,
            lifecycleState,
            lifecycleStatus: lifecycleStatus ?? "UNKNOWN",
            viewerCount,
            hostId: extractHostId(lifecycleText),
            username: extractUsername(lifecycleText),
            normalizedUsername: null,
            thumbnailImageDataUrl: null
          });
        };

        document.querySelectorAll<HTMLElement>("a[href], [href], [data-href], [data-url], [to]").forEach((anchor) => {
          const href = anchor.getAttribute("href") ?? anchor.getAttribute("data-href") ?? anchor.getAttribute("data-url") ?? anchor.getAttribute("to") ?? "";
          if (!livePathPattern.test(href) && !liveUrlPattern.test(href) && !streamFromText(href)) return;
          rawLiveLinks += 1;

          try {
            const stream = streamFromText(href) ?? normalizeUrl(href);
            if (!stream.streamId) return;
            const matchText = getAnchorContextText(anchor, 8);
            const lifecycleMatchText = getAnchorContextText(anchor, 3);
            const normalizedStreamId = normalizeKey(stream.streamId);
            const apolloIndex = normalizeKey(apolloText).indexOf(normalizedStreamId);
            const apolloWindow = apolloIndex >= 0 ? apolloText.slice(Math.max(0, apolloIndex - 4000), apolloIndex + 4000) : "";
            const lifecycleText = `${lifecycleMatchText} ${apolloWindow}`;
            upsertStream(stream, matchText, lifecycleText);
            const savedStream = streams.get(stream.streamId);
            if (savedStream) {
              savedStream.thumbnailImageDataUrl = thumbnailForStream(stream.streamId, anchor);
            }
          } catch {
            // Ignore malformed or non-Whatnot URLs.
          }
        });

        Array.from(document.querySelectorAll<HTMLElement>("article, li, [role='article'], [data-testid], div"))
          .slice(0, 500)
          .forEach((container) => {
            const text = container.textContent?.replace(/\s+/g, " ").trim() ?? "";
            const viewerCount = parseViewerCount(text);
            if (!viewerCount || viewerCount <= 10) return;
            if (!hasVisibleLiveBadge(container)) return;

            const stream = streamFromElement(container);
            if (!stream || streams.has(stream.streamId)) return;
            rawLiveLinks += 1;
            upsertStream(stream, text.slice(0, 4000), text, "LIVE");
            const savedStream = streams.get(stream.streamId);
            if (savedStream) {
              savedStream.thumbnailImageDataUrl = thumbnailForStream(stream.streamId, container);
            }
          });

        const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
        const feedBadgePattern = /@?([a-z0-9_.-]{2,})\s+Live\b.{0,24}?(\d+(?:[,.]\d+)?\s*[kKmM]?)/gi;
        let feedBadgeMatch: RegExpExecArray | null;
        while ((feedBadgeMatch = feedBadgePattern.exec(bodyText)) !== null) {
          const username = feedBadgeMatch[1];
          const viewerCount = parseViewerCount(feedBadgeMatch[2]);
          if (!viewerCount || viewerCount <= 10) continue;
          const normalizedUsername = normalizeKey(username);
          const existingLiveHrefStream = [...streams.values()].find(
            (stream) => stream.streamUrl && normalizeKey(stream.matchText).includes(normalizedUsername)
          );
          const apolloStream = existingLiveHrefStream ?? streamFromFeedDataForUsername(username, apolloText);
          const streamId = apolloStream?.streamId ?? `feed-badge:${normalizedUsername}`;
          if (existingLiveHrefStream) {
            streams.delete(existingLiveHrefStream.streamId);
          }
          if (streams.has(streamId)) continue;
          const exactThumbnail = apolloStream?.streamId ? thumbnailForStream(apolloStream.streamId) : null;
          rawLiveLinks += 1;
          onlineCount += 1;
          streams.set(streamId, {
            streamId,
            streamUrl: apolloStream?.streamUrl ?? "",
            matchText: feedBadgeMatch[0],
            isLive: true,
            lifecycleState: "online",
            lifecycleStatus: apolloStream ? "LIVE_BADGE_VIEWERS_UUID_RESOLVED" : "LIVE_BADGE_VIEWERS",
            viewerCount,
            hostId: null,
            username,
            normalizedUsername: normalizedUsername,
            thumbnailImageDataUrl: exactThumbnail ?? (() => {
              const liveCard = Array.from(document.querySelectorAll<HTMLElement>("article, li, [role='article'], [data-testid], div"))
                .map((element) => ({ element, text: element.textContent?.replace(/\s+/g, " ").trim() ?? "" }))
                .filter((candidate) => normalizeKey(candidate.text).includes(normalizeKey(username)) && /\blive\b/i.test(candidate.text))
                .sort((left, right) => left.text.length - right.text.length)[0]?.element;
              return liveCard ? thumbnailFromElement(liveCard) : null;
            })()
          });
        }

        return {
          rawLiveLinks,
          onlineCount,
          offlineCount,
          unknownCount,
          streams: [...streams.values()]
        };
      })
      .catch((error) => ({
        rawLiveLinks: 0,
        onlineCount: 0,
        offlineCount: 0,
        unknownCount: 0,
        streams: [],
        error: error instanceof Error ? error.message : String(error)
      }));
    if ("error" in result) {
      this.onBrowserEvent?.(`feed scrape failed: ${result.error}`);
    }
    for (const stream of result.streams) {
      if (stream.streamUrl || !stream.streamId.startsWith("feed-badge:") || !stream.username) continue;
      const resolvedStream = await this.resolveFeedBadgeStreamUrl(stream.username);
      if (!resolvedStream) {
        this.onBrowserEvent?.(`feed badge for ${stream.username} is live but no /live UUID URL was resolved yet`);
        continue;
      }

      stream.streamId = resolvedStream.streamId;
      stream.streamUrl = resolvedStream.streamUrl;
      stream.lifecycleStatus = "LIVE_BADGE_VIEWERS_CLICK_RESOLVED";
      this.onBrowserEvent?.(`feed badge resolved ${stream.username} -> ${stream.streamUrl}`);
    }

    this.onBrowserEvent?.(
      `scraped ${result.streams.length} stream link candidate(s) from FOLLOWING_FEED; raw=${result.rawLiveLinks}; online=${result.onlineCount}; offline=${result.offlineCount}; unknown=${result.unknownCount}`
    );
    if (result.rawLiveLinks === 0) {
      await this.logFeedDomDiagnostics();
    }
    return result.streams;
  }

  private async resolveFeedBadgeStreamUrl(username: string): Promise<{ streamId: string; streamUrl: string } | null> {
    if (!this.context) return null;

    const page = await this.context.newPage().catch(() => null);
    if (!page) return null;

    try {
      await page.setViewportSize({ width: 420, height: 760 }).catch(() => undefined);
      await page.goto(whatnotFollowingFeedUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(3_000).catch(() => undefined);

      const clickTarget = await page
        .evaluate((targetUsername) => {
          const normalize = (value: string) => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
          const target = normalize(targetUsername);
          const parseViewerCount = (text: string) => {
            const match = text.match(/(\d+(?:[,.]\d+)?)\s*([kKmM]?)/i);
            if (!match) return null;
            const base = Number(match[1].replace(",", "."));
            const suffix = match[2]?.toLowerCase();
            if (Number.isNaN(base)) return null;
            if (suffix === "k") return Math.round(base * 1000);
            if (suffix === "m") return Math.round(base * 1_000_000);
            return base;
          };
          const candidates = Array.from(document.querySelectorAll<HTMLElement>("article, li, [role='article'], [data-testid], a, button, div"))
            .map((element) => {
              const text = element.innerText?.replace(/\s+/g, " ").trim() ?? "";
              const normalizedText = normalize(text);
              const targetIndex = normalizedText.indexOf(target);
              const liveIndex = text.toLowerCase().indexOf("live");
              const viewerCount = parseViewerCount(text.slice(Math.max(0, liveIndex)));
              const rect = element.getBoundingClientRect();

              return {
                element,
                text,
                score:
                  (targetIndex >= 0 ? 100 : 0) +
                  (/\blive\b/i.test(text) ? 50 : 0) +
                  (viewerCount && viewerCount > 10 ? 50 : 0) -
                  Math.round(text.length / 250),
                area: rect.width * rect.height
              };
            })
            .filter((candidate) => candidate.score >= 190 && candidate.area > 0)
            .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

          const bestCandidate = candidates[0];
          const best = bestCandidate?.element;
          if (!bestCandidate || !best) return null;
          let clickable: HTMLElement | null = (best.closest("a, button") as HTMLElement | null) ?? best.querySelector<HTMLElement>("a, button") ?? best;
          let node: HTMLElement | null = best;
          for (let depth = 0; node && depth < 8; depth += 1) {
            const style = window.getComputedStyle(node);
            const role = node.getAttribute("role") ?? "";
            const tabIndex = node.getAttribute("tabindex");
            const hasClickSignal = role === "link" || role === "button" || tabIndex != null || style.cursor === "pointer";
            if (hasClickSignal) {
              clickable = node;
              break;
            }
            node = node.parentElement;
          }
          clickable.scrollIntoView({ block: "center", inline: "center" });
          const rect = clickable.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + Math.min(rect.height / 2, 180),
            text: bestCandidate.text.slice(0, 180)
          };
        }, username)
        .catch(() => null);

      if (!clickTarget) {
        this.onBrowserEvent?.(`feed badge resolver found no clickable live card for ${username}`);
        return null;
      }

      this.onBrowserEvent?.(`feed badge resolver clicking ${username} card: ${clickTarget.text}`);
      await page.mouse.click(clickTarget.x, clickTarget.y).catch(() => undefined);
      await page.waitForURL(/\/live\/[^/?#]+/i, { timeout: 12_000 }).catch(() => undefined);
      const url = page.url().split("?")[0].split("#")[0];
      const match = url.match(/\/live\/([^/?#]+)/i);
      if (!match) return null;

      const streamId = /^[0-9a-f-]{24,}$/i.test(match[1]) ? match[1].toLowerCase() : match[1];
      return {
        streamId,
        streamUrl: `https://www.whatnot.com/live/${streamId}`
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async logFeedDomDiagnostics(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;

    const diagnostics = await this.page
      .evaluate(() => {
        const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
        const liveTextCount = Array.from(document.querySelectorAll("*")).filter((element) => element.textContent?.trim().toUpperCase() === "LIVE").length;
        const viewerTextCount = (bodyText.match(/\d[\d,.]*\s*(viewers?|watching)/gi) ?? []).length;
        const linkSamples = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .slice(0, 20)
          .map((anchor) => anchor.getAttribute("href"));

        return {
          url: window.location.href,
          title: document.title,
          bodyLength: bodyText.length,
          bodySample: bodyText.slice(0, 700),
          liveTextCount,
          viewerTextCount,
          anchorCount: document.querySelectorAll("a[href]").length,
          linkSamples
        };
      })
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

    this.onBrowserEvent?.(`feed DOM diagnostics ${JSON.stringify(diagnostics)}`);
  }

  private async ensureFollowingFeedHealthy(reason: string, selfHealAttempted = false): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    const page = this.page;

    const inspect = async () =>
      page
        .evaluate(() => {
          const bodyText = document.body.innerText.replace(/\s+/g, " ").trim();
          const title = document.title;
          const url = window.location.href;
          const is404 =
            /\b404\b/i.test(title) ||
            /\b404\b/.test(bodyText.slice(0, 500)) ||
            /\b(page not found|not found|this page does not exist|something went wrong)\b/i.test(bodyText.slice(0, 900));
          const hasFollowedFeedText = /\b(Followed Hosts|For You|Following|Switch to Selling)\b/i.test(bodyText);
          const hasLoginPrompt = /\b(Log in|Sign up|Continue with Google|Continue with Apple|Continue with email)\b/i.test(bodyText);
          const isSecurityCheck =
            /\b(Performing security verification|security service|verifies you are not a bot|Cloudflare|Just a moment)\b/i.test(
              `${title} ${bodyText.slice(0, 900)}`
            );
          const hasBadRoute = /\/404(?:[/?#]|$)|not-found/i.test(new URL(url).pathname);

          return {
            url,
            title,
            bodyLength: bodyText.length,
            bodySample: bodyText.slice(0, 180),
            is404,
            isSecurityCheck,
            hasBadRoute,
            hasFollowedFeedText,
            hasLoginPrompt,
            transientError: false
          };
        })
        .catch((error) => ({
          url: page.url(),
          title: "",
          bodyLength: 0,
          bodySample: error instanceof Error ? error.message : String(error),
          is404: true,
          isSecurityCheck: false,
          hasBadRoute: true,
          hasFollowedFeedText: false,
          hasLoginPrompt: false,
          transientError: this.isTransientBrowserError(error instanceof Error ? error.message : String(error))
        }));

    let status = await inspect();
    if (status.transientError) {
      if (selfHealAttempted) return false;
      await this.recreateFeedCapture(reason, status.bodySample);
      return this.ensureFollowingFeedHealthy(`${reason} self-heal`, true);
    }
    if (status.isSecurityCheck) {
      this.feedBlocked = true;
      this.onBrowserEvent?.(`followed feed blocked by security check during ${reason}; body="${status.bodySample}"`);
      return false;
    }
    if (status.hasLoginPrompt && !status.hasFollowedFeedText) {
      this.feedBlocked = true;
      this.authenticated = false;
      this.onBrowserEvent?.("Chrome is not signed in to Whatnot; sign in with Chrome first, then click the browser card gear");
      return false;
    }

    const onFeedUrl = status.url.includes("feedId=FOLLOWING_FEED");
    const shouldRecover = !onFeedUrl || status.is404 || status.hasBadRoute;
    if (!shouldRecover) {
      this.feedBlocked = false;
      this.authenticated = status.hasFollowedFeedText || this.authenticated;
      return true;
    }

    this.onBrowserEvent?.(
      `followed feed unhealthy during ${reason}; recovering url=${status.url}; title=${status.title}; body="${status.bodySample}"`
    );
    const recoveryError = await this.page.goto(whatnotFollowingFeedUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch((error) => error);
    if (recoveryError) {
      const message = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      if (this.isTransientBrowserError(message)) {
        if (selfHealAttempted) return false;
        await this.recreateFeedCapture(`${reason} recovery`, message);
        return this.ensureFollowingFeedHealthy(`${reason} recovery self-heal`, true);
      }
    }
    await this.page.waitForTimeout(1_500).catch(() => undefined);

    status = await inspect();
    if (status.transientError) {
      if (selfHealAttempted) return false;
      await this.recreateFeedCapture(`${reason} post-recovery`, status.bodySample);
      return this.ensureFollowingFeedHealthy(`${reason} post-recovery self-heal`, true);
    }
    if (status.isSecurityCheck) {
      this.feedBlocked = true;
      this.onBrowserEvent?.(`followed feed recovery blocked by security check during ${reason}; body="${status.bodySample}"`);
      return false;
    }
    if (status.hasLoginPrompt && !status.hasFollowedFeedText) {
      this.feedBlocked = true;
      this.authenticated = false;
      this.onBrowserEvent?.("Chrome is not signed in to Whatnot after feed recovery; sign in with Chrome first, then click the browser card gear");
      return false;
    }

    if (status.is404 || status.hasBadRoute || !status.url.includes("feedId=FOLLOWING_FEED")) {
      this.onBrowserEvent?.(
        `followed feed recovery still unhealthy during ${reason}; url=${status.url}; title=${status.title}; body="${status.bodySample}"`
      );
      return false;
    }

    this.feedBlocked = false;
    this.authenticated = status.hasFollowedFeedText || this.authenticated;
    this.onBrowserEvent?.(`followed feed recovered during ${reason}; url=${status.url}`);
    return true;
  }

  async openStreamPages(streams: FollowingFeedLiveStream[]): Promise<void> {
    await this.ensureFeedPage();
    if (!this.context) return;
    const context = this.context;

    await Promise.all(streams.map(async (stream) => {
      try {
        const existingPage = this.streamPages.get(stream.streamId);
        if (existingPage && !existingPage.isClosed()) {
          const verified = await this.verifyStreamPage(existingPage, stream);
          if (!verified) {
            this.onBrowserEvent?.(`stream tab unhealthy ${stream.streamer ?? stream.streamId}; reopening ${stream.streamUrl}`);
            this.clearStreamRuntime(stream.streamId, false);
            await existingPage.close().catch(() => undefined);
            this.streamPages.delete(stream.streamId);
          } else {
            await this.attachGiveawayWebSocketListener(existingPage, stream);
            await this.attachGiveawayGraphQLListener(existingPage, stream);
            await this.refreshApolloGiveawayState(stream.streamId, existingPage).catch(() => undefined);
            this.startApolloGiveawayRetry(stream.streamId, existingPage);
            this.startStreamSignalWatchdog(stream);
            return;
          }
        }

        for (let attempt = 1; attempt <= 2; attempt += 1) {
          const page = await context.newPage().catch(() => null);
          if (!page) return;
          this.streamPages.set(stream.streamId, page);
          await page.setViewportSize({ width: 260, height: 420 }).catch(() => undefined);
          await this.attachGiveawayWebSocketListener(page, stream);
          await this.attachGiveawayGraphQLListener(page, stream);
          const gotoError = await page
            .goto(stream.streamUrl, { waitUntil: "domcontentloaded", timeout: 15_000 })
            .then(() => null)
            .catch((error) => error);
          if (gotoError) {
            const message = gotoError instanceof Error ? gotoError.message : String(gotoError);
            await page.close().catch(() => undefined);
            this.streamPages.delete(stream.streamId);
            this.clearStreamRuntime(stream.streamId, false);
            if (attempt < 2 && this.isTransientBrowserError(message)) {
              this.onBrowserEvent?.(`stream tab transient failure ${stream.streamer ?? stream.streamId}; retrying: ${message}`);
              continue;
            }
            this.onBrowserEvent?.(`stream tab failed ${stream.streamer ?? stream.streamId}: ${message}`);
            return;
          }
          await this.muteStreamPage(page).catch(() => undefined);
          await this.dismissStreamOverlays(page).catch(() => undefined);
          await this.refreshApolloGiveawayState(stream.streamId, page).catch(() => undefined);
          this.startApolloGiveawayRetry(stream.streamId, page);
          this.startStreamSignalWatchdog(stream);
          void this.verifyStreamPage(page, stream);
          this.onBrowserEvent?.(`stream tab ready ${stream.streamer ?? stream.streamId}: ${stream.streamUrl}`);
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.onBrowserEvent?.(`stream tab failed ${stream.streamer ?? stream.streamId}: ${message}`);
      }
    }));
  }

  getGiveawayStates(): Map<string, GiveawayState> {
    return new Map(this.giveawayStates);
  }

  private async attachGiveawayWebSocketListener(page: Page, stream: FollowingFeedLiveStream): Promise<void> {
    this.touchStreamSignal(stream, "attached");
    await this.attachGiveawayCdpWebSocketListener(page, stream);
    if (this.wsHookedStreamIds.has(stream.streamId)) return;
    this.wsHookedStreamIds.add(stream.streamId);

    page.on("websocket", (socket) => {
      if (!socket.url().includes("live/socket")) return;

      socket.on("framereceived", (frame) => {
        const payloadText = typeof frame.payload === "string" ? frame.payload : frame.payload.toString();
        void this.handleGiveawayPhoenixFrame(page, stream, payloadText, "page-websocket");
      });
    });
  }

  private async attachGiveawayCdpWebSocketListener(page: Page, stream: FollowingFeedLiveStream): Promise<void> {
    if (this.cdpHookedStreamIds.has(stream.streamId)) return;
    this.cdpHookedStreamIds.add(stream.streamId);
    const cdpContext = page.context() as unknown as {
      newCDPSession?: (target: Page) => Promise<{
        send: (method: string) => Promise<void>;
        on: (event: string, callback: (payload: unknown) => void) => void;
      }>;
    };
    const session = await cdpContext.newCDPSession?.(page).catch(() => null);
    if (!session) return;
    await session.send("Network.enable").catch(() => undefined);
    session.on("Network.webSocketFrameReceived", (eventPayload) => {
      const payloadText = (eventPayload as { response?: { payloadData?: unknown } })?.response?.payloadData;
      if (typeof payloadText !== "string") return;
      void this.handleGiveawayPhoenixFrame(page, stream, payloadText, "cdp-websocket");
    });
    this.onBrowserEvent?.(`stream signal CDP websocket hook attached ${stream.streamer ?? stream.streamId}`);
  }

  private async handleGiveawayPhoenixFrame(
    page: Page,
    stream: FollowingFeedLiveStream,
    payloadText: string,
    channel: string
  ): Promise<void> {
    this.touchStreamSignal(stream, "ws");
    this.logGiveawayWsFrameSummary(stream.streamId, stream.streamer, payloadText);
    const event = this.readPhoenixFrameEvent(payloadText);
    if (/^giveaway_won$/i.test(event) || /giveaway_won/i.test(payloadText)) {
      this.emitGiveawayWinner(stream, payloadText, /^phx_reply$/i.test(event));
    }
    const giveawayState = this.extractGiveawayStateFromPhoenixFrame(stream.streamId, payloadText, "WS_PRIMARY");
    if (!giveawayState) return;
    this.touchStreamSignal(stream, "giveaway");
    const existing = this.giveawayStates.get(stream.streamId);
    if (/^phx_reply$/i.test(event) && giveawayState.giveawayName && existing?.giveawayName) {
      this.onBrowserEvent?.(`ignored giveaway WS ${stream.streamId}: event=${event}; reason=historical reply cannot replace active giveaway`);
      return;
    }

    if (giveawayState.giveawayId && giveawayState.giveawayName) {
      this.rememberGiveawayName(stream.streamId, giveawayState.giveawayId, giveawayState.giveawayName);
    }

    const rememberedName = giveawayState.giveawayId
      ? this.giveawayNamesByStreamAndId.get(stream.streamId)?.get(giveawayState.giveawayId) ?? null
      : null;
    if (!giveawayState.giveawayName && rememberedName) {
      this.setGiveawayState(stream.streamId, {
        ...giveawayState,
        giveawayName: rememberedName,
        confidence: Math.max(giveawayState.confidence, 90)
      });
      this.logGiveawayStateChange(stream.streamId, stream.streamer, { ...giveawayState, giveawayName: rememberedName });
      return;
    }

    if (
      !giveawayState.giveawayName &&
      existing?.giveawayName &&
      (!giveawayState.giveawayId || !existing.giveawayId || giveawayState.giveawayId === existing.giveawayId)
    ) {
      const preservedState = {
        ...giveawayState,
        giveawayName: existing.giveawayName,
        source: existing.source,
        confidence: existing.confidence
      };
      this.setGiveawayState(stream.streamId, preservedState);
      return;
    }

    this.setGiveawayState(stream.streamId, giveawayState);
    this.logGiveawayStateChange(stream.streamId, stream.streamer, giveawayState);
    if (giveawayState.active && (!giveawayState.giveawayName || giveawayState.giveawayId)) {
      this.onBrowserEvent?.(`giveaway ${channel} ${stream.streamer ?? stream.streamId}: forcing Apollo refresh for ${giveawayState.giveawayId ?? "current giveaway"}`);
      await this.refreshApolloGiveawayState(stream.streamId, page, giveawayState.giveawayId);
    }
  }

  private readPhoenixFrameEvent(payloadText: string): string {
    try {
      const frame = JSON.parse(payloadText);
      return Array.isArray(frame) ? String(frame[3] ?? "") : "";
    } catch {
      return "";
    }
  }

  private emitGiveawayWinner(stream: FollowingFeedLiveStream, payloadText: string, snapshot: boolean): void {
    try {
      const frame = JSON.parse(payloadText);
      const payload = Array.isArray(frame) ? frame[4] : null;
      if (!payload || typeof payload !== "object") return;
      const emit = (giveawayId: unknown, winnerName: unknown, prize: unknown, timestamp?: unknown) => {
        const id = String(giveawayId ?? "").trim();
        const winnerUsername = String(winnerName ?? "").trim();
        const prizeName = String(prize ?? "").replace(/\s+/g, " ").trim();
        if (!id || !winnerUsername || !prizeName) return;
        const key = `${stream.streamId}:${id}`.toLowerCase();
        if (this.emittedGiveawayWinners.has(key)) return;
        this.emittedGiveawayWinners.add(key);
        if (this.emittedGiveawayWinners.size > 2_000) this.emittedGiveawayWinners.clear();
        const parsedTime = typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))
          ? new Date(timestamp).toISOString()
          : new Date().toISOString();
        const winner: GiveawayWinnerState = {
          giveawayId: id,
          winnerUsername,
          prizeName,
          wonAt: parsedTime,
          source: snapshot ? "snapshot" : "live"
        };
        this.onGiveawayWinner?.(stream.streamId, winner);
        this.onBrowserEvent?.(`giveaway winner ${stream.streamer ?? stream.streamId}: ${winnerUsername} won ${prizeName}`);
      };

      const record = payload as Record<string, unknown>;
      const giveaway = record.giveaway && typeof record.giveaway === "object" ? record.giveaway as Record<string, unknown> : {};
      const product = record.product && typeof record.product === "object" ? record.product as Record<string, unknown> : {};
      const purchaser = product.purchaserUser && typeof product.purchaserUser === "object" ? product.purchaserUser as Record<string, unknown> : {};
      emit(giveaway.productId ?? giveaway.id ?? product.id, purchaser.username, product.name, record.timestamp ?? record.createdAt);

      const seen = new WeakSet<object>();
      const visit = (value: unknown, depth: number) => {
        if (!value || typeof value !== "object" || depth > 9 || seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          for (let index = value.length - 1; index >= 0; index -= 1) visit(value[index], depth + 1);
          return;
        }
        const activity = value as Record<string, unknown>;
        const eventName = String(activity.eventName ?? activity.event_name ?? activity.event ?? "");
        if (/^giveaway_won$/i.test(eventName)) {
          const user = activity.activityPerformingUser && typeof activity.activityPerformingUser === "object"
            ? activity.activityPerformingUser as Record<string, unknown>
            : {};
          const eventInfo = activity.eventSpecificInfo && typeof activity.eventSpecificInfo === "object"
            ? activity.eventSpecificInfo as Record<string, unknown>
            : {};
          const activityProduct = eventInfo.livestreamProduct && typeof eventInfo.livestreamProduct === "object"
            ? eventInfo.livestreamProduct as Record<string, unknown>
            : {};
          emit(
            activityProduct.id ?? activityProduct.productId ?? activity.id,
            user.username,
            activityProduct.name ?? activityProduct.title,
            activity.createdAt ?? activity.timestamp ?? activity.occurredAt
          );
        }
        for (const nested of Object.values(activity)) visit(nested, depth + 1);
      };
      visit(payload, 0);
    } catch {
      // Ignore malformed or non-JSON frames.
    }
  }

  private async attachGiveawayGraphQLListener(page: Page, stream: FollowingFeedLiveStream): Promise<void> {
    if (this.graphqlHookedStreamIds.has(stream.streamId)) return;
    this.graphqlHookedStreamIds.add(stream.streamId);

    page.on("response", (response) => {
      const url = response.url();
      if (!/graphql|api/i.test(url)) return;

      void (async () => {
        const contentType = response.headers()["content-type"] ?? "";
        if (contentType && !/json/i.test(contentType)) return;
        const payload = await response.json().catch(() => null);
        if (!payload) return;
        this.touchStreamSignal(stream, "graphql");
        const giveawayState = this.extractGiveawayStateFromGraphQLPayload(payload);
        if (!giveawayState) return;
        const existing = this.giveawayStates.get(stream.streamId);
        if (existing?.source === "WS_PRIMARY" && existing.giveawayName && !giveawayState.giveawayName) return;
        this.setGiveawayState(stream.streamId, giveawayState);
        if (giveawayState.giveawayId && giveawayState.giveawayName) {
          this.rememberGiveawayName(stream.streamId, giveawayState.giveawayId, giveawayState.giveawayName);
        }
        if (giveawayState.giveawayName) {
          this.onBrowserEvent?.(`giveaway GraphQL ${stream.streamer ?? stream.streamId}: ${giveawayState.giveawayName}`);
        }
      })().catch(() => undefined);
    });
  }

  private setGiveawayState(streamId: string, state: GiveawayState): void {
    const sanitizedState = {
      ...state,
      giveawayName: this.cleanGiveawayName(state.giveawayName)
    };
    this.giveawayStates.set(streamId, sanitizedState);
    this.touchStreamSignalById(streamId, sanitizedState.giveawayName ? "stateName" : "state");
    if (sanitizedState.giveawayId && sanitizedState.giveawayName) {
      this.rememberGiveawayName(streamId, sanitizedState.giveawayId, sanitizedState.giveawayName);
    }
    if (sanitizedState.giveawayName || sanitizedState.giveawayId || !sanitizedState.active) {
      this.onGiveawayState?.(streamId, sanitizedState);
    }
  }

  private rememberGiveawayName(streamId: string, giveawayId: string, giveawayName: string): void {
    const cleanName = this.cleanGiveawayName(giveawayName);
    if (!cleanName) return;
    let namesById = this.giveawayNamesByStreamAndId.get(streamId);
    if (!namesById) {
      namesById = new Map<string, string>();
      this.giveawayNamesByStreamAndId.set(streamId, namesById);
    }
    namesById.set(giveawayId, cleanName);
    if (namesById.size > 40) {
      const firstKey = namesById.keys().next().value as string | undefined;
      if (firstKey) namesById.delete(firstKey);
    }
  }

  private touchStreamSignal(stream: FollowingFeedLiveStream, signal: "attached" | "ws" | "giveaway" | "graphql" | "apollo" | "state" | "stateName"): void {
    const now = Date.now();
    const existing = this.streamSignalHealth.get(stream.streamId);
    const next: StreamSignalHealth = existing ?? {
      streamer: stream.streamer ?? stream.username ?? null,
      streamUrl: stream.streamUrl,
      lastAttachedAt: now,
      lastWsFrameAt: null,
      lastGiveawayFrameAt: null,
      lastGraphqlAt: null,
      lastApolloAt: null,
      lastStateAt: null,
      lastStateNameAt: null,
      lastSelfHealAt: null
    };
    next.streamer = stream.streamer ?? next.streamer;
    next.streamUrl = stream.streamUrl;
    if (signal === "attached") next.lastAttachedAt = now;
    if (signal === "ws") next.lastWsFrameAt = now;
    if (signal === "giveaway") next.lastGiveawayFrameAt = now;
    if (signal === "graphql") next.lastGraphqlAt = now;
    if (signal === "apollo") next.lastApolloAt = now;
    if (signal === "state" || signal === "stateName") next.lastStateAt = now;
    if (signal === "stateName") next.lastStateNameAt = now;
    this.streamSignalHealth.set(stream.streamId, next);
  }

  private touchStreamSignalById(streamId: string, signal: "apollo" | "state" | "stateName"): void {
    const existing = this.streamSignalHealth.get(streamId);
    if (!existing) return;
    const now = Date.now();
    if (signal === "apollo") existing.lastApolloAt = now;
    if (signal === "state" || signal === "stateName") existing.lastStateAt = now;
    if (signal === "stateName") existing.lastStateNameAt = now;
  }

  private cleanGiveawayName(name: string | null | undefined): string | null {
    const normalized = (name ?? "").replace(/\s+/g, " ").trim();
    if (!normalized) return null;
    if (/^(new|used|sealed|ship only|rip only|rip or ship)$/i.test(normalized)) return null;
    if (/^\d+\s*-\s*#\d+\b/i.test(normalized)) return null;
    return normalized;
  }

  private logGiveawayStateChange(streamId: string, streamer: string | undefined, state: GiveawayState): void {
    const stateKey = `${state.active}:${state.giveawayId ?? ""}:${state.giveawayName ?? ""}:${state.source}`;
    if (this.loggedGiveawayStateKeys.get(streamId) === stateKey) return;
    this.loggedGiveawayStateKeys.set(streamId, stateKey);
    this.onBrowserEvent?.(`giveaway WS ${streamer ?? streamId}: ${state.giveawayName ?? state.giveawayId ?? "active"}`);
  }

  private logGiveawayWsFrameSummary(streamId: string, streamer: string | undefined, payloadText: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(payloadText);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || frame.length < 5) return;

    const topic = String(frame[2] ?? "");
    const event = String(frame[3] ?? "");
    const payload = frame[4];
    const payloadTextLower = JSON.stringify(payload).toLowerCase();
    if (!/giveaway/.test(`${topic} ${event} ${payloadTextLower}`)) return;

    const ids: string[] = [];
    const titles: string[] = [];
    const keys = payload && typeof payload === "object" ? Object.keys(payload as Record<string, unknown>).slice(0, 18).join(",") : typeof payload;
    const seen = new WeakSet<object>();

    const visit = (value: unknown, path: string[], depth: number): void => {
      if (depth > 6 || value == null) return;
      const key = path[path.length - 1] ?? "";
      if (typeof value === "string" || typeof value === "number") {
        const text = String(value).replace(/\s+/g, " ").trim();
        if (/^(id|uuid|giveaway_id|giveawayId|productId|product_id|itemId|item_id)$/i.test(key) && text.length >= 6) {
          ids.push(`${path.join(".")}=${text}`);
        }
        if (/(title|name|description)$/i.test(key) && text.length >= 3 && text.length <= 160) {
          if (!/^(giveaway|giveaways|live giveaway|entry|entries|winner|winners|join|joined)$/i.test(text)) {
            titles.push(`${path.join(".")}=${text}`);
          }
        }
        return;
      }
      if (typeof value !== "object" || seen.has(value)) return;
      seen.add(value);
      Object.entries(value as Record<string, unknown>).forEach(([childKey, child]) => visit(child, [...path, childKey], depth + 1));
    };

    visit(payload, [], 0);
    const summaryKey = `${streamId}:${event}:${ids.slice(0, 4).join("|")}:${titles.slice(0, 4).join("|")}`;
    if (this.giveawayWsObservedFrames.has(summaryKey)) return;
    this.giveawayWsObservedFrames.add(summaryKey);
    if (this.giveawayWsObservedFrames.size > 200) this.giveawayWsObservedFrames.clear();

    this.onBrowserEvent?.(
      `giveaway WS observe ${streamer ?? streamId}: topic=${topic}; event=${event}; keys=${keys}; ids=${ids.slice(0, 6).join(" || ") || "-"}; titles=${titles.slice(0, 8).join(" || ") || "-"}`
    );
  }

  private extractGiveawayStateFromPhoenixFrame(
    streamId: string,
    payloadText: string,
    source: GiveawayState["source"]
  ): GiveawayState | null {
    let frame: unknown;
    try {
      frame = JSON.parse(payloadText);
    } catch {
      return null;
    }

    if (!Array.isArray(frame) || frame.length < 5) return null;
    const event = String(frame[3] ?? "");
    if (/^phx_reply$/i.test(event)) return null;
    const activeEvent = /^(giveaway_started|giveaway_updated|giveaway_entered|giveaway_joined|giveaway_created)$/i.test(event);
    const giveawayEvent = /giveaway/i.test(event);
    const ended = /^(giveaway_ended|giveaway_cancelled|giveaway_canceled|giveaway_won|winner_selected)$/i.test(event);

    const payload = frame[4];
    if (!ended && payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const activeGiveaway = record.activeGiveaway ?? record.active_giveaway;
      if (activeGiveaway && typeof activeGiveaway === "object") {
        const activeFields = this.extractGiveawayFields(activeGiveaway, false);
        if (activeFields.id || activeFields.name) {
          return {
            active: true,
            giveawayId: activeFields.id,
            giveawayName: activeFields.name,
            source,
            confidence: source === "WS_PRIMARY" ? 99 : 78,
            updatedAt: new Date().toISOString()
          };
        }
      }
    }
    const extracted = this.extractGiveawayFields(payload, !activeEvent && !giveawayEvent);
    const hasGiveawayPayload = this.hasGiveawayPayload(payload);
    if (!activeEvent && !giveawayEvent && !ended && !hasGiveawayPayload) return null;
    if (!ended && !extracted.id && !extracted.name) {
      this.logIgnoredGiveawayFrame(streamId, event, payload, "no giveaway id/name");
      return null;
    }
    if (!activeEvent && giveawayEvent && !hasGiveawayPayload && !extracted.id && !extracted.name) {
      this.logIgnoredGiveawayFrame(streamId, event, payload, "weak giveaway payload");
      return null;
    }
    return {
      active: !ended,
      giveawayId: extracted.id,
      giveawayName: ended ? null : extracted.name,
      source,
      confidence: source === "WS_PRIMARY" ? 95 : 72,
      updatedAt: new Date().toISOString()
    };
  }

  private hasGiveawayPayload(value: unknown): boolean {
    const seen = new WeakSet<object>();
    let found = false;

    const visit = (entry: unknown, path: string[], depth: number) => {
      if (found || depth > 6 || entry == null || typeof entry !== "object") return;
      if (seen.has(entry)) return;
      seen.add(entry);

      const record = entry as Record<string, unknown>;
      const typeName = String(record.__typename ?? "");
      if (/Giveaway|LiveGiveaway|LivestreamGiveaway|GiveawayItem/i.test(typeName)) {
        found = true;
        return;
      }

      for (const [key, child] of Object.entries(record)) {
        const keyPath = [...path, key].join(".");
        if (/giveaway/i.test(keyPath)) {
          found = true;
          return;
        }
        visit(child, [...path, key], depth + 1);
      }
    };

    visit(value, [], 0);
    return found;
  }

  private logIgnoredGiveawayFrame(streamId: string, event: string, payload: unknown, reason: string): void {
    const key = `${streamId}:${event}:${reason}`;
    if (this.giveawayDebugEvents.has(key)) return;
    this.giveawayDebugEvents.add(key);
    if (this.giveawayDebugEvents.size > 80) this.giveawayDebugEvents.clear();

    const payloadKeys =
      payload && typeof payload === "object"
        ? Object.keys(payload as Record<string, unknown>).slice(0, 12).join(",")
        : typeof payload;
    this.onBrowserEvent?.(`ignored giveaway WS ${streamId}: event=${event}; reason=${reason}; keys=${payloadKeys}`);
  }

  private extractGiveawayFields(value: unknown, requireGiveawayScope = false): { id: string | null; name: string | null } {
    const seen = new WeakSet<object>();
    const candidates: Array<{ id: string | null; name: string | null; score: number }> = [];
    let fallbackId: string | null = null;

    const isUsableName = (candidate: string) => {
      const normalized = candidate.replace(/\s+/g, " ").trim();
      if (normalized.length < 3 || normalized.length > 120) return false;
      if (/^(giveaway|giveaways|live giveaway|live giveaways|upcoming giveaways?|winner|winners|entered|entry|entries|join|joined|starts?|ends?)$/i.test(normalized)) return false;
      if (/^(new|used|sealed|ship only|rip only|rip or ship)$/i.test(normalized)) return false;
      if (/^\d+\s*-\s*#\d+\b/i.test(normalized)) return false;
      return true;
    };

    const readPath = (record: Record<string, unknown>, path: string[]): unknown => {
      let current: unknown = record;
      for (const segment of path) {
        current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[segment] : undefined;
      }
      return current;
    };

    const recordId = (record: Record<string, unknown>): string | null => {
      const candidateId = record.id ?? record.giveaway_id ?? record.giveawayId ?? record.productId ?? record.product_id;
      if (typeof candidateId === "string" || typeof candidateId === "number") return String(candidateId);
      const product = record.product;
      if (product && typeof product === "object") {
        const productRecord = product as Record<string, unknown>;
        const productId = productRecord.id ?? productRecord.productId ?? productRecord.product_id;
        if (typeof productId === "string" || typeof productId === "number") return String(productId);
      }
      const eventProduct = readPath(record, ["eventSpecificInfo", "livestreamProduct"]);
      if (eventProduct && typeof eventProduct === "object") {
        const productRecord = eventProduct as Record<string, unknown>;
        const productId = productRecord.id ?? productRecord.productId ?? productRecord.product_id;
        if (typeof productId === "string" || typeof productId === "number") return String(productId);
      }
      return null;
    };

    const addCandidate = (candidateId: string | null, candidateName: string | null, score: number) => {
      const cleanName = typeof candidateName === "string" && isUsableName(candidateName)
        ? candidateName.replace(/\s+/g, " ").trim()
        : null;
      if (!candidateId && !cleanName) return;
      candidates.push({ id: candidateId, name: cleanName, score });
      if (!fallbackId && candidateId) fallbackId = candidateId;
    };

    const visit = (entry: unknown, path: string[], depth: number, inGiveawayScope: boolean) => {
      if (depth > 8 || entry == null) return;
      if (typeof entry === "string") {
        const key = path[path.length - 1] ?? "";
        if (requireGiveawayScope && !inGiveawayScope && !/giveaway/i.test(path.join("."))) return;
        if (!fallbackId && /^(id|giveaway_id|giveawayId|productId|product_id)$/i.test(key)) fallbackId = entry;
        if (/^(title|name|description)$/i.test(key) && isUsableName(entry)) {
          addCandidate(fallbackId, entry, inGiveawayScope ? 30 : 8);
        }
        return;
      }
      if (typeof entry === "number" && !fallbackId && /^(id|giveaway_id|giveawayId|productId|product_id)$/i.test(path[path.length - 1] ?? "")) {
        if (requireGiveawayScope && !inGiveawayScope && !/giveaway/i.test(path.join("."))) return;
        fallbackId = String(entry);
        return;
      }
      if (typeof entry !== "object" || seen.has(entry)) return;
      seen.add(entry);

      const record = entry as Record<string, unknown>;
      const keyPath = path.join(".");
      const typeName = String(record.__typename ?? "");
      const eventName = String(record.eventName ?? record.event_name ?? record.event ?? "");
      const isGiveawayWonEvent = /GIVEAWAY_WON/i.test(eventName);
      const looksLikeDirectGiveawayEvent =
        "giveaway" in record &&
        ("product" in record || "item" in record || "listing" in record);
      const giveawayScope =
        inGiveawayScope ||
        /giveaway/i.test(keyPath) ||
        /Giveaway|LiveGiveaway|LivestreamGiveaway/i.test(typeName) ||
        isGiveawayWonEvent ||
        looksLikeDirectGiveawayEvent;
      const preferredPaths = [
        ["activeGiveaway", "product", "title"],
        ["activeGiveaway", "product", "name"],
        ["active_giveaway", "product", "title"],
        ["active_giveaway", "product", "name"],
        ["giveaway", "product", "title"],
        ["giveaway", "product", "name"],
        ["item", "title"],
        ["item", "name"],
        ["product", "title"],
        ["product", "name"],
        ["eventSpecificInfo", "livestreamProduct", "title"],
        ["eventSpecificInfo", "livestreamProduct", "name"],
        ["listing", "title"],
        ["listing", "name"],
        ["title"],
        ["name"],
        ["description"]
      ];
      if (!requireGiveawayScope || giveawayScope) {
        const isActiveGiveawayPath = /(^|\.)(activeGiveaway|active_giveaway)(\.|$)/i.test(keyPath);
        const baseScore = isActiveGiveawayPath ? 100 : looksLikeDirectGiveawayEvent ? 92 : isGiveawayWonEvent ? 55 : giveawayScope ? 35 : 5;
        const candidateId = recordId(record);
        for (const preferredPath of preferredPaths) {
          const current = readPath(record, preferredPath);
          if (typeof current === "string" && isUsableName(current)) {
            addCandidate(candidateId, current, baseScore);
            break;
          }
        }
      }

      if (!fallbackId && (!requireGiveawayScope || giveawayScope)) {
        fallbackId = recordId(record);
      }

      Object.entries(record).forEach(([key, child]) => visit(child, [...path, key], depth + 1, giveawayScope));
    };

    visit(value, [], 0, false);
    const best = candidates
      .filter((candidate) => candidate.id || candidate.name)
      .sort((left, right) => right.score - left.score)[0];
    return { id: best?.id ?? fallbackId, name: best?.name ?? null };
  }

  private extractGiveawayStateFromGraphQLPayload(value: unknown): GiveawayState | null {
    const seen = new WeakSet<object>();
    const candidates: Array<{ id: string | null; name: string | null; score: number }> = [];

    const isUsableName = (candidate: string) => {
      const normalized = candidate.replace(/\s+/g, " ").trim();
      if (normalized.length < 3 || normalized.length > 120) return false;
      if (/^(giveaway|giveaways|live giveaway|live giveaways|upcoming giveaways?|winner|winners|entered|entry|entries|join|joined|starts?|ends?)$/i.test(normalized)) return false;
      if (/^(filter|sort|auction|buy now|sold)$/i.test(normalized)) return false;
      if (/^(new|used|sealed|ship only|rip only|rip or ship)$/i.test(normalized)) return false;
      if (/^\d+\s*-\s*#\d+\b/i.test(normalized)) return false;
      return true;
    };

    const extractName = (record: Record<string, unknown>) => {
      const paths = [
        ["item", "title"],
        ["item", "name"],
        ["product", "title"],
        ["product", "name"],
        ["listing", "title"],
        ["listing", "name"],
        ["title"],
        ["name"],
        ["description"]
      ];
      for (const path of paths) {
        let current: unknown = record;
        for (const segment of path) {
          current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[segment] : undefined;
        }
        if (typeof current === "string" && isUsableName(current)) return current.replace(/\s+/g, " ").trim();
      }
      return null;
    };

    const visit = (entry: unknown, path: string[], depth: number) => {
      if (depth > 9 || !entry || typeof entry !== "object" || seen.has(entry)) return;
      seen.add(entry);
      const record = entry as Record<string, unknown>;
      const keyPath = path.join(".");
      const typeName = String(record.__typename ?? "");
      const giveawayLike = /(^|\.|_|-)(giveaway|giveaways)(\.|_|-|$)|Giveaway|LiveGiveaway|LivestreamGiveaway/i.test(`${keyPath} ${typeName}`);

      if (giveawayLike) {
        const idCandidate = record.id ?? record.giveaway_id ?? record.giveawayId;
        const id = typeof idCandidate === "string" || typeof idCandidate === "number" ? String(idCandidate) : null;
        const endedAt = record.endedAt ?? record.ended_at ?? record.completedAt ?? record.completed_at;
        const status = String(record.status ?? record.lifecycleStatus ?? record.state ?? "").toLowerCase();
        const active =
          endedAt == null &&
          !/(ended|cancelled|canceled|complete|completed|inactive|offline)/i.test(status) &&
          !/(winner|won|past|previous)/i.test(keyPath);
        const name = active ? extractName(record) : null;
        if (active && (id || name)) {
          const score = (name ? 20 : 0) + (id ? 5 : 0) + (/active|current|live/i.test(keyPath) ? 8 : 0);
          candidates.push({ id, name, score });
        }
      }

      Object.entries(record).forEach(([key, child]) => visit(child, [...path, key], depth + 1));
    };

    visit(value, [], 0);
    const best = candidates
      .filter((candidate) => candidate.id || candidate.name)
      .sort((left, right) => right.score - left.score)[0];
    if (!best) return null;

    return {
      active: true,
      giveawayId: best.id,
      giveawayName: best.name,
      source: "BROWSER_APOLLO",
      confidence: best.name ? 80 : 68,
      updatedAt: new Date().toISOString()
    };
  }

  private async refreshApolloGiveawayState(streamId: string, page: Page, targetGiveawayId?: string | null): Promise<void> {
    const existing = this.giveawayStates.get(streamId);
    const giveawayIdToFind = targetGiveawayId ?? existing?.giveawayId ?? null;
    this.touchStreamSignalById(streamId, "apollo");

    const apolloState = await page
      .evaluate((targetId) => {
        const isUsableName = (candidate: string) => {
          const normalized = candidate.replace(/\s+/g, " ").trim();
          if (normalized.length < 3 || normalized.length > 120) return false;
          if (/^(giveaway|giveaways|live giveaway|live giveaways|upcoming giveaways?|winner|winners|entered|entry|entries|join|joined|starts?|ends?)$/i.test(normalized)) return false;
          if (/^(new|used|sealed|ship only|rip only|rip or ship)$/i.test(normalized)) return false;
          if (/^\d+\s*-\s*#\d+\b/i.test(normalized)) return false;
          return true;
        };
        const extractName = (record: Record<string, unknown>): string | null => {
          const paths = [
            ["item", "title"],
            ["item", "name"],
            ["product", "title"],
            ["product", "name"],
            ["listing", "title"],
            ["listing", "name"],
            ["title"],
            ["name"],
            ["description"]
          ];
          for (const path of paths) {
            let current: unknown = record;
            for (const segment of path) {
              current = typeof current === "object" && current !== null ? (current as Record<string, unknown>)[segment] : undefined;
            }
            if (typeof current === "string" && isUsableName(current)) return current.replace(/\s+/g, " ").trim();
          }
          return null;
        };
        const readCacheObjects = () => {
          const caches: Record<string, unknown>[] = [];
          const seen = new WeakSet<object>();
          const addCache = (value: unknown) => {
            if (!value || typeof value !== "object" || seen.has(value)) return;
            seen.add(value);
            caches.push(value as Record<string, unknown>);
          };
          const client = (window as unknown as { __APOLLO_CLIENT__?: { cache?: { extract?: () => unknown } } }).__APOLLO_CLIENT__;
          addCache(client?.cache?.extract?.());

          Object.entries(window as unknown as Record<string, unknown>).forEach(([key, value]) => {
            if (!/apollo|graphql|relay|next|urql|cache|store/i.test(key)) return;
            if (!value || typeof value !== "object") return;
            const maybeExtract = (value as { cache?: { extract?: () => unknown }; extract?: () => unknown });
            try {
              addCache(maybeExtract.extract?.());
              addCache(maybeExtract.cache?.extract?.());
            } catch {
              // Ignore inaccessible app internals.
            }
            addCache(value);
          });

          return caches;
        };
        const collectRecords = (root: Record<string, unknown>) => {
          const records: Array<[string, Record<string, unknown>]> = [];
          const seen = new WeakSet<object>();
          const visit = (entry: unknown, keyPath: string, depth: number) => {
            if (depth > 7 || !entry || typeof entry !== "object" || seen.has(entry)) return;
            seen.add(entry);
            const record = entry as Record<string, unknown>;
            const typeName = String(record.__typename ?? "");
            if (/Giveaway|LiveGiveaway|LivestreamGiveaway|GiveawayItem/i.test(`${keyPath} ${typeName}`)) {
              records.push([keyPath, record]);
            }
            Object.entries(record).forEach(([key, child]) => {
              if (child && typeof child === "object") visit(child, `${keyPath}.${key}`, depth + 1);
            });
          };

          Object.entries(root).forEach(([key, value]) => {
            if (value && typeof value === "object") visit(value, key, 0);
          });
          return records;
        };
        const containsText = (value: unknown, needle: string) => {
          const seen = new WeakSet<object>();
          const visit = (entry: unknown, depth: number): boolean => {
            if (depth > 6 || entry == null) return false;
            if (typeof entry === "string" || typeof entry === "number") return String(entry).includes(needle);
            if (typeof entry !== "object" || seen.has(entry)) return false;
            seen.add(entry);
            return Object.entries(entry as Record<string, unknown>).some(([key, child]) => key.includes(needle) || visit(child, depth + 1));
          };
          return visit(value, 0);
        };
        const records = readCacheObjects().flatMap(collectRecords);
        if (!records.length) return { debug: "no_apollo_giveaway_records" };

        const giveawayRecords = records
          .map(([key, value]) => {
            if (!value || typeof value !== "object") return null;
            const record = value as Record<string, unknown>;
            const typeName = String(record.__typename ?? "");
            const haystack = `${key} ${typeName}`;
            if (!/Giveaway|LiveGiveaway|LivestreamGiveaway|GiveawayItem/i.test(haystack)) return null;
            const idCandidate = record.id ?? record.giveaway_id ?? record.giveawayId ?? record.productId ?? record.product_id;
            const giveawayId = typeof idCandidate === "string" || typeof idCandidate === "number" ? String(idCandidate) : null;
            const containsTarget = Boolean(targetId && containsText(record, targetId));
            return { key, record, giveawayId, containsTarget };
          })
          .filter(Boolean) as Array<{ key: string; record: Record<string, unknown>; giveawayId: string | null; containsTarget: boolean }>;
        const orderedRecords = targetId
          ? [
              ...giveawayRecords.filter((entry) => entry.giveawayId === targetId || entry.key.includes(targetId) || entry.containsTarget),
              ...giveawayRecords.filter((entry) => entry.giveawayId !== targetId && !entry.key.includes(targetId) && !entry.containsTarget)
            ]
          : giveawayRecords;

        for (const { key, record, giveawayId, containsTarget } of orderedRecords) {
          const name = extractName(record);
          if (!name) continue;
          return {
            giveawayId,
            giveawayName: name
          };
        }

        return { debug: `no_name_records=${orderedRecords.length} target=${targetId ?? ""}` };
      }, giveawayIdToFind)
      .catch(() => null);

    if (!apolloState?.giveawayName) {
      if (apolloState && "debug" in apolloState && typeof apolloState.debug === "string") {
        this.onBrowserEvent?.(`giveaway Apollo miss ${streamId}: ${apolloState.debug}`);
      }
      return;
    }
    const nextState: GiveawayState = {
      active: true,
      giveawayId: apolloState.giveawayId ?? existing?.giveawayId ?? null,
      giveawayName: apolloState.giveawayName,
      source: existing?.source === "WS_PRIMARY" ? "WS_PRIMARY" : "BROWSER_APOLLO",
      confidence: existing?.source === "WS_PRIMARY" ? Math.max(existing.confidence, 88) : 72,
      updatedAt: new Date().toISOString()
    };
    this.setGiveawayState(streamId, nextState);
    this.onBrowserEvent?.(`giveaway Apollo ${streamId}: ${nextState.giveawayName}`);
  }

  private startApolloGiveawayRetry(streamId: string, page: Page): void {
    if (this.apolloRetryTimers.has(streamId)) return;
    const retry = async () => {
      if (page.isClosed()) {
        const timer = this.apolloRetryTimers.get(streamId);
        if (timer) clearInterval(timer);
        this.apolloRetryTimers.delete(streamId);
        return;
      }
      await this.refreshApolloGiveawayState(streamId, page).catch(() => undefined);
    };
    this.apolloRetryTimers.set(streamId, setInterval(() => void retry(), 2_000));
    void retry();
  }

  private startStreamSignalWatchdog(stream: FollowingFeedLiveStream): void {
    if (this.streamSignalWatchdogTimers.has(stream.streamId)) return;

    const watchdog = async () => {
      const page = this.streamPages.get(stream.streamId);
      if (!page || page.isClosed()) {
        const timer = this.streamSignalWatchdogTimers.get(stream.streamId);
        if (timer) clearInterval(timer);
        this.streamSignalWatchdogTimers.delete(stream.streamId);
        return;
      }

      const now = Date.now();
      const health = this.streamSignalHealth.get(stream.streamId);
      const state = this.giveawayStates.get(stream.streamId);
      const attachedAgeMs = health ? now - health.lastAttachedAt : Number.POSITIVE_INFINITY;
      const newestSignalAt = Math.max(
        health?.lastWsFrameAt ?? 0,
        health?.lastGraphqlAt ?? 0,
        health?.lastApolloAt ?? 0,
        health?.lastStateAt ?? 0
      );
      const signalAgeMs = newestSignalAt ? now - newestSignalAt : attachedAgeMs;
      const nameAgeMs = health?.lastStateNameAt ? now - health.lastStateNameAt : Number.POSITIVE_INFINITY;
      const selfHealAgeMs = health?.lastSelfHealAt ? now - health.lastSelfHealAt : Number.POSITIVE_INFINITY;
      const missingCurrentName = !state?.giveawayName || !state.active;
      const shouldForceRefresh = missingCurrentName || nameAgeMs > 45_000;
      const missingNameTooLong = missingCurrentName && attachedAgeMs > 20_000;
      const shouldReopen = (signalAgeMs > 60_000 || missingNameTooLong) && selfHealAgeMs > 30_000;

      if (shouldForceRefresh) {
        await this.refreshApolloGiveawayState(stream.streamId, page, state?.giveawayId).catch(() => undefined);
      }

      if (!shouldReopen) return;
      const latestHealth = this.streamSignalHealth.get(stream.streamId);
      if (latestHealth) latestHealth.lastSelfHealAt = now;
      this.onBrowserEvent?.(
        `stream signal self-heal ${stream.streamer ?? stream.streamId}: signalAge=${Math.round(signalAgeMs / 1000)}s nameAge=${Number.isFinite(nameAgeMs) ? Math.round(nameAgeMs / 1000) : "never"}s; reopening ${stream.streamUrl}`
      );
      this.clearStreamRuntime(stream.streamId, false);
      await page.close().catch(() => undefined);
      this.streamPages.delete(stream.streamId);
      await this.openStreamPages([stream]).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.onBrowserEvent?.(`stream signal self-heal failed ${stream.streamer ?? stream.streamId}: ${message}`);
      });
    };

    this.streamSignalWatchdogTimers.set(stream.streamId, setInterval(() => void watchdog(), 10_000));
    void watchdog();
  }

  private startStreamPreview(streamId: string, stream: FollowingFeedLiveStream, page: Page): void {
    if (this.streamPreviewTimers.has(streamId)) return;

    const pushFrame = async () => {
      if (page.isClosed()) {
        const timer = this.streamPreviewTimers.get(streamId);
        if (timer) clearInterval(timer);
        this.streamPreviewTimers.delete(streamId);
        this.onStreamPreviewFrame?.(streamId, null);
        return;
      }

      const frame = await this.captureStreamPreviewFrame(page, stream);
      if (frame) {
        this.onStreamPreviewFrame?.(streamId, frame);
      }
    };

    void pushFrame();
    this.streamPreviewTimers.set(streamId, setInterval(() => void pushFrame(), 250));
    this.onBrowserEvent?.(`started real-time stream preview for ${stream.streamer ?? streamId}: ${stream.streamUrl}`);
  }

  private async captureStreamPreviewFrame(page: Page, stream: FollowingFeedLiveStream): Promise<string | null> {
    await this.muteStreamPage(page);
    await this.dismissStreamOverlays(page);
    const readyForPreview = await page
      .evaluate((streamUrl) => {
        const expectedStreamId = streamUrl.match(/\/live\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? "";
        const html = document.documentElement.innerHTML.toLowerCase();
        const href = window.location.href.toLowerCase();
        const onStreamPage = Boolean(expectedStreamId && (href.includes(expectedStreamId) || html.includes(expectedStreamId)));
        const mediaElements = Array.from(document.querySelectorAll<HTMLElement>("video, canvas"));
        const visibleMediaCount = mediaElements.filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.width > 40 && rect.height > 40 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
        }).length;
        const videoReady = Array.from(document.querySelectorAll<HTMLVideoElement>("video")).some(
          (video) => video.readyState >= 2 || !video.paused || video.currentTime > 0
        );

        return {
          ready: onStreamPage && visibleMediaCount > 0,
          visibleMediaCount,
          videoReady
        };
      }, stream.streamUrl)
      .catch(() => ({ ready: false, visibleMediaCount: 0, videoReady: false }));
    if (!readyForPreview.ready) {
      await this.verifyStreamPage(page, stream);
      return null;
    }

    const previewTarget = await page
      .evaluate(() => {
        const visibleVideos = Array.from(document.querySelectorAll<HTMLVideoElement>("video"))
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              element,
              rect,
              area: rect.width * rect.height,
              visible: rect.width > 40 && rect.height > 40 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth
            };
          })
          .filter((candidate) => candidate.visible)
          .sort((left, right) => right.area - left.area);
        const video = visibleVideos[0]?.element;
        if (!video) return null;

        const rect = video.getBoundingClientRect();
        const points = [
          [rect.left + rect.width / 2, rect.top + rect.height / 2],
          [rect.left + rect.width * 0.25, rect.top + rect.height * 0.25],
          [rect.left + rect.width * 0.75, rect.top + rect.height * 0.25],
          [rect.left + rect.width * 0.25, rect.top + rect.height * 0.75],
          [rect.left + rect.width * 0.75, rect.top + rect.height * 0.75]
        ];
        const hidden = new Set<HTMLElement>();
        for (const [x, y] of points) {
          const stack = document.elementsFromPoint(x, y);
          for (const element of stack) {
            if (!(element instanceof HTMLElement)) continue;
            if (element === video || video.contains(element) || element.contains(video)) break;
            if (element === document.documentElement || element === document.body) continue;
            const style = window.getComputedStyle(element);
            if (style.pointerEvents === "none" || style.visibility === "hidden" || style.display === "none") continue;
            const text = element.innerText?.trim() ?? "";
            const clickable = element.closest("button, [role='button'], [aria-label*='close' i], [aria-label*='dismiss' i]");
            if (clickable instanceof HTMLElement) {
              clickable.click();
            }
            const elementRect = element.getBoundingClientRect();
            const coversMeaningfulArea = elementRect.width > 20 && elementRect.height > 20;
            if (coversMeaningfulArea || text || style.position === "fixed" || style.position === "absolute" || Number(style.zIndex) > 0) {
              element.setAttribute("data-nilbog-hidden-video-overlay", "true");
              element.style.setProperty("visibility", "hidden", "important");
              element.style.setProperty("pointer-events", "none", "important");
              hidden.add(element);
            }
          }
        }

        const clippedRect = video.getBoundingClientRect();
        const desiredRatio = 2 / 3;
        let clipWidth = clippedRect.width;
        let clipHeight = clippedRect.height;
        let clipX = clippedRect.left;
        let clipY = clippedRect.top;

        if (clipWidth / clipHeight > desiredRatio) {
          clipWidth = clipHeight * desiredRatio;
          clipX = clippedRect.left + (clippedRect.width - clipWidth) / 2;
        } else {
          clipHeight = clipWidth / desiredRatio;
          clipY = clippedRect.top + Math.max(0, (clippedRect.height - clipHeight) * 0.38);
        }

        clipX = Math.max(0, clipX);
        clipY = Math.max(0, clipY);
        clipWidth = Math.min(clipWidth, window.innerWidth - clipX);
        clipHeight = Math.min(clipHeight, window.innerHeight - clipY);

        return {
          source: "video",
          hiddenOverlayCount: hidden.size,
          clip: {
            x: Math.floor(clipX),
            y: Math.floor(clipY),
            width: Math.max(1, Math.floor(clipWidth)),
            height: Math.max(1, Math.floor(clipHeight))
          }
        };
      })
      .catch(() => null);

    if (!previewTarget) return null;

    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 52,
      clip: previewTarget.clip,
      timeout: 5_000
    }).catch(() => null);
    if (!bytes) return null;

    this.onBrowserEvent?.(
      `captured stream preview frame for ${stream.streamer ?? stream.streamId}: ${stream.streamUrl}; source=${previewTarget.source}; hiddenOverlays=${previewTarget.hiddenOverlayCount}; media=${readyForPreview.visibleMediaCount}; videoReady=${readyForPreview.videoReady}`
    );
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }

  private async muteStreamPage(page: Page): Promise<void> {
    await page
      .evaluate(() => {
        document.querySelectorAll<HTMLVideoElement | HTMLAudioElement>("video, audio").forEach((media) => {
          media.muted = true;
          media.volume = 0;
        });
      })
      .catch(() => undefined);
  }

  private async dismissStreamOverlays(page: Page): Promise<void> {
    const dismissSelectors = [
      "button[aria-label*='close' i]",
      "button[aria-label*='dismiss' i]",
      "button:has-text('Got it')",
      "button:has-text('Continue')",
      "button:has-text('Continue watching')",
      "button:has-text('Start watching')",
      "button:has-text('Watch live')",
      "button:has-text('Watch Live')",
      "button:has-text('Enter')",
      "button:has-text('Enter live')",
      "button:has-text('Enter Live')",
      "button:has-text('Join')",
      "button:has-text('Join live')",
      "button:has-text('Join Live')",
      "button:has-text('Maybe later')",
      "button:has-text('Not now')",
      "button:has-text('No thanks')",
      "button:has-text('I understand')",
      "button:has-text('Accept')",
      "button:has-text('Agree')",
      "[role='button']:has-text('Got it')",
      "[role='button']:has-text('Continue')",
      "[role='button']:has-text('Start watching')",
      "[role='button']:has-text('Watch live')",
      "[role='button']:has-text('Watch Live')",
      "[role='button']:has-text('Enter')",
      "[role='button']:has-text('Join')",
      "[role='button']:has-text('Maybe later')",
      "[role='button']:has-text('Not now')",
      "[role='button']:has-text('No thanks')",
      "[role='button']:has-text('I understand')"
    ];

    for (const selector of dismissSelectors) {
      const locator = page.locator(selector).first();
      const visible = await locator.isVisible({ timeout: 120 }).catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: 750 }).catch(() => undefined);
      await page.waitForTimeout(120).catch(() => undefined);
    }

    await page
      .evaluate(() => {
        const video = Array.from(document.querySelectorAll<HTMLVideoElement>("video"))
          .map((element) => ({ element, rect: element.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width > 40 && rect.height > 40)
          .sort((left, right) => right.rect.width * right.rect.height - left.rect.width * left.rect.height)[0]?.element;
        if (!video) return;

        const rect = video.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const blocker = document.elementFromPoint(centerX, centerY);
        const clickable = blocker?.closest?.("button, [role='button'], [aria-label*='close' i], [aria-label*='dismiss' i]");
        if (clickable instanceof HTMLElement && !video.contains(clickable)) {
          clickable.click();
        }
      })
      .catch(() => undefined);
  }

  async closeStreamPages(streamIds: string[]): Promise<void> {
    await Promise.all(
      streamIds.map(async (streamId) => {
        const page = this.streamPages.get(streamId);
        if (!page) return;
        await page.close().catch(() => undefined);
        this.streamPages.delete(streamId);
        this.clearStreamRuntime(streamId, true);
        this.onBrowserEvent?.(`closed hidden stream tab for offline stream ${streamId}`);
      })
    );
  }

  async logFeedMatches(streamers: string[], streams: FollowingFeedLiveStream[]): Promise<void> {
    const normalize = (value: string) => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

    for (const streamer of streamers) {
      const normalizedStreamer = normalize(streamer);
      const matches = streams.filter((stream) => {
        if (stream.normalizedUsername) return stream.normalizedUsername === normalizedStreamer;
        if (stream.username) return normalize(stream.username) === normalizedStreamer;
        return false;
      });
      const onlineMatch = matches.find((stream) => stream.lifecycleState === "online");
      const offlineMatch = matches.find((stream) => stream.lifecycleState === "offline");
      const match = onlineMatch ?? offlineMatch;
      this.onBrowserEvent?.(
        onlineMatch
          ? `feed matched ONLINE ${streamer} -> ${onlineMatch.streamUrl} (${onlineMatch.lifecycleStatus ?? "unknown lifecycle"})`
          : match
            ? `feed matched ${match.lifecycleState.toUpperCase()} ${streamer} -> ${match.streamUrl} (${match.lifecycleStatus ?? "unknown lifecycle"})`
          : `feed did not match ${streamer}; scanned ${streams.length} live link(s)`
      );
    }
  }

  private async verifyStreamPage(page: Page, stream: FollowingFeedLiveStream): Promise<boolean> {
    if (page.isClosed()) return false;

    const verification = await page
      .evaluate((streamUrl) => {
        const normalizePageUrl = (value: string) => value.split("?")[0].split("#")[0].replace(/\/$/, "").toLowerCase();
        const expectedStreamId = streamUrl.match(/\/live\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? "";
        const ready = document.readyState === "interactive" || document.readyState === "complete";
        const currentUrl = window.location.href;
        const documentHtml = document.documentElement.innerHTML;
        const onExpectedPage =
          normalizePageUrl(currentUrl) === normalizePageUrl(streamUrl) ||
          Boolean(expectedStreamId && documentHtml.toLowerCase().includes(expectedStreamId));
        const bodyText = document.body.innerText;
        const videos = Array.from(document.querySelectorAll("video"));
        const videoReady = videos.some((video) => video.readyState >= 2 || !video.paused || video.currentTime > 0);
        const mediaElementCount = videos.length + document.querySelectorAll("canvas, iframe").length;
        const pageText = `${bodyText} ${[...document.querySelectorAll("script")]
          .map((script) => script.textContent ?? "")
          .filter((text) => /liveStream|isLive|endedAt|viewer_count|viewerCount|streamStatus|lifecycleStatus/i.test(text))
          .join(" ")
          .slice(0, 300_000)}`;
        const hasLiveSignal =
          /\b(status|lifecycleStatus|streamStatus)\s*[:=]\s*["']?LIVE\b/i.test(pageText) ||
          /\bisLive\s*[:=]\s*true\b/i.test(pageText) ||
          /\bliveStream\s*[:=]\s*\{|\blive now\b|\bcurrently live\b/i.test(pageText) ||
          /\bendedAt\s*[:=]\s*(null|undefined)\b/i.test(pageText);
        const hasOfflineSignal =
          /\b(status|lifecycleStatus|streamStatus)\s*[:=]\s*["']?(ENDED|OFFLINE|CANCELLED|CANCELED)\b/i.test(pageText) ||
          /\bendedAt\s*[:=]\s*["']?\d{4}-\d{2}-\d{2}/i.test(pageText) ||
          /\b(stream ended|show ended|not live|offline|upcoming|replay)\b/i.test(bodyText);

        const hasMediaSignal = mediaElementCount > 0 || videoReady;
        const verified =
          ready &&
          onExpectedPage &&
          bodyText.trim().length > 0 &&
          (!hasOfflineSignal || hasLiveSignal || hasMediaSignal);

        return {
          verified,
          currentUrl,
          ready,
          onExpectedPage,
          hasLiveSignal,
          hasOfflineSignal,
          videoReady,
          mediaElementCount,
          bodyLength: bodyText.trim().length
        };
      }, stream.streamUrl)
      .catch(() => ({
        verified: false,
        currentUrl: "",
        ready: false,
        onExpectedPage: false,
        hasLiveSignal: false,
        hasOfflineSignal: false,
        videoReady: false,
        mediaElementCount: 0,
        bodyLength: 0
      }));

    if (verification.verified) {
      this.onBrowserEvent?.(
        `verified hidden stream tab for ${stream.streamer ?? stream.streamId}: ${stream.streamUrl}; media=${verification.mediaElementCount}; videoReady=${verification.videoReady}; liveSignal=${verification.hasLiveSignal}`
      );
    } else {
      this.onBrowserEvent?.(
        `hidden stream tab not verified yet for ${stream.streamer ?? stream.streamId}: ${stream.streamUrl}; current=${verification.currentUrl}; expectedPage=${verification.onExpectedPage}; media=${verification.mediaElementCount}; videoReady=${verification.videoReady}; liveSignal=${verification.hasLiveSignal}; offlineSignal=${verification.hasOfflineSignal}; body=${verification.bodyLength}`
      );
    }

    return verification.verified;
  }

  private async waitForLogin(timeoutMs: number): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;

    const deadline = Date.now() + timeoutMs;
    let consecutiveLoggedInChecks = 0;
    while (Date.now() < deadline) {
      const loggedIn = await this.page
        .evaluate(async () => {
          const hasAccountSignals = Boolean(
            document.querySelector(
              "[href*='/account'], [href*='/profile'], [aria-label*='profile' i], [aria-label*='account' i], [data-testid*='profile' i], [data-testid*='account' i]"
            )
          );
          const hasLoggedInText = document.body.innerText
            .split("\n")
            .some((line) => /^(logout|log out|my profile|my account|seller hub)$/i.test(line.trim()));
          const hasLoginPrompt = Boolean(
            document.querySelector("[href*='/login'], [href*='/signup'], [aria-label*='log in' i], [aria-label*='sign up' i]")
          );

          return (hasAccountSignals || hasLoggedInText) && !hasLoginPrompt;
        })
        .catch(() => false);

      consecutiveLoggedInChecks = loggedIn ? consecutiveLoggedInChecks + 1 : 0;
      if (consecutiveLoggedInChecks >= 5) return true;
      await this.page.waitForTimeout(1_000).catch(() => undefined);
    }

    return false;
  }

  private startLoginMonitor(): void {
    if (this.loginMonitor) return;

    this.loginMonitor = (async () => {
      this.authenticated = await this.waitForLogin(300_000);
      if (this.authenticated) {
        this.onBrowserEvent?.("login monitor confirmed authenticated; leaving browser visible");
      }
      this.loginMonitor = null;
    })();
  }

  private async navigateForLogin(): Promise<void> {
    if (!this.page || this.page.isClosed()) return;

    await this.page.goto(whatnotHomeUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  }

  private async openSystemBrowserForLogin(): Promise<void> {
    this.feedCaptureAllowed = false;
    await this.close();

    const packagedChromium = packagedChromiumPath();
    const browser = browserCandidates.find((candidate) => existsSync(candidate.path)) ??
      (packagedChromium ? { name: "Packaged Chromium", path: packagedChromium } : null);
    if (!browser) {
      throw new Error("Chrome, Edge, or packaged Chromium was not found.");
    }

    this.authorizationInProgress = true;
    const child = spawn(
      browser.path,
      [
        `--user-data-dir=${this.profilePath}`,
        "--disable-background-mode",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        "--window-position=80,80",
        "--window-size=440,800",
        whatnotHomeUrl
      ],
      {
        detached: true,
        stdio: "ignore"
      }
    );
    this.authorizationProcess = child;
    child.once("exit", () => {
      if (this.authorizationProcess !== child) return;
      this.authorizationInProgress = false;
      this.authenticated = true;
      this.feedBlocked = false;
      this.feedCaptureAllowed = true;
      this.authorizationProcess = null;
      this.onBrowserEvent?.("login browser closed; auth saved; opening followed feed");
      setTimeout(() => void this.ensureFeedPage(), 3_000);
    });
    child.once("error", (error) => {
      this.authorizationInProgress = false;
      if (this.authorizationProcess === child) this.authorizationProcess = null;
      this.onBrowserEvent?.(`login browser failed: ${error.message}`);
    });
    child.unref();
    this.onBrowserEvent?.(`opened ${browser.name} directly for login`);
  }

  private async ensureFeedPage(): Promise<void> {
    if (!this.feedCaptureAllowed) return;
    if (this.page && !this.page.isClosed()) return;
    if (this.authorizationInProgress) {
      this.onBrowserEvent?.("feed browser paused while login browser is open");
      return;
    }

    try {
      this.context = await this.launchPersistentContext();
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      const context = this.context;
      const page = this.page;
      context.once("close", () => {
        if (this.context !== context) return;
        this.context = null;
        this.page = null;
        this.onBrowserEvent?.("feed browser closed; retrying while feed capture is enabled");
        if (this.feedCaptureAllowed) setTimeout(() => void this.ensureFeedPage(), 2_500);
      });
      page.once("close", () => {
        if (this.page !== page) return;
        this.page = null;
        this.onBrowserEvent?.("feed page closed; retrying while feed capture is enabled");
        if (this.feedCaptureAllowed) setTimeout(() => void this.ensureFeedPage(), 2_500);
      });
      this.feedBlocked = false;
      await this.page.setViewportSize({ width: 260, height: 420 }).catch(() => undefined);
      await this.page.goto(whatnotFollowingFeedUrl, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => undefined);
      await this.lockAuthenticatedBrowser();
      this.onBrowserEvent?.("feed capture browser opened to FOLLOWING_FEED");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.context?.close().catch(() => undefined);
      this.context = null;
      this.page = null;
      this.onBrowserEvent?.(`feed capture browser unavailable: ${message}`);
      if (/existing browser session|profile is already in use|profile.*in use/i.test(message)) {
        this.onBrowserEvent?.("profile is still locked; retrying feed capture shortly");
        setTimeout(() => void this.ensureFeedPage(), 3_000);
      } else {
        this.feedBlocked = true;
      }
    }
  }

  private async launchPersistentContext(): Promise<BrowserContext> {
    if (!existsSync(this.profilePath)) {
      throw new Error("Chrome profile was not found. Install Chrome and sign in to Whatnot in Chrome first.");
    }
    const options = {
      headless: false,
      viewport: { width: 420, height: 760 },
      args: [
        "--profile-directory=Default",
        "--window-position=-10000,-10000",
        "--window-size=280,460",
        "--disable-notifications",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows"
      ]
    };

    for (const channel of chromiumChannels) {
      try {
        return await chromium.launchPersistentContext(this.profilePath, {
          ...options,
          channel
        });
      } catch {
        // Try the next installed Chromium channel before falling back to Playwright's bundled browser.
      }
    }

    throw new Error("Could not open Chrome profile. Close Chrome if it is already running, make sure Whatnot is signed in there, then click the browser card gear again.");
  }

  private async showBrowserForLogin(): Promise<void> {
    if (!this.page || this.page.isClosed() || !this.context) return;

    await this.page.setViewportSize({ width: 420, height: 760 }).catch(() => undefined);

    try {
      const session = await this.context.newCDPSession(this.page);
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: 80,
          top: 80,
          width: 440,
          height: 800,
          windowState: "normal"
        }
      });
    } catch {
      // The visible login window is best effort; Chromium still opens even if bounds cannot be set.
    }
  }

  private async lockAuthenticatedBrowser(): Promise<void> {
    if (!this.page || this.page.isClosed() || !this.context) return;

    await this.page.setViewportSize({ width: 260, height: 420 }).catch(() => undefined);

    try {
      const session = await this.context.newCDPSession(this.page);
      const { windowId } = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId,
        bounds: {
          left: -10_000,
          top: -10_000,
          width: 280,
          height: 460,
          windowState: "normal"
        }
      });
    } catch {
      // Some Chromium builds reject window-bound changes; viewport shrinking still keeps the feed usable.
    }
  }
}
