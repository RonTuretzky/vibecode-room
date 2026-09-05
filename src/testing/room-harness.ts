// ROOM HARNESS — boots the REAL Vibersyn room on a scratch port and injects speech.
//
// WHAT IS REAL HERE (deliberately almost everything):
//   • the real entrypoint — `bun src/server/index.ts` as a child process, so the
//     /api/mic WebSocket upgrade and MicSession lifecycle (src/server/index.ts
//     Bun.serve websocket handlers) are exercised. Those lines have essentially
//     no coverage today because every server test goes through `app.request()`
//     with no bound port.
//   • the real runtime (createProjectorRuntime), real routes, real snapshot,
//     real SSE fan-out, the real built `dist` served by the production Hono
//     static handler.
//   • the real transcript path: WebSocket → MicSession.pushAudio → ASR provider
//     → ingestTranscript → wake router / record-window collector / detection →
//     publish() → /api/events.
//
// WHAT IS FAKED (the outside world, and only at existing seams):
//   • the speech recognizer — a `voxterm` on the child's PATH
//     (scripts/fake-voxterm.ts). Production reaches its recognizer through
//     `Bun.spawn(["voxterm"])`, so this needs NO production change at all.
//   • the idea judge — VIBERSYN_IDEA_DETECTOR=heuristic, so no `claude` CLI is
//     spawned.
//   • git/GitHub/deploys/gateway/TTS — switched off by env so nothing reaches
//     the network. `capabilities()` reports exactly which legs are degraded.
//
// WHAT THIS HARNESS CANNOT EXERCISE — stated up front, per the honesty rule:
//   • src/ui/mic.ts (getUserMedia → AudioContext → ScriptProcessorNode →
//     WebSocket). The harness opens /api/mic itself; the browser's capture code
//     needs a user gesture and a real device.
//   • src/providers/asr/deepgram.ts. In voxterm mode the Deepgram normalizer,
//     its connection URL and its interim/final semantics are bypassed.
//   • the audio→text relationship. Production's own defaultVoxTermSpawn
//     (src/providers/asr/voxterm-source.ts) drops the audio stream and opens the
//     child with `stdin: "ignore"`, so the PCM this harness pushes is COUNTED by
//     the runtime (mic.bytesReceived) and then discarded. The transport is real;
//     the transcription is scripted.
// `capabilities().notExercised` returns this same list at runtime so no report
// generated from a run can overstate what was covered.
//
// RUNTIME-AGNOSTIC ON PURPOSE: only node: builtins and `ws` are used, so the
// same module drives both `bun test` scenarios and Playwright's node workers.
//
// SAFETY: never binds 8788 (the live room), 8787 (the repo's own playwright
// webServer), 7331 or 8899. Every child is killed and every temp dir removed by
// stop(), including on failure.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { compileScript, type CompiledScript, type SpeechScript } from "./speech-script";
import type { EmitRecord, ObservationRecord } from "./latency-ledger";
import type { ProjectorSnapshot } from "../ui/types";

/** Ports the harness must never touch. 8788 = the live room, in use right now. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([8787, 8788, 7331, 8899]);

/** Production capture framing, mirrored from src/ui/mic.ts (4096 samples @16kHz). */
export const MIC_SAMPLE_RATE = 16_000;
export const MIC_FRAME_SAMPLES = 4096;
export const MIC_FRAME_BYTES = MIC_FRAME_SAMPLES * 2;
export const MIC_FRAME_MS = Math.round((MIC_FRAME_SAMPLES / MIC_SAMPLE_RATE) * 1000);

export interface RoomOptions {
  /** Explicit scratch port. Default: first free port at/after 8901. */
  port?: number;
  /** VIBERSYN_SELF_MODE — the room's own tree. Default false. */
  selfMode?: boolean;
  /** VIBERSYN_SEED_DEMO_FLEET — deterministic Atlas/Cobalt fleet. Default true. */
  seedDemoFleet?: boolean;
  /** Repo root to run from. Default: the repo this file lives in. */
  repoRoot?: string;
  /** Extra/overriding env for the server child. */
  env?: Record<string, string>;
  /** Boot timeout for GET /api/health. Default 30s. */
  bootTimeoutMs?: number;
  /** Pipe the server's stdout/stderr to this process. Default false. */
  verbose?: boolean;
}

