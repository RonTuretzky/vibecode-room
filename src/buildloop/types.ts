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
  signal: AbortSignal;          // MUST abort within ~2s (emergency-stop budget); kill subprocesses
  onProgress: (u: { label: string; percent?: number; detail?: string }) => void;
}
export interface BuildResult {
  ok: boolean;
  entrypoint: string | null;    // "index.html" relative to outDir
  summary: string;              // the mock's headline PITCH LINE (one punchy sentence)
  error?: string;
}
export interface BuildBackend {
  readonly id: BuildBackendId;
  readonly label: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  build(req: BuildRequest): Promise<BuildResult>;
}
