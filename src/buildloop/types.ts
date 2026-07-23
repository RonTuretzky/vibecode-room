export type BuildBackendId = "smithers" | "eliza" | "native";
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
