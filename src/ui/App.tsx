import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { demoProjectorSnapshot, busyRoomSnapshot, emptyProjectorSnapshot, withUnmuted } from "./demo-data";
import type { ProjectorProcess, ProjectorSnapshot, ResearchTrayItem, TranscriptLine } from "./types";
import { GestureLayer } from "./gesture/GestureLayer";
import { CalibrationOverlay, type AutocalState } from "./CalibrationOverlay";
import { PinchCameraLayer } from "./gesture/PinchCameraLayer";
import { HandSkeletonHud } from "./gesture/HandSkeletonHud";
import type { HandsStatus } from "./gesture/hands-client";
import { RoomScene, type DialogueNodeSpec, type DialogueTopicSpec, type IdeaOrbSpec, type ResearchNodeSpec, type SceneLayout, type SceneMode, type TreeSpec } from "./RoomScene";
import { getSceneDwellSource, procDwellTargetId, type SceneDwellRect } from "./gesture/scene-source";
import { Slideshow } from "./Slideshow";
import { TreeMenu } from "./TreeMenu";
import { BranchPopup } from "./BranchPopup";
import { IssuePopup } from "./IssuePopup";
import type { IssueInfo } from "./tree-limbs";
import { HoloPanel } from "./HoloPanel";
import { IdeaTray } from "./IdeaTray";
import { ResearchTray } from "./ResearchTray";
import { ResearchDeckOverlay } from "./ResearchDeckOverlay";
import { QrImport } from "./QrImport";
import { GuestHands } from "./GuestHands";
import { roomHandsSocketUrl } from "./gesture/remote";
import { HelpOverlay } from "./HelpOverlay";
import { ControlDock } from "./ControlDock";
import { useSelfRepoTree, type SelfBranchesPayload, type SelfTreeSeed } from "./self-repo";
import { buildsOf, lifecycleActionsFor, looksLikeSnapshot } from "./buildloop";
import type { LifecycleAction } from "./buildloop";
import { executionOf, parseDeckDecisionMessage, sceneStageOf, stageOf } from "./stage";
import type { DecisionChoice, StagedProcess } from "./stage";
import { selfOf, trackBootId } from "./self-reload";
import { parseProjectorUrl } from "./url-params";
import { GuidedDemo } from "./guided/GuidedDemo";
import { advanceOnSnapshot, popPracticeOrb, skipStep, startGuided, type GuidedState } from "./guided/machine";
import "./buildloop.css";
import { startMicCapture, type MicCaptureHandle } from "./mic";

export const REQUIRED_PROJECTOR_REGIONS = [
  "status",
  "fleet",
  "transcript",
] as const;

interface ProjectorAppProps {
  initialSnapshot?: ProjectorSnapshot;
  // Test seam: overrides window.location.search for URL-config parsing so the
  // (windowless) test renderer can exercise wall/view URLs.
  urlSearch?: string;
  // Test seam: boot with an on-demand overlay already open so the (static,
  // effect-free) test renderer can assert the de-themed overlay contract —
  // menu/deck/QR overlays open on WHICHEVER wall summons them, never only
  // on view=builds. `selected` takes a callsign/upid and opens the per-tree
  // MENU (the static renderer's stand-in for a scene pick), `slideshowUpid`
  // a upid, `ideaCard` an idea-action-card target (id null = the primary
  // suggestion).
  initialOverlay?: {
    selected?: string;
    slideshowUpid?: string;
    qrOpen?: boolean;
    ideaCard?: { id: string | null };
    // Opens the HOLO PANEL (the imported tree's live /salem app) on this upid
    // — the static renderer's stand-in for the tree menu's "Live app" press.
    holoUpid?: string;
    // Opens the BRANCH POPUP (an adopted tree's limb-tip card) — the static
    // renderer's stand-in for picking a limb tip in the scene.
    branchPopup?: { upid: string; branch: string };
    // Opens the ISSUE POPUP (an adopted tree's fruit card) with the full
    // issue payload (the static renderer cannot poll /api/…/issues).
    issuePopup?: { upid: string; issue: IssueInfo };
    // Boots the wall-bound auto-calibration overlay with a calibrator state
    // (the static renderer cannot poll /api/autocal/state).
    calibration?: AutocalState;
  };
  // Test seam: seeds the self-repo tree data (the effect-free static renderer
  // cannot fetch /api/self-repo + /api/forest), so armed-wall markup tests can
  // assert the garden receives the room's own tree.
  initialSelfTree?: SelfTreeSeed;
  // Test seam: seeds the room's own version rails (/api/self/branches), so a
  // static render of a SELF branch popup can assert the load / you-are-here /
  // not-on-this-machine states.
  initialSelfBranches?: SelfBranchesPayload;
}

// AUTO-RELOAD ON NEW BUILDS: every window polls /api/build-stamp on this
// cadence, and a changed stamp reloads after a random 0–{jitter} delay so the
// projector windows never hammer the freshly-restarted server simultaneously.
const BUILD_STAMP_POLL_MS = 20_000;
const BUILD_RELOAD_JITTER_MS = 2_000;

// The synthetic id used for the (single) idea/suggestion bubble.
const IDEA_ID = "idea";

// "Park it for later" shows its confirmation strip this long before the deck
// window closes itself (the choice must visibly land at projector distance).
const PARK_CONFIRM_MS = 2_000;
// The tab that holds the room's microphone. A self-rebuild restarts the server
// and every wall reloads; without this the mic pipeline died with the old page
// and the room sat deaf until a human noticed and pressed the button again.
const MIC_OWNER_KEY = "vibersyn.mic.owner";

// ISSUE FRUIT poll cadence: while an adopted tree stands, its open GitHub
// issues refresh on this interval (GET /api/process/:upid/issues).
export const ISSUE_POLL_MS = 60_000;

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