export interface SseFrame {
  event: string;
  data: string;
  atMs: number;
  bytes: number;
}

export interface SpeakResult {
  script: CompiledScript;
  /** What the injector actually emitted, with real emit timestamps. */
  emits: EmitRecord[];
  /** PCM bytes pushed over the real /api/mic WebSocket. */
  bytesSent: number;
  startedAtMs: number;
  endedAtMs: number;
}

export interface SpeakingSession {
  /** Resolves when the last scripted frame has been emitted (+ settle). */
  readonly done: Promise<void>;
  /** Frames emitted so far, read from the injector's ledger. */
  emits(): EmitRecord[];
  bytesSent(): number;
  /** Close the mic WebSocket → MicSession.stop() → the injector child is killed. */
  close(): Promise<SpeakResult>;
}

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Included in the failure message so a red test says what it wanted. */
  label?: string;
}

export interface WaitResult<T> {
  value: T;
  /** Measured wait — every assertion in this harness reports its own latency. */
  elapsedMs: number;
}

export interface RoomCapabilities {
  asrMode: string;
  degradedLegs: string[];
  /** Things this boot does NOT exercise. Printed by every scenario. */
  notExercised: string[];
}

interface HealthPayload {
  ok: boolean;
  degradation: { degraded: Array<{ leg: string; mode: string }>; allReal: boolean };
  selfMode: boolean;
}

export class RoomUnderTest {
  readonly baseUrl: string;
  readonly port: number;
  readonly #child: ChildProcess;
  readonly #tmpDir: string;
  readonly #scriptPath: string;
  readonly #ledgerPath: string;
  readonly #injectorMarker: string;
  readonly #stderr: () => string;
  readonly #sseFrames: SseFrame[] = [];
  #sseAbort: AbortController | null = null;
  #sseStartedAtMs = 0;
  #speaking = false;
  #stopped = false;

  constructor(init: {
    baseUrl: string;
    port: number;
    child: ChildProcess;
    tmpDir: string;
    scriptPath: string;
    ledgerPath: string;
    injectorMarker: string;
    stderr: () => string;
  }) {
    this.baseUrl = init.baseUrl;
    this.port = init.port;
    this.#child = init.child;
    this.#tmpDir = init.tmpDir;
    this.#scriptPath = init.scriptPath;
    this.#ledgerPath = init.ledgerPath;
    this.#injectorMarker = init.injectorMarker;
    this.#stderr = init.stderr;
  }

