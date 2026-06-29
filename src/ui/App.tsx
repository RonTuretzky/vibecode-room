import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { demoProjectorSnapshot, withUnmuted } from "./demo-data";
import type { LogEvent } from "../types";
import type { ProjectorProcess, ProjectorSnapshot, TranscriptLine } from "./types";
import { Atmosphere } from "./Atmosphere";
import { ProcessBubble, IdeaBubble } from "./Bubble";
import { BuildDetail } from "./BuildDetail";
import { traceClass, traceTag, summarizeMeta } from "./trace-utils";
import { startMicCapture, type MicCaptureHandle } from "./mic";

export const REQUIRED_PROJECTOR_REGIONS = [
  "status",
  "suggestion",
  "fleet",
  "audio",
  "transcript",
  "trace",
] as const;

interface ProjectorAppProps {
  initialSnapshot?: ProjectorSnapshot;
}

// The synthetic id used for the (single) idea/suggestion bubble.
const IDEA_ID = "idea";

declare global {
  interface Window {
    __VIBERSYN__?: {
      ready: boolean;
      getSnapshot: () => ProjectorSnapshot;
      applySnapshot: (snapshot: Partial<ProjectorSnapshot>) => void;
      select: (callsignOrUpid: string | null) => void;
      getSelected: () => string | null;
    };
  }
}