export function ProjectorApp({ initialSnapshot, urlSearch, initialOverlay, initialSelfTree, initialSelfBranches }: ProjectorAppProps) {
  // Window configuration from the URL, parsed FIRST — the guided-demo entry
  // and Mock-Room gates below depend on it: wall identity badge (?wall=A|B),
  // the view param (?view=ideas|builds — scopes the 2D surfaces + controls to
  // that wall; the default full view renders everything), and the gesture
  // layer — which mounts ONLY on an explicit ?gesture=1 or ?fusion= (desk mode
  // is the default; a bare ?wall= is just a badge so two-wall projections work
  // without cameras).
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
  // PINCH CAMERA (TouchDesigner/MediaPipe hands): runtime-toggleable from the
  // HUD, seeded from the ?hands= URL default so launcher flags still opt in.
  // handsStatus surfaces the live socket state on the toggle (OFF / connecting
  // / LIVE); it resets to "closed" whenever the layer unmounts.
  const [handsOn, setHandsOn] = useState<boolean>(urlConfig.hands !== null);
  const [handsStatus, setHandsStatus] = useState<HandsStatus>("closed");
  // ?hands= carries the resolved URL; a manual toggle (no URL opt-in) falls
  // back to the TD/MediaPipe default port on this page's host.
  const handsUrl = useMemo(() => {
    if (urlConfig.hands !== null) {
      return urlConfig.hands.url;
    }
    const host = typeof window !== "undefined" && window.location.hostname ? window.location.hostname : "localhost";
    return `ws://${host}:9980`;
  }, [urlConfig.hands]);
  const toggleHands = useCallback(() => {
    setHandsOn((on) => {
      if (on) {
        setHandsStatus("closed");
      }
      return !on;
    });
  }, []);

  // AUDIT (no-mocks): with no explicit snapshot prop the wall boots from the
  // EMPTY live baseline — never the Atlas/Cobalt fixture — so a live window
  // shows nothing canned while /api/state resolves (or when the server is
  // down). The offline demo (?live=0, or DEV without ?live=1) seeds the
  // interactive demo fixture in an effect below.
  const [snapshot, setSnapshot] = useState(initialSnapshot ?? emptyProjectorSnapshot);
  const [selected, setSelected] = useState<string | null>(initialOverlay?.selected ?? null);
  // Where the selected tree stood ON SCREEN at pick time (RoomScene projects
  // its dwell rect through onSelectProcess) — the tree menu anchors beside it.
  // Null = no projection (keyboard select / test seam): the menu edge-rests.
  const [menuAnchor, setMenuAnchor] = useState<SceneDwellRect | null>(null);
  const [isUnmuting, setIsUnmuting] = useState(false);
  // Is the live push stream actually attached? Starts optimistic so a wall that
  // has never connected (offline demo, static render) shows no alarm; the SSE
  // error handler flips it and the next landing frame flips it back.
  const [streamLive, setStreamLive] = useState(true);
  // WHICH PARTS OF THIS ROOM ARE STAND-INS. The server knows exactly which
  // legs are running stubbed backends and has always said so on /api/health —
  // but nothing in the UI ever fetched it, so a room whose judge, build
  // substrate and voice were all simulated looked identical on the wall to a
  // fully real one. Nobody standing in the room could tell.
  const [standIns, setStandIns] = useState<string[]>([]);
  const [micState, setMicState] = useState<"off" | "connecting" | "live">("off");
  // Per-TAB marker (not localStorage): the one window holding the room's mic.
  // Survives the reload a self-rebuild forces; never leaks to the other walls.
  const [micLevel, setMicLevel] = useState(0);
  const [micError, setMicError] = useState<string | null>(null);
  const micHandleRef = useRef<MicCaptureHandle | null>(null);
  // In-flight mic start, set SYNCHRONOUSLY before the first await in toggleMic.
  // getUserMedia can take seconds (permission prompt), and micHandleRef is only
  // assigned after it resolves — without this guard a held key / double-click
  // launches a SECOND pipeline and the loser keeps capturing + streaming with
  // nothing left pointing at it. This ref is also the start's OWNERSHIP token:
  // stopMic clears it to disown a pending start, and a disowned start tears
  // down its own pipeline instead of committing it (see toggleMic).
  const micStartRef = useRef<Promise<void> | null>(null);
  const [qrOpen, setQrOpen] = useState(initialOverlay?.qrOpen ?? false);
  // HOLO PANEL (the imported tree's LIVE deployment via the /salem proxy): at
  // most ONE at a time — {upid, anchor} or null. Opened from the tree menu's
  // "🌐 Live app ▸" row (which closes the menu, handing over its anchor);
  // dwell-miss closes it FIRST (closeTopPopup — holo before tree menu).
  const [holoPanel, setHoloPanel] = useState<{ upid: string; anchor: SceneDwellRect | null } | null>(
    initialOverlay?.holoUpid !== undefined ? { upid: initialOverlay.holoUpid, anchor: null } : null,
  );
  const holoPanelRef = useRef<{ upid: string; anchor: SceneDwellRect | null } | null>(null);
  holoPanelRef.current = holoPanel;
  // BRANCH / ISSUE POPUPS (adopted trees): the contextual glass a limb-tip or
  // fruit pick opens, anchored to the SUB-OBJECT's projected rect. At most
  // one of the pair at a time; both sit ABOVE the tree menu in the
  // closeTopPopup ordering (under the holo panel).
  const [branchPopup, setBranchPopup] = useState<{ upid: string; branch: string; anchor: SceneDwellRect | null } | null>(
    initialOverlay?.branchPopup !== undefined
      ? { upid: initialOverlay.branchPopup.upid, branch: initialOverlay.branchPopup.branch, anchor: null }
      : null,
  );
  const branchPopupRef = useRef<typeof branchPopup>(null);
  branchPopupRef.current = branchPopup;
  const [issuePopup, setIssuePopup] = useState<{ upid: string; issue: IssueInfo; anchor: SceneDwellRect | null } | null>(
    initialOverlay?.issuePopup !== undefined
      ? { upid: initialOverlay.issuePopup.upid, issue: initialOverlay.issuePopup.issue, anchor: null }
      : null,
  );
  const issuePopupRef = useRef<typeof issuePopup>(null);
  issuePopupRef.current = issuePopup;
  // GUEST HANDS overlay (the URL/QR other computers open to get hand controls).
  const [guestsOpen, setGuestsOpen] = useState(false);
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
  const [slideshowUpid, setSlideshowUpid] = useState<string | null>(initialOverlay?.slideshowUpid ?? null);
  // Which backend tab the deck window opens on (a lane's View button targets
  // its own lane; null = the window's default).
  const [slideshowBackend, setSlideshowBackend] = useState<string | null>(null);
  const slideshowRef = useRef<string | null>(null);
  slideshowRef.current = slideshowUpid;
  // POST-CHOICE deck decision state for the OPEN deck window (Phase 2 decide
  // redesign): null = still asking; "commission" collapses the bar to a
  // status strip, "iterate" swaps it for the inline steer input (deck stays
  // open), "done" shows the parked confirmation for ~2s and then closes.
  // Reset whenever the deck target changes (each open deck asks fresh).
  const [deckDecisionState, setDeckDecisionState] = useState<DecisionChoice | null>(null);
  const parkCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDeckDecisionState(null);
    if (parkCloseTimerRef.current !== null) {
      clearTimeout(parkCloseTimerRef.current);
      parkCloseTimerRef.current = null;
    }
  }, [slideshowUpid]);
  // Research dossier overlay: the quest id whose deck is open, or null.
  const [researchDeckId, setResearchDeckId] = useState<string | null>(null);
  const researchDeckRef = useRef<string | null>(null);
  researchDeckRef.current = researchDeckId;
  // IDEA ACTION CARD: clicking an idea orb in the scene opens this contextual
  // card (bottom-center, above the scene controls) instead of building on the
  // spot — id null = the primary suggestion bubble, otherwise a ledger idea.
  // The card's "✓ Done — build it" runs the old instant-accept behavior.
  const [ideaCard, setIdeaCard] = useState<{ id: string | null } | null>(initialOverlay?.ideaCard ?? null);
  const ideaCardRef = useRef<{ id: string | null } | null>(null);
  ideaCardRef.current = ideaCard;
  // ?zen=1 boots a dedicated display straight into the chrome-less scene.
  const [zenMode, setZenMode] = useState(urlConfig.zen);
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
    setGuided((current) => (current === null ? current : advanceOnSnapshot(current, snapshot, Date.now())));
  }, [snapshot]);

  // The race step's minimum dwell can elapse with no snapshot arriving (the
  // mocks already finished), so tick the machine while the race is on screen.
  const guidedStep = guided?.step ?? null;
  useEffect(() => {
    if (guidedStep !== "race") {
      return;
    }
    const timer = setInterval(() => {
      setGuided((current) =>
        current === null ? current : advanceOnSnapshot(current, snapshotRef.current, Date.now()),
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [guidedStep]);

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

  // A CONTROL THAT FAILS MUST SAY SO. These handlers applied the snapshot on
  // response.ok and did nothing whatsoever otherwise — no error, no busy
  // state, not even a repaint. Measured with each endpoint forced to 500: four
  // of five high-stakes controls produced no change of any kind for 2.1-2.4s,
  // so the person presses again, and again. The commission path already had
  // this rule written beside it ("a dead button reads as a broken wall"); it
  // was just never applied to the rest of them.
  const reportControlFailure = useCallback((what: string, status?: number) => {
    setGuidedEpilogue(
      status === undefined
        ? `${what} failed (no answer from the room) — nothing changed.`
        : `${what} failed (${status}) — nothing changed.`,
    );
  }, []);
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

  // Toggle selection: selecting the already-open bubble closes it. Keyboard/
  // programmatic selects carry no screen anchor — the menu edge-rests.
  const selectBubble = useCallback(
    (id: string) => {
      const next = resolveSelection(id);
      setMenuAnchor(null);
      setSelected((current) => (current !== null && current === next ? null : next));
    },
    [resolveSelection],
  );

  const closeMenu = useCallback(() => setSelected(null), []);

  // The current steering target UPID (CLICK A PROJECT -> STEER IT). Surfaced on the
  // live snapshot; null in the static demo.
  const steeringUpid = snapshot.steeringUpid ?? null;

  // CLICK THE IDEA BUBBLE -> BUILD. In live mode the popped idea bubble's primary
  // click POSTs /api/suggestion/accept, which accepts the current pending
  // suggestion and starts the real build; the returned snapshot is applied. In
  // offline demo there is no runtime, so it falls back to opening the idea detail.
  const acceptIdea = useCallback(async (): Promise<ProjectorSnapshot | null> => {
    if (!liveMode || mockModeRef.current) {
      selectBubble(IDEA_ID);
      return null;
    }
    try {
      const response = await fetch("/api/suggestion/accept", { method: "POST" });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        const fresh = (await response.json()) as ProjectorSnapshot;
        setSnapshot(fresh);
        return fresh;
      }
    } catch {
      // Non-authoritative projector: a failed accept must never block the UI.
    }
    return null;
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
        } else {
          // The most consequential button in the room. With the endpoint
          // failing the wall was completely unchanged 2.4s later — no tree, no
          // word about it — which is indistinguishable from "the build is
          // thinking". Never leave that silent.
          reportControlFailure(action === "accept" ? "Build it" : "Dismiss", response.status);
        }
      } catch {
        reportControlFailure(action === "accept" ? "Build it" : "Dismiss");
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
      } else {
        reportControlFailure("Auto-build", response.status);
      }
    } catch {
        reportControlFailure("Auto-build");
      // Non-authoritative projector: a failed toggle must never block the UI.
    }
  }, [liveMode]);

  // SELF-REBUILD toggle ("the room rebuilds itself"). Flips the server-side
  // runtime flag gating the green-self-commit → rebuild-and-relaunch (exit 87)
  // trigger. The supervisor wrapper is boot-time (run-room.sh --self), so the
  // button's title says honestly whether flipping ON arms a live supervisor
  // (snapshot.selfSupervisor) or only records intent for a future --self launch.
  const selfRebuild = snapshot.selfRebuild ?? false;
  const selfSupervisor = snapshot.selfSupervisor ?? false;
  // SELF-REBUILD REPO TREE: while the toggle is armed on a WALL window (never
  // the research-pinned ceiling), poll the forest payload and grow the room's
  // OWN repo as ONE MORE tree inside the RoomScene garden — not a panel. The
  // hook returns null while unarmed/warming, and RoomScene simply omits the
  // tree then.
  const selfTree = useSelfRepoTree(
    selfRebuild && urlConfig.wall !== null && !urlConfig.research,
    initialSelfTree,
  );
  const toggleSelfRebuild = useCallback(async () => {
    if (!liveMode || mockModeRef.current) {
      return;
    }
    try {
      const response = await fetch("/api/self-rebuild", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !snapshotRef.current.selfRebuild }),
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
      } else {
        reportControlFailure("Self-rebuild", response.status);
      }
    } catch {
        reportControlFailure("Self-rebuild");
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

  // RESEARCH MODE toggle. Flips the server-side suggester loop so the room's
  // conversation is watched for researchable material (fact-checks, deep-dives,
  // bias scans). Offline demo flips the flag locally so the static fixtures
  // stay interactive.
  // Room-wide mode, OR-ed with the window-local ?research=1 pin: a dedicated
  // display (ceiling projector) always shows the conversation tree while the
  // walls keep following the shared toggle. Local only — no server writes.
  // DISPLAY is window-local ONLY (?research=1 — the ceiling projector): on
  // this rig the tree has a dedicated display, so the walls never flip
  // scenes. The room-wide researchMode is purely the ENGINE switch (dialogue
  // review + sphere suggestions run server-side while it is on).
  const researchActive = urlConfig.research;
  const researchEngineOn = snapshot.researchMode ?? false;
  const toggleResearchMode = useCallback(async () => {
    if (!liveMode || mockModeRef.current) {
      setSnapshot((current) => ({ ...current, researchMode: !(current.researchMode ?? false) }));
      return;
    }
    try {
      const response = await fetch("/api/research-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: !(snapshotRef.current.researchMode ?? false) }),
      });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
      } else {
        reportControlFailure("Research mode", response.status);
      }
    } catch {
        reportControlFailure("Research mode");
      // Non-authoritative projector: a failed toggle must never block the UI.
    }
  }, [liveMode]);

  // RESEARCH TRAY actions: accept (spawn the research agent) or dismiss a
  // SPECIFIC quest. Live mode POSTs the per-quest endpoint and applies the
  // returned snapshot; offline demo mutates the card locally so the static
  // tray stays interactive.
  const actOnResearch = useCallback(
    async (id: string, action: "accept" | "dismiss") => {
      if (!liveMode || mockModeRef.current) {
        setSnapshot((current) => ({
          ...current,
          research:
            action === "dismiss"
              ? (current.research ?? []).filter((quest) => quest.id !== id)
              : (current.research ?? []).map((quest) =>
                  quest.id === id && quest.status === "proposed"
                    ? { ...quest, status: "researching" as const, progress: 12, progressLabel: "researching sources" }
                    : quest,
                ),
        }));
        return;
      }
      try {
        const response = await fetch(`/api/research/${encodeURIComponent(id)}/${action}`, { method: "POST" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          setSnapshot((await response.json()) as ProjectorSnapshot);
        }
      } catch {
        // Non-authoritative projector: a failed POST must never block the UI.
      }
    },
    [liveMode],
  );

  // Clicking a research crystal in the 3D scene: a proposed quest spawns its
  // research; a complete quest opens the dossier deck.
  const onResearchNode = useCallback(
    (id: string) => {
      const quest = (snapshotRef.current.research ?? []).find((candidate) => candidate.id === id);
      if (quest === undefined) {
        return;
      }
      if (quest.status === "proposed") {
        void actOnResearch(id, "accept");
      } else if (quest.status === "complete") {
        setResearchDeckId(id);
      }
    },
    [actOnResearch],
  );

  // ↳ Spawn a dossier's follow-up question as its own quest (child crystal).
  const researchFollowUp = useCallback(
    async (id: string, index: number) => {
      if (!liveMode || mockModeRef.current) {
        return;
      }
      try {
        const response = await fetch(`/api/research/${encodeURIComponent(id)}/followup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index }),
        });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          setSnapshot((await response.json()) as ProjectorSnapshot);
        }
      } catch {
        // Non-authoritative projector: a failed POST must never block the UI.
      }
    },
    [liveMode],
  );

  // 🌱 Reset the research tree: full clean slate server-side (vine, crystals,
  // dossiers). The returned snapshot repaints the wall in one hop.
  const resetResearchTree = useCallback(async () => {
    if (!liveMode || mockModeRef.current) {
      return;
    }
    try {
      const response = await fetch("/api/research/tree/reset", { method: "POST" });
      if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
        setSnapshot((await response.json()) as ProjectorSnapshot);
      }
    } catch {
      // Non-authoritative projector: a failed POST must never block the UI.
    }
  }, [liveMode]);

  // Clicking a dialogue TURN in the 3D tree: research that utterance directly —
  // the server creates the quest and spawns the agent in one step, no passive
  // suggestion round required.
  const onDialogueNode = useCallback(
    async (turnId: string) => {
      if (!liveMode || mockModeRef.current) {
        return; // offline demo: turns render but the direct spawn needs the server
      }
      try {
        const response = await fetch(`/api/research/turn/${encodeURIComponent(turnId)}`, { method: "POST" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          setSnapshot((await response.json()) as ProjectorSnapshot);
        }
      } catch {
        // Non-authoritative projector: a failed POST must never block the UI.
      }
    },
    [liveMode],
  );

  // CLICK/DWELL A TREE -> ITS MENU, NOTHING MORE. Picking a garden tree opens
  // that instance's anchored control menu right there (the fleet rail is gone
  // from the walls — the tree IS the interface). Picking deliberately does
  // NOT touch voice steering: it used to POST /api/process/:upid/select as a
  // side effect, which meant any dwell that landed on a tree silently routed
  // the operator's narration into that build (live-room P0). The
  // RecordSteerToggle inside the menu is the ONLY armer — it POSTs
  // select/select-clear itself and lights from the snapshot's steering flag.

  // 🗑 REMOVE (the tree menu's two-stage delete): stop this project's builds
  // and remove it from the snapshot entirely — POST /api/process/:upid/dismiss.
  // Offline demo drops the process locally so the static garden stays
  // interactive. The menu closes immediately either way (its tree is going).
  const dismissProcess = useCallback(
    async (upid: string) => {
      setSelected(null);
      if (!liveMode || mockModeRef.current) {
        setSnapshot((current) => ({
          ...current,
          processes: current.processes.filter((process) => process.upid !== upid),
        }));
        return;
      }
      try {
        const response = await fetch(`/api/process/${encodeURIComponent(upid)}/dismiss`, { method: "POST" });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.json();
          if (looksLikeSnapshot(body)) {
            setSnapshot(body);
          }
        } else {
          // The tree stays in the garden — say why, or the two-stage confirm
          // reads as having silently worked.
          reportControlFailure("Remove", response.status);
        }
      } catch {
        reportControlFailure("Remove");
      }
    },
    [liveMode, reportControlFailure],
  );

  // NOTE: the BackendSelector UI is gone (the rooms run env-configured
  // backends; /api/backends and the server-side roster logic remain for
  // operators). The wall presents build RESULTS per backend, never a chooser.

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
  // Returns whether the commission LANDED — the deck's post-choice strip must
  // not keep claiming "the real build is running" after a failed POST.
  const commissionProcess = useCallback(
    async (upid: string): Promise<boolean> => {
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
        return true;
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
        } else if (!response.ok) {
          // "Build it for real" must never be a perceived no-op: say the
          // commission failed instead of leaving the deck silently unchanged.
          setGuidedEpilogue(`Commission failed (${response.status}) — the concept is untouched; try again.`);
          return false;
        }
        return true;
      } catch {
        // Network failure: same rule — a dead button reads as a broken wall.
        setGuidedEpilogue("Commission failed (network) — the concept is untouched; try again.");
        return false;
      }
    },
    [liveMode],
  );

  // DECK DECISION ("How should we continue?") — fired by the deck overlay's
  // room-native decision bar (dwell/click) or by a postMessage from the
  // generated deck's in-iframe decision slide (see the bridge effect below).
  // Every choice leaves a VISIBLE post-choice state (Slideshow.decisionState):
  //   commission → fire the REAL commission; the bar collapses to the
  //                "Commissioned" status strip and the deck stays open so the
  //                executing chip is immediately visible.
  //   iterate    → the bar becomes the inline steer input; the deck stays open.
  //   done       → the "Parked" confirmation strip for ~2s, then the deck
  //                closes (timer guarded by upid; reset on deck change).
  // If the guided demo is at its decide finale, ANY choice completes the demo
  // (with an epilogue note; commissioning is an epilogue, never waited on).
  const deckDecision = useCallback(
    (upid: string, choice: DecisionChoice) => {
      setDeckDecisionState(choice);
      if (choice === "commission") {
        // A failed commission re-opens the question (the strip must not lie);
        // the epilogue toast explains what happened.
        void commissionProcess(upid).then((landed) => {
          if (!landed) {
            setDeckDecisionState((current) => (current === "commission" ? null : current));
          }
        });
      } else if (choice === "done") {
        if (parkCloseTimerRef.current !== null) {
          clearTimeout(parkCloseTimerRef.current);
        }
        parkCloseTimerRef.current = setTimeout(() => {
          parkCloseTimerRef.current = null;
          setSlideshowUpid((current) => (current === upid ? null : current));
        }, PARK_CONFIRM_MS);
      }
      if (guidedRef.current !== null && guidedRef.current.step === "decide") {
        setGuided(null);
        setGuidedEpilogue(
          choice === "commission"
            ? "Commissioned! The real build is now executing — watch this concept's tree grow."
            : choice === "iterate"
              ? "Demo complete — keep talking (or type below) to reshape the concept."
              : "Demo complete — the idea is parked in the tray.",
        );
      }
    },
    [commissionProcess],
  );
  // Inline steer sender for the iterate post-choice state: the SAME endpoint
  // the spoken "steer <callsign> …" path and the in-deck typed form use. Live
  // mode applies the returned snapshot when it is one; offline demo is a
  // visual no-op (the input still confirms locally).
  const deckSteer = useCallback(
    async (upid: string, text: string) => {
      if (!liveMode || mockModeRef.current) {
        return;
      }
      try {
        const response = await fetch(`/api/process/${encodeURIComponent(upid)}/steer`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          const body: unknown = await response.json();
          if (looksLikeSnapshot(body)) {
            setSnapshot(body);
          }
        }
      } catch {
        // Non-authoritative projector: a failed steer POST must never block the UI.
      }
    },
    [liveMode],
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

  const stopMic = useCallback(() => {
    // A deliberate stop hands the mic back: this window must NOT grab it again
    // on the next reload.
    try {
      window.sessionStorage.removeItem(MIC_OWNER_KEY);
    } catch {
      // See the setItem note in toggleMic.
    }
    // Disowning any in-flight start (clearing the ownership token) is enough
    // to cover a stop that races getUserMedia: the start body re-checks the
    // token once the pipeline lands and stops it itself when disowned, so the
    // pipeline the (still null) handle ref cannot see is never orphaned.
    micStartRef.current = null;
    micHandleRef.current?.stop();
    micHandleRef.current = null;
    setMicState("off");
    setMicLevel(0);
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
    // Stop any live (or still-starting) mic capture as part of the kill-all.
    stopMic();
  }, [stopMic]);

  const toggleMic = useCallback(async () => {
    // Toggle semantics under concurrency: a second toggle while a start is in
    // flight (or already live) is a STOP — stopMic disowns any pending start,
    // whose pipeline is then torn down (below), never orphaned.
    if (micStartRef.current !== null || micHandleRef.current !== null) {
      stopMic();
      return;
    }
    setMicError(null);
    setMicState("connecting");
    // Definite-assignment assertion: the async body compares itself against
    // the ref, and it only reads `start` after its first await — by which time
    // the assignment below has run.
    let start!: Promise<void>;
    start = (async () => {
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
        // While getUserMedia was pending a stop (or emergency/unmount) may
        // have disowned this start; committing now would resurrect — or, if a
        // newer start already committed, clobber — the handle ref. Tear down
        // this pipeline instead.
        if (micStartRef.current !== start) {
          handle.stop();
          return;
        }
        micHandleRef.current = handle;
        // Remember that THIS window carries the room's mic, so the reload a
        // self-rebuild forces on it can take the mic back (see the re-arm
        // effect). sessionStorage is per-tab by design: only the window that
        // actually held the mic re-arms, never the other three walls.
        try {
          window.sessionStorage.setItem(MIC_OWNER_KEY, "1");
        } catch {
          // Private mode / storage disabled: re-arming is a convenience, never
          // a requirement. The operator can still press the button.
        }
      } catch (error) {
        setMicError(error instanceof Error ? error.message : "Could not start microphone");
        setMicState("off");
      }
    })();
    // Published before the await below (and before the async body's first await
    // can yield), so every concurrent caller sees the in-flight start.
    micStartRef.current = start;
    await start;
    // Clear only if still ours — a concurrent stopMic (or a newer start after
    // it) may have replaced the token already.
    if (micStartRef.current === start) {
      micStartRef.current = null;
    }
  }, [releaseMute, stopMic]);

  // ONE BUTTON for mic + capture (live-room request): "mic on" and "capturing"
  // are the same act for a visitor, so a single control drives both. Activating
  // unmutes + starts the browser mic AND flips Idea Capture on; deactivating
  // stops the mic AND turns capture off. Composes the existing mic and
  // /api/capture handlers — no new endpoints. Both 'm' and 'c' map here.
  const toggleMicCapture = useCallback(async () => {
    // A start still in flight counts as active, so a rapid second press stops
    // (toggle semantics) instead of racing a second getUserMedia pipeline.
    const active =
      micStartRef.current !== null || micHandleRef.current !== null || (snapshotRef.current.captureMode ?? false);
    if (active) {
      stopMic();
      if (snapshotRef.current.captureMode) {
        await toggleCaptureMode();
      }
      return;
    }
    // Capture flag first (so the room is eager by the time audio flows), then
    // the mic — toggleMic releases the mute before streaming.
    if (!snapshotRef.current.captureMode) {
      await toggleCaptureMode();
    }
    await toggleMic();
  }, [stopMic, toggleCaptureMode, toggleMic]);

  // Stop capture if the component unmounts. Disowning a start still in flight
  // makes it stop its own pipeline when getUserMedia lands (see toggleMic), so
  // an unmount mid-start can't orphan it. (No stopMic here: this must not set
  // state on an unmounted component.)
  useEffect(() => {
    return () => {
      micStartRef.current = null;
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
    // Snapshot-aware: a room already unmuted+capturing skips the record step
    // (its button would be a no-op) and lands straight on "describe your idea".
    setGuided((current) => (current === null ? current : popPracticeOrb(current, snapshotRef.current, Date.now())));
  }, []);
  const guidedSkip = useCallback(() => {
    setGuided((current) => (current === null ? current : skipStep(current, snapshotRef.current, Date.now())));
  }, []);
  // GUIDED HOLD: while the demo sits on "describe your idea", the room must
  // not auto-build mid-description — the Done button is the only trigger.
  // Posted on the step's boundary transitions only; the server TTLs the hold
  // so a wall that dies here can never wedge auto-build.
  const guidedHoldRef = useRef(false);
  useEffect(() => {
    const on = guided !== null && guided.step === "idea";
    if (on === guidedHoldRef.current) {
      return;
    }
    guidedHoldRef.current = on;
    void fetch("/api/guided/hold", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    }).catch(() => undefined);
  }, [guided]);

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
    // Ensure-on, not toggle: skip when the mic is live OR already starting, so
    // a double-click on the record button can't stop (or double-start) the mic.
    if (micStartRef.current === null && micHandleRef.current === null) {
      void toggleMic();
    }
  }, [liveMode, releaseMute, toggleMic]);

  // RE-ARM THE MIC AFTER A REBOOT. The room's flagship move — speak a change,
  // the agent edits the source, the server exits 87 and relaunches — reloads
  // every wall. The mic lives in a browser pipeline, so it died with the old
  // page and nothing ever restarted it: the room rebuilt itself into silence.
  // The window that held the mic reclaims it on mount. getUserMedia needs no
  // prompt here (the origin's permission is already granted), and the per-tab
  // marker keeps the other walls out of it.
  useEffect(() => {
    if (!liveMode) {
      return;
    }
    let owned = false;
    try {
      owned = window.sessionStorage.getItem(MIC_OWNER_KEY) === "1";
    } catch {
      owned = false;
    }
    if (!owned) {
      return;
    }
    // Let the first snapshot land first: toggleMic reads snapshotRef to decide
    // whether it must release the mute before streaming.
    const timer = setTimeout(() => {
      if (micStartRef.current === null && micHandleRef.current === null) {
        void toggleMic();
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [liveMode, toggleMic]);

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

  // AUTO-CALIBRATION overlay activity, mirrored into a ref so the build-stamp
  // auto-reload below can skip reloading mid-sweep without re-binding.
  const calibrationActiveRef = useRef(initialOverlay?.calibration != null);
  const onCalibrationActive = useCallback((calibrating: boolean) => {
    calibrationActiveRef.current = calibrating;
  }, []);

  // AUTO-RELOAD ON NEW BUILDS: the server stamps the served dist build
  // (/api/build-stamp = dist/index.html's mtime). Every window — wall-bound
  // or not — remembers the first stamp it observes and, when it changes,
  // reloads after a small random jitter (0–2s) so the operator never cmd-R's
  // the projector windows after `bun run build` again. Guard: a window whose
  // calibration overlay is up skips the reload (the camera is measuring this
  // screen); the next 20s poll retries once the calibrator is gone.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    let closed = false;
    let baseline: string | null | undefined; // undefined = no successful read yet
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch("/api/build-stamp", { headers: { accept: "application/json" } });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
          return;
        }
        const body = (await response.json()) as { stamp?: unknown };
        const stamp = typeof body.stamp === "string" ? body.stamp : null;
        if (closed) {
          return;
        }
        if (baseline === undefined) {
          baseline = stamp; // first observation — the build this page came from
          return;
        }
        if (stamp === null || stamp === baseline || reloadTimer !== undefined) {
          return;
        }
        reloadTimer = setTimeout(() => {
          reloadTimer = undefined;
          if (closed || calibrationActiveRef.current) {
            return; // never blank a mid-sweep wall; the next poll retries
          }
          window.location.reload();
        }, Math.random() * BUILD_RELOAD_JITTER_MS);
      } catch {
        // Server restarting/unreachable — keep the current page; retry next tick.
      }
    };
    void check(); // capture the boot build's stamp immediately
    const timer = setInterval(() => void check(), BUILD_STAMP_POLL_MS);
    return () => {
      closed = true;
      clearInterval(timer);
      if (reloadTimer !== undefined) {
        clearTimeout(reloadTimer);
      }
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
        if (!closed && !mockModeRef.current) {
          // Out-of-order guard: a resync ISSUED before a state change can
          // RESOLVE after that change's SSE push — applying it blindly would
          // revert the wall to pre-change state with nothing left to correct
          // it (no further push comes). Never let a fetched snapshot roll the
          // clock back over one the stream already delivered.
          setSnapshot((current) =>
            typeof current.updatedAt === "string" &&
            typeof liveSnapshot.updatedAt === "string" &&
            liveSnapshot.updatedAt < current.updatedAt
              ? current
              : liveSnapshot,
          );
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
          setStreamLive(true);
        } catch {
          // Ignore a malformed frame; the next push or a resync recovers.
        }
      });
      // Lightweight mic byte-counter ticks: merge into the current snapshot's
      // mic section without a full-snapshot parse (the server no longer pushes
      // whole snapshots just to move this counter).
      source.addEventListener("mic", (messageEvent) => {
        if (closed || mockModeRef.current) {
          return;
        }
        try {
          const mic = JSON.parse((messageEvent as MessageEvent).data) as ProjectorSnapshot["mic"];
          setSnapshot((current) => ({ ...current, mic }));
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
        // SAY SO. Reconnecting silently meant a killed server left the wall
        // projecting a confident, frozen room forever — same status chips, same
        // last transcript line, still reading "listening". Nobody in the room
        // could tell a quiet room from a dead one. The banner clears itself the
        // moment a frame lands again.
        setStreamLive(false);
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

  // Ask once per boot: the leg selection is fixed when the server starts.
  useEffect(() => {
    if (!liveMode) {
      return;
    }
    let cancelled = false;
    void fetch("/api/health")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: unknown) => {
        if (cancelled || body === null || typeof body !== "object") {
          return;
        }
        const legs = (body as { degradation?: { degraded?: Array<{ leg?: unknown }> } }).degradation?.degraded ?? [];
        setStandIns(legs.map((entry) => String(entry.leg)).filter((leg) => leg.length > 0));
      })
      .catch(() => {
        // A wall that cannot reach /api/health has bigger problems; the stale
        // banner covers that case.
      });
    return () => {
      cancelled = true;
    };
  }, [liveMode]);

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
  const guestsOpenRef = useRef(guestsOpen);
  guestsOpenRef.current = guestsOpen;
  const helpOpenRef = useRef(helpOpen);
  helpOpenRef.current = helpOpen;
  // Current selection mirrored the same way, so 'k' (halt selected) reads the
  // latest selection without re-binding the listener on every click.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // --- Keyboard: the primary desk-mode control surface (SSR-guarded) ---
  // 1–9 select/steer · b/Enter build top idea · x dismiss · c/m mic+capture
  // (one control) · Shift+A auto-build (plain a/w/s/d = scene WASD walk) ·
  // u unmute · q QR · ?/h help · k halt selected · Shift+E emergency · Esc close.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    function onKey(keyEvent: KeyboardEvent) {
      // A held key auto-repeats; every binding here is a discrete action or a
      // toggle (the mic toggle would race a fresh getUserMedia per repeat), so
      // only the initial press counts.
      if (keyEvent.repeat) {
        return;
      }
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
        if (researchDeckRef.current !== null) {
          setResearchDeckId(null);
          return;
        }
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
        if (guestsOpenRef.current) {
          setGuestsOpen(false);
          return;
        }
        // The contextual idea card closes without building anything.
        if (ideaCardRef.current !== null) {
          setIdeaCard(null);
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
        case "m":
          // Both legacy keys drive the MERGED mic+capture control.
          void toggleMicCapture();
          return;
        // Shift+A: plain "a" is now WASD strafe-left in the 3D scene, so the
        // Auto-Build toggle takes a deliberate chord (mnemonic preserved).
        case "A":
          void toggleAutoAccept();
          return;
        case "r":
          void toggleResearchMode();
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
    toggleMicCapture,
    toggleAutoAccept,
    toggleResearchMode,
    releaseMute,
    triggerEmergency,
    processLifecycle,
    clearHidden,
  ]);

  // The orb told the room "Listening" whenever the SERVER intended to listen —
  // which stayed true with zero audio arriving. Every self-rebuild restarts the
  // server and reloads the walls, the mic pipeline dies with the old page, and
  // the room stood there deaf under a green light. `listening` is intent;
  // `mic.active` (a live /api/mic socket) is the truth. When the two disagree
  // the orb says DEAF, because a silent room that looks healthy is the worst
  // failure this wall can show.
  const micSession = snapshot.mic ?? null;
  const roomIsDeaf = !snapshot.muted && snapshot.listening && micSession !== null && !micSession.active;
  const listeningState = snapshot.muted ? "muted" : roomIsDeaf ? "deaf" : "listening";
  const listeningLabel = snapshot.muted ? "Muted" : roomIsDeaf ? "No mic" : "Listening";

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

  // PER-WALL CONTRACT (DE-THEMED): the two walls are ONE continuous room —
  // neither is "the idea wall" or "the build wall". The 3D room scene renders
  // in FULL on every window, and ON-DEMAND overlays (tree menu, deck, QR
  // import, guided demo) open on WHICHEVER wall summons them. ?view only
  // places the single-instance PERSISTENT panels pragmatically so the two
  // projections don't duplicate them: view=ideas (wall A) carries the idea
  // tray + suggestion + capture/auto-build/mic/guided-demo cluster,
  // view=builds (wall B) the transcript rail + QR-import button, and the
  // default full view (single-window desk mode) carries everything. Per-
  // process controls are NOT a rail anymore: pick a tree in the garden and
  // its anchored menu expands right there (TreeMenu.tsx).
  // Genuinely global chrome (status bar, scene controls, help) stays on both
  // walls. Only Mock Room hides the 2D rail/tray entirely (a pure 3D showcase).
  const showIdeaSurfaces = view !== "builds";
  const showBuildSurfaces = view !== "ideas";
  const ideas = snapshot.ideas ?? [];
  const showIdeaTray = ideas.length > 0 && showIdeaSurfaces;

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

  // ISSUE FRUIT poller: for every ADOPTED tree (treeRepo.remoteUrl recorded,
  // never the self process) fetch GET /api/process/:upid/issues once a
  // minute while the tree exists. Degrades honestly: an absent route, a dead
  // server or a malformed payload all resolve to NO fruit ([]) — never a
  // crash, never stale beads. Results ride into the scene via treeSpecs
  // below; RoomScene's fruitSignature gate regrows the entry only when the
  // set actually changed.
  const [issuesByUpid, setIssuesByUpid] = useState<Record<string, IssueInfo[]>>({});
  const issuesByUpidRef = useRef(issuesByUpid);
  issuesByUpidRef.current = issuesByUpid;
  const adoptedKey = useMemo(
    () =>
      snapshot.processes
        .filter(
          (process) =>
            process.upid !== "self" &&
            typeof process.treeRepo?.remoteUrl === "string" &&
            process.treeRepo.remoteUrl.length > 0,
        )
        .map((process) => process.upid)
        .join("|"),
    [snapshot.processes],
  );
  useEffect(() => {
    if (typeof window === "undefined" || adoptedKey.length === 0) {
      return;
    }
    const upids = adoptedKey.split("|");
    let cancelled = false;
    const poll = async (): Promise<void> => {
      for (const upid of upids) {
        let issues: IssueInfo[] = [];
        try {
          const response = await fetch(`/api/process/${encodeURIComponent(upid)}/issues`, {
            headers: { accept: "application/json" },
          });
          if (response.ok) {
            const payload = (await response.json().catch(() => null)) as { issues?: unknown } | null;
            if (payload !== null && Array.isArray(payload.issues)) {
              issues = payload.issues.flatMap((issue): IssueInfo[] => {
                const candidate = issue as { number?: unknown; title?: unknown; labels?: unknown };
                if (typeof candidate.number !== "number" || !Number.isFinite(candidate.number)) {
                  return [];
                }
                return [
                  {
                    number: candidate.number,
                    title: typeof candidate.title === "string" ? candidate.title : "",
                    labels: Array.isArray(candidate.labels)
                      ? candidate.labels.filter((label): label is string => typeof label === "string")
                      : [],
                  },
                ];
              });
            }
          }
        } catch {
          // Route absent / server down: this tree just bears no fruit.
        }
        if (cancelled) {
          return;
        }
        setIssuesByUpid((current) => {
          const previous = current[upid] ?? [];
          const unchanged =
            previous.length === issues.length &&
            previous.every(
              (issue, index) =>
                issue.number === issues[index].number &&
                issue.title === issues[index].title &&
                issue.labels.join(",") === issues[index].labels.join(","),
            );
          return unchanged ? current : { ...current, [upid]: issues };
        });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), ISSUE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [adoptedKey]);

  // Scene trees: one per process (minus anything hidden via the hide menu).
  // Each spec carries the INFERRED project title (process.task) for the node
  // label, the live steering flag so the scene can ring the current steering
  // target, and the TWO-STAGE stage: concepts render as saplings, a
  // commissioned project visibly grows into the full tree (gold ring).
  const treeSpecs = useMemo<TreeSpec[]>(
    () =>
      snapshot.processes
        .filter((process) => !hiddenTrees.has(process.upid))
        .map((process) => {
          // Per-backend concept-mock lane tally → status satellites on the node.
          const builds = buildsOf(process);
          const summary = builds.reduce(
            (acc, b) => {
              if (b.status === "ready") acc.ready += 1;
              else if (b.status === "failed") acc.failed += 1;
              else acc.building += 1;
              return acc;
            },
            { building: 0, ready: 0, failed: 0 },
          );
          const execution = executionOf(process);
          return {
            upid: process.upid,
            callsign: process.callsign,
            state: process.state,
            progress: process.progress,
            task: process.task,
            steering: process.upid === steeringUpid,
            // The scene knows sapling/tree only; the SELF project folds onto
            // that axis by whether a self-run is live (sceneStageOf).
            stage: sceneStageOf(process),
            builds: builds.length > 0 ? summary : undefined,
            published: typeof process.publishedUrl === "string" && process.publishedUrl.length > 0,
            failedCount: summary.failed + (execution?.status === "failed" ? 1 : 0),
            // GIT SUBSTRATE limbs (room/* branches) + issue fruit ride the
            // spec straight from the snapshot/poller — the scene re-derives
            // limbs each reconcile, so a fresh branch appears within a tick.
            treeRepo: process.treeRepo ?? null,
            issues: issuesByUpid[process.upid],
          };
        }),
    [snapshot.processes, hiddenTrees, steeringUpid, issuesByUpid],
  );

  const visibleIdeaOrbs = useMemo<IdeaOrbSpec[]>(
    () => ideaOrbs.filter((orb) => !hiddenIdeas.has(orb.id ?? "__primary__")),
    [ideaOrbs, hiddenIdeas],
  );

  // RESEARCH is a MODE SWITCH, not an overlay: while the toggle is on the
  // scene shows the dialogue tree + research crystals INSTEAD of the idea
  // garden (and the idea tray/banner/action card yield to the research tray).
  // Quests live on the server, so toggling back restores them intact.
  const researchQuests = snapshot.research ?? [];
  const showResearch = researchActive;
  const dialogueSpecs = useMemo<DialogueNodeSpec[]>(
    () => (showResearch ? (snapshot.dialogue ?? []) : []),
    [showResearch, snapshot.dialogue],
  );
  // Concept clusters over the dialogue window: the tree's topic BRANCHES.
  const topicSpecs = useMemo<DialogueTopicSpec[]>(
    () => (showResearch ? (snapshot.dialogueTopics ?? []) : []),
    [showResearch, snapshot.dialogueTopics],
  );
  const researchSpecs = useMemo<ResearchNodeSpec[]>(
    () =>
      showResearch
        ? researchQuests.map((quest) => ({
            id: quest.id,
            topic: quest.topic,
            kind: quest.kind,
            status: quest.status,
            confidence: quest.confidence,
            progress: quest.progress,
            turnId: quest.turnId ?? null,
          }))
        : [],
    [showResearch, researchQuests],
  );
  const researchDeckQuest = useMemo<ResearchTrayItem | null>(
    () => (researchDeckId === null ? null : researchQuests.find((quest) => quest.id === researchDeckId) ?? null),
    [researchDeckId, researchQuests],
  );

  // The orb the open idea card points at, resolved against the live orb list so
  // the card always mirrors the scene: null = closed OR the idea is gone.
  const ideaCardOrb = useMemo<IdeaOrbSpec | null>(() => {
    if (ideaCard === null) {
      return null;
    }
    return ideaOrbs.find((orb) => orb.id === ideaCard.id) ?? null;
  }, [ideaCard, ideaOrbs]);

  // Auto-close: when the card's idea disappears from the snapshot (built,
  // dismissed, superseded), the stale card must not linger over the scene.
  useEffect(() => {
    if (ideaCard !== null && ideaCardOrb === null) {
      setIdeaCard(null);
    }
  }, [ideaCard, ideaCardOrb]);

  // Picking a tree in the scene (click or dwell): open ITS anchored menu at
  // the pick-time screen rect — and ONLY that (steering stays with the menu's
  // RecordSteerToggle; see the steer-arm note above). Picking another tree
  // MOVES the menu (selected changes, anchor re-derives); the deck, previews,
  // steer toggle and remove all live inside the menu now — including fixture
  // decks (mock room), which get the menu's "Deck ▸" button.
  const selectSceneProcess = useCallback(
    (callsign: string, anchor?: SceneDwellRect | null) => {
      const process = snapshotRef.current.processes.find(
        (candidate) => candidate.callsign === callsign || candidate.upid === callsign,
      );
      if (process === undefined) {
        return; // e.g. the synthetic self tree before the mirror is pinned
      }
      setMenuAnchor(anchor ?? null);
      setSelected(process.callsign);
    },
    [],
  );

  // Picking a LIMB — its tip or anywhere along the wood — opens the branch's
  // contextual popup at the limb TIP's own projected rect, on adopted trees
  // (a work rail) and on the room's own tree alike (a version of the room;
  // its callsign is the mirror's, which resolves here to upid "self"). One of
  // the branch/issue pair at a time — opening one closes the other.
  const openBranchPopup = useCallback((callsign: string, branch: string, anchor: SceneDwellRect | null) => {
    const process = snapshotRef.current.processes.find(
      (candidate) => candidate.callsign === callsign || candidate.upid === callsign,
    );
    if (process === undefined) {
      return;
    }
    setIssuePopup(null);
    setBranchPopup({ upid: process.upid, branch, anchor });
  }, []);

  // Picking a FRUIT opens the issue's popup; the issue payload comes from
  // the poller's latest list (falling back to the bare number when the list
  // refreshed between render and pick).
  const openIssuePopup = useCallback((callsign: string, issueNumber: number, anchor: SceneDwellRect | null) => {
    const process = snapshotRef.current.processes.find(
      (candidate) => candidate.callsign === callsign || candidate.upid === callsign,
    );
    if (process === undefined) {
      return;
    }
    const issue =
      issuesByUpidRef.current[process.upid]?.find((candidate) => candidate.number === issueNumber) ?? {
        number: issueNumber,
        title: "",
        labels: [],
      };
    setBranchPopup(null);
    setIssuePopup({ upid: process.upid, issue, anchor });
  }, []);

  // 🌱 GROW A BRANCH (tree menu, adopted trees): POST names a real room/*
  // rail off the freshly fetched origin tip; the menu closes immediately and
  // the LIMB appears via the next snapshot (limbs re-derive each reconcile).
  const growBranch = useCallback(async (upid: string) => {
    setSelected(null);
    try {
      await fetch(`/api/process/${encodeURIComponent(upid)}/branch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "spoken-changes" }),
      });
    } catch {
      // No limb grows; the server logs the honest failure.
    }
  }, []);

  // ANCHOR CHASE (menu ↔ tree): while a menu is open, refresh its anchor from
  // the tree's LIVE projected dwell rect about once a second — slot re-shuffles
  // and settle easing move trees after pick time, and a menu pinned to a stale
  // rect reads as orphaned glass. Lightweight by design: 1 Hz (never
  // per-frame), one projected-box query through the existing scene-source
  // seam, and the guarded set keeps identical rects from re-rendering. A null
  // rect (tree gone / degenerate projection this beat) keeps the last anchor.
  // Side benefit: a keyboard/hook select (anchor null → edge-rest) adopts the
  // real anchor within a second.
  const selectedMenuCallsign = selectedProcess?.callsign ?? null;
  useEffect(() => {
    if (selectedMenuCallsign === null || typeof window === "undefined") {
      return;
    }
    const timer = setInterval(() => {
      const rect = getSceneDwellSource()?.rectFor(procDwellTargetId(selectedMenuCallsign)) ?? null;
      if (rect === null) {
        return;
      }
      setMenuAnchor((current) =>
        current !== null &&
        Math.abs(current.left - rect.left) < 1 &&
        Math.abs(current.top - rect.top) < 1 &&
        Math.abs(current.width - rect.width) < 1 &&
        Math.abs(current.height - rect.height) < 1
          ? current
          : rect,
      );
    }, 1_000);
    return () => clearInterval(timer);
  }, [selectedMenuCallsign]);

  // TWO GLASS PANELS NEVER OVERLAP (projector legibility): an opening tree
  // menu folds the control dock's tray via its collapse seam; hover/dwell on
  // the dock re-opens it as usual afterwards.
  const [dockCollapseSignal, setDockCollapseSignal] = useState(0);
  const treeMenuOpen = selectedProcess !== null;
  useEffect(() => {
    if (treeMenuOpen) {
      setDockCollapseSignal((n) => n + 1);
    }
  }, [treeMenuOpen]);

  // AUTO-FIT ON IMPORT: when a upid never seen before appears in the snapshot
  // (QR import, voice build, mock toggle), pulse the EXISTING one-shot fit
  // (fitSignal → RoomScene's fitToContent) once so the garden reframes with
  // every tree mid-frame instead of the new one clipping the bottom edge.
  // Baseline = the mount snapshot, so the first live /api/state sync frames
  // the standing garden too. RoomScene keeps its own guards: rigid corner/
  // flat pairs ignore the pulse (their cameras may not move).
  const seenUpidsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const seen = seenUpidsRef.current;
    if (seen === null) {
      seenUpidsRef.current = new Set(snapshot.processes.map((process) => process.upid));
      return;
    }
    let grewNewTree = false;
    for (const process of snapshot.processes) {
      if (!seen.has(process.upid)) {
        seen.add(process.upid);
        grewNewTree = true;
      }
    }
    if (grewNewTree) {
      setFitSignal((n) => n + 1);
    }
  }, [snapshot.processes]);

  // DWELL-MISS / WALKED-AWAY CLOSE (GestureLayer → popup-dismiss.ts): the
  // gesture wall's ground-click. Closes the TOP popup only — the holo panel
  // first (it stacks over the menu that opened it), then the branch/issue
  // popups (they stack over the tree menu their limb/fruit belongs to), then
  // the tree menu, else the idea action card. Deliberately narrow: the
  // deck/QR/help overlays keep their explicit close buttons (auto-closing a
  // deck mid-pitch because nobody pointed for 6s would be worse than stale
  // glass).
  const closeTopPopup = useCallback(() => {
    if (holoPanelRef.current !== null) {
      setHoloPanel(null);
      return;
    }
    if (branchPopupRef.current !== null) {
      setBranchPopup(null);
      return;
    }
    if (issuePopupRef.current !== null) {
      setIssuePopup(null);
      return;
    }
    if (selectedRef.current !== null) {
      setSelected(null);
      return;
    }
    if (ideaCardRef.current !== null) {
      setIdeaCard(null);
    }
  }, []);

  // Clicking an idea orb OPENS its contextual action card — building is the
  // card's explicit "✓ Done — build it" press, never the orb click itself.
  // (The guided demo's practice orbs are GuidedDemo's own DOM targets routed
  // through onPopOrb, so they never land here and keep their pop-on-click.)
  const acceptOrb = useCallback((id: string | null) => {
    setIdeaCard({ id });
  }, []);

  // GESTURE MODE (fusion cursors drive the UI): there is NO OS cursor — the
  // `gesture-mode` class hides the pointer everywhere. The pointed-at target's
  // highlight + dwell ring are the selection feedback, and the gesture layer
  // additionally draws a per-person cursor dot (toggleable, on by default).
  // Pointer navigation on the scene is disabled so pointing never fights
  // drag-orbit.
  // ?dwell=mouse mounts the same dwell layer driven by the mouse (testing/
  // accessibility) with the OS cursor and drag-orbit left intact.
  const gestureMode = urlConfig.gesture !== null;
  // GUEST HANDS (?remote=): people on the LAN drive this wall's dwell layer
  // from their own computers. ?remote=1 subscribes to the page's own origin
  // (the production wall is served by the projector server); ?remote=ws://…
  // overrides for split-origin dev setups.
  const remoteHandsUrl = useMemo(() => {
    if (urlConfig.remote === null) {
      return "";
    }
    if (urlConfig.remote.url !== null) {
      return urlConfig.remote.url;
    }
    return typeof window !== "undefined" ? roomHandsSocketUrl(window.location) : "";
  }, [urlConfig.remote]);
  // CORNER LOCK: in gesture mode with an explicit wall, the two wall windows
  // stop being independent vantage points and become a RIGID camera pair
  // rendering ONE continuous world around the physical 90° corner — shared eye
  // point, yaws exactly 90° apart, 90° horizontal FOV per window, no camera
  // animation (see corner-lock.ts). Scene CONTENT stays full on both windows.
  // The two-wall rigid corner rig. The pinch camera (?hands=) is a FREE-orbit
  // control, which corner-lock reasserts away every frame — the two intents are
  // mutually exclusive, so an explicit pinch-camera opt-in wins (single-wall
  // Kinect + hands must be able to orbit). Without hands, corner-lock stays as
  // the two-wall gesture pair intends.
  // FLAT LOCK: on the flat rig (?flat=1 — one wall, two side-by-side
  // projections, docs/FLAT-WALL.md) the pair is rigid too, but coplanar:
  // shared eye, ONE shared view direction, each window rendering its HALF of
  // a single wide frustum (see flat-lock.ts). It applies in desk AND gesture
  // mode — the physical wall is flat either way — so it wins over the corner
  // lock. Unlike the corner pair, ?hands= does NOT defeat it: the pinch
  // camera orbits the SHARED panorama (every window applies the identical
  // stream-fed deltas, so the pair stays continuous while it spins —
  // RoomScene's flat rig).
  const flatLock = urlConfig.flat && urlConfig.wall !== null;
  // A research-pinned window (?research=1 — the ceiling projector) is a
  // dedicated aux display, never one half of the corner pair: corner-locking
  // it would aim its camera at the pair's OTHER quadrant, away from the tree.
  const cornerLock =
    !flatLock && !urlConfig.research && gestureMode && urlConfig.wall !== null && urlConfig.hands === null;
  // CONTINUOUS AUTO-FRAMING: a research-pinned dedicated display (the ceiling
  // projector) must keep the WHOLE conversation tree in view as it grows, so
  // auto-fit defaults ON there; ?autofit=0 opts out, ?autofit=1 forces it on
  // any other window. Never under the corner/flat lock — rigid pairs may not
  // move (RoomScene gates it again defensively).
  const autoFit = !cornerLock && !flatLock && (urlConfig.autoFit ?? urlConfig.research);
  const dwellLayerOn = gestureMode || urlConfig.dwell === "mouse" || remoteHandsUrl.length > 0;
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
        ideas={researchActive ? [] : visibleIdeaOrbs}
        trees={researchActive ? [] : treeSpecs}
        mode={sceneMode}
        layout={sceneLayout}
        wall={urlConfig.wall}
        cornerLock={cornerLock}
        flatLock={flatLock}
        autoFit={autoFit}
        fitSignal={fitSignal}
        focusUpid={
          guided !== null && (guided.step === "race" || guided.step === "decide")
            ? guided.focusUpid
            : null
        }
        pointerNav={!gestureMode && !flatLock}
        onAcceptIdea={acceptOrb}
        onSelectProcess={selectSceneProcess}
        onPickMiss={closeMenu}
        onPickBranch={openBranchPopup}
        onPickIssue={openIssuePopup}
        dialogue={dialogueSpecs}
        topics={topicSpecs}
        research={researchSpecs}
        onResearchNode={onResearchNode}
        onDialogueNode={(turnId) => void onDialogueNode(turnId)}
        selfTree={selfTree}
        park={urlConfig.park}
      />
      {dwellLayerOn ? (
        <GestureLayer
          wall={urlConfig.gesture?.wall ?? urlConfig.wall ?? "A"}
          fusionUrl={urlConfig.gesture?.fusionUrl ?? ""}
          remoteUrl={remoteHandsUrl}
          mouseTest={urlConfig.dwell === "mouse"}
          initialCursorDots={urlConfig.dots ? true : undefined}
          onDwellMiss={closeTopPopup}
        />
      ) : null}
      {/* PINCH CAMERA (hands): runtime-toggleable (HUD button) and seeded from
          the ?hands= URL default. Composes with gesture mode — pointerNav only
          unbinds DOM listeners, the rig stays drivable through the registered
          camera control — and with desk mode via the rig's latest-writer-wins
          d* contract. onStatus feeds the toggle's OFF/connecting/LIVE label. */}
      {handsOn ? (
        <PinchCameraLayer url={handsUrl} wall={urlConfig.wall} onStatus={setHandsStatus} />
      ) : null}
      {/* In-room hand-tracking HUD (top-left): live skeleton + id + pinch text,
          no camera image. Same 9980 stream; shows whenever the hand camera is on. */}
      {handsOn ? <HandSkeletonHud url={handsUrl} wall={urlConfig.wall} /> : null}
      {urlConfig.badge ? (
        <div className="wall-badge" data-testid="wall-badge">
          {urlConfig.badge}
        </div>
      ) : null}
      <FullscreenButton />
      {/* Research-pinned displays (the ceiling) run zen — chrome-less — but
          still need the one tree control: a corner chip, dimmed until a
          cursor rests on it, dwellable like everything else. */}
      {urlConfig.research ? (
        <div className="ceiling-dock">
          <ControlDock>
            <button
              type="button"
              className="ctl-button ceiling-reset"
              data-testid="ceiling-reset-button"
              title="Reset the conversation tree (vine + crystals + dossiers)"
              onClick={() => void resetResearchTree()}
            >
              🧹 Reset tree
            </button>
            <button
              type="button"
              className={`ctl-button research-toggle${researchEngineOn ? " on" : ""}`}
              data-testid="ceiling-research-button"
              data-state={researchEngineOn ? "on" : "off"}
              onClick={() => void toggleResearchMode()}
              title="Research engine: while ON, the room reviews the talk (~1/min) and buds spheres onto this tree."
            >
              {researchEngineOn ? "🔍 Research: ON" : "🔍 Research: OFF"}
            </button>
          </ControlDock>
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

      {/* THE ROOM DIED WHILE YOU WERE LOOKING AT IT. Every reading on this wall
          is a snapshot; when the push stream drops, they all freeze at their
          last value and keep looking authoritative. Measured: the server was
          killed and 8.5s later the wall still read "READY / ambient listening /
          ALL CLEAR" with the pre-death transcript. This banner is the only
          thing that distinguishes a quiet room from a dead one, so it shows in
          gesture mode too — it is not a debugging chip. */}
      {streamLive ? null : (
        <div className="stream-stale" data-testid="stream-stale" role="status">
          ⚠ lost the room — this wall is frozen at its last update, reconnecting…
        </div>
      )}

      {/* Not a debugging chip: a room half-made of stand-ins that looks exactly
          like a real one is the "weirdly mocked" feeling made visible. Names
          the legs so it doubles as the list of what is left to make real. */}
      {standIns.length > 0 ? (
        <div className="stand-ins" data-testid="stand-ins" title="These subsystems are running stubbed backends — see /api/health for how to upgrade each.">
          ⚠ stand-ins: {standIns.join(", ")}
        </div>
      ) : null}

      <header className="status-bar" data-region="status">
        {/* STATUS READOUTS (listening orb, session id/global state, active cue,
            read-only tag, gate %): DESK-ONLY debugging chips. In gesture mode
            they are noise at projector distance — the bar keeps only genuinely
            actionable controls (and the emergency banner when one is live). */}
        {gestureMode ? null : (
        <div className="status-left">
          <div
            className={`listening-orb ${listeningState}`}
            data-testid="listening-indicator"
            data-state={listeningState}
          >
            <span className="orb-core" aria-hidden="true" />
            <span className="orb-label">{listeningLabel}</span>
          </div>
          <div className="session-meta">
            <span className="session-id">{snapshot.sessionId}</span>
            <span className="provider">{snapshot.globalState}</span>
          </div>
        </div>
        )}

        {gestureMode ? null : (
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
        )}

        <div className="status-right">
          {/* Emergency status: desk mode always shows it (ALL CLEAR is a
              debugging readout); gesture mode shows it ONLY while an emergency
              is actually active — that's the actionable case. */}
          {!gestureMode || snapshot.emergencyStopTriggered ? (
            <div
              className={`emergency-status ${snapshot.emergencyStopTriggered ? "triggered" : "clear"}`}
              data-testid="emergency-status"
              data-triggered={snapshot.emergencyStopTriggered ? "true" : "false"}
            >
              {snapshot.emergencyStopTriggered ? "EMERGENCY STOP" : "ALL CLEAR"}
            </div>
          ) : null}
          {/* UNMUTE — the SAFETY control. A muted room must SAY so and offer
              the release right on the wall, so it stays OUTSIDE the control
              dock (like the emergency banner: alert-state chrome never folds
              behind a hover). Idea-side placement: wall A + full view. */}
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
          {/* CONTROL DOCK (calm wall): every routine control folds behind ONE
              "⚙ Controls" affordance — hover/dwell/focus expands the popover
              tray, and it collapses ~4s after every cursor leaves (see
              ControlDock.tsx). The per-wall ?view gating of each button is
              unchanged; only its resting visibility moved. An opening tree
              menu folds the tray (collapseSignal) so two glass panels never
              overlap on the projector. */}
          <ControlDock collapseSignal={dockCollapseSignal}>
          {/* ONE control for mic + capture (live-room request): activating
              unmutes + starts the mic AND turns Idea Capture on; deactivating
              stops both. Replaces the separate Mic and Idea Capture buttons. */}
          {/* NOT gated by ?view. This is the only way to arm the room's
              microphone, and wall B (view=builds) had no mic control and no
              unmute — that window could never start listening, so whoever
              stood in front of it could not wake the room at all. Every wall
              gets the mic. */}
          <MicCaptureControl
            active={captureMode || micState !== "off"}
            micState={micState}
            level={micLevel}
            error={micError}
            mode={snapshot.mic?.mode}
            bytesReceived={snapshot.mic?.bytesReceived ?? 0}
            onToggle={() => void toggleMicCapture()}
          />
          {showIdeaSurfaces ? (
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
          ) : null}
          {/* SELF-REBUILD ("the room rebuilds itself"): runtime gate on the
              green-self-commit → rebuild-and-relaunch trigger. The title is
              HONEST about the boot-time part: without the --self supervisor
              wrapping this server, an exit 87 cannot rebuild anything. */}
          {showIdeaSurfaces ? (
            <button
              type="button"
              className={`ctl-button self-rebuild${selfRebuild ? " on" : ""}`}
              data-testid="self-rebuild-button"
              data-state={selfRebuild ? "on" : "off"}
              aria-pressed={selfRebuild}
              onClick={() => void toggleSelfRebuild()}
              title={
                selfSupervisor
                  ? selfRebuild
                    ? "ARMED (supervisor live): when the mirror lands a green self: commit, the server rebuilds and relaunches itself — walls reload on the new build."
                    : "Supervisor live but the trigger is OFF: a green self: commit will NOT rebuild the room until this is switched on."
                  : "on (needs --self launch to take effect): no supervisor is wrapping this server, so a green self: commit cannot rebuild-and-relaunch it. Start the room with run-room.sh --self."
              }
            >
              {selfRebuild ? "🔁 Self-Rebuild: ON" : "🔁 Self-Rebuild: OFF"}
            </button>
          ) : null}
          {showIdeaSurfaces ? (
            <button
              type="button"
              className={`ctl-button research-toggle${researchActive ? " on" : ""}`}
              data-testid="research-mode-button"
              data-state={researchEngineOn ? "on" : "off"}
              aria-pressed={researchEngineOn}
              onClick={() => void toggleResearchMode()}
              title="Research engine (R): while ON, the room reviews the conversation (~1/min) and buds research spheres onto the dialogue tree — shown on the dedicated ?research=1 display (the ceiling). Wall scenes stay put."
            >
              {researchEngineOn ? "🔍 Research: ON" : "🔍 Research: OFF"}
            </button>
          ) : null}
          {/* QR Import lives in the dock on EVERY view (live-room request):
              the overlay opens on whichever wall summons it, so scoping the
              button to the build view just made it look missing on wall A. */}
          <button
            type="button"
            className="ctl-button qr-import"
            data-testid="qr-import-button"
            onClick={() => setQrOpen(true)}
            title="Show a QR code — scan it on a phone to add a project (context + optional link) to the wall."
          >
            QR Import
          </button>
          {/* GUEST HANDS: only rendered when this wall actually listens for
              guests (?remote=1 / --guests) — a URL that connects to nothing is
              worse than no button. */}
          {urlConfig.remote !== null ? (
            <button
              type="button"
              className="ctl-button guest-hands"
              data-testid="guest-hands-button"
              onClick={() => setGuestsOpen(true)}
              title="Show the URL other computers on this network open to get hand controls for this wall (webcam hand-tracking or trackpad)."
            >
              🖐 Guests
            </button>
          ) : null}
          {showIdeaSurfaces ? (
            <button
              type="button"
              className={`ctl-button guided-launch${guided !== null ? " on" : ""}`}
              data-testid="guided-demo-button"
              data-state={guided !== null ? "on" : "off"}
              aria-pressed={guided !== null}
              onClick={enterGuidedDemo}
              title="Guided demo (kickoff phase): point, record, say an idea, watch the concept mocks race, then decide on the pitch deck. Restarts from step 1."
            >
              Guided Demo
            </button>
          ) : null}
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
          </ControlDock>
        </div>
      </header>


      <div className="stage">
        <div className="stage-main">
          {showIdeaTray && !mockMode && !researchActive ? (
            <IdeaTray
              ideas={ideas}
              onBuild={(id) => void actOnIdea(id, "accept")}
              onDismiss={(id) => void actOnIdea(id, "dismiss")}
            />
          ) : null}
          {researchActive && showIdeaSurfaces && !mockMode ? (
            <ResearchTray
              quests={researchQuests}
              thinking={snapshot.researchThinking === true}
              onAccept={(id) => void actOnResearch(id, "accept")}
              onDismiss={(id) => void actOnResearch(id, "dismiss")}
              onOpenDeck={(id) => setResearchDeckId(id)}
              onFollowUp={(id, index) => void researchFollowUp(id, index)}
              onReset={() => void resetResearchTree()}
            />
          ) : null}
        </div>

        {/* Mock room is a pure 3D showcase — the 2D rail/tray stay hidden.
            THE FLEET RAIL IS GONE (operator-directed redesign): per-process
            controls live in the anchored per-tree menu now (pick a tree →
            TreeMenu opens beside it). The rail keeps only the transcript
            card + the hands toggle — wall B's single-instance placement. In
            gesture mode the transcript card is lifted into wall B's right
            third by CSS (display-only content may use the pointing-forbidden
            zone); desk mode keeps it in-rail. */}
        {/* The rail carries the TRANSCRIPT, which is the room's only proof it
            heard anything. Gated to view=builds it left wall A — the wall with
            the capture cluster, the one people talk at — showing no words at
            all, however much they said. Both walls keep it now. */}
        {!mockMode ? (
          <aside className="rail">
            {/* PINCH CAMERA toggle (hands): a compact chip docked in the rail
                (live-room request — it was crowding the header). Seeded
                from ?hands=; the label mirrors PinchCameraLayer's socket state. */}
            <button
              type="button"
              className={`ctl-button hands-toggle${handsOn ? " on" : ""}`}
              data-testid="hands-toggle-button"
              data-state={handsOn ? (handsStatus === "open" ? "live" : "connecting") : "off"}
              aria-pressed={handsOn}
              onClick={toggleHands}
              title="Pinch-camera control: point with your hands (TouchDesigner/MediaPipe) to orbit, zoom and pan the room. Toggle to arm the hand tracker."
            >
              {!handsOn
                ? "✋ Hands: OFF"
                : handsStatus === "open"
                  ? "✋ Hands: LIVE"
                  : "✋ Hands: connecting"}
            </button>
            <TranscriptStream lines={snapshot.transcript} />
          </aside>
        ) : null}
      </div>

      {/* Scene controls (visualizer parity): mode / fit / hide / zen. DESK
          affordances only — in gesture mode they would duplicate on both walls
          of the corner pair (and dwell-selecting them per-window could desync
          the locked cameras' render styles), so they do not render at all
          there; the keyboard shortcuts (G / L / F / Z / `) still work. */}
      {gestureMode ? null : (
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
      )}

      {/* IDEA ACTION CARD: the contextual "✓ Done — build it" surface, opened
          by clicking an idea orb in the scene (see acceptOrb). Floats
          bottom-center above the scene-controls cluster; the Done button runs
          the old instant-accept behavior (primary → /api/suggestion/accept,
          ledger idea → per-idea accept), close (✕ / Esc) just dismisses. */}
      {ideaCard !== null && ideaCardOrb !== null && !researchActive ? (
        <div
          className="idea-action-card"
          data-testid="idea-action-card"
          // Dwell-miss dismissal shield (popup-dismiss.ts): a cursor reading
          // the pitch/confidence copy must not close the card under it.
          data-dwell-shield="1"
          role="dialog"
          aria-label="Build this idea?"
        >
          <div className="idea-card-copy">
            <span className="idea-card-pitch">{ideaCardOrb.pitch}</span>
            {ideaCardOrb.confidence > 0 ? (
              <span className="idea-card-confidence">{Math.round(ideaCardOrb.confidence * 100)}% confident</span>
            ) : null}
          </div>
          <button
            type="button"
            className="ctl-button idea-done"
            data-testid="idea-done-button"
            title={
              ideaCard.id === null && snapshot.ideaSettle?.armed === true
                ? "Stop refining and build the heard idea now"
                : "Build this idea now"
            }
            onClick={() => {
              if (ideaCard.id === null) {
                void acceptIdea();
              } else {
                void actOnIdea(ideaCard.id, "accept");
              }
              setIdeaCard(null);
            }}
          >
            ✓ Done — build it
            {/* Primary + armed settle gate: surface the auto-build countdown. */}
            {ideaCard.id === null && snapshot.ideaSettle?.armed === true && snapshot.ideaSettle.firesInMs !== null
              ? ` (${Math.max(1, Math.ceil(snapshot.ideaSettle.firesInMs / 1000))}s)`
              : ""}
          </button>
          <button
            type="button"
            className="ctl-button idea-card-close"
            data-testid="idea-card-close"
            onClick={() => setIdeaCard(null)}
            title="Close without building (Esc)"
          >
            ✕
          </button>
        </div>
      ) : null}

      {/* Hide/unhide menu: a desk affordance like the scene controls above —
          never rendered in gesture mode (it would duplicate on both walls). */}
      {hideMenuOpen && !gestureMode ? (
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

      {/* ON-DEMAND overlays (tree menu / deck / QR) open on WHICHEVER wall
          summons them — the walls are one continuous room, so a person
          dwelling a build tree on wall A gets the anchored menu right there.
          The TREE MENU replaces the old modal BuildDetail: it expands beside
          the picked tree (RoomScene passes the pick-time screen rect) and
          closes on ✕, on picking empty ground (onPickMiss), or moves when
          another tree is picked. Its plain enabled <button>s are dwell
          targets automatically (GestureLayer collectDomTargets). */}
      {selectedProcess !== null ? (
        <TreeMenu
          process={selectedProcess}
          snapshot={snapshot}
          anchor={menuAnchor}
          onClose={closeMenu}
          onOpenDeck={(upid, backend) => {
            // The deck window takes over — one overlay at a time.
            setSelected(null);
            setSlideshowBackend(backend ?? null);
            setSlideshowUpid(upid);
          }}
          onDismiss={(upid) => void dismissProcess(upid)}
          onOpenLiveApp={(upid) => {
            // The holo panel takes the menu's place beside the tree — it
            // inherits the pick-time anchor, and only ONE panel ever exists.
            setHoloPanel({ upid, anchor: menuAnchor });
            setSelected(null);
          }}
          onGrowBranch={(upid) => void growBranch(upid)}
        />
      ) : null}

      {/* BRANCH / ISSUE POPUPS (adopted trees): the limb-tip / fruit
          contextual glass, anchored to the picked SUB-OBJECT's rect. Closed
          by ✕, by opening the other, or by the dwell-miss ground-click
          (closeTopPopup — above the tree menu, below the holo panel). */}
      {branchPopup !== null
        ? (() => {
            const popupProcess = snapshot.processes.find((candidate) => candidate.upid === branchPopup.upid);
            return popupProcess !== undefined ? (
              <BranchPopup
                process={popupProcess}
                branch={branchPopup.branch}
                anchor={branchPopup.anchor}
                // The SELF tree's limbs resolve out of the forest spec (the
                // mirror carries no treeRepo); the local rails ride along so
                // the static renderer can exercise the version buttons.
                self={selfTree !== null ? { tree: selfTree, versions: initialSelfBranches ?? null } : null}
                onClose={() => setBranchPopup(null)}
              />
            ) : null;
          })()
        : null}
      {issuePopup !== null
        ? (() => {
            const popupProcess = snapshot.processes.find((candidate) => candidate.upid === issuePopup.upid);
            return popupProcess !== undefined ? (
              <IssuePopup
                process={popupProcess}
                issue={issuePopup.issue}
                anchor={issuePopup.anchor}
                onClose={() => setIssuePopup(null)}
              />
            ) : null;
          })()
        : null}

      {/* HOLO PANEL: the imported tree's LIVE deployment (via the same-origin
          /salem proxy) floating beside the tree. Mounted like the tree menu —
          on whichever wall summoned it — and closed by ✕ or the dwell-miss
          ground-click (closeTopPopup closes it BEFORE the tree menu). */}
      {holoPanel !== null
        ? (() => {
            const holoProcess = snapshot.processes.find((candidate) => candidate.upid === holoPanel.upid);
            return holoProcess !== undefined ? (
              <HoloPanel process={holoProcess} anchor={holoPanel.anchor} onClose={() => setHoloPanel(null)} />
            ) : null;
          })()
        : null}

      {slideshowUpid !== null
        ? (() => {
            const deckProcess = snapshot.processes.find((candidate) => candidate.upid === slideshowUpid);
            return deckProcess !== undefined ? (
              <Slideshow
                process={deckProcess}
                onLifecycle={(upid, action) => void processLifecycle(upid, action)}
                onClose={() => setSlideshowUpid(null)}
                initialBackend={guided?.step === "decide" ? guided.readyBackend : slideshowBackend}
                onDecision={(choice) => deckDecision(deckProcess.upid, choice)}
                decisionState={deckDecisionState}
                onSteer={(text) => void deckSteer(deckProcess.upid, text)}
                /* The guided demo's decide finale opens the generated deck
                   STRAIGHT on its decision slide (#decision hash nav). */
                openAtDecision={guided?.step === "decide"}
              />
            ) : null;
          })()
        : null}
      {researchDeckQuest !== null ? (
        <ResearchDeckOverlay quest={researchDeckQuest} onClose={() => setResearchDeckId(null)} />
      ) : null}
      {qrOpen ? <QrImport processes={snapshot.processes} onClose={() => setQrOpen(false)} /> : null}
      {guestsOpen ? <GuestHands onClose={() => setGuestsOpen(false)} /> : null}
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
          onDone={() => {
            // Done is the ONLY way forward from the idea step: accept builds
            // from the surfaced idea (or the raw transcript, server-side),
            // then the demo advances — the race adopts the newborn process,
            // and a silent Done still moves the visitor along.
            void acceptIdea().then(() => {
              guidedSkip();
            });
          }}
        />
      ) : null}
      {/* AUTO-CALIBRATION: wall-bound windows watch for a running projector
          calibrator (gesturewall.autocal via the /api/autocal proxy) and flip
          into the fullscreen calibration surface by themselves — rendered
          LAST + at the top z-index so the opaque surface suppresses every
          other overlay while the cameras measure this screen. */}
      {urlConfig.wall !== null ? (
        <CalibrationOverlay
          wall={urlConfig.wall}
          initialState={initialOverlay?.calibration ?? null}
          onActiveChange={onCalibrationActive}
        />
      ) : null}
    </main>
  );
}

