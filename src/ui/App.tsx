import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { demoProjectorSnapshot, busyRoomSnapshot, withUnmuted } from "./demo-data";
import type { LogEvent } from "../types";
import type { ProjectorProcess, ProjectorSnapshot, TranscriptLine } from "./types";
import { GestureLayer } from "./gesture/GestureLayer";
import { RoomScene, type IdeaOrbSpec, type SceneMode, type TreeSpec } from "./RoomScene";
import { BuildDetail } from "./BuildDetail";
import { IdeaTray } from "./IdeaTray";
import { QrImport } from "./QrImport";
import { HelpOverlay } from "./HelpOverlay";
import { parseProjectorUrl } from "./url-params";
import { traceClass, traceTag, summarizeMeta } from "./trace-utils";
import { startMicCapture, type MicCaptureHandle } from "./mic";

export const REQUIRED_PROJECTOR_REGIONS = [
  "status",
  "suggestion",
  "fleet",
  "transcript",
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
  const [qrOpen, setQrOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // MOCK ROOM: a client-only demo showing several projects building at once.
  // While on, the live SSE stream is held back (see the guard below) so the
  // fixture is not overwritten; toggling off re-syncs the real state.
  const [mockMode, setMockMode] = useState(false);
  const mockModeRef = useRef(false);
  mockModeRef.current = mockMode;
  // Scene controls (visualizer parity): garden/orbit render mode, zen mode
  // (all chrome hidden), the hide/unhide menu, and a fit-to-content signal.
  const [sceneMode, setSceneMode] = useState<SceneMode>("garden");
  const [zenMode, setZenMode] = useState(false);
  const zenModeRef = useRef(false);
  zenModeRef.current = zenMode;
  const [hideMenuOpen, setHideMenuOpen] = useState(false);
  const hideMenuOpenRef = useRef(false);
  hideMenuOpenRef.current = hideMenuOpen;
  const [hiddenIdeas, setHiddenIdeas] = useState<ReadonlySet<string>>(new Set());
  const [hiddenTrees, setHiddenTrees] = useState<ReadonlySet<string>>(new Set());
  const [fitSignal, setFitSignal] = useState(0);
  const toggleHiddenIdea = useCallback((id: string) => {
    setHiddenIdeas((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);
  const toggleHiddenTree = useCallback((upid: string) => {
    setHiddenTrees((current) => {
      const next = new Set(current);
      if (next.has(upid)) {
        next.delete(upid);
      } else {
        next.add(upid);
      }
      return next;
    });
  }, []);
  const clearHidden = useCallback(() => {
    setHiddenIdeas(new Set());
    setHiddenTrees(new Set());
  }, []);
  // The transient voice-command confirmation ("🎤 vibersyn → build"), or null.
  const [voiceFlash, setVoiceFlash] = useState<string | null>(null);

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

  // Window configuration from the URL: view slice (?view=ideas|builds|full),
  // wall identity badge (?wall=A|B), and the LEGACY gesture layer — which mounts
  // ONLY on an explicit ?gesture=1 or ?fusion= (desk mode is the default; a bare
  // ?wall= is just a badge so two-wall projections work without cameras).
  const urlConfig = useMemo(() => {
    if (typeof window === "undefined") {
      return parseProjectorUrl("", "localhost");
    }
    return parseProjectorUrl(window.location.search, window.location.hostname);
  }, []);
  const view = urlConfig.view;

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
    if (!liveMode || mockModeRef.current) {
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

  // IDEA TRAY actions: Build/Dismiss a SPECIFIC ledger candidate (not just the
  // primary bubble). Live mode POSTs the per-idea endpoint and applies the
  // returned snapshot; offline demo drops the card locally so the static tray
  // stays interactive.
  const actOnIdea = useCallback(
    async (id: string, action: "accept" | "dismiss") => {
      if (!liveMode || mockModeRef.current) {
        setSnapshot((current) => ({
          ...current,
          ideas: (current.ideas ?? []).filter((idea) => idea.id !== id),
        }));
        return;
      }
      try {
        const response = await fetch(`/api/idea/${encodeURIComponent(id)}/${action}`, { method: "POST" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          setSnapshot((await response.json()) as ProjectorSnapshot);
        }
      } catch {
        // Non-authoritative projector: a failed POST must never block the UI.
      }
    },
    [liveMode],
  );

  // Keyboard/voice-parity target: b/Enter and x act on the TOP ready idea (the
  // tray is ready-first, so this is the first ready card). No-op when none is.
  const actOnTopIdea = useCallback(
    async (action: "accept" | "dismiss") => {
      const top = (snapshotRef.current.ideas ?? []).find((idea) => idea.status === "ready");
      if (top !== undefined) {
        await actOnIdea(top.id, action);
      }
    },
    [actOnIdea],
  );

  // AUTO-BUILD toggle. Flips the server-side auto-accept flag so every fired idea
  // builds itself with no click. The returned snapshot carries the new state.
  const autoAccept = snapshot.autoAccept ?? false;
  const toggleAutoAccept = useCallback(async () => {
    if (!liveMode || mockModeRef.current) {
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

  // IDEA CAPTURE toggle (alternative to passive auto-detect). Flips the server-side
  // capture flag: when on, detection runs eagerly on every final utterance — but
  // building stays explicit (tray/keyboard/voice) unless Auto-Build is also on.
  const captureMode = snapshot.captureMode ?? false;
  const toggleCaptureMode = useCallback(async () => {
    if (!liveMode || mockModeRef.current) {
      return;
    }
    try {
      const response = await fetch("/api/capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !snapshotRef.current.captureMode }),
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
      if (!liveMode || mockModeRef.current || match === undefined) {
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

  // VOICE FEEDBACK: when the server recognizes a wake-word command the snapshot's
  // `voice` field changes; flash the command near the status bar so the room gets
  // visible confirmation the utterance landed. The initial value (a stale command
  // from before this window loaded) is recorded without flashing. The effect keys
  // on the VALUE, not the object: every SSE frame rebuilds `snapshot.voice` via
  // JSON.parse, and an identity-keyed effect would run its cleanup (clearing the
  // 4s timer) on each frame and never re-arm it — the flash would stick forever.
  const voiceFlashKey = snapshot.voice ? `${snapshot.voice.lastCommand}@${snapshot.voice.at}` : null;
  const voiceCommand = snapshot.voice?.lastCommand ?? null;
  const prevVoiceKeyRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevVoiceKeyRef.current === undefined || voiceFlashKey === null) {
      prevVoiceKeyRef.current = voiceFlashKey;
      return;
    }
    if (voiceFlashKey === prevVoiceKeyRef.current) {
      return;
    }
    prevVoiceKeyRef.current = voiceFlashKey;
    setVoiceFlash(voiceCommand);
    const timer = setTimeout(() => setVoiceFlash(null), 4_000);
    return () => clearTimeout(timer);
  }, [voiceFlashKey, voiceCommand]);

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
        if (!closed && !mockModeRef.current) {
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
        if (closed || mockModeRef.current) {
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

  // Overlay open-state mirrored into refs so the keyboard handler (bound once)
  // can close the topmost overlay on Escape without re-binding per keystroke.
  const qrOpenRef = useRef(qrOpen);
  qrOpenRef.current = qrOpen;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;

  // --- Keyboard: the primary desk-mode control surface (SSR-guarded) ---
  // 1–9 select/steer · b/Enter build top idea · x dismiss · c capture · a auto-
  // build · m mic · u unmute · q QR · ?/h help · Shift+E emergency · Esc close.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    function onKey(keyEvent: KeyboardEvent) {
      // Never steal keys from text entry or browser-level shortcuts.
      if (keyEvent.metaKey || keyEvent.ctrlKey) {
        return;
      }
      const target = keyEvent.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) {
          return;
        }
        // Enter on a focused control is that control's activation, not "build".
        if (keyEvent.key === "Enter" && target.closest("button, a, [role='button']") !== null) {
          return;
        }
      }
      if (keyEvent.key === "Escape") {
        // Close the topmost overlay first; fall back to closing the detail.
        // Help renders after (above) the QR overlay in the tree, so it closes
        // first — otherwise Escape appears to do nothing while both are open.
        if (hideMenuOpenRef.current) {
          setHideMenuOpen(false);
          return;
        }
        if (zenModeRef.current) {
          setZenMode(false);
          return;
        }
        if (helpOpenRef.current) {
          setHelpOpen(false);
          return;
        }
        if (qrOpenRef.current) {
          setQrOpen(false);
          return;
        }
        setSelected(null);
        return;
      }
      // Scene controls (visualizer parity): ` hide menu, g garden/orbit,
      // z zen, f fit-to-content, 0 clears filters while the menu is open.
      if (keyEvent.key === "`") {
        setHideMenuOpen((open) => !open);
        return;
      }
      if (keyEvent.key === "0" && hideMenuOpenRef.current) {
        clearHidden();
        return;
      }
      switch (keyEvent.key) {
        case "g":
          setSceneMode((current) => (current === "garden" ? "orbit" : "garden"));
          return;
        case "z":
          setZenMode((zen) => !zen);
          return;
        case "f":
          setFitSignal((n) => n + 1);
          return;
        default:
          break;
      }
      // Shift+E only — a deliberate chord for the kill-all, so brushing "e" while
      // reaching for other keys can never stop the room.
      if (keyEvent.key === "E" && keyEvent.shiftKey) {
        triggerEmergency();
        return;
      }
      switch (keyEvent.key) {
        case "b":
        case "Enter":
          void actOnTopIdea("accept");
          return;
        case "x":
          void actOnTopIdea("dismiss");
          return;
        case "c":
          void toggleCaptureMode();
          return;
        case "a":
          void toggleAutoAccept();
          return;
        case "m":
          void toggleMic();
          return;
        case "u":
          if (snapshotRef.current.muted) {
            void releaseMute();
          }
          return;
        case "q":
          setQrOpen((open) => !open);
          return;
        case "?":
        case "h":
          setHelpOpen((open) => !open);
          return;
        default:
          break;
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
  }, [selectBubble, actOnTopIdea, toggleCaptureMode, toggleAutoAccept, toggleMic, releaseMute, triggerEmergency, clearHidden]);

  const detailOpen = selectedProcess !== null;
  const listeningState = snapshot.muted ? "muted" : "listening";

  // MOCK ROOM toggle: swap in the busy fixture (several projects at once) and
  // hold back the live stream; toggling off re-syncs the authoritative state
  // (offline demo just restores its own fixture).
  const toggleMockMode = useCallback(() => {
    const turningOn = !mockModeRef.current;
    setMockMode(turningOn);
    if (turningOn) {
      setSnapshot(busyRoomSnapshot());
      setSelected(null);
      return;
    }
    if (!liveMode) {
      setSnapshot(demoProjectorSnapshot);
      return;
    }
    void fetch("/api/state", { headers: { accept: "application/json" } })
      .then((response) =>
        response.ok && response.headers.get("content-type")?.includes("application/json")
          ? (response.json() as Promise<ProjectorSnapshot>)
          : null,
      )
      .then((restored) => {
        if (restored) {
          setSnapshot(restored);
        }
      })
      .catch(() => {
        // A failed resync must never wedge the UI; the live stream will catch up.
      });
  }, [liveMode]);

  // Two-wall view split: the ideas wall hides the build fleet, the builds wall
  // hides the idea surfaces; "full" (default) shows everything on one screen.
  // Mock room forces the full layout so every project is visible at once.
  const effectiveView = mockMode ? "full" : view;
  const showIdeaSurfaces = effectiveView !== "builds";
  const showFleetSurfaces = effectiveView !== "ideas";
  // The tray renders whenever there are candidates; the dedicated ideas wall
  // always shows it (with an empty-state hint) so the surface reads as present.
  const ideas = snapshot.ideas ?? [];
  const showIdeaTray = showIdeaSurfaces && (effectiveView === "ideas" || ideas.length > 0);

  // 3D constellation input: every ledger candidate as an orb; with an empty
  // ledger, the primary pending suggestion (id null) is the lone orb.
  const ideaOrbs = useMemo<IdeaOrbSpec[]>(() => {
    if (ideas.length > 0) {
      return ideas.map((idea) => ({
        id: idea.id,
        pitch: idea.pitch,
        confidence: idea.confidence,
        status: idea.status,
        maturity: idea.maturity,
        verified: idea.verified,
      }));
    }
    if (snapshot.suggestion.pitch.length > 0) {
      return [
        {
          id: null,
          pitch: snapshot.suggestion.pitch,
          confidence: snapshot.suggestion.confidence,
          status: "ready",
          maturity: "proposed",
          verified: false,
        },
      ];
    }
    return [];
  }, [ideas, snapshot.suggestion.pitch, snapshot.suggestion.confidence]);

  // Scene trees: one per process (minus anything hidden via the hide menu).
  // The scene itself drops trees on the dedicated ideas wall (view gating
  // lives in RoomScene's reconcile).
  const treeSpecs = useMemo<TreeSpec[]>(
    () =>
      snapshot.processes
        .filter((process) => !hiddenTrees.has(process.upid))
        .map((process) => ({
          upid: process.upid,
          callsign: process.callsign,
          state: process.state,
          progress: process.progress,
          task: process.task,
        })),
    [snapshot.processes, hiddenTrees],
  );

  const visibleIdeaOrbs = useMemo<IdeaOrbSpec[]>(
    () => ideaOrbs.filter((orb) => !hiddenIdeas.has(orb.id ?? "__primary__")),
    [ideaOrbs, hiddenIdeas],
  );

  // Clicking a ready orb builds it: ledger candidates go through the per-idea
  // accept endpoint, the primary suggestion through /api/suggestion/accept.
  const acceptOrb = useCallback(
    (id: string | null) => {
      if (id === null) {
        void acceptIdea();
      } else {
        void actOnIdea(id, "accept");
      }
    },
    [acceptIdea, actOnIdea],
  );

  return (
    <main className={`deep${zenMode ? " zen" : ""}`} data-testid="app" data-view={view} data-zen={zenMode ? "true" : "false"}>
      <RoomScene
        ideas={visibleIdeaOrbs}
        trees={treeSpecs}
        mode={sceneMode}
        view={effectiveView}
        fitSignal={fitSignal}
        onAcceptIdea={acceptOrb}
        onSelectProcess={(callsign) => void steerProcess(callsign)}
      />
      {urlConfig.gesture ? (
        <GestureLayer wall={urlConfig.gesture.wall} fusionUrl={urlConfig.gesture.fusionUrl} />
      ) : null}
      {urlConfig.badge ? (
        <div className="wall-badge" data-testid="wall-badge">
          {urlConfig.badge}
        </div>
      ) : null}
      {voiceFlash !== null ? (
        <div className="voice-flash" data-testid="voice-flash" role="status">
          🎤 vibersyn → {voiceFlash}
        </div>
      ) : null}

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
            className={`ctl-button capture${captureMode ? " on" : ""}`}
            data-testid="capture-button"
            data-state={captureMode ? "on" : "off"}
            aria-pressed={captureMode}
            onClick={() => void toggleCaptureMode()}
            title="Idea Capture: detection runs eagerly on every utterance — building stays explicit unless Auto-Build is on."
          >
            {captureMode ? "● Capturing" : "Idea Capture"}
          </button>
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
            className="ctl-button qr-import"
            data-testid="qr-import-button"
            onClick={() => setQrOpen(true)}
            title="Show a QR code — scan it on a phone to add a GitHub repo to the wall."
          >
            QR Import
          </button>
          <button
            type="button"
            className={`ctl-button mock-room${mockMode ? " on" : ""}`}
            data-testid="mock-room-button"
            data-state={mockMode ? "on" : "off"}
            aria-pressed={mockMode}
            onClick={toggleMockMode}
            title="Demo: fill the room with several projects building at once. Toggle off to return to the live state."
          >
            {mockMode ? "● Mock Room" : "Mock Room"}
          </button>
        </div>
      </header>

      {showIdeaSurfaces && !mockMode ? <SuggestionRegion pitch={snapshot.suggestion.pitch} /> : null}

      <div className={`stage${detailOpen ? " stage-dimmed" : ""}`}>
        <div className="stage-main">
          {showIdeaTray && !mockMode ? (
            <IdeaTray
              ideas={ideas}
              onBuild={(id) => void actOnIdea(id, "accept")}
              onDismiss={(id) => void actOnIdea(id, "dismiss")}
            />
          ) : null}
        </div>

        {/* Mock room is a pure 3D showcase — the 2D rail/tray stay hidden. */}
        {!mockMode ? (
          <aside className="rail">
            {showFleetSurfaces ? (
              <FleetPanel
                processes={snapshot.processes}
                selected={selected}
                steeringUpid={steeringUpid}
                onSelect={(id) => void steerProcess(id)}
              />
            ) : null}
            <TranscriptStream lines={snapshot.transcript} />
          </aside>
        ) : null}
      </div>

      {/* Scene controls (visualizer parity): mode / fit / hide / zen. */}
      <div className="scene-controls" data-testid="scene-controls">
        <button
          type="button"
          className="ctl-button scene-toggle"
          data-testid="scene-mode-button"
          data-mode={sceneMode}
          onClick={() => setSceneMode((current) => (current === "garden" ? "orbit" : "garden"))}
          title="Switch between the garden and orbit renderings (G)."
        >
          {sceneMode === "garden" ? "🌳 Garden" : "🪐 Orbit"}
        </button>
        <button
          type="button"
          className="ctl-button scene-fit"
          data-testid="scene-fit-button"
          onClick={() => setFitSignal((n) => n + 1)}
          title="Frame everything in view (F). Drag orbits · Shift+drag pans · scroll zooms."
        >
          ⤢ Fit
        </button>
        <button
          type="button"
          className={`ctl-button scene-hide${hideMenuOpen ? " on" : ""}`}
          data-testid="scene-hide-button"
          aria-pressed={hideMenuOpen}
          onClick={() => setHideMenuOpen((open) => !open)}
          title="Hide or unhide builds and ideas (`)."
        >
          ◐ Hide
        </button>
        <button
          type="button"
          className="ctl-button scene-zen"
          data-testid="scene-zen-button"
          onClick={() => setZenMode(true)}
          title="Zen: hide every panel and button (Z or Esc to exit)."
        >
          ◉ Zen
        </button>
      </div>

      {hideMenuOpen ? (
        <div className="hide-menu" data-testid="hide-menu">
          <div className="rail-title-row">
            <h3 className="rail-title">Hide / Unhide</h3>
            <button type="button" className="ctl-button hide-clear" onClick={clearHidden} title="Show everything (0)">
              0 · Clear
            </button>
          </div>
          {snapshot.processes.length > 0 ? (
            <>
              <span className="hide-section">Builds</span>
              {snapshot.processes.map((process) => {
                const hidden = hiddenTrees.has(process.upid);
                return (
                  <button
                    key={process.upid}
                    type="button"
                    className={`hide-item${hidden ? " is-hidden" : ""}`}
                    data-testid="hide-item"
                    onClick={() => toggleHiddenTree(process.upid)}
                  >
                    <span className="hide-name">{process.callsign}</span>
                    <span className="hide-state">{hidden ? "hidden" : "visible"}</span>
                  </button>
                );
              })}
            </>
          ) : null}
          {ideaOrbs.filter((orb) => orb.pitch.length > 0).length > 0 ? (
            <>
              <span className="hide-section">Ideas</span>
              {ideaOrbs
                .filter((orb) => orb.pitch.length > 0)
                .map((orb) => {
                  const key = orb.id ?? "__primary__";
                  const hidden = hiddenIdeas.has(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      className={`hide-item${hidden ? " is-hidden" : ""}`}
                      data-testid="hide-item"
                      onClick={() => toggleHiddenIdea(key)}
                    >
                      <span className="hide-name">{orb.pitch.length > 42 ? `${orb.pitch.slice(0, 42)}…` : orb.pitch}</span>
                      <span className="hide-state">{hidden ? "hidden" : "visible"}</span>
                    </button>
                  );
                })}
            </>
          ) : null}
        </div>
      ) : null}

      {zenMode ? (
        <div className="zen-hint" data-testid="zen-hint">
          ◎ zen — z to exit
        </div>
      ) : null}

      {detailOpen && selectedProcess ? (
        <div className="detail-overlay" onClick={closeDetail}>
          <BuildDetail process={selectedProcess} trace={snapshot.trace} onClose={closeDetail} />
        </div>
      ) : null}

      {qrOpen ? <QrImport processes={snapshot.processes} onClose={() => setQrOpen(false)} /> : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} /> : null}
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
