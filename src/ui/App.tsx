import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { demoProjectorSnapshot, busyRoomSnapshot, emptyProjectorSnapshot, withUnmuted } from "./demo-data";
import type { ProjectorProcess, ProjectorSnapshot, TranscriptLine } from "./types";
import { GestureLayer } from "./gesture/GestureLayer";
import { PinchCameraLayer } from "./gesture/PinchCameraLayer";
import { RoomScene, type IdeaOrbSpec, type SceneLayout, type SceneMode, type TreeSpec } from "./RoomScene";
import { Slideshow } from "./Slideshow";
import { BuildDetail } from "./BuildDetail";
import { IdeaTray } from "./IdeaTray";
import { QrImport } from "./QrImport";
import { HelpOverlay } from "./HelpOverlay";
import { BackendSelector } from "./BackendSelector";
import { BuildChips, CommissionButton, ExecutionChip, ProcessControls } from "./BuildChips";
import { TakeHomeQr } from "./TakeHomeQr";
import { backendsOf, buildsOf, lifecycleActionsFor, looksLikeSnapshot } from "./buildloop";
import type { BuildloopSnapshot, LifecycleAction } from "./buildloop";
import { executionOf, parseDeckDecisionMessage, sceneStageOf, stageOf } from "./stage";
import { selfOf, trackBootId } from "./self-reload";
import type { DecisionChoice, StagedProcess } from "./stage";
import { parseProjectorUrl } from "./url-params";
import { GuidedDemo } from "./guided/GuidedDemo";
import { advanceOnSnapshot, popPracticeOrb, skipStep, startGuided, type GuidedState } from "./guided/machine";
import "./buildloop.css";
import { startMicCapture, type MicCaptureHandle } from "./mic";

export const REQUIRED_PROJECTOR_REGIONS = [
  "status",
  "suggestion",
  "fleet",
  "transcript",
] as const;

