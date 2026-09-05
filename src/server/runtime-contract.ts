import type { AcceptanceController } from "../acceptance/spawn";
import type { MuteController } from "../audio/mute-controller";
import type { CueAdapter } from "../cue/adapter";
import type { CueBridgeMode } from "./cue-bridge";
import type { EmergencyStopController } from "../emergency/stop";
import type { TraceProcessor } from "../obs/trace";
import type { ProcessRegistry } from "../process/registry";
import type { DegradationNotice } from "./degradation-notice";
import type { RunEventDriver } from "./run-event-driver";
import type { GatewayRpcTransport } from "../seam/smithers-client";
import type { ASRProvider, AsrProviderMode } from "../providers";
import type { ClaudeMessagesTransport, ReplayASRSource, TTSProvider, TTSTransport, VoxTermSegmentSource } from "../providers";
import type { AudioSink } from "./audio-device-sink";
import type { IdeaBuildRegistry, BuilderAgent } from "./idea-builder";
import type { BackendSelector } from "../buildloop/selector";
import type { BuildOrchestrator } from "../buildloop/orchestrator";
import type { ExecutionRegistry, ExecutionSnapshot } from "../buildloop/execution";
import type { BuildBackend } from "../buildloop/types";
import type { publishDeck, PublishDeckFn } from "../publish/gh-pages";
import type { SuggestionEngine, PendingQueuedSuggestion } from "../suggest/engine";
import type { DetectionRunner } from "./detection-runner";
import type { CloudGraph, ResearchLoop, ConceptTree, ResearchAgent, ResearchSuggester } from "../research";
import type { GitHeadFact } from "../self/commission";
import type { SeamDispatcher } from "../seam/dispatcher";
import type { cloneRepo, repoDigest } from "./repo-clone";
import type { resolveDeployUrl } from "./deploy-resolver";
import type { GitCommandRunner } from "./tree-git";
import type { ForestCommandRunner } from "./github-org";
import type { ProjectBrief } from "./project-brief";
import type { ProjectIntent } from "./project-intake";
import type { TreeIssue } from "./tree-issues";
import type { IdeaDetector } from "../detect";
import type { StageSequencer } from "../spine/stage-sequencer";
import type { ProjectorSnapshot } from "../ui/types";


// Subscribers receive the snapshot object AND its one-time serialization so N
// SSE clients share a single JSON.stringify per publish instead of each doing
// their own.
export type ProjectorRuntimeSubscriber = (snapshot: ProjectorSnapshot, serialized: string) => void;


// A live browser-microphone session. The /api/mic WebSocket pushes raw PCM
// frames in via `pushAudio`; the runtime streams them through the ASR provider
// and surfaces resulting transcript lines on the projector snapshot.
export interface MicSession {
  readonly id: string;
  pushAudio(chunk: Uint8Array): void;
  stop(): Promise<void>;
}


/**
 * WHAT THE OPEN RECORD WINDOW WILL DO WITH WHAT IT HEARS.
 *
 *  • "onto" — graft: apply the spoken change to a branch. `branch` names the
 *    one the operator dwelled on, or null for the default (continue on the
 *    tree's newest room/* rail, cutting one only if none exists).
 *  • "grow" — cut a BRAND NEW branch named by the words themselves, and apply
 *    the change there. Never reuses a rail: reusing one is exactly what the
 *    operator pressed 🌱 grow a branch to avoid.
 *
 * A discriminated union rather than a nullable branch + a boolean, because the
 * pair makes "graft onto room/x AND cut a fresh one" representable, and a
 * sentinel branch name would leak onto the wire (snapshot.steeringBranch is
 * public and read by the branch card).
 */
export type SteerScope = { mode: "onto"; branch: string | null } | { mode: "grow" };