  async state(): Promise<ProjectorSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/state`);
    if (!response.ok) {
      throw new Error(`GET /api/state → ${response.status}`);
    }
    return (await response.json()) as ProjectorSnapshot;
  }

  async health(): Promise<HealthPayload> {
    const response = await fetch(`${this.baseUrl}/api/health`);
    return (await response.json()) as HealthPayload;
  }

  /** The runtime trace ring — how the harness proves ROUTING, not just text. */
  async traces(): Promise<Array<{ event: string; level: string; meta?: Record<string, unknown> }>> {
    const snapshot = await this.state();
    return (snapshot.trace ?? []) as unknown as Array<{ event: string; level: string; meta?: Record<string, unknown> }>;
  }

  async post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Server stderr so far — surfaced verbatim when a scenario fails. */
  serverStderr(): string {
    return this.#stderr();
  }

  /**
   * Report what this boot actually covers. Called by every scenario so the
   * output never lets a reader assume more fidelity than exists.
   */
  async capabilities(): Promise<RoomCapabilities> {
    const [health, snapshot] = await Promise.all([this.health(), this.state()]);
    const asrMode = (snapshot as unknown as { mic?: { mode?: string } }).mic?.mode ?? "unknown";
    const notExercised = [
      "src/ui/mic.ts — browser capture (getUserMedia/AudioContext/ScriptProcessorNode) is bypassed; the harness opens /api/mic directly",
    ];
    if (asrMode === "voxterm") {
      notExercised.push(
        "src/providers/asr/deepgram.ts — the Deepgram normalizer, connection URL and interim/final semantics are not on this path",
        "audio→text — production's defaultVoxTermSpawn drops the audio stream (stdin:'ignore'), so pushed PCM is counted then discarded",
      );
    }
    return { asrMode, degradedLegs: health.degradation.degraded.map((leg) => leg.leg), notExercised };
  }

  // --- SSE ledger -----------------------------------------------------------

  /**
   * Subscribe to the real /api/events stream and timestamp every frame. This is
   * the server half of the responsivity measurement (the browser half is taken
   * in-page); it also exposes publish amplification, since publish() is
   * unthrottled — every interim republishes the whole snapshot.
   */
  startSseRecorder(): void {
    if (this.#sseAbort !== null) {
      return;
    }
    const abort = new AbortController();
    this.#sseAbort = abort;
    this.#sseStartedAtMs = Date.now();
    void (async () => {
      try {
        const response = await fetch(`${this.baseUrl}/api/events`, { signal: abort.signal });
        const body = response.body;
        if (body === null) {
          return;
        }
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const block = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const frame = parseSseBlock(block, Date.now());
            if (frame !== null) {
              this.#sseFrames.push(frame);
            }
            split = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Aborted on stop(), or the server went away — both terminal here.
      }
    })();
  }

  sseFrames(): readonly SseFrame[] {
    return this.#sseFrames;
  }

  sseWindowMs(): number {
    return this.#sseStartedAtMs === 0 ? 0 : Date.now() - this.#sseStartedAtMs;
  }

  /**
   * Every transcript line the SSE stream ever carried, stamped with the arrival
   * time of the FIRST frame that contained it — i.e. "the server published it".
   */
  sseTranscriptObservations(): ObservationRecord[] {
    const seen = new Set<string>();
    const observations: ObservationRecord[] = [];
    for (const frame of this.#sseFrames) {
      if (frame.event !== "snapshot") {
        continue;
      }
      let snapshot: ProjectorSnapshot;
      try {
        snapshot = JSON.parse(frame.data) as ProjectorSnapshot;
      } catch {
        continue;
      }
      for (const line of snapshot.transcript ?? []) {
        const text = line.text.trim();
        if (seen.has(text)) {
          continue;
        }
        seen.add(text);
        observations.push({ stage: "sse", text, atMs: frame.atMs });
      }
    }
    return observations;
  }

  // --- speech injection -----------------------------------------------------

  /**
   * Stage a script and open the real /api/mic WebSocket. The server spawns the
   * injector (a `voxterm` on its PATH) as part of starting the MicSession, and
   * the injector replays the script against a wall clock.
   *
   * PCM is pushed at production's own framing (4096 samples @16kHz every 256ms,
   * matching src/ui/mic.ts) so the WebSocket transport, the MicSession queue and
   * the mic byte counter are all driven for real.
   */
  async startSpeaking(script: SpeechScript, options: { settleMs?: number } = {}): Promise<SpeakingSession> {
    if (this.#speaking) {
      throw new Error("a mic session is already open — close it before speaking again");
    }
    const compiled = compileScript(script);
    // Staged BEFORE the socket opens: the injector reads this file at spawn, and
    // the spawn happens inside runtime.startMicSession() on ws open.
    writeFileSync(this.#scriptPath, JSON.stringify({ frames: compiled.frames }));
    writeFileSync(this.#ledgerPath, "");

    // The room hard-closes a muted mic socket (src/server/index.ts), so unmute
    // through the real route rather than assuming boot state.
    await this.post("/api/unmute").catch(() => undefined);

    this.#speaking = true;
    const settleMs = options.settleMs ?? 800;
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/api/mic`);
    let bytesSent = 0;

    const startedAtMs = await new Promise<number>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error("/api/mic never sent its ready ack")), 10_000);
      socket.on("error", (error) => {
        clearTimeout(timer);
        rejectPromise(new Error(`/api/mic socket errored: ${error.message}`));
      });
      socket.on("message", (data) => {
        const text = typeof data === "string" ? data : String(data);
        let parsed: { type?: string; reason?: string };
        try {
          parsed = JSON.parse(text) as { type?: string; reason?: string };
        } catch {
          return;
        }
        if (parsed.type === "ready") {
          clearTimeout(timer);
          resolvePromise(Date.now());
        } else if (parsed.type === "error") {
          clearTimeout(timer);
          rejectPromise(new Error(`/api/mic refused the session: ${parsed.reason ?? "unknown"}`));
        }
      });
    });

    const pump = setInterval(() => {
      if (socket.readyState !== 1) {
        return;
      }
      socket.send(micFrame(bytesSent / MIC_FRAME_BYTES));
      bytesSent += MIC_FRAME_BYTES;
    }, MIC_FRAME_MS);

    const done = delay(compiled.durationMs + settleMs);
    const readEmits = (): EmitRecord[] => readLedger(this.#ledgerPath);

    return {
      done,
      emits: readEmits,
      bytesSent: () => bytesSent,
      close: async (): Promise<SpeakResult> => {
        clearInterval(pump);
        if (socket.readyState === 0 || socket.readyState === 1) {
          socket.close();
        }
        // MicSession.stop() awaits its ASR drain; give the runtime a beat to
        // fold the last observation before the caller asserts.
        await delay(150);
        // ...and sweep the injector child. The room cannot do it: see the
        // comment at the top of scripts/fake-voxterm.ts — VoxTermSpawnSource's
        // cleanup is unreachable while the recognizer keeps its session open,
        // so in voxterm mode every closed mic socket leaks a child process AND
        // a never-resolving drain task inside MicSession.stop().
        this.#sweepInjectors();
        this.#speaking = false;
        return { script: compiled, emits: readEmits(), bytesSent, startedAtMs, endedAtMs: Date.now() };
      },
    };
  }

  /** Speak a whole script and hang up: start → play out → close. */
  async speak(script: SpeechScript, options: { settleMs?: number } = {}): Promise<SpeakResult> {
    const session = await this.startSpeaking(script, options);
    await session.done;
    return session.close();
  }

  // --- polling --------------------------------------------------------------

  /**
   * Poll the live snapshot until `predicate` returns a value, reporting the
   * MEASURED wait. Every wait in this harness carries a budget: a green test
   * that took 9s is a finding, not a pass.
   */
  async waitFor<T>(
    predicate: (snapshot: ProjectorSnapshot) => T | null | undefined | false,
    options: WaitOptions = {},
  ): Promise<WaitResult<T>> {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const pollMs = options.pollMs ?? 50;
    const startedAtMs = Date.now();
    let lastError: unknown = null;
    while (Date.now() - startedAtMs < timeoutMs) {
      try {
        const snapshot = await this.state();
        const value = predicate(snapshot);
        if (value !== null && value !== undefined && value !== false) {
          return { value: value as T, elapsedMs: Date.now() - startedAtMs };
        }
      } catch (error) {
        lastError = error;
      }
      await delay(pollMs);
    }
    const label = options.label ?? "condition";
    throw new Error(
      `timed out after ${timeoutMs}ms waiting for ${label}${lastError === null ? "" : ` (last error: ${String(lastError)})`}`,
    );
  }

  // --- teardown -------------------------------------------------------------

  /** Kill any injector child this room spawned. Safe to call repeatedly. */
  #sweepInjectors(): void {
    spawnSync("pkill", ["-f", this.#injectorMarker]);
  }

  /** Kill the server child, stop the SSE reader, remove the temp dir. Idempotent. */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#sseAbort?.abort();
    this.#sseAbort = null;
    // The server child spawns the injector; a hard kill mid-session would
    // otherwise orphan it. Sweep by this room's unique argv marker.
    this.#sweepInjectors();
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(() => {
          this.#child.kill("SIGKILL");
          resolveExit();
        }, 4000);
        this.#child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
        this.#child.kill("SIGTERM");
      });
    }
    try {
      rmSync(this.#tmpDir, { recursive: true, force: true });
    } catch {
      // Best effort.
    }
  }
}