interface ProjectorAppProps {
  initialSnapshot?: ProjectorSnapshot;
  // Test seam: overrides window.location.search for URL-config parsing so the
  // (windowless) test renderer can exercise wall/view URLs.
  urlSearch?: string;
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

export function ProjectorApp({ initialSnapshot, urlSearch }: ProjectorAppProps) {
  // Window configuration from the URL, parsed FIRST — the guided-demo entry
  // and Mock-Room gates below depend on it: wall identity badge (?wall=A|B),
  // the LEGACY view param (?view=ideas|builds — accepted so old two-wall URLs
  // keep working, but INERT for content: every window renders the full room),
  // and the LEGACY gesture layer — which mounts ONLY on an explicit ?gesture=1
  // or ?fusion= (desk mode is the default; a bare ?wall= is just a badge so
  // two-wall projections work without cameras).
  const urlConfig = useMemo(() => {
    if (urlSearch !== undefined) {
      return parseProjectorUrl(urlSearch, "localhost");
    }
    if (typeof window === "undefined") {
      return parseProjectorUrl("", "localhost");
    }
    return parseProjectorUrl(window.location.search, window.location.hostname);
  }, [urlSearch]);
  const view = urlConfig.view;

  // AUDIT (no-mocks): with no explicit snapshot prop the wall boots from the
  // EMPTY live baseline — never the Atlas/Cobalt fixture — so a live window
  // shows nothing canned while /api/state resolves (or when the server is
  // down). The offline demo (?live=0, or DEV without ?live=1) seeds the
  // interactive demo fixture in an effect below.
  const [snapshot, setSnapshot] = useState(initialSnapshot ?? emptyProjectorSnapshot);
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
  // Layout strategy axis (visualizer parity): standard radial, H3 Poincaré
  // ball, or the Poincaré disk. Crossed with the garden/orbit style axis.
  const [sceneLayout, setSceneLayout] = useState<SceneLayout>("radial");
  // Project explainer deck: the upid whose slideshow is open, or null.
  const [slideshowUpid, setSlideshowUpid] = useState<string | null>(null);
  const slideshowRef = useRef<string | null>(null);
  slideshowRef.current = slideshowUpid;
  const [zenMode, setZenMode] = useState(false);
  const zenModeRef = useRef(false);
  zenModeRef.current = zenMode;
  // Fullscreen toggle: mirrors the browser's fullscreen state so the projector
  // wall can fill the display without OS chrome (also dwell-selectable).
  const [isFullscreen, setIsFullscreen] = useState(false);
  const toggleFullscreen = useCallback(() => {
    if (typeof document === "undefined") return;
    if (document.fullscreenElement) {
      void document.exitFullscreen?.();
    } else {
      void document.documentElement.requestFullscreen?.();
    }
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onChange = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", onChange);
    onChange();
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // Motion-tracking cursor glyph: off by default (the room highlights targets,
  // not a pointer), toggled on from the HUD to see/aim where the camera is
  // tracking. Defaults ON in gesture mode's first moments would distract, so off.
  const [showCursor, setShowCursor] = useState(false);
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

  // Offline demo (?live=0, or DEV without ?live=1) with no explicit snapshot
  // prop: seed the interactive demo fixture. The LIVE path stays on the empty
  // baseline until the real /api/state arrives (see the audit note above).
  const hasExplicitSnapshot = initialSnapshot !== undefined;
  useEffect(() => {
    if (!hasExplicitSnapshot && !liveMode) {
      setSnapshot(demoProjectorSnapshot);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasExplicitSnapshot]);

  // GUIDED DEMO: the coached walkthrough (see ./guided/machine.ts for the step
  // contract). Null = not running. ?demo=guided auto-enters on load; the HUD
  // button (re-)enters a FRESH run at any time.
  const [guided, setGuided] = useState<GuidedState | null>(() =>
    urlConfig.demo === "guided" ? startGuided(initialSnapshot ?? emptyProjectorSnapshot) : null,
  );
  const guidedRef = useRef(guided);
  guidedRef.current = guided;

  // Latest snapshot exposed to the e2e window hook without re-binding it.
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // Feed EVERY snapshot through the guided-demo machine: real room state is
  // the only thing that advances a step. advanceOnSnapshot is identity-stable
  // when nothing changes, so setState bails without render churn.
  useEffect(() => {
    setGuided((current) => (current === null ? current : advanceOnSnapshot(current, snapshot)));
  }, [snapshot]);

  // Entering the decide step auto-opens the REAL generated pitch deck of the
  // project born during the demo, starting on whichever mock finished first —
  // the deck's "How should we continue?" bar is the demo's finale surface.
  const guidedStepRef = useRef<GuidedState["step"] | null>(null);
  useEffect(() => {
    const step = guided?.step ?? null;
    const previous = guidedStepRef.current;
    guidedStepRef.current = step;
    if (step === "decide" && previous !== "decide" && guided?.focusUpid != null) {
      setSlideshowUpid(guided.focusUpid);
    }
  }, [guided]);

  // GUIDED EPILOGUE: the transient completion note after the decide finale
  // ("Build it for real" says the commission fired; the demo never waits for
  // the full build). Cleared automatically a few seconds later.
  const [guidedEpilogue, setGuidedEpilogue] = useState<string | null>(null);
  useEffect(() => {
    if (guidedEpilogue === null) {
      return;
    }
    const timer = setTimeout(() => setGuidedEpilogue(null), 8_000);
    return () => clearTimeout(timer);
  }, [guidedEpilogue]);

  // DECIDE-STEP COMMISSION WATCHER: the generated deck's own in-iframe
  // decision buttons POST /api/process/:upid/execute directly — no event
  // reaches the room. But the SNAPSHOT tells the truth: the focus process
  // grows an execution lane. If that happens while the demo is waiting on the
  // decide finale, the decision was made — complete the demo with the
  // commission epilogue (the room-native bar's path does the same via
  // deckDecision).
  useEffect(() => {
    const current = guidedRef.current;
    if (current === null || current.step !== "decide" || current.focusUpid === null) {
      return;
    }
    const focus = snapshot.processes.find((process) => process.upid === current.focusUpid);
    if (focus !== undefined && stageOf(focus) === "commissioned") {
      setGuided(null);
      setGuidedEpilogue(
        "Commissioned! The real build is now executing — watch this concept's tree grow.",
      );
    }
  }, [snapshot]);

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

  // BUILD BACKENDS (build-loop contract): the toggleable roster from
  // snapshot.backends. Empty on old servers/malformed frames, which simply hides
  // the selector — the wall never white-screens on a pre-build-loop snapshot.
  const backends = useMemo(() => backendsOf(snapshot), [snapshot]);

  // BACKEND TOGGLE: flip one build backend on/off for FUTURE builds. Live mode
  // POSTs /api/backends {id, enabled} and applies the returned snapshot —
  // guarded, so a thin {"ok":true} acknowledgment can never wipe the wall.
  // Offline demo flips the chip locally so static fixtures stay interactive.
  const toggleBackend = useCallback(
    async (id: string, enabled: boolean) => {
      if (!liveMode) {
        setSnapshot((current) => {
          const next: BuildloopSnapshot = {
            ...current,
            backends: backendsOf(current).map((backend) =>
              backend.id === id ? { ...backend, enabled } : backend,
            ),
          };
          return next;
        });
        return;
      }
      try {
        const response = await fetch("/api/backends", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, enabled }),
        });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.json();
          if (looksLikeSnapshot(body)) {
            setSnapshot(body);
          }
        }
      } catch {
        // Non-authoritative projector: a failed toggle must never block the UI.
      }
    },
    [liveMode],
  );