export interface ProjectorRuntimeEnv {
  DEEPGRAM_API_KEY?: string;
  VIBERSYN_SESSION_ID?: string;
  VIBERSYN_INITIAL_MUTED?: string;
  // Opt-in: seed the FIXTURE demo fleet (Atlas/Cobalt) into the live registry at
  // boot. OFF by default so an idle live runtime has zero processes; set to "1"
  // for the projector demo (`bun run start`) / tests that exercise the fleet.
  VIBERSYN_SEED_DEMO_FLEET?: string;
  [key: string]: string | undefined;
}


export interface ProjectorRuntime {
  readonly sessionId: string;
  // The directory this room's permanent transcript archive is written to, or
  // null when it keeps no record. The read-back endpoints report it so "where
  // are my words" has an answer even when the archive is off.
  readonly transcriptArchiveDir: string | null;
  readonly asrMode: AsrProviderMode;
  readonly micMode: AsrProviderMode;
  readonly asr: ASRProvider;
  readonly tts: TTSProvider;
  readonly cueAdapter: CueAdapter;
  // Which Cue wake/earcon path is active (GAP-006). `null` only before the async
  // bridge selection runs; `createProjectorRuntime` always resolves it.
  readonly cueBridgeMode: CueBridgeMode | null;
  // Structured startup degradation notice (GAP-002): which legs resolved to a
  // stubbed/offline backend and how to upgrade each. Logged at boot and surfaced
  // on /api/health so a degraded deployment is explicit, not silent.
  // The notice REBUILT with live facts — currently the gateway's reachability
  // and advertised protocol, which the boot-time `degradation` cannot know
  // because a gateway is a separate process that can die after boot. Bounded
  // and cached (gateway-probe.ts), so /api/health stays cheap.
  degradationNow(): Promise<DegradationNotice>;
  readonly degradation: DegradationNotice;
  readonly muteController: MuteController;
  readonly suggestionEngine: SuggestionEngine;
  // Ambient idea detection (replaces the word/time gate): windowed model inference
  // over the rolling transcript that surfaces grounded idea candidates. Drives the
  // idea bubble, click-to-build, and auto-build.
  readonly detection: DetectionRunner;
  readonly acceptanceController: AcceptanceController;
  readonly registry: ProcessRegistry;
  readonly stageSequencer: StageSequencer;
  readonly trace: TraceProcessor;
  readonly emergencyController: EmergencyStopController;
  // Subscribes each spawned run to the gateway's live event stream and folds the
  // frames into a per-UPID overlay that the process panel reads (ISSUE-0021), so
  // a live run shows real progress/lastOutput/state instead of demo fixtures.
  readonly runEventDriver: RunEventDriver;
  // Seam action API executor (/api/seam/*): validates DispatchedActions and
  // executes them against the live registry — the SAME fleet the voice and
  // click paths drive — so an HTTP/WS action and a spoken command are one system.
  readonly seamDispatcher: SeamDispatcher;
  // Real accept->build->preview registry: each voice-accepted idea scaffolds a
  // runnable artifact + a live preview server, tracked here per UPID so the
  // snapshot can surface previewUrl/buildStatus and lifecycle can tear it down.
  readonly ideaBuilds: IdeaBuildRegistry;
  // Multi-backend BUILD LOOP (src/buildloop). The selector owns the registered
  // backend roster + enable/availability state (the snapshot's top-level
  // `backends[]` and POST /api/backends); the orchestrator fans each accepted
  // idea out to every enabled+available backend concurrently and tracks the
  // per-process builds[] fragment the wall consumes. Since the two-stage pivot
  // these lanes are fast CONCEPT MOCKS (kickoff), not full apps.
  readonly buildSelector: BackendSelector;
  readonly buildOrchestrator: BuildOrchestrator;
  // COMMISSION stage (two-stage pivot): the per-UPID execution lane for the
  // durable subscription run — artifacts preview + lane snapshot. Launched
  // only by an explicit executeProcess (never at accept), torn down on halt /
  // emergency stop.
  readonly executionRegistry: ExecutionRegistry;
  // COMMISSION a kicked-off process: launch the durable `vibersyn-process`
  // gateway run (claude subscription via the existing shim + steer-window
  // workflow), flip the process's execution lane to `executing`, and subscribe
  // its live run-event telemetry. Idempotent per UPID; errors are typed so the
  // HTTP route can 400/404 honestly.
  executeProcess(upid: string, correlationId?: string): Promise<ExecuteProcessResult>;
  // GIT SUBSTRATE explicit publish ("push this tree to GitHub now"): the same
  // idempotent private-repo publish the commission fires, exposed for the
  // publish-repo route. {ok:false} when the substrate is disabled, the UPID
  // is unknown, or the tree was adopted from a GitHub import.
  publishTreeRepo(upid: string, correlationId?: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  // ADOPTED-TREE BRANCH RAILS (the PR engine for GitHub imports). Create a
  // real room/<slug> branch off the freshly fetched origin/main tip; ride
  // spoken changes to a REAL PR against the import's own origin (commit the
  // clone's working tree if dirty → push only room/<slug> → gh pr create).
  // Honest {ok:false} for local trees — these rails are adopted-only.
  createTreeBranch(upid: string, name: string, correlationId?: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }>;
  openTreeBranchPr(
    upid: string,
    branch: string,
    input?: { title?: string; body?: string },
    correlationId?: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  // The LAST rail of the ride (branch → commits → PR → merged): squash-merge
  // the branch's open PR through the gh seam. Idempotent — an already-merged
  // PR answers ok. For an import whose host deploys latest main, this IS the
  // deploy, so the UI asks twice before it calls.
  mergeTreeBranch(upid: string, branch: string, correlationId?: string): Promise<{ ok: true; merged: true } | { ok: false; error: string }>;
  // WHY THE BRANCH RAILS WOULD REFUSE THIS TREE, in the substrate's own words,
  // or null when they apply. For a caller that has to decide BEFORE it starts
  // anything — the grow-scoped /select, which would otherwise open a record
  // window whose only possible ending is a refusal delivered after the
  // operator has finished speaking.
  treeBranchRailRefusal(upid: string): string | null;
  // The tree's repo facts for menus/popups (GET /api/process/:upid/repo):
  // origin + branches (with per-branch prUrl once open) + optional deployUrl
  // (an import's resolved live deployment, else the take-home publish URL).
  treeRepoInfo(upid: string): {
    origin: string | null;
    branches: Array<{ name: string; commits: number; prUrl?: string }>;
    deployUrl?: string;
  } | null;
  // ANSWER LEDGER (the deck's swipe-to-answer cards): record a chosen answer
  // for a process (latest answer per questionId wins) and read them back. The
  // /answer route records BEFORE steering; the slideshow hook passes the
  // ledger into every deck regeneration so answered cards render pre-decided
  // — an answer survives the steer → rebuild → deck-regen loop.
  recordAnswer(upid: string, entry: DeckAnswer): void;
  answeredQuestions(upid: string): DeckAnswer[];
  // SELF-HOSTING MODE (VIBERSYN_SELF_MODE=1). `bootId` is this process's
  // stable per-boot id — surfaced on /api/health and the snapshot so a wall
  // can detect that the server it reconnected to is a NEW build and reload
  // itself. `requestSelfReload` is the guarded reload trigger: honored only in
  // self mode, serialized, and gated on the last self-run having verified
  // green — on success the server publishes reloadPending, briefly lets
  // in-flight responses finish, then exits 87 (the run-room --self supervisor
  // rebuilds and relaunches it).
  readonly bootId: string;
  readonly selfMode: boolean;
  requestSelfReload(correlationId?: string): { ok: true } | { ok: false; reason: string };
  // SELF-REBUILD runtime toggle ("the room rebuilds itself", POST
  // /api/self-rebuild): gates the green-self-commit → exit-87 trigger at
  // RUNTIME, independent of the boot env. Boot default is VIBERSYN_SELF_MODE
  // (on under the --self supervisor). Flipping it cannot summon a supervisor
  // that isn't there — off VETOES the rebuild-and-relaunch trigger, on arms
  // it for the next verified green self-run.
  setSelfRebuild(on: boolean, correlationId?: string): ProjectorSnapshot;
  selfRebuild(): boolean;
  pendingSuggestion(): PendingQueuedSuggestion | null;
  snapshot(): ProjectorSnapshot;
  // Rebuild + broadcast the snapshot NOW and return it. The HTTP control routes
  // call this after registry mutations that do not republish on their own
  // (pause/resume/steer — only halt fires onHalt), so the returned body and the
  // SSE stream both reflect the mutation immediately.
  publishNow(): ProjectorSnapshot;
  subscribe(subscriber: ProjectorRuntimeSubscriber): () => void;
  // Lightweight mic telemetry channel (SSE `mic` events): the streaming byte
  // counter ticks here instead of forcing full-snapshot publishes.
  subscribeMic(subscriber: (serialized: string) => void): () => void;
  unmute(correlationId?: string): Promise<ProjectorSnapshot>;
  emergencyStop(correlationId?: string): Promise<ProjectorSnapshot>;
  startMicSession(correlationId?: string): MicSession;
  // Click-to-build (CLICK THE IDEA BUBBLE -> BUILD): accept the CURRENT pending
  // suggestion directly, bypassing the spoken AcceptanceClassifier/semantic gate,
  // by spawning through the same accept path (build:true) so ideaBuilds.build runs
  // and a process with previewUrl/buildStatus appears on the snapshot. A no-op
  // returning the current snapshot when there is no pending suggestion.
  acceptPendingSuggestion(correlationId?: string): Promise<ProjectorSnapshot>;
  // Click-to-steer (CLICK A PROJECT -> STEER IT): set the steering target UPID so
  // subsequent live FINAL transcript lines route to THAT process's agent loop
  // (registry.steer) instead of seeding a fresh ambient suggestion. The `scope`
  // says what the window DOES with what it hears — graft onto a branch
  // (optionally a named one) or grow a fresh one named by the speech. Stored
  // beside the target and cleared with it.
  setSteeringTarget(upid: string, correlationId?: string, scope?: SteerScope): ProjectorSnapshot;
  // Clear the steering target; live transcript returns to ambient suggestion +
  // click-to-build behavior. For an ADOPTED tree with a non-empty spoken slice,
  // the clear ALSO fires the steer applier (steer-applier.ts): the joined
  // slice becomes a real, bounded commit on the tree's room/<slug> branch.
  clearSteeringTarget(correlationId?: string): ProjectorSnapshot;
  submitProjectChange(upid: string, text: string, scope: SteerScope): Promise<boolean>;
  setPlantPosition(upid: string, point: { x: number; z: number }): boolean;
  retryProject(upid: string): Promise<boolean>;
  cancelProjectWork(upid: string): Promise<boolean>;
  shutdownWork(): Promise<void>;
  cancelSteeringTarget(): ProjectorSnapshot;
  branchJobAction(id: string, action: "retry" | "cancel"): boolean;
  steeringTarget(): string | null;
  steeringBranch(): string | null;
  // ADOPTED-TREE ISSUES (GET /api/process/:upid/issues): the origin repo's
  // open issues via the gh seam ({issues: [{number, title, labels}]}),
  // 60s-cached per upid, {issues: []} for local/self trees or ANY failure.
  treeIssues(upid: string): Promise<{ issues: TreeIssue[] }>;
  // PROJECT INTAKE (project-intake.ts / project-brief.ts): what an import
  // asked the room to do, and what studying it turned up. Null for trees that
  // were never imported or never studied — the wall shows the "About this
  // project" row only when there is something behind it.
  projectBrief(upid: string): ProjectBrief | null;
  projectIntent(upid: string): ProjectIntent | null;
  // The brief's one press forward: fan a studied project out to the build
  // backends after all. No-op for anything that was not studied.
  buildStudiedProject(upid: string, correlationId?: string): ProjectorSnapshot;
  // AUTO-BUILD toggle (no click required): when on, every fired suggestion is
  // accepted+built the instant it pops.
  setAutoAccept(on: boolean, correlationId?: string): ProjectorSnapshot;
  autoAccept(): boolean;
  // SELF VERSION RAILS: the room's own branch list (record windows cut one
  // per spoken change) and load-a-version (checkout + supervisor relaunch).
  selfBranches(): Promise<{ current: string; branches: Array<{ name: string; subject: string; date: string }> }>;
  checkoutSelfBranch(branch: string): Promise<{ ok: true } | { ok: false; error: string }>;
  // TEND A LIMB: archive (room/x -> archive/x) or delete a room/* branch that
  // is not the running one. The wall's tree-menu lifecycle actions; the room
  // must never delete or archive the branch it is standing on. Delete's
  // optional `scope`: "branch" (default — today's label-only prune) or
  // "everywhere" — first EXCISE the branch's own graft commits by reverting
  // them on every OTHER branch that carries them (temp worktrees; the current
  // branch reverts in place and the room rebuilds). `excised` names each
  // branch that lost the graft, `conflicts` each branch the revert could NOT
  // land on (left untouched, reported by name — partial success is honest,
  // never silent), `reloading` says the current branch was excised and the
  // exit-87 rebuild is scheduled.
  manageSelfBranch(
    branch: string,
    action: "archive" | "delete",
    scope?: "branch" | "everywhere",
  ): Promise<
    | { ok: true; excised?: Array<{ branch: string; reverted: number }>; conflicts?: string[]; reloading?: boolean; grafts?: number }
    | { ok: false; error: string }
  >;
  // STOP GROWING (the wall's halt verb): abort the EXECUTING self-run —
  // cancels the durable run through the commissioner and settles the lane
  // failed·"aborted" — WITHOUT touching registry.halt (POST /api/process/
  // self/halt marks the pinned record dead and orphans the mirror until
  // reboot; that stays the emergency path). Idempotent: nothing executing is
  // {halted:false}, never an error.
  haltSelfRun(correlationId?: string): Promise<{ ok: true; halted: boolean } | { ok: false; error: string }>;
  // INTO THE TRUNK (finalize): merge a room/* branch to main — via its PR
  // (draft → ready, base retargeted to main, merge commit) or a plain
  // fast-forward push when no PR exists. Merging the CURRENT branch is
  // allowed: the room keeps standing on it; main simply gains its commits
  // (the operator loads main later via /api/self/checkout).
  mergeSelfBranch(
    branch: string,
  ): Promise<{ ok: true; merged: true; via: "pr" | "fast-forward" } | { ok: false; error: string }>;
  // GUIDED-DEMO HOLD: suspends the armed auto-build's self-firing while the
  // demo's "describe your idea" step is up (Done is the only trigger). TTL'd
  // server-side; releasing re-checks an armed candidate immediately.
  setGuidedHold(on: boolean): ProjectorSnapshot;
  // IDEA CAPTURE mode toggle: when on, detection runs EAGERLY (a rate-limited
  // force-detect per final) so ideas surface fast. Capture no longer implies
  // building — auto-building happens ONLY when autoAccept is on; otherwise the
  // room confirms via the tray/keyboard/voice.
  setCaptureMode(on: boolean, correlationId?: string): ProjectorSnapshot;
  captureMode(): boolean;
  // IDEA TRAY: accept a SPECIFIC ledger candidate by id (not just the primary
  // bubble), spawning/building through the same accept path as
  // acceptPendingSuggestion. 404-free by contract: an unknown id is a no-op
  // returning the current snapshot.
  acceptIdea(id: string, correlationId?: string): Promise<ProjectorSnapshot>;
  // IDEA TRAY: explicitly reject a candidate — drop it from the ledger and
  // suppress its pitch for the accept-cooldown window (nothing is built).
  // Unknown id is a no-op returning the current snapshot.
  dismissIdea(id: string, correlationId?: string): ProjectorSnapshot;
  // QR import (phone -> POST /api/projects/import): validate a GitHub URL and
  // add it to the fleet as a REAL project-in-progress: context (+ optional
  // link) fans out to the build backends immediately; a github.com/<owner>/
  // <repo> link runs the clone routine first and grounds the build in the
  // repo. Source kinds: github → { kind: "github-import", url }, everything
  // else → { kind: "phone-import", url: string | null }.
  importProject(request: string | { url?: unknown; context?: unknown }, correlationId?: string): Promise<ImportProjectResult>;
  // RESEARCH MODE: the suggester/agent loop that watches the conversation for
  // researchable material (fact-checks, deep-dives, bias scans), spawns
  // research agents on accept, and produces sourced dossier decks.
  readonly research: ResearchLoop;
  // Toggle the research suggester loop (POST /api/research-mode, voice
  // "research on/off"). Turning it on runs an immediate suggestion round.
  setResearchMode(on: boolean, correlationId?: string): ProjectorSnapshot;
  researchMode(): boolean;
  // Accept a PROPOSED research quest: spawns the research agent (fact-check +
  // bias scan + sources) in the background. 404-free: unknown/non-proposed ids
  // are a no-op returning the current snapshot.
  acceptResearch(id: string, correlationId?: string): ProjectorSnapshot;
  // Research a dialogue TURN directly (the wall clicked a turn node): creates
  // the quest and spawns the agent in one step, bypassing the passive
  // suggestion cadence. Unknown turn / mode off → no-op current snapshot.
  researchTurn(turnId: string, correlationId?: string): ProjectorSnapshot;
  // Spawn one of a completed dossier's follow-up questions as its own quest
  // (child crystal beside the parent). Unknown id/index → no-op snapshot.
  researchFollowUp(parentId: string, index: number, correlationId?: string): ProjectorSnapshot;
  // RESEARCH-TREE RESET (the wall's 🌱 button): abort every in-flight agent,
  // drop all quests + dossiers, clear the dialogue window and topics.
  resetResearchTree(correlationId?: string): ProjectorSnapshot;
  // Dismiss a quest: proposed → dropped + topic suppressed; researching →
  // cancelled; complete/failed → cleared from the wall.
  dismissResearch(id: string, correlationId?: string): ProjectorSnapshot;
  // The completed quest's dossier deck (self-contained HTML slideshow with a
  // QR code per source), or null when the quest is unknown/not complete.
  researchDeckHtml(id: string): Promise<string | null>;
}


export type ImportProjectResult =
  | { ok: true; snapshot: ProjectorSnapshot; upid: string; callsign: string; title: string | null }
  | { ok: false; error: string };


// One recorded swipe-deck answer (the deck's question cards). The slideshow
// track consumes this shape as AnsweredDeckQuestion (structural mirror).
export interface DeckAnswer {
  questionId: string;
  prompt: string;
  answer: string;
}


// COMMISSION result for the HTTP/voice surfaces. `status` maps directly onto
// the /api/process/:upid/execute response code: 404 unknown/dead UPID, 400
// already executing/built or emergency-stopped.
export type ExecuteProcessResult =
  | { ok: true; execution: ExecutionSnapshot | null; snapshot: ProjectorSnapshot }
  | { ok: false; status: 400 | 404; error: string; execution?: ExecutionSnapshot | null };


export interface SeededProcessView {
  upid: string;
  runId: string;
  callsign: string;
  task: string;
  model: string;
  progressLabel: string;
  progress: number;
  lastOutput: string;
  events: string[];
}


export interface ProjectorRuntimeOptions {
  stateFile?: string | null;
  branchAgent?: import("./branch-jobs").BranchAgent;
  // Injects a gateway RPC transport for the Smithers client (tests/e2e drive the
  // gateway path with a stub transport; production builds the real one from env).
  smithersTransport?: GatewayRpcTransport;
  // Injectable ASR sources for the registry-selected backends (tests/e2e feed a
  // synthetic feed with no mic/process/network). `voxtermSource` drives the
  // voxterm backend; `replaySource` (observations array or jsonl path) drives the
  // replay backend. Both flow to the ambient + live-mic providers.
  voxtermSource?: VoxTermSegmentSource;
  replaySource?: ReplayASRSource;
  // Injectable Anthropic transport for the auto-selected Claude decider, so a
  // credential-present runtime can be exercised in tests/e2e with no network.
  decisionTransport?: ClaudeMessagesTransport;
  // Injectable ElevenLabs streaming transport (ISSUE-0022), so a runtime with
  // VIBERSYN_TTS_PROVIDER=elevenlabs can drain a stubbed synthesized stream in
  // tests/e2e with no network or audio device.
  ttsTransport?: TTSTransport;
  // Injectable real audio sink (ISSUE-0026). When provided it backs BOTH the
  // earcon playPcm path and the TTS drain sink, so a test/the browser-broadcast
  // path (ISSUE-0027) can substitute a sink that actually retains the audible
  // bytes. Unset, the runtime falls back to selectAudioSink(env) — the silent
  // no-op sink unless VIBERSYN_AUDIO_SINK=device.
  audioSink?: AudioSink;
  // Injectable monotonic clock (ISSUE-0024). The whole runtime — including the
  // room-idle gap that drives deferred-suggestion delivery — reads time through
  // this, so tests advance silence deterministically instead of waiting on the
  // wall clock. Defaults to Date.now.
  clock?: () => number;
  // Root directory the real accept->build->preview artifacts are scaffolded under
  // (idea-builder). Defaults to <cwd>/builds. Tests point it at a temp dir so the
  // repo tree stays clean and each run is isolated.
  buildsRoot?: string;
  // Phone-import GitHub clone seam. Production defaults to the real shallow
  // `git clone` (repo-clone.ts); tests inject a fake so no git subprocess or
  // network fetch ever runs from the suite.
  cloneRepoFn?: typeof cloneRepo;
  repoDigestFn?: typeof repoDigest;
  // DEPLOYMENT RESOLVER seam (an imported tree FINDS its live app): the whole
  // chain — VIBERSYN_DEPLOY_MAP override → clone scrape + HEAD probes → gh
  // garnish — kicked fire-and-forget by the GitHub import routine once the
  // clone settles. Undefined = the real resolver; NULL disables entirely —
  // the test idiom (an import test that leaves this unset would HEAD-probe
  // real hosts and spawn a real gh).
  resolveDeployFn?: typeof resolveDeployUrl | null;
  // GIT SUBSTRATE ("tree = repo") seams. `treeGitRunner` undefined = the real
  // `git` subprocess runner; NULL = substrate disabled entirely — the test
  // idiom (any test that drives an accept with fake buildBackends but leaves
  // this unset would spawn real git into its temp dir). `treeGhRunner` backs
  // the commission-time publish (gh repo create / pr create).
  treeGitRunner?: GitCommandRunner | null;
  treeGhRunner?: ForestCommandRunner;
  // SELF VERSION-RAIL seams (the room's OWN checkout, not a build's clone):
  // `selfGitRunner` undefined = the real `git` subprocess in process.cwd();
  // injected = every self rail (branches/checkout/archive/delete/merge) is
  // testable with no subprocess. `selfGhRunner` backs the finalize (merge)
  // and remote-prune gh calls the same way — plain keychain gh, never the
  // tree-git credential chain.
  selfGitRunner?: GitCommandRunner;
  // Test seam: replaces the real gateway /health round-trip so the unreachable
  // and protocol-mismatch paths are provable without a socket.
  gatewayProbe?: (url: string) => Promise<import("./gateway-probe").GatewayLiveness>;
  selfGhRunner?: ForestCommandRunner;
  // The real coding agent that turns an accepted idea's scaffold into a working
  // app (idea-builder). Defaults to the host `claude` CLI builder. Tests inject a
  // synthetic builder so no real `claude` spawn occurs.
  builderAgent?: BuilderAgent;
  // Multi-backend build roster for the BUILD LOOP fan-out (src/buildloop).
  // Production defaults to the real smithers/native/eliza backends. Tests inject
  // fakes so no real model call or CLI spawn occurs. Seam contract: when this is
  // ABSENT and a legacy `builderAgent` IS injected, the accept path keeps the
  // LEGACY single-build ideaBuilds route (the existing e2e contract — root
  // previewUrl, ideaBuilds.settle) and the orchestrator is constructed but not
  // wired into the registry; injecting buildBackends always routes accepts
  // through the orchestrator instead.
  buildBackends?: BuildBackend[];
  // Injectable idea detector (the inference that decides whether a buildable idea
  // was proposed and which span of conversation it came from). Production selects
  // host-`claude` inference, or the durable Smithers `idea-detection` run when a
  // gateway is configured. Tests inject a scripted/heuristic detector so detection
  // is deterministic with no model spawn.
  ideaDetector?: IdeaDetector;
  // Root directory the COMMISSIONED durable runs write their full-app artifacts
  // under (the vibersyn-process workflow's contract-fixed output root). Defaults
  // to <cwd>/artifacts/vibersyn-runs. Tests point it at a temp dir.
  executionArtifactsRoot?: string;
  // SELF-HOSTING seams (VIBERSYN_SELF_MODE=1). `selfGitHead` injects the green-
  // gate git probe (tests fake the HEAD sequence; production shells out to
  // `git log -1`). `exitProcess` injects the reload trigger's exit so tests can
  // observe the 87 without killing the test process.
  selfGitHead?: () => Promise<GitHeadFact | null>;
  exitProcess?: (code: number) => void;
  // Where the conversation's permanent archive lives (a directory of
  // YYYY-MM-DD.jsonl day segments — transcript-archive.ts). Absent → the env
  // marker VIBERSYN_TRANSCRIPT_ARCHIVE decides; null (explicit) or no marker →
  // no archive at all, which is what every directly-constructed test runtime
  // gets. This option NEVER falls back to a literal path.
  transcriptArchiveDir?: string | null;
  // GitHub Pages deck publisher seam (src/publish/gh-pages). Fired once per
  // kicked-off idea, fire-and-forget, after its FIRST pitch deck lands; the
  // resolved public URL becomes the process's publishedUrl + take-home QR.
  // Default: the real REST publisher (PAT from env — publishing is cleanly
  // disabled with a trace when no PAT resolves). Tests inject a fake; null
  // disables publishing entirely.
  publishDeck?: PublishDeckFn | null;
  // RESEARCH MODE seams: the suggester that proposes quests from the rolling
  // transcript and the agent that researches an accepted quest. Production
  // selects host-`claude` inference for both (the agent does real web
  // search); tests inject deterministic fakes so no model spawns.
  researchSuggester?: ResearchSuggester;
  researchAgent?: ResearchAgent;
  // Concept-topic clustering seam (research/tree.ts). Tests inject a
  // heuristic-only tree (model: null); production defaults to the loop's own
  // tree with the bounded Cerebras refiner.
  researchConceptTree?: ConceptTree;
  // Conversation-sky seam (research/sky.ts). Tests inject a graph with a
  // scripted relate runner (or runner: null for lexical-only); production
  // defaults to the env-cadenced graph with the bounded Cerebras runner.
  cloudGraph?: CloudGraph;
}


export interface SuggestionGateMeta {
  wordCount: number;
  elapsedS: number;
  quality: number;
}


export interface DuplicateSpawnGuardOptions {
  clock?: () => number;
  windowMs?: number;
  onSuppressed?: (info: { pitch: string; reason: "in-flight" | "recently-accepted"; correlationId: string }) => void;
}
