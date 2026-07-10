import { app, BrowserWindow, globalShortcut, ipcMain, screen } from "electron";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AdbService } from "./adbService.js";
import { AutoUpdaterService } from "./autoUpdater.js";
import { BrowserService } from "./browserService.js";
import { ConfigStore } from "./configStore.js";
import { NotificationService } from "./notificationService.js";
import { Scanner } from "./scanner.js";
import { WhatnotResolver } from "./whatnotResolver.js";
import type { AdbDevice, AppSnapshot, StreamCard } from "./types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const isDev = !app.isPackaged;
const preloadPath = join(__dirname, "../../electron/preload.cjs");
const DECK_COLUMNS = 12;
const DECK_PADDING = 18;
const DECK_GAP_TOTAL = 80;
const DECK_HEIGHT_RATIO = 1.5;
const KRAKEN_SLOT = 0;

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let snapshot: AppSnapshot;
let browserService: BrowserService;
let scanner: Scanner;
let adb: AdbService;
let autoUpdater: AutoUpdaterService;
let notifier: NotificationService;
let lastEnterNotificationKey: string | null = null;
let autoClickerTimer: NodeJS.Timeout | null = null;
let autoClickerWatchdogTimer: NodeJS.Timeout | null = null;
let deviceWatcherTimer: NodeJS.Timeout | null = null;
let winnerWatcherTimer: NodeJS.Timeout | null = null;
let deviceWatcherRunning = false;
let winnerWatcherRunning = false;
let shutdownStarted = false;
const whatnotPackage = "com.whatnot_mobile";
const winnerNotificationSeen = new Map<string, number>();
const winnerNotificationTtlMs = 30 * 60_000;
const routeBatchSize = 5;
const routeBatchDelayMs = 180;

const debugLog = async (message: string, error?: unknown) => {
  const details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : (error ? String(error) : "");
  await appendFile(join(app.getPath("userData"), "nilbog-debug.log"), `[${new Date().toISOString()}] ${message}${details ? `\n${details}` : ""}\n`).catch(
    () => undefined
  );
};

const readLocalDiscordWebhook = async (appDataDir: string): Promise<string> => {
  const envWebhook = process.env.NILBOG_DISCORD_WEBHOOK?.trim();
  if (envWebhook) return envWebhook;

  const appDataWebhookPath = join(appDataDir, "nilbog-discord-webhook.txt");
  const appDataWebhook = (await readFile(appDataWebhookPath, "utf8").catch(() => "")).trim();
  if (appDataWebhook) return appDataWebhook;

  const bundledWebhook = (
    await readFile(join(process.resourcesPath ?? "", "discord", "nilbog-discord-webhook.txt"), "utf8").catch(() => "")
  ).trim();
  if (!bundledWebhook) return "";

  await mkdir(appDataDir, { recursive: true }).catch(() => undefined);
  await writeFile(appDataWebhookPath, bundledWebhook, "utf8").catch((error) => debugLog("discord webhook seed failed", error));
  return bundledWebhook;
};