export function ProjectorApp({ initialSnapshot = demoProjectorSnapshot }: ProjectorAppProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selected, setSelected] = useState<string | null>(null);
  const [isUnmuting, setIsUnmuting] = useState(false);
  const [micState, setMicState] = useState<"off" | "connecting" | "live">("off");
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const micHandleRef = useRef<MicCaptureHandle | null>(null);

  // Whether this projector is bound to the LIVE runtime (vs. the static offline
  // demo). Mirrors the /api/state + SSE gate below: ?live=0 is always offline; in
  // DEV only ?live=1 opts in; in a built deployment live is the default. Click-to-
  // build / click-to-steer POST to the runtime only in live mode; in offline demo
  // they fall back to local selection so the static fixtures stay interactive.
  const liveMode = useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    const liveParam = new URLSearchParams(window.location.search).get("live");
    if (liveParam === "0") {
      return false;
    }
    if (import.meta.env.DEV && liveParam !== "1") {
      return false;
    }
    return true;
  }, []);

  // Latest snapshot exposed to the e2e window hook without re-binding it.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const gatePercent = useMemo(() => {
    const { gate } = snapshot.suggestion;
    const byWords = gate.minWords > 0 ? gate.words / gate.minWords : 0;
    const bySeconds = gate.minSeconds > 0 ? gate.seconds / gate.minSeconds : 0;
    return Math.min(100, Math.max(byWords, bySeconds) * 100);
  }, [snapshot.suggestion]);

  // Resolve the currently selected process from a callsign or UPID.
  const selectedProcess = useMemo<ProjectorProcess | null>(() => {
    if (selected === null || selected === IDEA_ID) {
      return null;
    }
    return (
      snapshot.processes.find(
        (process) => process.callsign === selected || process.upid === selected,
      ) ?? null
    );
  }, [selected, snapshot.processes]);

  const ideaSelected = selected === IDEA_ID;

  // Normalize any incoming selection id to its canonical callsign / IDEA_ID, or
  // null when it does not resolve to anything selectable.
  const resolveSelection = useCallback(
    (id: string | null): string | null => {
      if (id === null) {
        return null;
      }
      if (id === IDEA_ID) {
        return IDEA_ID;
      }
      const match = snapshotRef.current.processes.find(
        (process) => process.callsign === id || process.upid === id,
      );
      return match ? match.callsign : null;
    },
    [],
  );

  // Toggle selection: selecting the already-open bubble closes it.
  const selectBubble = useCallback(
    (id: string) => {
      const next = resolveSelection(id);
      setSelected((current) => (current !== null && current === next ? null : next));
    },
    [resolveSelection],
  );

  const closeDetail = useCallback(() => setSelected(null), []);

  // The current steering target UPID (CLICK A PROJECT -> STEER IT). Surfaced on the
  // live snapshot; null in the static demo.
  const steeringUpid = snapshot.steeringUpid ?? null;

  // CLICK THE IDEA BUBBLE -> BUILD. In live mode the popped idea bubble's primary
  // click POSTs /api/suggestion/accept, which accepts the current pending
  // suggestion and starts the real build; the returned snapshot is applied. In
  // offline demo there is no runtime, so it falls back to opening the idea detail.
  const acceptIdea = useCallback(async () => {
    if (!liveMode) {
      selectBubble(IDEA_ID);
      return;
    }
    try {
      const response = await fetch("/api/suggestion/accept", { method: "POST" });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
      }
    } catch {
      // Non-authoritative projector: a failed accept must never block the UI.
    }
  }, [liveMode, selectBubble]);

  // AUTO-BUILD toggle. Flips the server-side auto-accept flag so every fired idea
  // builds itself with no click. The returned snapshot carries the new state.
  const autoAccept = snapshot.autoAccept ?? false;
  const toggleAutoAccept = useCallback(async () => {
    if (!liveMode) {
      return;
    }
    try {
      const response = await fetch("/api/auto-accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !snapshotRef.current.autoAccept }),
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
      }
    } catch {
      // Non-authoritative projector: a failed toggle must never block the UI.
    }
  }, [liveMode]);

  // CLICK A PROJECT -> STEER IT. In live mode, clicking a process bubble/panel sets
  // it as the steering target (so subsequent transcript routes to it); clicking the
  // current target again clears steering. In offline demo it falls back to opening
  // the process detail.
  const steerProcess = useCallback(
    async (id: string) => {
      const match = snapshotRef.current.processes.find(
        (process) => process.callsign === id || process.upid === id,
      );
      if (!liveMode || match === undefined) {
        selectBubble(id);
        return;
      }
      const clearing = snapshotRef.current.steeringUpid === match.upid;
      const url = clearing ? "/api/process/select/clear" : `/api/process/${encodeURIComponent(match.upid)}/select`;
      try {
        const response = await fetch(url, { method: "POST" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          setSnapshot((await response.json()) as ProjectorSnapshot);
        }
      } catch {
        // Non-authoritative projector: a failed select must never block the UI.
      }
    },
    [liveMode, selectBubble],
  );

  const releaseMute = useCallback(async () => {
    setIsUnmuting(true);
    try {
      const response = await fetch("/api/unmute", { method: "POST" });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
        return;
      }
    } catch {
      // Local demo mode has no API server; keep the projector interactive.
    } finally {
      setIsUnmuting(false);
    }
    setSnapshot((current) => withUnmuted(current));
  }, []);

  const triggerEmergency = useCallback(() => {
    // Optimistically reflect the FULL kill-all (mirrors the server's emergency
    // transition: stop listening + halt) so demo/offline mode stays coherent; the
    // SSE push reconciles when the backend is live. The spoken loop stays authoritative.
    setSnapshot((current) => ({
      ...current,
      emergencyStopTriggered: true,
      listening: false,
      muted: true,
      globalState: "emergency stopped",
      activeCue: "none",
    }));
    if (typeof fetch !== "undefined") {
      void fetch("/api/emergency-stop", { method: "POST" }).catch(() => {
        // Best-effort: the projector is non-authoritative; never block on the API.
      });
    }
    // Stop any live mic capture as part of the kill-all.
    micHandleRef.current?.stop();
    micHandleRef.current = null;
    setMicState("off");
    setMicLevel(0);
  }, []);

  const stopMic = useCallback(() => {
    micHandleRef.current?.stop();
    micHandleRef.current = null;
    setMicState("off");
    setMicLevel(0);
  }, []);

  const toggleMic = useCallback(async () => {
    if (micHandleRef.current !== null) {
      stopMic();
      return;
    }
    setMicError(null);
    setMicState("connecting");
    try {
      // Safety mirror of the server: a muted room must unmute before the mic can
      // stream cloud ASR. Release the mute first so the socket is accepted.
      if (snapshotRef.current.muted) {
        await releaseMute();
      }
      const handle = await startMicCapture({
        onLevel: (rms) => setMicLevel(rms),
        onStatus: (status) => {
          if (status === "live") {
            setMicState("live");
          } else if (status === "stopped") {
            setMicState("off");
            setMicLevel(0);
          }
        },
        onError: (message) => setMicError(message),
      });
      micHandleRef.current = handle;
    } catch (error) {
      setMicError(error instanceof Error ? error.message : "Could not start microphone");
      setMicState("off");
    }
  }, [releaseMute, stopMic]);

  // Stop capture if the component unmounts.
  useEffect(() => {
    return () => {
      micHandleRef.current?.stop();
      micHandleRef.current = null;
    };
  }, []);

  // --- Live data: fetch /api/state + subscribe to /api/events (SSR-guarded) ---
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const liveParam = new URLSearchParams(window.location.search).get("live");
    if (liveParam === "0") {
      return;
    }
    if (import.meta.env.DEV && liveParam !== "1") {
      return;
    }

    let closed = false;
    let events: EventSource | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1_000;

    // Pull the authoritative snapshot from /api/state. Runs on first load and on
    // EVERY (re)connect / tab re-focus, so a server restart or dropped SSE stream
    // can never leave the projector frozen on stale state.
    async function syncState() {
      try {
        const response = await fetch("/api/state", { headers: { accept: "application/json" } });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          return;
        }
        const liveSnapshot = (await response.json()) as ProjectorSnapshot;
        if (!closed) {
          setSnapshot(liveSnapshot);
        }
      } catch {
        // Transient (e.g. server restarting); the reconnect loop will retry.
      }
    }

    function openStream() {
      if (closed || typeof EventSource === "undefined") {
        return;
      }
      const source = new EventSource("/api/events");
      events = source;
      source.addEventListener("open", () => {
        backoffMs = 1_000; // healthy connection — reset backoff
        void syncState(); // resync current state immediately on (re)connect
      });
      source.addEventListener("snapshot", (messageEvent) => {
        if (closed) {
          return;
        }
        try {
          setSnapshot(JSON.parse((messageEvent as MessageEvent).data) as ProjectorSnapshot);
        } catch {
          // Ignore a malformed frame; the next push or a resync recovers.
        }
      });
      source.addEventListener("error", () => {
        // The stream dropped (server restart / network blip). Tear it down and
        // reconnect with capped exponential backoff so the tab self-heals instead
        // of silently going stale — the root cause of "the bubble stopped showing".
        source.close();
        if (closed) {
          return;
        }
        reconnectTimer = setTimeout(openStream, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 15_000);
      });
    }

    // Re-focusing the tab may have missed pushes while backgrounded/disconnected.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void syncState();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    void syncState();
    openStream();

    return () => {
      closed = true;
      events?.close();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // --- Window hook for e2e (SSR-guarded) ---
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.__VIBERSYN__ = {
      ready: true,
      getSnapshot: () => snapshotRef.current,
      applySnapshot: (partial) => setSnapshot((prev) => ({ ...prev, ...partial })),
      select: (id) => {
        if (id === null) {
          setSelected(null);
          return;
        }
        setSelected(resolveSelection(id));
      },
      getSelected: () => selected,
    };
    return () => {
      delete window.__VIBERSYN__;
    };
  }, [resolveSelection, selected]);

  // --- Keyboard: digits 1–9 select, Escape closes (SSR-guarded) ---
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    function onKey(keyEvent: KeyboardEvent) {
      if (keyEvent.key === "Escape") {
        setSelected(null);
        return;
      }
      const digit = Number.parseInt(keyEvent.key, 10);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
        const process = snapshotRef.current.processes[digit - 1];
        if (process) {
          selectBubble(process.callsign);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectBubble]);

  // Significance-driven sizing: selected/active largest, planning mid, others base.
  const bubbleSize = useCallback(
    (process: ProjectorProcess): number => {
      if (process.callsign === selected) {
        return 300;
      }
      if (process.state === "active") {
        return 264;
      }
      if (process.state === "planning") {
        return 232;
      }
      return 212;
    },
    [selected],
  );

  const detailOpen = selectedProcess !== null;
  const listeningState = snapshot.muted ? "muted" : "listening";

  return (
    <main className="deep" data-testid="app">
      <Atmosphere />

      <header className="status-bar" data-region="status">
        <div className="status-left">
          <div
            className={`listening-orb ${listeningState}`}
            data-testid="listening-indicator"
            data-state={listeningState}
          >
            <span className="orb-core" aria-hidden="true" />
            <span className="orb-label">{snapshot.muted ? "Muted" : "Listening"}</span>
          </div>
          <div className="session-meta">
            <span className="session-id">{snapshot.sessionId}</span>
            <span className="provider">{snapshot.globalState}</span>
          </div>
        </div>

        <div className="status-center">
          <span className="cue-eyebrow">active cue</span>
          <span className="active-cue" data-testid="active-cue">
            {snapshot.activeCue}
          </span>
          <div className="center-tags">
            <span className="readonly-tag">READ-ONLY · NON-AUTHORITATIVE</span>
            <div className="gate-chip" aria-label="Suggestion gate progress">
              <span className="gate-track">
                <span className="gate-fill" style={{ width: `${gatePercent}%` }} />
              </span>
              <span className="gate-text">gate {Math.round(gatePercent)}%</span>
            </div>
          </div>
        </div>

        <div className="status-right">
          <div
            className={`emergency-status ${snapshot.emergencyStopTriggered ? "triggered" : "clear"}`}
            data-testid="emergency-status"
            data-triggered={snapshot.emergencyStopTriggered ? "true" : "false"}
          >
            {snapshot.emergencyStopTriggered ? "EMERGENCY STOP" : "ALL CLEAR"}
          </div>
          {snapshot.muted ? (
            <button
              type="button"
              className="ctl-button unmute"
              data-testid="unmute-button"
              onClick={() => void releaseMute()}
              disabled={isUnmuting}
            >
              {isUnmuting ? "Unmuting" : "Unmute"}
            </button>
          ) : null}
          <MicControl
            state={micState}
            level={micLevel}
            error={micError}
            mode={snapshot.mic?.mode}
            bytesReceived={snapshot.mic?.bytesReceived ?? 0}
            onToggle={() => void toggleMic()}
          />
          <button
            type="button"
            className={`ctl-button auto-build${autoAccept ? " on" : ""}`}
            data-testid="auto-build-button"
            data-state={autoAccept ? "on" : "off"}
            aria-pressed={autoAccept}
            onClick={() => void toggleAutoAccept()}
            title="When on, every detected idea builds itself — no click required."
          >
            {autoAccept ? "Auto-Build: ON" : "Auto-Build: OFF"}
          </button>
          <button
            type="button"
            className="ctl-button emergency"
            data-testid="emergency-button"
            onClick={triggerEmergency}
          >
            Emergency
          </button>
        </div>
      </header>

      <div className={`stage${detailOpen ? " stage-dimmed" : ""}`}>
        <section className="bubble-field" data-region="fleet" data-testid="bubble-field" onClick={closeDetail}>
          <SuggestionRegion pitch={snapshot.suggestion.pitch} />
          <div className="field-inner" onClick={(clickEvent) => clickEvent.stopPropagation()}>
            <IdeaBubble
              state={snapshot.suggestion.state}
              pitch={snapshot.suggestion.pitch}
              confidence={snapshot.suggestion.confidence}
              gatePercent={gatePercent}
              selected={ideaSelected}
              size={ideaSelected ? 250 : 196}
              evidence={snapshot.suggestion.contextSpan?.quote}
              onSelect={() => void acceptIdea()}
            />
            {snapshot.processes.map((process, index) => (
              <ProcessBubble
                key={process.upid}
                process={{
                  ...process,
                  selected: process.callsign === selected,
                  steering: process.upid === steeringUpid,
                }}
                index={index}
                size={bubbleSize(process)}
                hotkey={index < 9 ? index + 1 : null}
                onSelect={() => void steerProcess(process.callsign)}
              />
            ))}
          </div>
        </section>

        <aside className="rail">
          <FleetPanel
            processes={snapshot.processes}
            selected={selected}
            steeringUpid={steeringUpid}
            onSelect={(id) => void steerProcess(id)}
          />
          <AudioReadout snapshot={snapshot} />
          <TranscriptStream lines={snapshot.transcript} />
          <TraceRail trace={snapshot.trace} />
        </aside>
      </div>

      {detailOpen && selectedProcess ? (
        <div className="detail-overlay" onClick={closeDetail}>
          <BuildDetail process={selectedProcess} trace={snapshot.trace} onClose={closeDetail} />
        </div>
      ) : null}
    </main>
  );
}

