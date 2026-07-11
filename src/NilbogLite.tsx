import { useEffect, useMemo, useState, type CSSProperties, type PointerEvent } from "react";
import { ArrowRight, Check, Navigation, Pause, Play, RefreshCw, Settings, Trash2 } from "lucide-react";
import { createDefaultKeywordRules, type AppSnapshot, type StreamCard } from "../electron/types";
import { isElectronApiAvailable, nilbogApi } from "./nilbogApi";
import "./styles/app.css";

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

const ensureTenCards = (cards: StreamCard[]): StreamCard[] => {
  const bySlot = new Map(cards.map((card) => [card.slot, card]));
  return ["KrakenHits", "NovaTCG", "RosesCloset", "SpaceNarwhalz", "VendturesVault", "WestCoastCards", "Woosleys"].map((streamer, slot) => ({
    slot,
    streamer,
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
    ...bySlot.get(slot)
  }));
};

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>(emptySnapshot);
  const [editingSlot, setEditingSlot] = useState<number | null>(null);
  const [draftStreamer, setDraftStreamer] = useState("");
  const [draftClickX, setDraftClickX] = useState("540");
  const [draftClickY, setDraftClickY] = useState("1920");
  const [draftClickSec, setDraftClickSec] = useState("1.3");

  useEffect(() => {
    void nilbogApi.getSnapshot().then(setSnapshot);
    return nilbogApi.onSnapshot(setSnapshot);
  }, []);

  const displayCards = useMemo(() => ensureTenCards(snapshot.cards), [snapshot.cards]);

  const updateAutoClicker = (patch: Partial<AppSnapshot["autoClicker"]>) => {
    void nilbogApi.updateAutoClicker(patch).then(setSnapshot);
  };
  const clickerRunning = snapshot.autoClicker.enabled || snapshot.autoClicker.autoNavEnabled;

  const updateCard = (slot: number, patch: Partial<StreamCard>) => {
    void nilbogApi.updateCard(slot, patch).then(setSnapshot);
  };

  const openChromiumAuth = () => {
    setSnapshot((current) => ({
      ...current,
      browser: {
        ...current.browser,
        launchStatus: isElectronApiAvailable ? "launching" : "error",
        launchError: isElectronApiAvailable ? null : "NO IPC"
      }
    }));
    if (!isElectronApiAvailable) return;
    void nilbogApi.launchBrowser().then(setSnapshot).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setSnapshot((current) => ({
        ...current,
        browser: {
          ...current.browser,
          launchStatus: "error",
          launchError: message
        }
      }));
    });
  };

  const handleBrowserAuthPointer = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openChromiumAuth();
  };

  const openCardSettings = (card: StreamCard) => {
    setEditingSlot(card.slot);
    setDraftStreamer(card.streamer);
    setDraftClickX(String(card.clickTargetX));
    setDraftClickY(String(card.clickTargetY));
    setDraftClickSec(String(Number((card.clickIntervalMs / 1000).toFixed(1))));
  };

  const saveCardSettings = () => {
    if (editingSlot === null) return;
    const streamer = draftStreamer.trim().replace(/^@/, "");
    const clickTargetX = Number(draftClickX);
    const clickTargetY = Number(draftClickY);
    const clickIntervalMs = Math.max(100, Number(draftClickSec) * 1000);
    updateCard(editingSlot, {
      streamer,
      clickTargetX: Number.isFinite(clickTargetX) ? clickTargetX : 540,
      clickTargetY: Number.isFinite(clickTargetY) ? clickTargetY : 1920,
      clickIntervalMs: Number.isFinite(clickIntervalMs) ? clickIntervalMs : 3000,
      status: streamer ? "resolving" : "empty",
      error: null
    });
    setEditingSlot(null);
  };

  const forgetCardSettings = () => {
    if (editingSlot === null) return;
    updateCard(editingSlot, {
      streamer: "",
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
      error: null,
      forgetStreamer: true
    } as Partial<StreamCard> & { forgetStreamer: true });
    setEditingSlot(null);
  };

  return (
    <main className="app-shell">
      <section className="deck">
        <aside className="control-tile">
          <div className="brand-row">
            <div>
              <h1>Clicker Control</h1>
            </div>
            <RefreshCw size={15} className={snapshot.scanner.running ? "spin-slow" : ""} />
          </div>

          <div className="control-spacer" />

          <div className="autoclicker-actions">
            <button
              className={`auto-button nav-button ${snapshot.autoClicker.autoNavEnabled ? "is-active" : ""}`}
              onClick={() => {
                const nextAuto = !snapshot.autoClicker.autoNavEnabled;
                updateAutoClicker({ autoNavEnabled: nextAuto, enabled: nextAuto });
              }}
              title="Auto send devices by card priority"
            >
              <Navigation size={14} />
            </button>
            <button
              className="auto-button start-button"
              disabled={clickerRunning}
              onClick={() => updateAutoClicker({ enabled: true, autoNavEnabled: false })}
              title="Start autoclicker"
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
          <article className={`stream-card ${card.status} ${editingSlot === card.slot ? "is-flipped" : ""}`} key={card.slot} style={cardStyle}>
            <div className="stream-card-media" />
            {editingSlot === card.slot ? (
              <div className="card-edit-face">
                <div className="card-head">
                  <span className="slot">Streamer</span>
                </div>

                <label className="field edit-field">
                  <span>Name</span>
                  <input
                    autoFocus
                    placeholder="seller_name"
                    value={draftStreamer}
                    onChange={(event) => setDraftStreamer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveCardSettings();
                      if (event.key === "Escape") setEditingSlot(null);
                    }}
                  />
                </label>

                <div className="coord-grid card-coord-grid">
                  <label className="field compact">
                    <input
                      type="number"
                      value={draftClickX}
                      onChange={(event) => setDraftClickX(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveCardSettings();
                        if (event.key === "Escape") setEditingSlot(null);
                      }}
                    />
                    <span>X</span>
                  </label>

                  <label className="field compact">
                    <input
                      type="number"
                      value={draftClickY}
                      onChange={(event) => setDraftClickY(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveCardSettings();
                        if (event.key === "Escape") setEditingSlot(null);
                      }}
                    />
                    <span>Y</span>
                  </label>

                  <label className="field compact">
                    <input
                      type="number"
                      min={0.1}
                      step={0.1}
                      value={draftClickSec}
                      onChange={(event) => setDraftClickSec(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveCardSettings();
                        if (event.key === "Escape") setEditingSlot(null);
                      }}
                    />
                    <span>SEC</span>
                  </label>
                </div>

                <div className="card-actions">
                  <button className="card-action forget-action" onClick={forgetCardSettings} title="Forget streamer">
                    <Trash2 size={14} />
                  </button>
                  <button className="card-action save-action" onClick={saveCardSettings} title="Save streamer">
                    <Check size={15} />
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="card-head">
                  <span className="slot">{card.streamer || "Empty"}</span>
                </div>

                <div className="card-body">
                  <div className="giveaway-info">
                    <strong>{(card.giveawayName || "Mystery Pack Giveaway").toUpperCase()}</strong>
                  </div>
                </div>

                <div className="card-actions">
                  <button className="card-action settings-action" onClick={() => openCardSettings(card)} title={`Edit card ${card.slot + 1}`}>
                    <Settings size={14} />
                  </button>
                  <button
                    className="card-action send-action"
                    disabled={!card.resolvedUrl}
                    onClick={() => nilbogApi.sendCardToDevices(card.slot).then(setSnapshot)}
                    title="Send devices"
                  >
                    <ArrowRight size={15} />
                  </button>
                </div>
              </>
            )}
          </article>
          );
        })}

        <article className="browser-tile" onPointerDown={handleBrowserAuthPointer}>
          <button
            className="browser-gear-button"
            onPointerDown={handleBrowserAuthPointer}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            title="Authorize Chromium"
          >
            <Settings size={14} />
          </button>
          <div className="browser-frame">
            {snapshot.browser.feedImageDataUrl ? (
              <img src={snapshot.browser.feedImageDataUrl} alt="Authenticated followed hosts browser feed" />
            ) : (
              <div className="browser-placeholder">
                {!isElectronApiAvailable && <span>NO IPC</span>}
                {snapshot.browser.launchStatus === "launching" && <span>OPENING</span>}
                {snapshot.browser.launchStatus === "error" && <span>{snapshot.browser.launchError || "BROWSER ERROR"}</span>}
              </div>
            )}
          </div>
        </article>
      </section>
    </main>
  );
}
