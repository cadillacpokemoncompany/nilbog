import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Pause, Play, RefreshCw } from "lucide-react";
import { createDefaultKeywordRules, type AppSnapshot, type StreamCard } from "../electron/types";
import { nilbogApi } from "./nilbogApi";
import "./styles/app.css";

const focusStreamers = ["KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "VendturesVault", "WestCoastCards", "Woosleys"];
const normalizeFocusStreamer = (value: string) => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

const emptySnapshot: AppSnapshot = {
  cards: [],
  devices: [],
  autoClicker: {
    enabled: false,
    autoNavEnabled: false,
    dryRun: false,
    intervalMs: 0,
    jitterMs: 0,
    targetX: 0,
    targetY: 0,
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
      connected: 0,
      unauthorized: 0,
      offline: 0,
      selectedConnected: 0,
      lastTapAt: null,
      lastTapDevice: null,
      lastEnteredSlot: null,
      lastTapOk: null,
      lastError: null
    },
    deviceRuntime: [],
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
    profilePath: "",
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
};

const ensureFocusCards = (cards: StreamCard[]): StreamCard[] => {
  const bySlot = new Map(cards.map((card) => [card.slot, card]));
  const byStreamer = new Map(cards.map((card) => [normalizeFocusStreamer(card.streamer), card]));
  return focusStreamers.map((streamer, slot) => {
    const savedBySlot = bySlot.get(slot);
    const saved =
      savedBySlot && normalizeFocusStreamer(savedBySlot.streamer) === normalizeFocusStreamer(streamer)
        ? savedBySlot
        : byStreamer.get(normalizeFocusStreamer(streamer));

    return {
      slot,
      clickTargetX: 0,
      clickTargetY: 0,
      clickIntervalMs: 0,
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
      error: null,
      ...saved,
      streamer
    };
  });
};

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [clickerDraft, setClickerDraft] = useState({ x: "580", y: "280", sec: "3" });
  useEffect(() => {
    void nilbogApi.getSnapshot().then(setSnapshot);
    return nilbogApi.onSnapshot(setSnapshot);
  }, []);
  useEffect(() => {
    setClickerDraft({
      x: String(snapshot.autoClicker.targetX || 580),
      y: String(snapshot.autoClicker.targetY || 280),
      sec: String(Number(((snapshot.autoClicker.intervalMs || 3000) / 1000).toFixed(1)))
    });
  }, [snapshot.autoClicker.targetX, snapshot.autoClicker.targetY, snapshot.autoClicker.intervalMs]);
  useEffect(() => {
    return nilbogApi.onStreamPreviewFrame((frame) => {
      setSnapshot((current) => ({
        ...current,
        cards: current.cards.map((card) =>
          card.streamUuid === frame.streamId ? { ...card, streamPreviewImageDataUrl: frame.imageDataUrl } : card
        )
      }));
    });
  }, []);

  const displayCards = useMemo(() => ensureFocusCards(snapshot.cards), [snapshot.cards]);
  const fixedRules = useMemo(() => createDefaultKeywordRules(), []);

  const updateAutoClicker = (patch: Partial<AppSnapshot["autoClicker"]>) => {
    void nilbogApi.updateAutoClicker(patch).then(setSnapshot);
  };
  const formatLogTime = (value: string) =>
    new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const renderLatestLogEntry = (entries: AppSnapshot["autoClicker"]["activityLog"]["currentTask"], emptyText: string) => {
    const entry = entries[0];
    if (!entry) return <em>{emptyText}</em>;
    return (
      <b className="status-latest-entry">
        <time>{formatLogTime(entry.at)}</time>
        <span>{entry.text}</span>
      </b>
    );
  };
  const clickerRunning = snapshot.autoClicker.enabled || snapshot.autoClicker.autoNavEnabled;
  const hasClickerSettings = snapshot.autoClicker.targetX > 0 && snapshot.autoClicker.targetY > 0 && snapshot.autoClicker.intervalMs > 0;
  const deviceRuntimeSummary = useMemo(() => {
    const runtime = snapshot.autoClicker.deviceRuntime;
    const ready = runtime.filter((device) => device.status === "connected" && device.phase !== "failed").length;
    const failed = runtime.filter((device) => device.phase === "failed" || Boolean(device.lastError)).length;
    const active = runtime.filter((device) => device.phase === "routing" || device.phase === "on_stream" || device.phase === "clicking").length;
    return { ready, failed, active };
  }, [snapshot.autoClicker.deviceRuntime]);
  const normalizeStreamer = (value: string) => value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const evaluateTitle = (streamer: string, title: string) => {
    const normalizedStreamer = normalizeStreamer(streamer);
    const normalizedTitle = title.toLowerCase();
    let best: { score: number; phrase: string; rule: number } | null = null;

    for (const rule of fixedRules) {
      const scope = rule.omitWords.replace(/^streamer:/i, "").trim();
      const scopes = scope
        .split(",")
        .map((entry) => normalizeStreamer(entry))
        .filter(Boolean);
      if (scopes.length && scope.toLowerCase() !== "any" && !scopes.includes(normalizedStreamer)) continue;
      const phrase = rule.words
        .split(",")
        .map((word) => word.trim().toLowerCase())
        .find((word) => word && normalizedTitle.includes(word));
      if (!phrase) continue;
      if (!best || rule.score > best.score) best = { score: rule.score, phrase, rule: rule.id };
    }

    return best;
  };
  const cardReasons = useMemo(
    () =>
      new Map(
        displayCards.map((card) => {
          const match = card.giveawayName ? evaluateTitle(card.streamer, card.giveawayName) : null;
          const reason =
            card.status !== "live"
              ? "OFFLINE"
              : !card.giveawayName
                ? "NO GIVEAWAY"
                : match
                  ? `MATCH +${match.score}`
                  : "NO MATCH";
          return [card.slot, reason];
        })
      ),
    [displayCards]
  );
  const draftToSettings = () => {
    const targetX = Number(clickerDraft.x);
    const targetY = Number(clickerDraft.y);
    const seconds = Number(clickerDraft.sec);
    const intervalMs = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
    return {
      targetX: Number.isFinite(targetX) ? targetX : 0,
      targetY: Number.isFinite(targetY) ? targetY : 0,
      intervalMs,
      jitterMs: 0
    };
  };
  const saveClickerSettings = () => {
    updateAutoClicker(draftToSettings());
  };
  const updateClickerDraft = (key: "x" | "y" | "sec", value: string) => {
    setClickerDraft((current) => ({
      ...current,
      [key]: value
    }));
  };

  return (
    <main className="app-shell">
      <section className="deck">
        <aside className="status-tile">
          <div className="brand-row">
            <div>
              <h1>App Status</h1>
            </div>
            <span className="connected-count">{snapshot.autoClicker.adbHealth.connected} connected</span>
          </div>

          <div className="status-card-grid">
            <section className="status-mini-card">
              <span>Scans</span>
              <strong>{snapshot.autoClicker.runtimeDetail || "Waiting for scanner"}</strong>
              <em>
                Last {snapshot.scanner.lastTickAt ? formatLogTime(snapshot.scanner.lastTickAt) : "Waiting"} | Next{" "}
                {snapshot.autoClicker.nextScanAt
                  ? formatLogTime(snapshot.autoClicker.nextScanAt)
                  : "Soon"}
              </em>
              <em>
                Update {snapshot.autoClicker.updateHealth.status}
                {snapshot.autoClicker.updateHealth.latestVersion ? ` ${snapshot.autoClicker.updateHealth.latestVersion}` : ""}
              </em>
            </section>

            <section className="status-mini-card">
              <span>Entered Stream</span>
              {renderLatestLogEntry(snapshot.autoClicker.activityLog.enteredStream, "No stream route yet")}
            </section>

            <section className="status-mini-card">
              <span>Entered Giveaway</span>
              {renderLatestLogEntry(snapshot.autoClicker.activityLog.enteredGiveaway, "No tap yet")}
            </section>

            <section className="status-mini-card">
              <span>Devices</span>
              <strong>
                {snapshot.autoClicker.adbHealth.connected} connected | {snapshot.autoClicker.adbHealth.selectedConnected} selected
              </strong>
              <em>
                {snapshot.autoClicker.adbHealth.unauthorized} unauthorized | {snapshot.autoClicker.adbHealth.offline} offline
              </em>
              <em>
                {deviceRuntimeSummary.active} active | {deviceRuntimeSummary.ready} ready | {deviceRuntimeSummary.failed} failed
              </em>
            </section>
          </div>
        </aside>

        <aside className="control-tile">
          <div className="brand-row">
            <div>
              <h1>Clicker Control</h1>
            </div>
          </div>

          <div className="clicker-profile-stack">
            <div className="clicker-profile-column is-single">
              <input
                inputMode="numeric"
                value={clickerDraft.x}
                onBlur={saveClickerSettings}
                onChange={(event) => updateClickerDraft("x", event.target.value)}
              />
              <input
                inputMode="numeric"
                value={clickerDraft.y}
                onBlur={saveClickerSettings}
                onChange={(event) => updateClickerDraft("y", event.target.value)}
              />
              <input
                inputMode="decimal"
                value={clickerDraft.sec}
                onBlur={saveClickerSettings}
                onChange={(event) => updateClickerDraft("sec", event.target.value)}
              />
            </div>
          </div>

          <button
            className="account-switch-button"
            onClick={() => nilbogApi.switchAccountsNext().then(setSnapshot)}
            title="Switch every connected phone to the next saved account slot"
          >
            <RefreshCw size={12} />
            NEXT ACCT
          </button>

          <div className="autoclicker-actions">
            <button
              className="auto-button start-button"
              disabled={clickerRunning || !hasClickerSettings}
              onClick={() => updateAutoClicker({ ...draftToSettings(), enabled: true, autoNavEnabled: true })}
              title="Start autoplay"
            >
              <Play size={14} />
            </button>
            <button
              className="auto-button stop-button"
              disabled={!clickerRunning}
              onClick={() => updateAutoClicker({ enabled: false, autoNavEnabled: false })}
              title="Stop autoclicker"
            >
              <Pause size={14} />
            </button>
          </div>
        </aside>

        {displayCards.map((card) => {
          const cardBackground = card.thumbnailImageDataUrl;
          const cardStyle = cardBackground
            ? ({
                "--card-background-image": `url("${cardBackground}")`
              } as CSSProperties)
            : undefined;

          return (
          <article className={`stream-card ${card.status}`} key={card.slot} style={cardStyle}>
            <div className="stream-card-media" />
            <div className="card-head">
              <span className="slot">{card.streamer}</span>
            </div>

                <div className="card-body">
                  <div className="giveaway-info">
                    <strong>{(card.giveawayName || "Waiting for info").toUpperCase()}</strong>
                    <span>{cardReasons.get(card.slot)}</span>
                  </div>
                </div>
          </article>
          );
        })}

      </section>
    </main>
  );
}