// Live-mic control: toggles browser capture and shows a real-time input level
// meter so the room can confirm the mic is actually feeding the server. When the
// server reports ASR mode "replay" (no DEEPGRAM_API_KEY), audio still streams and
// the meter moves, but words are not transcribed — surfaced via the title hint.
function MicControl({
  state,
  level,
  error,
  mode,
  bytesReceived,
  onToggle,
}: {
  state: "off" | "connecting" | "live";
  level: number;
  error: string | null;
  mode?: "deepgram" | "voxterm" | "replay";
  bytesReceived: number;
  onToggle: () => void;
}) {
  // Map RMS (~0–0.3 for speech) onto a 0–100% bar with mild gain.
  const levelPercent = Math.min(100, Math.round(level * 320));
  const label = state === "live" ? "Mic On" : state === "connecting" ? "Starting" : "Mic";
  const hint =
    mode === "replay"
      ? "Audio streams to the server, but transcription needs DEEPGRAM_API_KEY."
      : "Live mic → server ASR → transcript.";

  return (
    <div className="mic-control" data-testid="mic-control" data-state={state}>
      <button
        type="button"
        className={`ctl-button mic mic-${state}`}
        data-testid="mic-button"
        onClick={onToggle}
        disabled={state === "connecting"}
        title={error ?? hint}
      >
        <span className="mic-dot" aria-hidden="true" />
        {label}
      </button>
      {state === "live" ? (
        <>
          <span className="mic-meter" aria-label="Microphone input level">
            <span className="mic-meter-fill" data-testid="mic-meter-fill" style={{ width: `${levelPercent}%` }} />
          </span>
          <span className="mic-stats" data-testid="mic-stats">
            {mode === "replay" ? "replay · " : "deepgram · "}
            {formatBytes(bytesReceived)} in
          </span>
        </>
      ) : null}
      {error ? <span className="mic-error" data-testid="mic-error">{error}</span> : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// A region carrying the suggestion pitch text + data-region="suggestion".
// Kept lightweight so the headline idea reads from across the room and the
// projector contract (the pitch string) renders even before interaction.
function SuggestionRegion({ pitch }: { pitch: string }) {
  return (
    <div className="suggestion-banner" data-region="suggestion">
      <span className="suggestion-eyebrow">queued idea</span>
      <span className="suggestion-pitch">{pitch}</span>
    </div>
  );
}

// Always-visible per-process panels (spec §9): callsign / state / last spoken
// output / last action / UPID + the recent action log — so a passive room viewer
// reads "how each build is going" without interacting. V0 caps the operable fleet
// at 2; when fewer than 2 run, an explicit "No second process running" slot shows.
function FleetPanel({
  processes,
  selected,
  steeringUpid,
  onSelect,
}: {
  processes: ProjectorProcess[];
  selected: string | null;
  steeringUpid: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="rail-card fleet-card">
      <div className="rail-title-row">
        <h3 className="rail-title">Fleet</h3>
        <span className="trace-count">{processes.length}/2</span>
      </div>
      <div className="fleet-panels">
        {processes.map((process) => {
          const steering = process.upid === steeringUpid;
          return (
          <article
            key={process.upid}
            className={`fleet-panel state-${process.state}${process.callsign === selected ? " selected" : ""}${steering ? " steering" : ""}`}
            data-testid="fleet-panel"
            data-callsign={process.callsign}
            data-state={process.state}
            data-steering={steering ? "true" : "false"}
            onClick={() => onSelect(process.callsign)}
          >
            <div className="fleet-panel-head">
              <strong className="fleet-callsign">{process.callsign}</strong>
              <span className={`fleet-state badge state-${process.state}`}>{process.state}</span>
              {steering ? <span className="fleet-steering" data-testid="fleet-steering">steering →</span> : null}
            </div>
            <p className="fleet-output">{process.lastOutput || "—"}</p>
            <p className="fleet-action">↳ {process.lastAction}</p>
            {process.events.length > 0 ? (
              <ol className="fleet-log">
                {process.events.slice(-5).map((entry, index) => (
                  <li key={`${entry}-${index}`}>{entry}</li>
                ))}
              </ol>
            ) : null}
            <code className="fleet-upid">{process.upid}</code>
          </article>
          );
        })}
        {processes.length < 2 ? (
          <article className="fleet-panel empty" data-testid="fleet-empty">
            No second process running
          </article>
        ) : null}
      </div>
    </section>
  );
}

function AudioReadout({ snapshot }: { snapshot: ProjectorSnapshot }) {
  return (
    <section className="rail-card audio-card" data-region="audio">
      <h3 className="rail-title">Audio</h3>
      <div className="audio-row">
        <span className="audio-label">last spoken</span>
        <p className="audio-spoken">{snapshot.audio.lastSpoken}</p>
      </div>
      <div className="audio-foot">
        <span className="audio-earcon">♪ {snapshot.audio.earcon}</span>
        <span className="audio-silence">{Math.round(snapshot.audio.silenceRatio * 100)}% silence</span>
      </div>
    </section>
  );
}

function TranscriptStream({ lines }: { lines: TranscriptLine[] }) {
  return (
    <section className="rail-card transcript-card" data-region="transcript">
      <h3 className="rail-title">Transcript</h3>
      <div className="transcript-scroll">
        {lines.map((line) => (
          <div key={`${line.time}-${line.speaker}-${line.text}`} className={`tx-line tx-${line.kind}`}>
            <span className="tx-meta">
              <time>{line.time}</time>
              <strong>{line.speaker}</strong>
            </span>
            <p>{line.text}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// Trace rail: color-coded stream, auto-scroll DISABLED. When new events arrive
// while the operator has scrolled up, a "NEW" pill appears; clicking it jumps to
// the bottom (navigational, not operational).
function TraceRail({ trace }: { trace: LogEvent[] }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const atBottomRef = useRef(true);
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const prevCount = useRef(trace.length);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (node === null) {
      return;
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    const atBottom = distance < 24;
    atBottomRef.current = atBottom;
    setPinnedToBottom(atBottom);
    if (atBottom) {
      setUnseen(false);
    }
  }, []);

  // Track new events without auto-scrolling: only mark "unseen" if scrolled up.
  useEffect(() => {
    if (trace.length > prevCount.current && !atBottomRef.current) {
      setUnseen(true);
    }
    prevCount.current = trace.length;
  }, [trace.length]);

  const scrollToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (node !== null) {
      node.scrollTop = node.scrollHeight;
    }
    setUnseen(false);
    setPinnedToBottom(true);
    atBottomRef.current = true;
  }, []);

  return (
    <section className="rail-card trace-card" data-region="trace" data-testid="trace-rail">
      <div className="rail-title-row">
        <h3 className="rail-title">Trace</h3>
        <span className="trace-count">{trace.length} events</span>
      </div>
      <div className="trace-scroll" ref={scrollRef} onScroll={onScroll}>
        {trace.map((event, index) => (
          <div
            key={`${event.event}-${event.correlationId ?? index}`}
            className={`trace-event ${traceClass(event.event)}`}
            data-testid="trace-event"
            data-event={event.event}
          >
            <span className="tc-tag">{traceTag(event.event)}</span>
            <code className="tc-name">{event.event}</code>
            <span className="tc-meta">{summarizeMeta(event.meta)}</span>
          </div>
        ))}
      </div>
      {unseen && !pinnedToBottom ? (
        <button type="button" className="new-events-pill" data-testid="new-events-pill" onClick={scrollToBottom}>
          NEW ↓
        </button>
      ) : null}
    </section>
  );
}

// Re-export for any consumer that needs the inline-style helper shape.
export type ProjectorStyle = CSSProperties;