// Live-mic control: toggles browser capture and shows a real-time input level
// meter so the room can confirm the mic is actually feeding the server. When the
// server reports ASR mode "replay" (no DEEPGRAM_API_KEY), audio still streams and
// the meter moves, but words are not transcribed — surfaced via the title hint.
// Placement-time fullscreen affordance: browsers only honor requestFullscreen
// from a real user gesture, so this is a mouse/trackpad button for when the
// operator drags a wall window onto its projector. It hides once the window
// is fullscreen (or effectively fullscreen, e.g. Chrome --kiosk).
function FullscreenButton() {
  const [visible, setVisible] = useState<boolean>(() => needsFullscreenHint());
  useEffect(() => {
    const update = () => setVisible(needsFullscreenHint());
    // Keyboard path: plain "f" toggles fullscreen (keydown counts as a real
    // user gesture, so requestFullscreen is honored). Stays bound while the
    // button is hidden so "f" also EXITS fullscreen. Ignored with modifiers
    // held or while typing into a field.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "f" && event.key !== "F") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target !== null &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (document.fullscreenElement !== null) {
        void document.exitFullscreen?.();
      } else {
        void document.documentElement.requestFullscreen?.();
      }
    };
    document.addEventListener("fullscreenchange", update);
    window.addEventListener("resize", update);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!visible) {
    return null;
  }
  return (
    <button
      type="button"
      className="ctl-button fullscreen-button"
      data-testid="fullscreen-button"
      // Dwell-exempt: requestFullscreen only works from a TRUSTED gesture
      // (real mouse/keyboard). A dwell cursor "clicking" this would silently
      // no-op — use the keyboard F, or a real mouse click.
      data-dwell-exempt="true"
      title="Fullscreen this wall on its projector (or press F)"
      onClick={() => {
        void document.documentElement.requestFullscreen?.();
      }}
    >
      ⛶ Fullscreen <span className="fullscreen-key-hint">(F)</span>
    </button>
  );
}