/**
 * Boot a scratch room. Builds `dist` if it is missing (the production static
 * handler resolves `process.cwd()/dist`), then spawns the real entrypoint.
 *
 * Retries on a different port when the bind loses a race — parallel Playwright
 * workers each boot their own room, and free-port probing is inherently
 * time-of-check/time-of-use.
 */
export async function startRoom(options: RoomOptions = {}): Promise<RoomUnderTest> {
  if (options.port !== undefined) {
    return bootRoom(options, options.port);
  }
  // Spread workers apart so the probe rarely collides in the first place.
  let search = 8901 + Math.floor(Math.random() * 40) * 7;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await findFreePort(search);
    try {
      return await bootRoom(options, port);
    } catch (error) {
      lastError = error;
      search = port + 1;
    }
  }
  throw new Error(`could not boot a scratch room after 5 attempts: ${String(lastError)}`);
}

async function bootRoom(options: RoomOptions, port: number): Promise<RoomUnderTest> {
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(`refusing to bind port ${port}: reserved (live room / repo webServer)`);
  }

  if (!existsSync(join(repoRoot, "dist", "index.html"))) {
    const build = spawnSync("bun", ["run", "build"], { cwd: repoRoot, encoding: "utf8" });
    if (build.status !== 0) {
      throw new Error(`bun run build failed:\n${build.stderr ?? ""}`);
    }
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "vibersyn-room-"));
  const binDir = join(tmpDir, "bin");
  const scriptPath = join(tmpDir, "speech-script.json");
  const ledgerPath = join(tmpDir, "speech-ledger.jsonl");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(scriptPath, JSON.stringify({ frames: [] }));
  writeFileSync(ledgerPath, "");

  // THE INJECTION POINT: production resolves its recognizer as the bare command
  // `voxterm` (src/providers/asr/voxterm-source.ts defaultVoxTermSpawn), so a
  // shim first on PATH replaces the outside world and nothing else.
  const shimPath = join(binDir, "voxterm");
  // The marker rides in ARGV (env vars are invisible to pkill) so teardown can
  // sweep this room's injector children and nobody else's.
  const marker = `vibersyn-harness-${basename(tmpDir)}`;
  writeFileSync(
    shimPath,
    `#!/bin/sh\nexec bun ${JSON.stringify(join(repoRoot, "scripts/fake-voxterm.ts"))} --session ${marker} "$@"\n`,
  );
  chmodSync(shimPath, 0o755);

  const child = spawn("bun", ["src/server/index.ts"], {
    cwd: repoRoot,
    env: serverEnv({ repoRoot, port, tmpDir, binDir, scriptPath, ledgerPath, options }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString("utf8");
    if (options.verbose === true) {
      process.stderr.write(chunk);
    }
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (options.verbose === true) {
      process.stdout.write(chunk);
    }
  });

  const room = new RoomUnderTest({
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    child,
    tmpDir,
    scriptPath,
    ledgerPath,
    injectorMarker: marker,
    stderr: () => stderrBuffer,
  });
  try {
    await waitForHealth(room, options.bootTimeoutMs ?? 30_000, child, () => stderrBuffer);
  } catch (error) {
    await room.stop();
    throw error;
  }
  return room;
}

