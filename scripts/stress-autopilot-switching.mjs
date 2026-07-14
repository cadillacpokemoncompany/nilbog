import { Scanner } from "../dist-electron/electron/scanner.js";
import { BrowserService } from "../dist-electron/electron/browserService.js";
import { createDefaultKeywordRules, createEmptyCards } from "../dist-electron/electron/types.js";

const deviceCount = Number(process.env.NILBOG_STRESS_DEVICES ?? "20");
const churnIterations = Number(process.env.NILBOG_STRESS_CHURN ?? "200");
const devices = Array.from({ length: deviceCount }, (_, index) => ({
  id: `device-${String(index + 1).padStart(2, "0")}`,
  status: "connected",
  label: `device-${index + 1}`,
  selected: true
}));

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const createDeviceRuntime = () =>
  devices.map((device) => ({
    ...device,
    phase: "connected",
    targetStreamer: null,
    targetUrl: null,
    lastSeenAt: iso(),
    lastActionAt: null,
    lastAction: null,
    lastError: null
  }));

const makeSnapshot = () => ({
  cards: createEmptyCards(),
  devices,
  autoClicker: {
    enabled: true,
    autoNavEnabled: true,
    dryRun: false,
    intervalMs: 3000,
    jitterMs: 0,
    targetX: 580,
    targetY: 305,
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
      connected: deviceCount,
      unauthorized: 0,
      offline: 0,
      selectedConnected: deviceCount,
      lastTapAt: null,
      lastTapDevice: null,
      lastEnteredSlot: null,
      lastTapOk: null,
      lastError: null
    },
    deviceRuntime: createDeviceRuntime(),
    updateHealth: {
      currentVersion: "0.1.8",
      latestVersion: null,
      status: "idle",
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastError: null,
      pendingInstaller: null
    }
  },
  focusRouting: {
    watchDate: "2026-07-04",
    novaBaselineUuid: null,
    novaAcceptedUuid: null,
    novaSawOffline: false
  },
  keywordScoring: { rules: createDefaultKeywordRules() },
  browser: {
    launched: false,
    authenticated: true,
    profilePath: "stress",
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

const streamCard = (slot, streamer, giveawayName, streamUuid, offsetMs = 0) => ({
  slot,
  streamer,
  clickTargetX: 0,
  clickTargetY: 0,
  clickIntervalMs: 0,
  status: "live",
  resolvedUrl: `https://www.whatnot.com/live/${streamUuid}`,
  streamUuid,
  title: streamer,
  currentItem: null,
  giveawayName,
  entryCount: null,
  viewerCount: null,
  thumbnailImageDataUrl: null,
  streamPreviewImageDataUrl: null,
  lastResolvedAt: iso(offsetMs),
  error: null
});

const offlineCard = (slot, streamer) => ({
  ...streamCard(slot, streamer, null, `offline-${slot}`),
  status: "offline",
  resolvedUrl: null,
  streamUuid: null,
  lastResolvedAt: iso()
});

const createHarness = ({ foregroundSequence = [] } = {}) => {
  const calls = [];
  const foregroundChecks = [...foregroundSequence];
  const adb = {
    openUrl: async (deviceId, url) => calls.push({ type: "openUrl", deviceId, url }),
    getForegroundPackage: async () => foregroundChecks.shift() ?? "com.whatnot_mobile",
    prepareFullscreenWhatnot: async (deviceId) => calls.push({ type: "fullscreen", deviceId }),
    parkWhatnotOnHome: async (deviceId) => {
      calls.push({ type: "park", deviceId });
      return { foregroundPackage: "com.android.launcher" };
    }
  };
  const scanner = new Scanner(
    makeSnapshot(),
    adb,
    {},
    {},
    { save: async () => undefined },
    () => null
  );
  return { scanner, calls };
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const setCards = (scanner, cards) => {
  const base = createEmptyCards();
  scanner.snapshot = {
    ...scanner.state,
    cards: base.map((card) => cards.find((candidate) => candidate.slot === card.slot) ?? card)
  };
};

const runNavigation = async (scanner) => {
  await scanner.navigateAutoTarget(scanner.state.devices);
};

const openUrls = (calls) => calls.filter((call) => call.type === "openUrl").map((call) => call.url);
const parkCount = (calls) => calls.filter((call) => call.type === "park").length;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("extracts SpaceNarwhalz active giveaway product name from websocket frame", async () => {
  const browser = new BrowserService("stress-profile");
  const frame = [
    "1",
    "2",
    "auction:9fb0eb47-d944-44e0-8aa4-2acd37793223",
    "user_joined",
    {
      activeGiveaway: {
        product: {
          id: "945d055a-e47b-4deb-997b-0ccddab6fc51",
          productId: 540626101,
          name: "ASCENDED HEROES PACK FOR THE FREEEE!! ✨✨ #36",
          description: "NO PURCHASE NEEDED"
        },
        productId: "945d055a-e47b-4deb-997b-0ccddab6fc51"
      },
      livestream: {
        id: "9fb0eb47-d944-44e0-8aa4-2acd37793223",
        hostUsername: "spacenarwhalz",
        title: "VINTAGE SLABS IN THE SUNROOM"
      },
      pinnedProduct: {
        name: "APEX BLITZ PSA (SURPRISE SLAB) (RIP ONLY)"
      }
    }
  ];
  const state = browser.extractGiveawayStateFromPhoenixFrame(
    "9fb0eb47-d944-44e0-8aa4-2acd37793223",
    JSON.stringify(frame),
    "WS_PRIMARY"
  );
  assert(state?.active === true, "expected active giveaway state");
  assert(state?.giveawayName === "ASCENDED HEROES PACK FOR THE FREEEE!! ✨✨ #36", `expected active giveaway product name, got ${state?.giveawayName}`);
});

test("falls back to KrakenHits when no match exists", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(0, "KrakenHits", "No scored phrase today", "uuid-kraken-fallback")]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.runtimeState === "NO_MATCH", `expected NO_MATCH fallback runtime, got ${scanner.state.autoClicker.runtimeState}: ${scanner.state.autoClicker.runtimeDetail}`);
  assert(scanner.state.autoClicker.activeSlot === 0, "expected Kraken fallback active slot");
  assert(openUrls(calls).length === deviceCount, "expected one Kraken open per device");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-kraken-fallback")), "expected Kraken fallback URL");
  assert(parkCount(calls) === 0, "expected no home parking");
});

