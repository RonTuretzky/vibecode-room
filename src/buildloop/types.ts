export type BuildBackendId = "smithers" | "eliza" | "native";
export interface BuildRequest {
  upid: string;                 // e.g. "upid-3"
  ideaId: string;
  prompt: string;               // idea pitch text
  callsign: string | null;
  outDir: string;               // ABSOLUTE dir to write the app into: <repo>/builds/<upid>/<backendId>/
  correction?: string;          // steer mode: outDir already has an app; apply this spoken correction to it
  signal: AbortSignal;          // MUST abort within ~2s (emergency-stop budget); kill subprocesses
  onProgress: (u: { label: string; percent?: number; detail?: string }) => void;
}
export interface BuildResult {
  ok: boolean;
  entrypoint: string | null;    // "index.html" relative to outDir
  summary: string;              // 1-paragraph human summary of what was built
  error?: string;
}
export interface BuildBackend {
  readonly id: BuildBackendId;
  readonly label: string;
  available(): Promise<{ ok: boolean; reason?: string }>;
  build(req: BuildRequest): Promise<BuildResult>;
}