/**
 * The child's complete environment — built from scratch, never inherited.
 * The repo root can carry a `.env` that bun auto-loads with REAL credentials
 * (DEEPGRAM/CEREBRAS/GITHUB_PAT/SALEM_SID/gateway URL/auto-accept). Explicit
 * values on the child take precedence over a `.env`, so every dangerous key is
 * listed here and blanked on purpose.
 */
export function serverEnv(input: {
  repoRoot: string;
  port: number;
  tmpDir: string;
  binDir: string;
  scriptPath: string;
  ledgerPath: string;
  options: RoomOptions;
}): Record<string, string> {
  const { options } = input;
  return {
    PATH: `${input.binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",

    HOST: "127.0.0.1",
    VIBERSYN_PORT: String(input.port),
    // A second listener on 0.0.0.0 at port+1 is the default; a scratch room must
    // never expose itself on the LAN.
    VIBERSYN_PHONE_LISTENER: "0",
    // Empty (not unset) disables the fire-and-forget GitHub clone that
    // src/server/index.ts performs at every boot.
    VIBERSYN_PINNED_IMPORTS: "",
    // The transcript archive is ON BY DEFAULT at the boot entry, and this
    // harness spawns that entry FOR REAL with scripted fake-voxterm speech.
    // Redirected into the scratch room's tmp dir (torn down with it) so a
    // harness run can never write invented sentences into the operator's
    // permanent record — the exact pollution 6a1d228 was written to stop.
    VIBERSYN_TRANSCRIPT_ARCHIVE: join(input.tmpDir, "transcripts"),
    VIBERSYN_STATE_FILE: join(input.tmpDir, "room-state.json"),

    // The recognizer seam.
    VIBERSYN_ASR_PROVIDER: "voxterm",
    VIBERSYN_FAKE_VOXTERM_SCRIPT: input.scriptPath,
    VIBERSYN_FAKE_VOXTERM_LEDGER: input.ledgerPath,

    VIBERSYN_INITIAL_MUTED: "0",
    VIBERSYN_SEED_DEMO_FLEET: options.seedDemoFleet === false ? "0" : "1",
    VIBERSYN_SELF_MODE: options.selfMode === true ? "1" : "0",

    // Detection must be a deterministic local heuristic: the LLM judge spawns
    // the `claude` CLI.
    VIBERSYN_IDEA_DETECTOR: "heuristic",
    VIBERSYN_DECISION_LLM: "heuristic",
    VIBERSYN_DETECT_MIN_NEW_TURNS: "1",
    VIBERSYN_DETECT_MIN_INTERVAL_MS: "0",
    VIBERSYN_DETECT_TICK_MS: "200",

    // Nothing may write a repo, open a PR, or deploy.
    VIBERSYN_TREE_GIT: "0",
    VIBERSYN_STEER_APPLIER: "0",
    VIBERSYN_AUTO_ACCEPT: "0",
    VIBERSYN_CAPTURE_MODE: "0",

    // Blank every credential a stray `.env` could supply.
    DEEPGRAM_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    CEREBRAS_API_KEY: "",
    ELEVENLABS_API_KEY: "",
    VIBERSYN_GITHUB_PAT: "",
    GITHUB_PAT: "",
    GH_TOKEN: "",
    VIBERSYN_SALEM_SID: "",
    VIBERSYN_SMITHERS_GATEWAY_URL: "",
    VIBERSYN_DEPLOY_MAP: "",
    LANGFUSE_OTLP_ENDPOINT: "",
    VIBERSYN_TTS_PROVIDER: "",
    VIBERSYN_AUDIO_SINK: "",

    ...(options.env ?? {}),
  };
}

async function waitForHealth(
  room: RoomUnderTest,
  timeoutMs: number,
  child: ChildProcess,
  stderr: () => string,
): Promise<void> {
  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`server exited during boot (code ${child.exitCode})\n${stderr().slice(-4000)}`);
    }
    try {
      const response = await fetch(`${room.baseUrl}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await delay(100);
  }
  throw new Error(`server never answered /api/health within ${timeoutMs}ms\n${stderr().slice(-4000)}`);
}