  // PER-CARD LIFECYCLE: pause/resume/halt ONE process (fleet-card buttons, plus
  // 'k' = halt the selected process). Live mode POSTs /api/process/:upid/{action}
  // and applies the returned snapshot when it is one; offline demo applies the
  // state change locally so the static fleet stays interactive.
  const processLifecycle = useCallback(
    async (upid: string, action: LifecycleAction) => {
      if (!liveMode) {
        const nextState = action === "pause" ? "paused" : action === "resume" ? "active" : "halted";
        setSnapshot((current) => ({
          ...current,
          processes: current.processes.map((process) =>
            process.upid === upid ? { ...process, state: nextState } : process,
          ),
        }));
        return;
      }
      try {
        const response = await fetch(`/api/process/${encodeURIComponent(upid)}/${action}`, {
          method: "POST",
        });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.json();
          if (looksLikeSnapshot(body)) {
            setSnapshot(body);
          }
        }
      } catch {
        // Non-authoritative projector: a failed lifecycle POST must never block the UI.
      }
    },
    [liveMode],
  );

  // COMMISSION (the two-stage pivot's explicit second stage): POST
  // /api/process/:upid/execute starts the real subscription execution lane
  // (executing → built with the full-app preview). Live mode applies the
  // returned snapshot when it is one (guarded, so a thin {"ok":true} ack can
  // never wipe the wall); offline demo writes local execution telemetry so
  // the concept→commissioned transformation stays demonstrable end-to-end.
  const commissionProcess = useCallback(
    async (upid: string) => {
      if (!liveMode || mockModeRef.current) {
        setSnapshot((current) => ({
          ...current,
          processes: current.processes.map((process) =>
            process.upid === upid
              ? ({
                  ...process,
                  execution: {
                    status: "executing",
                    progressLabel: "subscription run queued",
                    percent: 4,
                    previewUrl: null,
                    summary: null,
                  },
                } as StagedProcess)
              : process,
          ),
        }));
        return;
      }
      try {
        const response = await fetch(`/api/process/${encodeURIComponent(upid)}/execute`, {
          method: "POST",
        });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.json();
          if (looksLikeSnapshot(body)) {
            setSnapshot(body);
          }
        }
      } catch {
        // Non-authoritative projector: a failed commission POST must never
        // block the UI; the chip simply stays on concept until the SSE stream
        // reports otherwise.
      }
    },
    [liveMode],
  );

  // DECK DECISION ("How should we continue?") — fired by the deck overlay's
  // room-native decision bar (dwell/click) or by a postMessage from the
  // generated deck's in-iframe decision slide (see the bridge effect below).
  //   commission → fire the REAL commission for the deck's process; the deck
  //                stays open so the executing chip is immediately visible.
  //   iterate/done → close the deck.
  // If the guided demo is at its decide finale, ANY choice completes the demo
  // (with an epilogue note; commissioning is an epilogue, never waited on).
  const deckDecision = useCallback(
    (upid: string, choice: DecisionChoice) => {
      if (choice === "commission") {
        void commissionProcess(upid);
      } else {
        setSlideshowUpid(null);
      }
      if (guidedRef.current !== null && guidedRef.current.step === "decide") {
        setGuided(null);
        setGuidedEpilogue(
          choice === "commission"
            ? "Commissioned! The real build is now executing — watch this concept's tree grow."
            : choice === "iterate"
              ? "Demo complete — keep talking to reshape the concept."
              : "Demo complete — the concept stays on the wall.",
        );
      }
    },
    [commissionProcess],
  );
  const deckDecisionRef = useRef(deckDecision);
  deckDecisionRef.current = deckDecision;

  // DECK DWELL BRIDGE (postMessage half): the generated deck renders its own
  // decision slide with data-dwell buttons inside an iframe, which the dwell
  // layer cannot reach — so the room mirrors the choices as native buttons
  // (Slideshow's deck-decision bar). But a mouse/touch click INSIDE the
  // iframe still lands here: the deck posts {type:"vibersyn:decision",
  // choice} and this listener routes it through the same handler. Origin is
  // deliberately open (decks are served from per-build 127.0.0.1 ports); the
  // payload is strictly validated and only acted on while a deck is open.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const onMessage = (messageEvent: MessageEvent) => {
      const choice = parseDeckDecisionMessage(messageEvent.data);
      if (choice === null) {
        return;
      }
      const upid = slideshowRef.current;
      if (upid !== null) {
        deckDecisionRef.current(upid, choice);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

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

  // ── guided demo actions ────────────────────────────────────────────────────
  // (Re-)enter: always a FRESH run — step 1, zero orbs, baseline = the fleet
  // as it stands right now. Any open deck closes so step 1 owns the wall.
  const enterGuidedDemo = useCallback(() => {
    setSlideshowUpid(null);
    setGuided(startGuided(snapshotRef.current));
  }, []);
  const exitGuidedDemo = useCallback(() => setGuided(null), []);
  const guidedPopOrb = useCallback(() => {
    setGuided((current) => (current === null ? current : popPracticeOrb(current)));
  }, []);
  const guidedSkip = useCallback(() => {
    setGuided((current) => (current === null ? current : skipStep(current, snapshotRef.current)));
  }, []);

  // GUIDED RECORD (step 2's big button): REALLY unmute (/api/unmute), turn on
  // Idea Capture (/api/capture {on:true}) and Auto-Build (/api/auto-accept
  // {on:true}) — the exact endpoints the keyboard u/c/a path uses — and start
  // the browser mic so the room can actually hear the visitor. The step itself
  // advances only when the SNAPSHOT confirms unmuted+capturing, so a failed
  // POST leaves the coach on step 2 telling the truth. Offline demo applies
  // the same states locally so the flow stays testable without a server.
  const guidedRecord = useCallback(async () => {
    try {
      if (snapshotRef.current.muted) {
        await releaseMute();
      }
      if (liveMode) {
        for (const url of ["/api/capture", "/api/auto-accept"]) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ on: true }),
          });
          if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
            const body: unknown = await response.json();
            if (looksLikeSnapshot(body)) {
              setSnapshot(body);
            }
          }
        }
      } else {
        setSnapshot((current) => ({ ...current, muted: false, listening: true, captureMode: true, autoAccept: true }));
      }
    } catch {
      // Non-authoritative projector: a failed POST must never wedge the demo.
    }
    if (micHandleRef.current === null) {
      void toggleMic();
    }
  }, [liveMode, releaseMute, toggleMic]);

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

  // SELF-HOSTING (VIBERSYN_SELF_MODE=1): bind this page to the server's
  // per-boot id; when a reconnected SSE stream / state resync delivers a
  // DIFFERENT bootId, the server was rebuilt and relaunched underneath us
  // (exit 87 → supervisor → new build) — reload so this wall runs the new
  // build too. The decision is the pure trackBootId fold (unit-tested); the
  // "room is reloading itself…" overlay keeps the wall alive-looking from
  // reloadPending until the reload lands.
  const selfState = selfOf(snapshot);
  const bootBindingRef = useRef<string | null>(null);
  useEffect(() => {
    const next = trackBootId(bootBindingRef.current, snapshot);
    bootBindingRef.current = next.bound;
    if (next.reload && typeof window !== "undefined") {
      window.location.reload();
    }
  }, [snapshot]);

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
  // Current selection mirrored the same way, so 'k' (halt selected) reads the
  // latest selection without re-binding the listener on every click.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // --- Keyboard: the primary desk-mode control surface (SSR-guarded) ---
  // 1–9 select/steer · b/Enter build top idea · x dismiss · c capture · a auto-
  // build · m mic · u unmute · q QR · ?/h help · k halt selected · Shift+E
  // emergency · Esc close.
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
        if (slideshowRef.current !== null) {
          setSlideshowUpid(null);
          return;
        }
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
        // Esc exits the guided demo at any step (documented; skip stays a
        // per-step button). The deck/help/QR overlays above close first.
        if (guidedRef.current !== null) {
          setGuided(null);
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
        case "l":
          setSceneLayout((current) => (current === "radial" ? "ball" : current === "ball" ? "disk" : "radial"));
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
        case "k": {
          // Halt the SELECTED process (not the idea bubble, and not a no-op on a
          // terminal state) — the keyboard parity for the fleet card's Halt button.
          const target = snapshotRef.current.processes.find(
            (process) => process.callsign === selectedRef.current,
          );
          if (target && lifecycleActionsFor(target.state).includes("halt")) {
            void processLifecycle(target.upid, "halt");
          }
          return;
        }
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
  }, [
    selectBubble,
    actOnTopIdea,
    toggleCaptureMode,
    toggleAutoAccept,
    toggleMic,
    releaseMute,
    triggerEmergency,
    processLifecycle,
    clearHidden,
  ]);

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

  // TWO-WALL CONTRACT: every window renders the FULL room. The legacy
  // ?view=ideas|builds param still parses (old URLs keep working and it labels
  // the wall badge) but it NEVER filters content any more — both walls show
  // every idea surface AND the whole build fleet. Only Mock Room hides the 2D
  // rail/tray (a pure 3D showcase).
  const ideas = snapshot.ideas ?? [];
  const showIdeaTray = ideas.length > 0;

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
  // Each spec carries the INFERRED project title (process.task) for the node
  // label, the live steering flag so the scene can ring the current steering
  // target, and the TWO-STAGE stage: concepts render as saplings, a
  // commissioned project visibly grows into the full tree (gold ring).
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
          steering: process.upid === steeringUpid,
          // The scene knows sapling/tree only; the SELF project folds onto
          // that axis by whether a self-run is live (sceneStageOf).
          stage: sceneStageOf(process),
        })),
    [snapshot.processes, hiddenTrees, steeringUpid],
  );

  const visibleIdeaOrbs = useMemo<IdeaOrbSpec[]>(
    () => ideaOrbs.filter((orb) => !hiddenIdeas.has(orb.id ?? "__primary__")),
    [ideaOrbs, hiddenIdeas],
  );

  // Clicking a project in the scene: mock/demo processes with a FIXTURE deck
  // open their slideshow (mock room has no rail, so the scene click is the only
  // deck path there); every live process steers — click-to-steer stays the
  // primary live semantic, and real generated decks open from the fleet card's
  // "Deck ▸" button instead.
  const selectSceneProcess = useCallback(
    (callsign: string) => {
      const process = snapshotRef.current.processes.find(
        (candidate) => candidate.callsign === callsign || candidate.upid === callsign,
      );
      if (process !== undefined && (process.slides?.length ?? 0) > 0) {
        setSlideshowUpid(process.upid);
        return;
      }
      void steerProcess(callsign);
    },
    [steerProcess],
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

  // GESTURE MODE (fusion cursors drive the UI): there is NO cursor glyph and NO
  // OS cursor — the `gesture-mode` class hides the pointer everywhere, and the
  // pointed-at target's highlight + dwell ring are the only feedback. Pointer
  // navigation on the scene is disabled so pointing never fights drag-orbit.
  // ?dwell=mouse mounts the same dwell layer driven by the mouse (testing/
  // accessibility) with the OS cursor and drag-orbit left intact.
  const gestureMode = urlConfig.gesture !== null;
  const dwellLayerOn = gestureMode || urlConfig.dwell === "mouse";
  // AUDIT (no-mocks): the Mock Room toggle renders ONLY behind ?mock=1.
  const mockRoomEnabled = urlConfig.mock;

  return (
    <main
      className={`deep${zenMode ? " zen" : ""}${gestureMode ? " gesture-mode" : ""}`}
      data-testid="app"
      data-view={view}
      data-zen={zenMode ? "true" : "false"}
      data-gesture={gestureMode ? "true" : "false"}
    >
      <RoomScene
        ideas={visibleIdeaOrbs}
        trees={treeSpecs}
        mode={sceneMode}
        layout={sceneLayout}
        wall={urlConfig.wall}
        fitSignal={fitSignal}
        focusUpid={
          guided !== null && (guided.step === "race" || guided.step === "decide")
            ? guided.focusUpid
            : null
        }
        pointerNav={!gestureMode}
        onAcceptIdea={acceptOrb}
        onSelectProcess={selectSceneProcess}
      />
      {dwellLayerOn ? (
        <GestureLayer
          wall={urlConfig.gesture?.wall ?? "A"}
          fusionUrl={urlConfig.gesture?.fusionUrl ?? ""}
          mouseTest={urlConfig.dwell === "mouse"}
          showCursor={showCursor}
        />
      ) : null}
      {/* PINCH CAMERA (?hands=): composes with gesture mode — pointerNav only
          unbinds DOM listeners, the rig stays drivable through the registered
          camera control — and with desk mode via the rig's latest-writer-wins
          d* contract. */}
      {urlConfig.hands !== null ? <PinchCameraLayer url={urlConfig.hands.url} wall={urlConfig.wall} /> : null}
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
      {selfState?.reloadPending === true ? (
        <div className="self-reload-overlay" data-testid="self-reload-overlay" role="status">
          <span className="self-reload-mark">🪞</span>
          <span>room is reloading itself…</span>
        </div>
      ) : null}
      {guidedEpilogue !== null ? (
        <div className="guided-epilogue" data-testid="guided-epilogue" role="status">
          ✨ {guidedEpilogue}
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
            className={`ctl-button fullscreen${isFullscreen ? " on" : ""}`}
            data-testid="fullscreen-button"
            data-state={isFullscreen ? "on" : "off"}
            aria-pressed={isFullscreen}
            onClick={toggleFullscreen}
            title="Fill the display (projector wall). Point and dwell, or click."
          >
            {isFullscreen ? "⛶ Exit Fullscreen" : "⛶ Fullscreen"}
          </button>
          <button
            type="button"
            className={`ctl-button cursor-toggle${showCursor ? " on" : ""}`}
            data-testid="cursor-toggle-button"
            data-state={showCursor ? "on" : "off"}
            aria-pressed={showCursor}
            onClick={() => setShowCursor((v) => !v)}
            title="Show/hide the motion-tracking cursor — a dot marking where the camera sees your hand. Handy for aiming; off by default."
          >
            {showCursor ? "◉ Cursor: ON" : "◎ Cursor: OFF"}
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
            className={`ctl-button guided-launch${guided !== null ? " on" : ""}`}
            data-testid="guided-demo-button"
            data-state={guided !== null ? "on" : "off"}
            aria-pressed={guided !== null}
            onClick={enterGuidedDemo}
            title="Guided demo (kickoff phase): point, record, say an idea, watch three mock concepts race, then decide on the pitch deck. Restarts from step 1."
          >
            Guided Demo
          </button>
          {/* AUDIT (no-mocks): the Mock Room fixture toggle is HIDDEN unless the
              launcher opts in with ?mock=1 (run-room.sh appends it only when
              VIBERSYN_MOCK_ROOM=1). A default room never offers canned decks. */}
          {mockRoomEnabled ? (
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
          ) : null}
        </div>
      </header>

      {!mockMode ? <SuggestionRegion pitch={snapshot.suggestion.pitch} /> : null}

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
            <BackendSelector
              backends={backends}
              onToggle={(id, enabled) => void toggleBackend(id, enabled)}
            />
            <FleetPanel
              processes={snapshot.processes}
              selected={selected}
              steeringUpid={steeringUpid}
              onSelect={(id) => void steerProcess(id)}
              onLifecycle={(upid, action) => void processLifecycle(upid, action)}
              onOpenDeck={(upid) => setSlideshowUpid(upid)}
              onCommission={(upid) => void commissionProcess(upid)}
            />
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
          className="ctl-button scene-layout"
          data-testid="scene-layout-button"
          data-layout={sceneLayout}
          onClick={() =>
            setSceneLayout((current) => (current === "radial" ? "ball" : current === "ball" ? "disk" : "radial"))
          }
          title="Cycle the spatial layout (L): radial → H3 Poincaré ball → Poincaré disk."
        >
          {sceneLayout === "radial" ? "⊹ Radial" : sceneLayout === "ball" ? "◉ Ball" : "⊙ Disk"}
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

      {slideshowUpid !== null
        ? (() => {
            const deckProcess = snapshot.processes.find((candidate) => candidate.upid === slideshowUpid);
            return deckProcess !== undefined ? (
              <Slideshow
                process={deckProcess}
                onLifecycle={(upid, action) => void processLifecycle(upid, action)}
                onClose={() => setSlideshowUpid(null)}
                initialBackend={guided?.step === "decide" ? guided.readyBackend : null}
                onDecision={(choice) => deckDecision(deckProcess.upid, choice)}
              />
            ) : null;
          })()
        : null}
      {qrOpen ? <QrImport processes={snapshot.processes} onClose={() => setQrOpen(false)} /> : null}
      {helpOpen ? <HelpOverlay onClose={() => setHelpOpen(false)} gestureMode={gestureMode} /> : null}
      {guided !== null ? (
        <GuidedDemo
          state={guided}
          snapshot={snapshot}
          micState={micState}
          micError={micError}
          onPopOrb={guidedPopOrb}
          onRecord={() => void guidedRecord()}
          onSkip={guidedSkip}
          onExit={exitGuidedDemo}
          onFinish={exitGuidedDemo}
        />
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
  onLifecycle,
  onOpenDeck,
  onCommission,
}: {
  processes: ProjectorProcess[];
  selected: string | null;
  steeringUpid: string | null;
  onSelect: (id: string) => void;
  onLifecycle: (upid: string, action: LifecycleAction) => void;
  onOpenDeck: (upid: string) => void;
  onCommission: (upid: string) => void;
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
          const builds = buildsOf(process);
          // TWO-STAGE surfaces: a project with mock lanes is a CONCEPT until
          // an explicit commission starts the execution lane (COMMISSIONED).
          // Legacy processes with no build surfaces at all get no badge.
          const stage = stageOf(process);
          const execution = executionOf(process);
          // The SELF (mirror) project always shows its stage badge — its whole
          // identity is the stage — even before any self-run opens a lane.
          const hasBuildSurface =
            builds.length > 0 || execution !== null || typeof process.buildStatus === "string" || stage === "self";
          // Commission is offered once ANY mock lane is ready (there is a
          // concept worth executing) and only while still a concept.
          const commissionable =
            stage === "concept" && builds.some((build) => build.status === "ready");
          // A deck exists when the process carries fixture slides (mock room) or
          // any backend build published a REAL generated slideshow.
          const hasDeck =
            (process.slides?.length ?? 0) > 0 || builds.some((build) => build.slideshowUrl !== null);
          return (
          <article
            key={process.upid}
            className={`fleet-panel state-${process.state}${process.callsign === selected ? " selected" : ""}${steering ? " steering" : ""} stage-${stage}`}
            data-testid="fleet-panel"
            data-dwell="steer"
            data-callsign={process.callsign}
            data-state={process.state}
            data-steering={steering ? "true" : "false"}
            data-stage={stage}
            onClick={() => onSelect(process.callsign)}
          >
            <div className="fleet-panel-head">
              <strong className="fleet-callsign">{process.callsign}</strong>
              <span className={`fleet-state badge state-${process.state}`}>{process.state}</span>
              {hasBuildSurface ? (
                <span
                  className={`stage-badge stage-${stage}`}
                  data-testid="process-stage"
                  data-stage={stage}
                >
                  {stage === "self" ? "🪞 SELF" : stage === "concept" ? "🌱 concept" : "🌳 commissioned"}
                </span>
              ) : null}
              {steering ? <span className="fleet-steering" data-testid="fleet-steering">steering →</span> : null}
            </div>
            {process.task.length > 0 ? (
              <p className="fleet-task" data-testid="fleet-task">{process.task}</p>
            ) : null}
            <p className="fleet-output">{process.lastOutput || "—"}</p>
            <p className="fleet-action">↳ {process.lastAction}</p>
            <BuildChips builds={builds} stage={stage} />
            {execution !== null ? <ExecutionChip execution={execution} /> : null}
            {/* Take-home QR: the published deck's Pages URL, scannable from a
                phone at projector distance. */}
            {typeof process.publishedUrl === "string" && typeof process.publishedQrSvg === "string" ? (
              <TakeHomeQr url={process.publishedUrl} qrSvg={process.publishedQrSvg} size="card" />
            ) : null}
            <div className="fleet-actions-row">
              <ProcessControls upid={process.upid} state={process.state} onLifecycle={onLifecycle} />
              {commissionable ? (
                <CommissionButton upid={process.upid} onCommission={onCommission} />
              ) : null}
              {hasDeck ? (
                <button
                  type="button"
                  className="fleet-ctl fleet-ctl-deck"
                  data-testid="process-deck-button"
                  title="Open this project's slideshow deck."
                  onClick={(clickEvent) => {
                    clickEvent.stopPropagation();
                    onOpenDeck(process.upid);
                  }}
                >
                  Deck ▸
                </button>
              ) : null}
            </div>
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

// Re-export for any consumer that needs the inline-style helper shape.
export type ProjectorStyle = CSSProperties;