function needsFullscreenHint(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  if (document.fullscreenElement !== null) {
    return false;
  }
  // Kiosk/native-fullscreen windows report no fullscreenElement but already
  // cover the screen — no hint needed there.
  const screenH = window.screen?.height ?? 0;
  return screenH === 0 || window.innerHeight < screenH - 2;
}

// ONE button for mic + Idea Capture (live-room request): "mic on" and
// "capturing" were two adjacent controls; a visitor should hit a single
// target. Inactive it invites ("🎤 Capture idea"); active it shows a live
// capturing indicator — the pulsing dot plus the mic level meter (the RMS the
// mic capture already reports) — and deactivating stops BOTH mic and capture.
function MicCaptureControl({
  active,
  micState,
  level,
  error,
  mode,
  bytesReceived,
  onToggle,
}: {
  active: boolean;
  micState: "off" | "connecting" | "live";
  level: number;
  error: string | null;
  mode?: "deepgram" | "voxterm" | "replay";
  bytesReceived: number;
  onToggle: () => void;
}) {
  // Map RMS (~0–0.3 for speech) onto a 0–100% bar with mild gain.
  const levelPercent = Math.min(100, Math.round(level * 320));
  const label = micState === "connecting" ? "Starting" : active ? "● Capturing" : "🎤 Capture idea";
  const hint = active
    ? mode === "replay"
      ? "Capturing. Audio streams to the server, but transcription needs DEEPGRAM_API_KEY."
      : "Capturing: live mic → server ASR → ideas. Click to stop the mic and Idea Capture together."
    : "One button: unmute + mic on + Idea Capture on. Click again to stop both.";

  return (
    <div className="mic-control" data-testid="mic-capture-control" data-state={micState}>
      <button
        type="button"
        className={`ctl-button mic-capture mic-${micState}${active ? " on" : ""}`}
        data-testid="mic-capture-button"
        data-state={active ? "on" : "off"}
        aria-pressed={active}
        onClick={onToggle}
        disabled={micState === "connecting"}
        title={error ?? hint}
      >
        <span className="mic-dot" aria-hidden="true" />
        {label}
      </button>
      {micState === "live" ? (
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

// NOTE: the FleetPanel rail is GONE (operator-directed redesign): its
// per-process controls now live in the anchored per-tree menu (TreeMenu.tsx),
// opened by picking a tree in the garden. FleetScroll.tsx / BuildChips.tsx
// stay as components — the deck HUD still composes BuildChips/ProcessControls.

function TranscriptStream({ lines }: { lines: TranscriptLine[] }) {
  // Newest line FIRST: this is a passive wall display with no scroll
  // interaction, and appending at the bottom of an overflowing card meant new
  // lines landed below the fold — the transcript looked permanently frozen.
  const newestFirst = [...lines].reverse();
  return (
    <section className="rail-card transcript-card" data-region="transcript">
      <h3 className="rail-title">Transcript</h3>
      <div className="transcript-scroll">
        {newestFirst.map((line) => (
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
