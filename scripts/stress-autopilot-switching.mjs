import { Scanner } from "../dist-electron/electron/scanner.js";
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
    selectedProfile: "2024",
    profiles: {
      "2024": { targetX: 580, targetY: 305, intervalMs: 3000, jitterMs: 0 },
      "2025": { targetX: 580, targetY: 280, intervalMs: 3000, jitterMs: 0 }
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

const createHarness = () => {
  const calls = [];
  const adb = {
    openUrl: async (deviceId, url) => calls.push({ type: "openUrl", deviceId, url }),
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

test("parks all selected devices when no match exists", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [offlineCard(1, "KrakenHits")]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.runtimeState === "PARKED", "expected PARKED runtime");
  assert(parkCount(calls) === deviceCount, `expected ${deviceCount} park calls`);
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

test("reopens same stream URL when a new matching giveaway appears", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  setCards(scanner, [streamCard(1, "KrakenHits", "PS5 giveaway", "uuid-a", 1000)]);
  await runNavigation(scanner);
  assert(openUrls(calls).length === deviceCount * 2, "expected resend for new giveaway on same URL");
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
    streamCard(0, "CoolKicks", "1000 Amazon giveaway", "uuid-cool", 1000)
  ]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.activeSlot === 0, "expected CoolKicks active slot");
  assert(openUrls(calls).every((url) => url.endsWith("/uuid-cool")), "expected higher score URL");
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

test("ignores stale matches and parks", async () => {
  const { scanner, calls } = createHarness();
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-stale", -180000)]);
  await runNavigation(scanner);
  assert(scanner.state.autoClicker.runtimeState === "PARKED", "expected stale match to park");
  assert(openUrls(calls).length === 0, "expected no stale open");
});

test("parks after a match ends even inside park cooldown", async () => {
  const { scanner, calls } = createHarness();
  scanner.snapshot = {
    ...scanner.state,
    autoClicker: {
      ...scanner.state.autoClicker,
      lastParkedAt: iso(-30000)
    }
  };
  setCards(scanner, [streamCard(1, "KrakenHits", "Elite Trainer Box giveaway", "uuid-a")]);
  await runNavigation(scanner);
  setCards(scanner, [offlineCard(1, "KrakenHits")]);
  await runNavigation(scanner);
  assert(parkCount(calls) === deviceCount, "expected park after active match ended despite cooldown");
});

test("rapid churn never keeps stale active slot on no-match", async () => {
  const { scanner, calls } = createHarness();
  for (let index = 0; index < churnIterations; index += 1) {
    if (index % 5 === 0) {
      setCards(scanner, [streamCard(1, "KrakenHits", `PS5 giveaway ${index}`, `uuid-${index}`)]);
    } else if (index % 5 === 1) {
      setCards(scanner, [streamCard(4, "SpaceNarwhalz", `Elite Trainer Box ${index}`, `space-${index}`, 1000)]);
    } else if (index % 5 === 2) {
      setCards(scanner, [streamCard(0, "CoolKicks", `1000 Amazon ${index}`, `cool-${index}`, 2000)]);
    } else {
      setCards(scanner, [offlineCard(1, "KrakenHits"), offlineCard(4, "SpaceNarwhalz"), offlineCard(0, "CoolKicks")]);
    }
    await runNavigation(scanner);
    if (scanner.state.autoClicker.runtimeState === "PARKED") {
      assert(scanner.state.autoClicker.activeSlot === null, `active slot should be null when parked at iteration ${index}`);
    }
  }
    assert(openUrls(calls).length > deviceCount * Math.max(20, Math.floor(churnIterations / 10)), "expected many stream switches under churn");
  assert(parkCount(calls) >= deviceCount, "expected parking under churn");
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
