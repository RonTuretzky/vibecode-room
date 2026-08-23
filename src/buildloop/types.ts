export type BuildBackendId = "smithers" | "eliza" | "native";

// One decision-shaping Q&A rider on the brief; `chosen` is set once the room
// has answered it (deck swipe / spoken answer).
export interface BuildBriefQa {
  id: string;
  prompt: string;
  answers: readonly string[];
  chosen?: string;
}

// The idea's context brief: everything the detection judge knew when the room
// accepted — the pitch, the VERBATIM room speech it was grounded in, why it is
// buildable, and the decision Q&A. Mirrors IdeaBrief in src/types.ts BY
// CONVENTION — that module is owned by the server/detection track and this
// track must stand alone (no cross-track imports); the shapes are structurally
// identical, so an IdeaBrief is directly assignable here.
export interface BuildBrief {
  pitch: string;
  sourceQuote: string;          // verbatim room speech (clamped ≤300 chars upstream)
  rationale: string;            // why the judge thinks it is buildable (≤200 chars upstream)
  qa: readonly BuildBriefQa[];
  callsign: string | null;
  maturity?: string;
}

// The staged-mock ladder (smithers): Task 1 HERO (hero screen + nav shell —
// the lane goes live here), Task 2 FLOWS (real flow screens), Task 3 META
// (the mock.json deck sidecar). Single-shot backends (eliza/native) never
// report stages — every stage field below is optional by contract.
export type BuildStageId = "hero" | "flows" | "meta";

// One screen of the mock as recorded in the mock.json sidecar: `path` is
// either a hash route inside the entrypoint ("#/flow") or a relative file
// path that exists on disk (backends VALIDATE before surfacing).
export interface BuildScreen {
  path: string;
  title: string;
}

// Fired by a ladder backend the moment a stage's artifact is REAL on disk —
// the orchestrator's ready-ratchet (hero → lane live) hangs off this.
export interface BuildStageEvent {
  stage: BuildStageId;
  entrypoint: string;            // entrypoint relative to outDir (valid as of this stage)
  summary?: string;              // headline pitch line, when this stage produced one
  screens?: readonly BuildScreen[];             // meta stage: validated sidecar screens
  suggestedQuestions?: readonly string[];       // meta stage: deck decision questions
}

// A structured revision of an existing mock — the typed successor of the bare
// correction string. `kind:"answer"` is a deck-question decision; `text` is
// always present (the flattened spoken/decision line every backend can apply);
// `targetScreens` lets the smithers ladder rewrite incrementally (only the
// named screens' files are serialized into the prompt). `seq` orders revisions
// per process — freshest human intent wins.
export interface BuildRevision {
  kind: "steer" | "answer";
  text: string;
  questionId?: string;
  answer?: string;
  targetScreens?: readonly string[];
  seq: number;
}

// KICKOFF scope (two-stage pivot): build() produces a fast CONCEPT MOCK — one
// self-contained static page pitching the imagined app (hero screen, visual
// identity, headline pitch line, one lightly-functional key interaction). The
// FULL app is the separate, user-triggered commission stage (execution.ts) and
// is never built here.
export interface BuildRequest {
  upid: string;                 // e.g. "upid-3"
  ideaId: string;
  prompt: string;               // idea pitch text
  callsign: string | null;
  brief?: BuildBrief;           // the idea's context brief when the accept carried one
  outDir: string;               // ABSOLUTE dir to write the mock into: <repo>/builds/<upid>/<backendId>/
  correction?: string;          // steer mode: outDir already has a mock; apply this spoken correction to it
  // Structured steer: when present it carries the same text as `correction`
  // (the flattened alias single-shot backends keep reading) plus the typed
  // intent (kind/questionId/targetScreens) the ladder applies incrementally.
  revision?: BuildRevision;
  signal: AbortSignal;          // MUST abort within ~2s (emergency-stop budget); kill subprocesses
  onProgress: (u: { label: string; percent?: number; detail?: string }) => void;
  // Stage-ladder progress: fired per completed stage (hero/flows/meta) so the
  // orchestrator can flip the lane ready at hero instead of at build() exit.
  onStage?: (event: BuildStageEvent) => void;
}
export interface BuildResult {
  ok: boolean;
  entrypoint: string | null;    // "index.html" relative to outDir
  summary: string;              // the mock's headline PITCH LINE (one punchy sentence)
  error?: string;
  // Ladder outcomes (absent for single-shot backends): which stages actually
  // landed, and the validated mock.json facts when the meta stage did.
  completedStages?: readonly BuildStageId[];
  screens?: readonly BuildScreen[];
  suggestedQuestions?: readonly string[];
}
export interface BuildBackend {
  readonly id: BuildBackendId;
  readonly label: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  build(req: BuildRequest): Promise<BuildResult>;
}