const createWindow = async () => {
  const { workArea } = screen.getPrimaryDisplay();
  const cellSize = Math.floor((workArea.width - DECK_PADDING - DECK_GAP_TOTAL) / DECK_COLUMNS);
  const height = Math.min(Math.max(Math.round(cellSize * DECK_HEIGHT_RATIO) + DECK_PADDING, 240), workArea.height);

  mainWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y + workArea.height - height,
    width: workArea.width,
    height,
    minWidth: 1180,
    minHeight: 240,
    backgroundColor: "#111315",
    title: "Nilbog",
    alwaysOnTop: false,
    minimizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5187");
  } else {
    await mainWindow.loadFile(join(__dirname, "../../dist/index.html"));
  }

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    void debugLog(`renderer console level=${level} ${sourceId}:${line} ${message}`);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, description, validatedUrl) => {
    void debugLog(`renderer failed load code=${code} description=${description} url=${validatedUrl}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    void debugLog(`renderer process gone ${JSON.stringify(details)}`);
  });

  const preloadStatus = await mainWindow.webContents
    .executeJavaScript("({ hasNilbog: Boolean(window.nilbog), href: location.href, title: document.title })")
    .catch((error) => ({ hasNilbog: false, href: "unknown", title: error instanceof Error ? error.message : String(error) }));
  await debugLog(`renderer preload status ${JSON.stringify(preloadStatus)}`);

  setTimeout(() => {
    void mainWindow?.webContents
      .executeJavaScript(
        "({ streamCards: document.querySelectorAll('.stream-card').length, controlTiles: document.querySelectorAll('.control-tile').length, browserTiles: document.querySelectorAll('.browser-tile').length, bodyText: document.body.innerText.slice(0, 120) })"
      )
      .then((status) => debugLog(`renderer mount status ${JSON.stringify(status)}`))
      .catch((error) => debugLog("renderer mount status failed", error));
  }, 1_500);
};

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
});

const stopAutoClickerLoop = () => {
  if (!autoClickerTimer) return;
  clearTimeout(autoClickerTimer);
  autoClickerTimer = null;
};

const stopAutoClickerWatchdogLoop = () => {
  if (!autoClickerWatchdogTimer) return;
  clearInterval(autoClickerWatchdogTimer);
  autoClickerWatchdogTimer = null;
};

const stopDeviceWatcherLoop = () => {
  if (!deviceWatcherTimer) return;
  clearInterval(deviceWatcherTimer);
  deviceWatcherTimer = null;
};

const stopWinnerWatcherLoop = () => {
  if (!winnerWatcherTimer) return;
  clearInterval(winnerWatcherTimer);
  winnerWatcherTimer = null;
};

const clickerIsStopped = (): boolean => !scanner?.state.autoClicker.enabled && !scanner?.state.autoClicker.autoNavEnabled;

const applySelectedClickerProfile = (autoClicker: AppSnapshot["autoClicker"]): AppSnapshot["autoClicker"] => {
  const selectedProfile = autoClicker.selectedProfile;
  if (selectedProfile !== "2024" && selectedProfile !== "2025") {
    return {
      ...autoClicker,
      enabled: false,
      autoNavEnabled: false,
      targetX: 0,
      targetY: 0,
      intervalMs: 0,
      jitterMs: 0
    };
  }

  const profile = autoClicker.profiles[selectedProfile];
  return {
    ...autoClicker,
    targetX: profile.targetX,
    targetY: profile.targetY,
    intervalMs: profile.intervalMs,
    jitterMs: profile.jitterMs
  };
};

const hasSelectedClickerProfile = () =>
  scanner.state.autoClicker.selectedProfile === "2024" || scanner.state.autoClicker.selectedProfile === "2025";

const isKrakenOnlyClickerMode = (autoClicker = scanner.state.autoClicker): boolean => autoClicker.selectedProfile === "2024";

const isHomePackage = (packageName: string | null): boolean => {
  if (!packageName) return false;
  return /launcher|trebuchet|quickstep/i.test(packageName);
};

const activeTargetCard = (): StreamCard | null => {
  const activeSlot = scanner.state.autoClicker.activeSlot;
  if (activeSlot === null || activeSlot === undefined) return null;
  return scanner.state.cards.find((card) => card.slot === activeSlot && card.status === "live" && card.resolvedUrl) ?? null;
};

const bestWinnerContextCard = (): StreamCard | null =>
  activeTargetCard() ??
  scanner.state.cards.find((card) => card.status === "live" && card.giveawayName && card.resolvedUrl) ??
  scanner.state.cards.find((card) => card.status === "live" && card.resolvedUrl) ??
  null;

const appendActivityLog = (
  log: AppSnapshot["autoClicker"]["activityLog"],
  key: keyof AppSnapshot["autoClicker"]["activityLog"],
  text: string
): AppSnapshot["autoClicker"]["activityLog"] => {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return log;
  const current = log[key] ?? [];
  const nextEntry = { at: new Date().toISOString(), text: trimmed };
  const nextList = current[0]?.text === trimmed ? [nextEntry, ...current.slice(1)] : [nextEntry, ...current].slice(0, 8);
  return {
    ...log,
    [key]: nextList
  };
};

const updateTapHealth = async (patch: Partial<AppSnapshot["autoClicker"]["adbHealth"]>, action?: string): Promise<void> => {
  let activityLog = scanner.state.autoClicker.activityLog;
  if (action) {
    activityLog = appendActivityLog(activityLog, "currentTask", action);
  }
  if (
    patch.lastTapOk === true &&
    patch.lastEnteredSlot !== null &&
    patch.lastEnteredSlot !== undefined &&
    patch.lastTapDevice !== "dry-run"
  ) {
    const card = scanner.state.cards.find((candidate) => candidate.slot === patch.lastEnteredSlot);
    activityLog = appendActivityLog(
      activityLog,
      "enteredGiveaway",
      `${card?.streamer ?? `Slot ${patch.lastEnteredSlot}`} ${patch.lastTapDevice ?? ""}`.trim()
    );
    const notifyKey = [
      patch.lastEnteredSlot,
      card?.streamUuid ?? "",
      card?.giveawayName ?? "",
      patch.lastTapDevice ?? ""
    ].join(":");
    if (notifyKey !== lastEnterNotificationKey) {
      lastEnterNotificationKey = notifyKey;
      void notifier?.sendAlert(
        "entry",
        card?.streamer ?? `slot ${patch.lastEnteredSlot}`,
        ["Entered giveaway", card?.giveawayName ?? "", `Tapped ${patch.lastTapDevice ?? "phones"}`].filter(Boolean).join("\n")
      );
    }
  }
  await scanner.setState({
    ...scanner.state,
    autoClicker: {
      ...scanner.state.autoClicker,
      lastAction: action ?? scanner.state.autoClicker.lastAction,
      lastActionAt: action ? new Date().toISOString() : scanner.state.autoClicker.lastActionAt,
      activityLog,
      adbHealth: {
        ...scanner.state.autoClicker.adbHealth,
        ...patch
      }
    }
  }).catch((error) => debugLog("tap health update failed", error));
};

const tapConnectedDevices = async (
  devices: AdbDevice[],
  targetX: number,
  targetY: number,
  context: string
): Promise<Array<{ deviceId: string; ok: true } | { deviceId: string; ok: false; message: string }>> => {
  const results: Array<{ deviceId: string; ok: true } | { deviceId: string; ok: false; message: string }> = [];
  const batchSize = 4;

  for (let index = 0; index < devices.length; index += batchSize) {
    const batch = devices.slice(index, index + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (device) => {
        try {
          await adb.tap(device.id, targetX, targetY);
          await debugLog(`${context} coord tapped device=${device.id} x=${targetX} y=${targetY}`);
          return { deviceId: device.id, ok: true as const };
        } catch (firstError) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          try {
            await adb.tap(device.id, targetX, targetY);
            await debugLog(`${context} coord tapped device=${device.id} x=${targetX} y=${targetY} retry=1`);
            return { deviceId: device.id, ok: true as const };
          } catch (secondError) {
            const message = secondError instanceof Error ? secondError.message : String(secondError);
            await debugLog(
              `${context} coord tap failed device=${device.id} x=${targetX} y=${targetY}: ${
                firstError instanceof Error ? firstError.message : String(firstError)
              } / ${message}`
            );
            return { deviceId: device.id, ok: false as const, message };
          }
        }
      })
    );
    results.push(...batchResults);
    if (index + batchSize < devices.length) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  return results;
};

const routeConnectedDevices = async (
  devices: AdbDevice[],
  url: string,
  context: string
): Promise<Array<{ deviceId: string; ok: true } | { deviceId: string; ok: false; message: string }>> => {
  const results: Array<{ deviceId: string; ok: true } | { deviceId: string; ok: false; message: string }> = [];
  for (let index = 0; index < devices.length; index += routeBatchSize) {
    const batch = devices.slice(index, index + routeBatchSize);
    const batchResults = await Promise.all(
      batch.map(async (device) => {
        try {
          await adb.openUrl(device.id, url);
          await debugLog(`${context} routed device=${device.id} url=${url}`);
          return { deviceId: device.id, ok: true as const };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await debugLog(`${context} route failed device=${device.id} url=${url}: ${message}`);
          return { deviceId: device.id, ok: false as const, message };
        }
      })
    );
    results.push(...batchResults);
    if (index + routeBatchSize < devices.length) {
      await new Promise((resolve) => setTimeout(resolve, routeBatchDelayMs));
    }
  }
  return results;
};

const shutdownRuntime = async (reason: string): Promise<void> => {
  if (shutdownStarted) return;
  shutdownStarted = true;
  stopAutoClickerLoop();
  stopAutoClickerWatchdogLoop();
  stopDeviceWatcherLoop();
  stopWinnerWatcherLoop();
  autoUpdater?.stop();
  await debugLog(`runtime shutdown: ${reason}`);

  if (scanner) {
    scanner.stop();
    await scanner.setState({
      ...scanner.state,
      autoClicker: {
        ...scanner.state.autoClicker,
        enabled: false
      }
    }).catch((error) => debugLog("runtime shutdown state save failed", error));
  }

  await browserService?.close().catch((error) => debugLog("runtime shutdown browser close failed", error));
  await adb?.killServer().catch((error) => debugLog("runtime shutdown adb kill-server failed", error));
};

const startAutoClickerLoop = () => {
  stopAutoClickerLoop();
  const nextClickDelayMs = () => {
    return Math.max(100, scanner.state.autoClicker.intervalMs || 1000);
  };

  const runClick = async () => {
    if (!scanner.state.autoClicker.enabled) {
      stopAutoClickerLoop();
      return;
    }
    if (!hasSelectedClickerProfile()) {
      await debugLog("autoclicker tick skipped: no clicker profile selected");
      stopAutoClickerLoop();
      await scanner.setState({
        ...scanner.state,
        autoClicker: {
          ...scanner.state.autoClicker,
          enabled: false,
          autoNavEnabled: false
        }
      });
      return;
    }

    const targetSlot = isKrakenOnlyClickerMode() ? KRAKEN_SLOT : scanner.state.autoClicker.activeSlot;
    const card =
      targetSlot === null
        ? null
        : scanner.state.cards.find((candidate) => candidate.slot === targetSlot && candidate.status === "live" && candidate.resolvedUrl);
    if (!card) {
      await debugLog(
        isKrakenOnlyClickerMode()
          ? "autoclicker tick skipped: KrakenHits is not live/resolved for 2024 coord-only mode"
          : "autoclicker tick skipped: no scored active stream target"
      );
      autoClickerTimer = setTimeout(runClick, nextClickDelayMs());
      return;
    }
    if (!scanner.state.autoClicker.intervalMs || scanner.state.autoClicker.targetX <= 0 || scanner.state.autoClicker.targetY <= 0) {
      await debugLog("autoclicker tick skipped: clicker settings are not saved");
      autoClickerTimer = setTimeout(runClick, nextClickDelayMs());
      return;
    }
    const freshDevices = await adb.listDevices(scanner.state.devices);
    const devices = freshDevices.filter((device) => device.status === "connected");

    if (!devices.length) {
      await debugLog("autoclicker tick skipped: no connected devices");
      await updateTapHealth({ lastTapOk: false, lastError: "No connected devices" });
    } else if (scanner.state.autoClicker.dryRun) {
      await debugLog(`autoclicker dry run skipped tap x=${scanner.state.autoClicker.targetX} y=${scanner.state.autoClicker.targetY} devices=${devices.length}`);
      await updateTapHealth({ lastTapAt: new Date().toISOString(), lastTapDevice: "dry-run", lastEnteredSlot: card.slot, lastTapOk: true, lastError: null }, "Dry run tap skipped");
    } else {
      const targetX = scanner.state.autoClicker.targetX;
      const targetY = scanner.state.autoClicker.targetY;
      await debugLog(
        `autoclicker coord tap x=${targetX} y=${targetY} slot=${card?.slot ?? "none"} streamer=${card?.streamer ?? ""} devices=${devices.length}`
      );
      const settled = await tapConnectedDevices(
        devices,
        targetX,
        targetY,
        `autoclicker slot=${card?.slot ?? "none"} streamer=${card?.streamer ?? ""}`
      );
      const okCount = settled.filter((result) => result.ok).length;
      const failed = settled.find((result) => !result.ok);
      await updateTapHealth(
        {
          lastTapAt: new Date().toISOString(),
          lastTapDevice: `${okCount}/${devices.length}`,
          lastEnteredSlot: card.slot,
          lastTapOk: okCount === devices.length,
          lastError: failed ? `${devices.length - okCount} tap failed: ${failed.message}` : null
        },
        `Tapped ${okCount}/${devices.length}`
      );
    }

    autoClickerTimer = setTimeout(runClick, nextClickDelayMs());
  };

  autoClickerTimer = setTimeout(runClick, nextClickDelayMs());
};

const startAutoClickerWatchdogLoop = () => {
  stopAutoClickerWatchdogLoop();
  autoClickerWatchdogTimer = setInterval(() => {
    if (shutdownStarted) return;
    if (autoClickerTimer) return;
    if (!scanner.state.autoClicker.enabled) return;
    if (!hasSelectedClickerProfile()) return;
    void debugLog("autoclicker watchdog restarted missing tap timer");
    startAutoClickerLoop();
  }, 2_000);
};

const startDeviceWatcherLoop = () => {
  stopDeviceWatcherLoop();

  const watcherTick = async () => {
    if (deviceWatcherRunning || shutdownStarted) return;
    if (!scanner.state.autoClicker.enabled || !scanner.state.autoClicker.autoNavEnabled) return;
    if (scanner.state.autoClicker.dryRun) return;
    deviceWatcherRunning = true;

    try {
      const freshDevices = await adb.listDevices(scanner.state.devices);
      const connectedDevices = freshDevices.filter((device) => device.status === "connected");
      const target = activeTargetCard();

      await Promise.allSettled(
        connectedDevices.map(async (device) => {
          const foregroundPackage = await adb.getForegroundPackage(device.id).catch(() => null);

          if (target?.resolvedUrl) {
            if (foregroundPackage === whatnotPackage) return;
            await adb.openUrl(device.id, target.resolvedUrl);
            await debugLog(
              `device watcher redirected device=${device.id} target=${target.streamer} previousForeground=${foregroundPackage ?? "unknown"}`
            );
            return;
          }

          if (foregroundPackage === whatnotPackage) {
            await adb.parkWhatnotOnHome(device.id, scanner.state.autoClicker.selectedProfile);
            await debugLog(`device watcher parked Whatnot device=${device.id}`);
            return;
          }

          if (!isHomePackage(foregroundPackage)) {
            await adb.goHome(device.id);
            await debugLog(`device watcher sent Home device=${device.id} previousForeground=${foregroundPackage ?? "unknown"}`);
          }
        })
      );
    } catch (error) {
      await debugLog("device watcher tick failed", error);
    } finally {
      deviceWatcherRunning = false;
    }
  };

  deviceWatcherTimer = setInterval(() => void watcherTick(), 10_000);
  void watcherTick();
};

const startWinnerWatcherLoop = () => {
  stopWinnerWatcherLoop();

  const pruneWinnerNotifications = () => {
    const now = Date.now();
    for (const [key, seenAt] of winnerNotificationSeen.entries()) {
      if (now - seenAt > winnerNotificationTtlMs) winnerNotificationSeen.delete(key);
    }
  };

  const watcherTick = async () => {
    if (winnerWatcherRunning || shutdownStarted) return;
    if (!scanner.state.autoClicker.enabled || !scanner.state.autoClicker.autoNavEnabled) return;
    if (scanner.state.autoClicker.dryRun) return;
    winnerWatcherRunning = true;

    try {
      pruneWinnerNotifications();
      const card = bestWinnerContextCard();
      const freshDevices = await adb.listDevices(scanner.state.devices);
      const connectedDevices = freshDevices.filter((device) => device.status === "connected");
      const batchSize = 4;
      const wins: string[] = [];

      for (let index = 0; index < connectedDevices.length; index += batchSize) {
        const batch = connectedDevices.slice(index, index + batchSize);
        const batchResults = await Promise.allSettled(
          batch.map(async (device) => {
            const result = await adb.isWinnerPopupVisible(device.id);
            return { device, result };
          })
        );

        for (const settled of batchResults) {
          if (settled.status !== "fulfilled") continue;
          const { device, result } = settled.value;
          if (!result.visible) continue;

          const streamer = card?.streamer ?? "Unknown stream";
          const giveawayName = card?.giveawayName ?? card?.title ?? "Unknown giveaway";
          const winnerKey = [device.id, card?.streamUuid ?? "", streamer, giveawayName].join(":");
          if (winnerNotificationSeen.has(winnerKey)) continue;
          winnerNotificationSeen.set(winnerKey, Date.now());

          const message = `WIN: ${streamer} - ${giveawayName} on ${device.label || device.id}`;
          wins.push(message);
          await debugLog(`winner popup detected device=${device.id} streamer=${streamer} giveaway=${giveawayName} detail=${result.detail}`);
          void notifier?.sendAlert("win", streamer, giveawayName);
        }

        if (index + batchSize < connectedDevices.length) {
          await new Promise((resolve) => setTimeout(resolve, 80));
        }
      }

      if (wins.length) {
        let activityLog = scanner.state.autoClicker.activityLog;
        for (const win of wins) {
          activityLog = appendActivityLog(activityLog, "enteredGiveaway", win);
          activityLog = appendActivityLog(activityLog, "currentTask", win);
        }
        await scanner.setState({
          ...scanner.state,
          autoClicker: {
            ...scanner.state.autoClicker,
            activityLog,
            lastAction: wins[0],
            lastActionAt: new Date().toISOString()
          }
        });
      }
    } catch (error) {
      await debugLog("winner watcher tick failed", error);
    } finally {
      winnerWatcherRunning = false;
    }
  };

  winnerWatcherTimer = setInterval(() => void watcherTick(), 2_500);
};

const tapActiveCardOnce = async (reason: string): Promise<void> => {
  const card =
    scanner.state.cards.find((candidate) => candidate.slot === scanner.state.autoClicker.activeSlot) ??
    scanner.state.cards.find((candidate) => candidate.status === "live" && candidate.resolvedUrl) ??
    scanner.state.cards.find((candidate) => candidate.streamer.trim());
  const freshDevices = await adb.listDevices(scanner.state.devices);
  const devices = freshDevices.filter((device) => device.status === "connected");

  if (!devices.length) {
    await debugLog(`${reason} coord tap skipped: no connected devices`);
    return;
  }

  const targetX = scanner.state.autoClicker.targetX;
  const targetY = scanner.state.autoClicker.targetY;
  await tapConnectedDevices(devices, targetX, targetY, `${reason} slot=${card?.slot ?? "none"} streamer=${card?.streamer ?? ""}`);
};

app.whenReady().then(async () => {
  const store = new ConfigStore();
  snapshot = await store.load();
  adb = new AdbService();
  notifier = new NotificationService(debugLog, await readLocalDiscordWebhook(store.appDataDir));
  browserService = new BrowserService(store.browserProfilePath);
  browserService.setAuthenticated(snapshot.browser.authenticated);
  browserService.setLogger((message) => void debugLog(`browserService: ${message}`));
  browserService.setStreamPreviewSink((streamId, imageDataUrl) => {
    scanner?.applyStreamPreviewFrame(streamId, imageDataUrl);
    mainWindow?.webContents.send("stream-preview-frame", { streamId, imageDataUrl });
  });
  const resolver = new WhatnotResolver();
  scanner = new Scanner(snapshot, adb, browserService, resolver, store, () => mainWindow, (notification) =>
    notifier.sendAlert(notification.kind, notification.streamer, notification.detail)
  );
  autoUpdater = new AutoUpdaterService({
    userDataPath: store.appDataDir,
    currentVersion: app.getVersion(),
    logger: debugLog,
    canInstall: clickerIsStopped,
    onStatus: async (message) => {
      await scanner.setState({
        ...scanner.state,
        autoClicker: {
          ...scanner.state.autoClicker,
          activityLog: appendActivityLog(scanner.state.autoClicker.activityLog, "currentTask", `UPDATE: ${message}`),
          lastAction: message,
          lastActionAt: new Date().toISOString()
        }
      });
    },
    onBeforeInstall: async (installerPath, manifest) => {
      await scanner.setState({
        ...scanner.state,
        autoClicker: {
          ...scanner.state.autoClicker,
          enabled: false,
          autoNavEnabled: false,
          runtimeState: "OFF",
          runtimeDetail: `Installing update ${manifest.version}`,
          activityLog: appendActivityLog(scanner.state.autoClicker.activityLog, "currentTask", `UPDATE: installing ${manifest.version}`),
          lastAction: `Installing update ${manifest.version}`,
          lastActionAt: new Date().toISOString()
        }
      });
      await shutdownRuntime(`auto-update ${manifest.version} ${installerPath}`);
    },
    quit: () => app.quit()
  });
  browserService.setGiveawayStateSink((streamId, state) => scanner.applyGiveawayState(streamId, state));
  globalShortcut.register("CommandOrControl+Shift+S", () => {
    void (async () => {
      stopAutoClickerLoop();
      await debugLog("emergency stop via shortcut");
      await scanner.setState({
        ...scanner.state,
        autoClicker: {
          ...scanner.state.autoClicker,
          enabled: false,
          autoNavEnabled: false,
          activeSlot: null,
          runtimeState: "OFF",
          runtimeDetail: "Emergency stop",
          lastAction: "Emergency stop",
          lastActionAt: new Date().toISOString()
        }
      });
    })();
  });

  ipcMain.handle("snapshot:get", () => scanner.state);
  ipcMain.handle("app:minimize", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("browser:launch", async () => {
    await debugLog("browser:launch clicked");
    await scanner.setState({
      ...scanner.state,
      browser: {
        ...scanner.state.browser,
        launchStatus: "launching",
        launchError: null
      }
    });

    try {
      const authenticated = await browserService.launch();
      await debugLog(`browser:launch success authenticated=${authenticated} currentUrl=${browserService.currentUrl ?? ""}`);
      await scanner.setState({
        ...scanner.state,
        browser: {
          ...scanner.state.browser,
          launched: browserService.launched,
          authenticated,
          currentUrl: browserService.currentUrl,
          launchStatus: browserService.isAuthorizationInProgress ? "launching" : "open",
          launchError: browserService.isAuthorizationInProgress ? "Close login window when done" : null
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await debugLog("browser:launch failed", error);
      await scanner.setState({
        ...scanner.state,
        browser: {
          ...scanner.state.browser,
          launched: browserService.launched,
          currentUrl: browserService.currentUrl,
          launchStatus: "error",
          launchError: message
        }
      });
    }
    return scanner.state;
  });
  ipcMain.handle("card:update", async (_event, slot: number, patch: Partial<StreamCard> & { forgetStreamer?: boolean }) => {
    if (slot === 0 || slot === 1) return scanner.state;
    const { forgetStreamer, ...cardPatch } = patch;
    await scanner.setState({
      ...scanner.state,
      cards: scanner.state.cards.map((card) => (card.slot === slot ? { ...card, ...cardPatch } : card))
    }, {
      persistLockedStreamers: true,
      allowStreamerClear: forgetStreamer === true
    });
    return scanner.state;
  });
  ipcMain.handle("autoclicker:update", async (_event, patch) => {
    let nextAutoClicker = applySelectedClickerProfile({ ...scanner.state.autoClicker, ...patch });
    if (patch?.selectedProfile === "2024" || patch?.selectedProfile === "2025") {
      nextAutoClicker.enabled = true;
      nextAutoClicker.autoNavEnabled = patch.selectedProfile === "2025";
      nextAutoClicker.activeSlot = patch.selectedProfile === "2024" ? KRAKEN_SLOT : nextAutoClicker.activeSlot;
    }
    if (patch?.autoNavEnabled === true) nextAutoClicker.enabled = true;
    if (patch?.autoNavEnabled === false && patch?.enabled === undefined) nextAutoClicker.enabled = false;
    if (patch?.enabled === true) {
      nextAutoClicker.autoNavEnabled = nextAutoClicker.selectedProfile === "2025";
      nextAutoClicker.activeSlot = nextAutoClicker.selectedProfile === "2024" ? KRAKEN_SLOT : nextAutoClicker.activeSlot;
    }
    nextAutoClicker = applySelectedClickerProfile(nextAutoClicker);
    if (nextAutoClicker.selectedProfile === "2024") {
      nextAutoClicker = {
        ...nextAutoClicker,
        autoNavEnabled: false,
        activeSlot: KRAKEN_SLOT
      };
    }
    await scanner.setState({
      ...scanner.state,
      autoClicker: nextAutoClicker
    });
    if (patch?.enabled === true || patch?.autoNavEnabled === true) {
      if (!hasSelectedClickerProfile()) {
        await debugLog("autoclicker start blocked: no clicker profile selected");
        return scanner.state;
      }
      await debugLog(`autoclicker start activeSlot=${scanner.state.autoClicker.activeSlot ?? "auto"}`);
      startAutoClickerLoop();
    }
    if (patch?.enabled === false || patch?.autoNavEnabled === false) {
      await debugLog("autoclicker stop");
      stopAutoClickerLoop();
    }
    return scanner.state;
  });
  ipcMain.handle("keyword-scoring:update", async (_event, rules) => {
    await scanner.setState({
      ...scanner.state,
      keywordScoring: {
        rules: Array.isArray(rules) ? rules : scanner.state.keywordScoring.rules
      }
    }, {
      persistKeywordRules: true
    });
    return scanner.state;
  });
  ipcMain.handle("card:send-to-devices", async (_event, slot: number) => {
    if (!scanner.state.autoClicker.enabled) return scanner.state;
    const card = scanner.state.cards.find((candidate) => candidate.slot === slot);
    const freshDevices = await adb.listDevices(scanner.state.devices);
    const devices = freshDevices.filter((device) => device.status === "connected");
    if (card?.resolvedUrl) {
      await scanner.setState({
        ...scanner.state,
        autoClicker: {
          ...scanner.state.autoClicker,
          activeSlot: slot,
          lastAction: scanner.state.autoClicker.dryRun ? `Dry run send ${card.streamer}` : `Manual send ${card.streamer}`,
          lastActionAt: new Date().toISOString()
        }
      });
      await debugLog(`card:send-to-devices slot=${slot} streamer=${card.streamer} url=${card.resolvedUrl} devices=${devices.length}`);
      if (scanner.state.autoClicker.dryRun) return scanner.state;
      const routeResults = await routeConnectedDevices(devices, card.resolvedUrl, `card:send slot=${slot} streamer=${card.streamer}`);
      const routedCount = routeResults.filter((result) => result.ok).length;
      void notifier?.sendAlert(
        "navigation",
        card.streamer,
        [`Manual navigation`, `Routed ${routedCount}/${devices.length} phones`, card.giveawayName ?? ""].filter(Boolean).join("\n")
      );
      await new Promise((resolve) => setTimeout(resolve, 750));
      const targetX = scanner.state.autoClicker.targetX;
      const targetY = scanner.state.autoClicker.targetY;
      const settled = await tapConnectedDevices(
        devices,
        targetX,
        targetY,
        `card:send initial slot=${slot} streamer=${card.streamer}`
      );
      const okCount = settled.filter((result) => result.ok).length;
      const failed = settled.find((result) => !result.ok);
      await updateTapHealth(
        {
          lastTapAt: new Date().toISOString(),
          lastTapDevice: `${okCount}/${devices.length}`,
          lastEnteredSlot: slot,
          lastTapOk: okCount === devices.length,
          lastError: failed ? `${devices.length - okCount} tap failed: ${failed.message}` : null
        },
        `Tapped ${okCount}/${devices.length}`
      );
    }
    return scanner.state;
  });

  await createWindow();
  scanner.start();
  startAutoClickerWatchdogLoop();
  startDeviceWatcherLoop();
  startWinnerWatcherLoop();
  autoUpdater.start();
  if (hasSelectedClickerProfile()) {
    const nextAutoClicker = applySelectedClickerProfile({
      ...scanner.state.autoClicker,
      enabled: true,
      autoNavEnabled: scanner.state.autoClicker.selectedProfile === "2025",
      activeSlot: scanner.state.autoClicker.selectedProfile === "2024" ? KRAKEN_SLOT : scanner.state.autoClicker.activeSlot
    });
    await scanner.setState({
      ...scanner.state,
      autoClicker: nextAutoClicker
    });
    await debugLog(`autoclicker start activeSlot=${scanner.state.autoClicker.activeSlot ?? "auto"} source=profile`);
    startAutoClickerLoop();
  }
  if (process.env.NILBOG_AUTOPILOT_ONCE === "1") {
    const nextAutoClicker = applySelectedClickerProfile({
      ...scanner.state.autoClicker,
      enabled: true,
      autoNavEnabled: scanner.state.autoClicker.selectedProfile === "2025",
      activeSlot: scanner.state.autoClicker.selectedProfile === "2024" ? KRAKEN_SLOT : scanner.state.autoClicker.activeSlot
    });
    await scanner.setState({
      ...scanner.state,
      autoClicker: nextAutoClicker
    });
    if (hasSelectedClickerProfile()) {
      await debugLog(`autoclicker start activeSlot=${scanner.state.autoClicker.activeSlot ?? "auto"} source=env`);
      startAutoClickerLoop();
    } else {
      await debugLog("autoclicker env start blocked: no clicker profile selected");
    }
  }
  void (async () => {
    await scanner.setState({
      ...scanner.state,
      browser: {
        ...scanner.state.browser,
        launchStatus: "launching",
        launchError: null
      }
    });
    try {
      const authenticated = await browserService.launch();
      await scanner.setState({
        ...scanner.state,
        browser: {
          ...scanner.state.browser,
          launched: browserService.launched,
          authenticated,
          currentUrl: browserService.currentUrl,
          launchStatus: browserService.isFeedBlocked ? "error" : "open",
          launchError: browserService.isFeedBlocked ? "Sign in to Whatnot in Chrome first." : null
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await debugLog("browser:auto-launch failed", error);
      await scanner.setState({
        ...scanner.state,
        browser: {
          ...scanner.state.browser,
          launched: browserService.launched,
          currentUrl: browserService.currentUrl,
          launchStatus: "error",
          launchError: message
        }
      });
    }
  })();
});

app.on("before-quit", (event) => {
  if (shutdownStarted) return;
  event.preventDefault();
  void shutdownRuntime("before-quit").finally(() => app.quit());
});

app.on("window-all-closed", () => {
  void shutdownRuntime("window-all-closed");
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});