test("opens every device to first matching stream", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.activeSlot === 1, "expected active slot 1");
  assert(openUrls(calls).length === deviceCount, "expected one open per device");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-a")), "expected uuid-a URL");
});

test("does not reopen same stream and same giveaway repeatedly", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  await runNavigation(scanner);
  assert(openUrls(calls).length === deviceCount, "expected no duplicate reopen");
});
test("routes all devices on a fresh current stream match even if runtime state claims they are already there", async () => {
  const { scanner, calls } = createHarness();
  const card = streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a");
  const targetUrl = card.resolvedUrl;
  setCards(scanner, [card]);
  scanner.snapshot = {
    ...scanner.state,
    autoClicker: {
      ...scanner.state.autoClicker,
      deviceRuntime: scanner.state.autoClicker.deviceRuntime.map((runtime, index) =>
        index === deviceCount - 1
          ? runtime
          : {
              ...runtime,
              phase: "on_stream",
              targetStreamer: "KrakenHits",
              targetUrl,
              lastAction: "on KrakenHits",
              lastActionAt: iso()
            }
      )
    }
  };
  await runNavigation(scanner);
  const routed = calls.filter((call) => call.type === "openUrl");
  assert(routed.length === deviceCount, `expected every device to route on fresh match, got ${routed.length}`);
  assert(routed.every((call) => call.url.endsWith("/uuid-a")), "expected current target URL for every device");
  assert(scanner.state.autoClicker.lastAction.includes(`Sent ${deviceCount}/${deviceCount}`), `expected full route count in action, got ${scanner.state.autoClicker.lastAction}`);
});

test("updates same stream match without reopening the same URL", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  setCards(scanner, [streamCard(1, "KrakenHits", "PS5 giveaway", "uuid-a", 1000)]);
  await runNavigation(scanner);
  assert(openUrls(calls).length === deviceCount, "expected no duplicate reopen for same URL");
  assert(scanner.state.autoClicker.activeSlot === 1, "expected active slot to stay on same stream");
  assert(scanner.state.autoClicker.matchedScore === 500, "expected PS5 score");
});

test("opens newer UUID for same streamer even with same matching title", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-old")]);
  await runNavigation(scanner);
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-new", 1000)]);
  await runNavigation(scanner);
  const urls = openUrls(calls);
  assert(urls.slice(0, deviceCount).every((url) => url.endsWith("/uuid-old")), "expected old UUID first");
  assert(urls.slice(deviceCount).every((url) => url.endsWith("/uuid-new")), "expected new UUID second");
});

