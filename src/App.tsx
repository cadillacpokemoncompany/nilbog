import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Download, Pause, Play } from "lucide-react";
import { createDefaultKeywordRules, type AppSnapshot, type StreamCard } from "../electron/types";
import { nilbogApi } from "./nilbogApi";
import "./styles/app.css";

const focusStreamers = ["KrakenDrips", "KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "TraderBea", "VendturesVault", "Woosleys"];
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
    activeDeviceProfile: "2025",
    profiles: { "2024": { targetX: 580, targetY: 305, intervalMs: 3000 }, "2025": { targetX: 580, targetY: 280, intervalMs: 3000 } },
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
  const [clickerDrafts, setClickerDrafts] = useState({
    "2024": { x: "580", y: "305", sec: "3" },
    "2025": { x: "580", y: "280", sec: "3" }
  });
  useEffect(() => {
    void nilbogApi.getSnapshot().then(setSnapshot);
    return nilbogApi.onSnapshot(setSnapshot);
  }, []);
  useEffect(() => {
    setClickerDrafts({
      "2024": { x: String(snapshot.autoClicker.profiles["2024"].targetX), y: String(snapshot.autoClicker.profiles["2024"].targetY), sec: String(snapshot.autoClicker.profiles["2024"].intervalMs / 1000) },
      "2025": { x: String(snapshot.autoClicker.profiles["2025"].targetX), y: String(snapshot.autoClicker.profiles["2025"].targetY), sec: String(snapshot.autoClicker.profiles["2025"].intervalMs / 1000) }
    });
  }, [snapshot.autoClicker.profiles]);
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
  const updateHealth = snapshot.autoClicker.updateHealth;
  const updateReady = ["available", "downloaded", "pending"].includes(updateHealth.status);
  const updateBusy = ["checking", "installing"].includes(updateHealth.status);
  const updateLabel =
    updateHealth.status === "current"
      ? `Current ${updateHealth.currentVersion}`
      : updateReady
        ? `Update ${updateHealth.latestVersion ?? ""}`.trim()
        : updateHealth.status === "error"
          ? "Update error"
          : updateBusy
            ? updateHealth.status
            : "No update";
  const requestUpdateInstall = () => {
    void nilbogApi.installLatestUpdate().then(setSnapshot);
  };
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
  const profileDraftToSettings = (profile: "2024" | "2025") => {
    const draft = clickerDrafts[profile];
    const targetX = Number(draft.x);
    const targetY = Number(draft.y);
    const seconds = Number(draft.sec);
    const intervalMs = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
    return {
      targetX: Number.isFinite(targetX) ? targetX : 0,
      targetY: Number.isFinite(targetY) ? targetY : 0,
      intervalMs,
      jitterMs: 0
    };
  };
  const saveClickerSettings = (profile: "2024" | "2025") => {
    const settings = profileDraftToSettings(profile);
    updateAutoClicker({ profiles: { ...snapshot.autoClicker.profiles, [profile]: settings }, ...(snapshot.autoClicker.activeDeviceProfile === profile ? settings : {}) });
  };
  const updateClickerDraft = (profile: "2024" | "2025", key: "x" | "y" | "sec", value: string) => {
    setClickerDrafts((current) => ({
      ...current,
      [profile]: { ...current[profile], [key]: value }
    }));
  };
  const selectClickerProfile = (profile: "2024" | "2025") => {
    const settings = profileDraftToSettings(profile);
    updateAutoClicker({ activeDeviceProfile: profile, profiles: { ...snapshot.autoClicker.profiles, [profile]: settings }, ...settings });
  };
  const activeCard = snapshot.autoClicker.activeSlot === null ? null : displayCards.find((card) => card.slot === snapshot.autoClicker.activeSlot) ?? null;
  const latestTask = snapshot.autoClicker.activityLog.currentTask[0];

  return (
    <main className="app-shell">
      <section className="deck">
        <aside className="control-tile">
          <div className={`update-panel ${updateReady ? "is-ready" : ""} ${updateHealth.status === "error" ? "is-error" : ""}`}>
            <div className="update-copy">
              <span>Updates</span>
              <strong>{updateLabel}</strong>
            </div>
            <button
              className="update-button"
              disabled={updateBusy || updateHealth.status === "current"}
              onClick={requestUpdateInstall}
              title="Stop everything and update"
            >
              <Download size={12} />
            </button>
          </div>

          <div className="clicker-profile-stack">
            {(["2024", "2025"] as const).map((profile) => (
              <div className="clicker-profile-column" key={profile}>
                <button className={`profile-toggle ${snapshot.autoClicker.activeDeviceProfile === profile ? "is-active" : ""}`} onClick={() => selectClickerProfile(profile)}>{profile}</button>
                <input inputMode="numeric" value={clickerDrafts[profile].x} onBlur={() => saveClickerSettings(profile)} onChange={(event) => updateClickerDraft(profile, "x", event.target.value)} />
                <input inputMode="numeric" value={clickerDrafts[profile].y} onBlur={() => saveClickerSettings(profile)} onChange={(event) => updateClickerDraft(profile, "y", event.target.value)} />
                <input inputMode="decimal" value={clickerDrafts[profile].sec} onBlur={() => saveClickerSettings(profile)} onChange={(event) => updateClickerDraft(profile, "sec", event.target.value)} />
              </div>
            ))}
          </div>

          <h1 className="clicker-control-title">Clicker Control</h1>
          <div className="autoclicker-actions">
            <button
              className="auto-button start-button"
              disabled={clickerRunning || !hasClickerSettings}
              onClick={() => updateAutoClicker({ ...profileDraftToSettings(snapshot.autoClicker.activeDeviceProfile), enabled: true, autoNavEnabled: true })}
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

        <article className={`status-tile app-status-card ${clickerRunning ? "is-running" : "is-stopped"}`}>
          <header className="app-status-head"><span>APP STATUS</span><strong>{snapshot.autoClicker.runtimeState.replaceAll("_", " ")}</strong></header>
          <div className="app-status-grid">
            <div><span>CURRENT TASK</span><strong title={latestTask?.text ?? snapshot.autoClicker.lastAction ?? "Waiting"}>{latestTask?.text ?? snapshot.autoClicker.lastAction ?? "WAITING"}</strong></div>
            <div><span>TARGET</span><strong title={activeCard?.giveawayName ?? "No active target"}>{activeCard ? `${activeCard.streamer}: ${activeCard.giveawayName ?? "MONITORING"}` : "NO ACTIVE TARGET"}</strong></div>
            <div><span>DEVICES</span><strong>{`${snapshot.autoClicker.adbHealth.connected} CONNECTED`}</strong></div>
            <div><span>LATEST SCAN</span><strong>{snapshot.scanner.lastTickAt ? formatLogTime(snapshot.scanner.lastTickAt) : "WAITING"}</strong></div>
          </div>
        </article>

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
                  <div className="stream-winner" title={card.lastWonItem ?? "No winner recorded"}>
                    <span>LAST WINNER</span>
                    <strong>{card.lastWinner ? card.lastWinner.toUpperCase() : "WAITING"}</strong>
                    <em>{card.lastWonItem ? card.lastWonItem.toUpperCase() : "NO WINNER RECORDED"}</em>
                  </div>
                </div>
          </article>
          );
        })}

      </section>
    </main>
  );
}