/** First free TCP port at or after `from`, skipping {@link FORBIDDEN_PORTS}. */
export async function findFreePort(from: number): Promise<number> {
  for (let port = from; port < from + 400; port += 1) {
    if (FORBIDDEN_PORTS.has(port)) {
      continue;
    }
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`no free port found at/after ${from}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = createServer();
    probe.once("error", () => resolvePromise(false));
    probe.once("listening", () => probe.close(() => resolvePromise(true)));
    probe.listen(port, "127.0.0.1");
  });
}

/** Parse one `event:`/`data:` SSE block. Exported for unit tests. */
export function parseSseBlock(block: string, atMs: number): SseFrame | null {
  const lines = block.split("\n");
  let event = "message";
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trim());
    }
  }
  if (data.length === 0) {
    return null;
  }
  return { event, data: data.join("\n"), atMs, bytes: block.length };
}

/** Read the injector's append-only emit ledger. Exported for unit tests. */
export function readLedger(path: string): EmitRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as EmitRecord;
      } catch {
        return null;
      }
    })
    .filter((record): record is EmitRecord => record !== null);
}

/**
 * One production-shaped PCM frame: 4096 mono 16-bit samples at 16kHz, exactly
 * what src/ui/mic.ts sends. A quiet tone rather than digital silence so the
 * bytes on the wire are audio-shaped.
 */
function micFrame(index: number): Uint8Array {
  const samples = new Int16Array(MIC_FRAME_SAMPLES);
  const phase = index * MIC_FRAME_SAMPLES;
  for (let i = 0; i < MIC_FRAME_SAMPLES; i += 1) {
    samples[i] = Math.round(Math.sin(((phase + i) * 2 * Math.PI * 220) / MIC_SAMPLE_RATE) * 1200);
  }
  return new Uint8Array(samples.buffer);
}