test("switches to higher score stream immediately", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [
    streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-kraken"),
    streamCard(6, "Woosleys", "1000 Amazon giveaway", "uuid-woosleys", 1000)
  ]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.activeSlot === 6, "expected Woosleys active slot");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-woosleys")), "expected higher score URL");
});

test("retries device route when Whatnot does not foreground first", async () => {
  const { scanner, calls } = createHarness({ foregroundSequence: ["com.android.launcher", "com.whatnot_mobile"] });
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-retry")]);
  await runNavigation(scanner);
  const urls = openUrls(calls);
  assert(urls.length === deviceCount + 1, "expected one extra retry open for first device");
  assert(scanner.state.autoClicker.adbHealth.lastError === null, "expected no route health error after retry success");
  assert(scanner.state.autoClicker.deviceRuntime.filter((device) => device.phase === "on_stream").length === deviceCount, "expected all devices on stream");
});

test("uses newer match as tie breaker for same score", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [
    streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-kraken", -2000),
    streamCard(4, "SpaceNarwhalz", "Elite Trainer Box giveaway", "uuid-space", 2000)
  ]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.activeSlot === 4, "expected newer same-score stream");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-space")), "expected newer same-score URL");
});

test("uses displayed live giveaway names regardless of feed timestamp age", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [
    streamCard(0, "KrakenHits", "No scored phrase today", "uuid-kraken-fallback"),
    streamCard(4, "SpaceNarwhalz", "Elite Trainer Box giveaway", "uuid-stale", -180000)
  ]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.runtimeState === "MATCHED", "expected displayed live match to remain actionable");
  assert(scanner.state.autoClicker.activeSlot === 4, "expected scored live card active slot");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-stale")), "expected scored live card URL");
  assert(parkCount(calls) === 0, "expected no home parking");
});

test("falls back to KrakenHits after a match ends", async () => {
  const { scanner, calls } = createHarness();
  scanner.snapshot = {
    ...scanner.state,
    autoClicker: {
      ...scanner.state.autoClicker,
      lastParkedAt: iso(-30000)
    }
  };
  setCards(scanner, [streamCard(4, "SpaceNarwhalz", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  setCards(scanner, [
    streamCard(0, "KrakenHits", "No scored phrase today", "uuid-kraken-fallback"),
    offlineCard(4, "SpaceNarwhalz")
  ]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.activeSlot === 0, "expected Kraken fallback active slot after match ended");
  assert(openUrls(calls).slice(-deviceCount).every((url) => url.endsWith("/uuid-kraken-fallback")), "expected Kraken fallback after match ended");
  assert(parkCount(calls) === 0, "expected no home parking");
});

test("rapid churn never keeps stale active slot on no-match", async () => {
  const { scanner, calls } = createHarness();
  for (let index = 0; index < churnIterations; index += 1) {
    if (index % 5 === 0) {
      setCards(scanner, [streamCard(1, "KrakenHits", `PS5 giveaway ${index}`, `uuid-${index}`)]);
    } else if (index % 5 === 1) {
      setCards(scanner, [streamCard(4, "SpaceNarwhalz", `Elite Trainer Box ${index}`, `space-${index}`, 1000)]);
    } else if (index % 5 === 2) {
      setCards(scanner, [streamCard(6, "Woosleys", `1000 Amazon ${index}`, `woosleys-${index}`, 2000)]);
    } else {
      setCards(scanner, [streamCard(0, "KrakenHits", `No scored phrase ${index}`, `kraken-fallback-${index}`), offlineCard(4, "SpaceNarwhalz"), offlineCard(6, "Woosleys")]);
    }
    await runNavigation(scanner);
    if (scanner.state.autoClicker.runtimeState === "NO_MATCH") {
      assert(scanner.state.autoClicker.activeSlot === 0, `active slot should be Kraken fallback at iteration ${index}`);
    }
  }
  const expectedSwitches = Math.max(1, Math.floor(churnIterations / 5));
  assert(openUrls(calls).length >= deviceCount * expectedSwitches, "expected stream switches under churn");
  assert(parkCount(calls) === 0, "expected no home parking under churn");
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
    break;
  }
}

if (!process.exitCode) {
  console.log(`All ${passed} stress tests passed with ${deviceCount} simulated selected devices.`);
}
