import type { LogEvent, OutputDecision } from "../types";
import type { ProcessBuildSnapshot } from "../buildloop/orchestrator";
import type { ExecutionRegistry, ExecutionSnapshot } from "../buildloop/execution";
import { CallsignAllocator, type CallsignAssignment } from "../routing/callsigns";
import { inferProjectName, llmProjectName, type InferredProjectName } from "./project-name";
import type { SmithersClient, SpawnSeed, SpawnResult } from "../seam/smithers-client";
import type { IdeaBuildRegistry } from "../server/idea-builder";
import {
  CAPACITY_REFUSAL_ACK,
  checkPreSpawnResources,
  DEFAULT_MAX_CONCURRENT_PROCESSES,
  type HostHeadroom,
  type ResourceCheckResult,
  type SpawnRefusalReason,
} from "./resource-check";

export type RegistryProcessState = "planning" | "active" | "paused" | "dead";

export interface RegistryProcess {
  upid: string;
  runId: string;
  callsign: string;
  // Inferred project name for display ("Annual Snowfall App"); the callsign
  // stays the one-word spoken handle. Absent/null when inference found nothing.
  title?: string | null;
  state: RegistryProcessState;
  selected: boolean;
  progressSeq: number;
  lastAction: string;
  updatedAtMs: number;
}

// The multi-backend build orchestrator seam (src/buildloop/orchestrator.ts —
// structural Pick so tests can inject a fake). When present it OWNS the accept
// path's app artifacts: spawn(build:true) fans the idea out to every enabled
// backend, steer forwards the spoken correction, halt aborts the UPID's builds,
// and builds() is the snapshot fragment the runtime merges per process. Since
// the two-stage pivot the fan-out produces CONCEPT MOCKS (kickoff), not full
// apps — the full app is the separate commission stage (execute()).
export interface BuildLoopOrchestrator {
  start(input: { upid: string; ideaId: string; prompt: string; callsign: string | null }): Promise<void>;
  steer(upid: string, text: string): Promise<void>;
  abortAll(upid: string): Promise<void>;
  builds(upid: string): ProcessBuildSnapshot[];
}

// The commission-stage execution lane seam (src/buildloop/execution.ts —
// structural Pick so tests can inject a fake). Owns the artifacts preview +
// snapshot fragment for the durable subscription run execute() launches.
export type ExecutionLaneRegistry = Pick<ExecutionRegistry, "start" | "snapshot" | "isExecuting" | "stop">;

export interface ProcessRegistryOptions {
  client: Pick<SmithersClient, "spawn" | "pause" | "resume" | "halt" | "steer">;
  sessionId?: string;
  maxConcurrentProcesses?: number;
  minRunSlots?: number;
  minMemoryMB?: number;
  headroom?: HostHeadroom | (() => HostHeadroom | Promise<HostHeadroom>);
  now?: () => number;
  callsigns?: CallsignAllocator;
  onTrace?: (event: LogEvent) => void;
  onOutput?: (decision: OutputDecision) => void;
  // Fired when a process is halted (panic / emergency stop). The runtime uses
  // this to tear down that process's live accept->build->preview server so a
  // halted build never leaves a reachable preview up (idea-builder lifecycle).
  onHalt?: (upid: string) => void;
  // The accept->build->preview builder (idea-builder). When provided, a spawn
  // carrying `build: true` (the genuine voice-accept path) scaffolds a REAL
  // runnable artifact under builds/<upid>/ and starts a live preview server; the
  // registry triggers it, emits a `process.build` trace on completion, and tears
  // the server down on halt. The demo seed spawns bare, so it never builds.
  ideaBuilds?: IdeaBuildRegistry | null;
  // The multi-backend build orchestrator. When present it REPLACES the legacy
  // single-build ideaBuilds path on spawn (both write under builds/<upid>/ and
  // would double-spawn the claude CLI): an accept fans out to every enabled
  // backend, spoken steers re-run ready builds with the correction, and halt
  // aborts the UPID's in-flight builds within the emergency budget.
  orchestrator?: BuildLoopOrchestrator | null;
  // Commission-stage execution lane (src/buildloop/execution.ts). execute()
  // opens a lane here when it launches the durable subscription run; halt and
  // the emergency stop tear it down. Optional — without it execute() still
  // launches the run and the registry synthesizes a minimal lane snapshot.
  execution?: ExecutionLaneRegistry | null;
  // LLM project namer: called fire-and-forget after a spawn to upgrade the
  // deterministic placeholder title ("Annual Snowfall App") to a model-named
  // one ("Snow Sip Calculator"). The spoken callsign is NOT renamed — voice
  // addressing must stay stable for the session. undefined = default (Cerebras
  // via CEREBRAS_API_KEY when present); null = disabled.
  namer?: ((pitch: string) => Promise<InferredProjectName | null>) | null;
  // Session nonce folded into pre-assigned runIds ("vibersyn-<upid>-<nonce>").
  // The gateway's runs are DURABLE across room restarts while UPIDs restart
  // from upid-1 every session — without a nonce a commission collides with a
  // previous session's finished "vibersyn-upid-1" run and instantly replays it
  // (stale artifacts included) instead of launching fresh work. Default: none
  // (bare "vibersyn-<upid>", the existing test contract); production passes a
  // per-boot nonce.
  runIdNonce?: string;
}

export type RegistrySpawnResult =
  | { accepted: true; process: RegistryProcess; spawn: SpawnResult; spokenAck: string }
  | {
      accepted: false;
      reason: SpawnRefusalReason;
      spokenAck: string;
      event: LogEvent;
      resourceCheck: Extract<ResourceCheckResult, { ok: false }>;
    };

// COMMISSION (execute) result. Idempotent by contract: a process whose durable
// run is already launched reports started:false with the live lane instead of
// double-launching (the stable per-UPID correlation doubles as the gateway
// idempotency key, so even a race cannot launch twice).
export type RegistryExecuteResult =
  | { started: true; runId: string; execution: ExecutionSnapshot | null }
  | { started: false; reason: "already-executing" | "already-built"; execution: ExecutionSnapshot | null };

export interface RegistryExecuteOptions {
  correlationId?: string;
  // Override the commissioned prompt; defaults to the kickoff pitch.
  prompt?: string;
}

export class ProcessRegistry {
  readonly client: ProcessRegistryOptions["client"];
  readonly sessionId: string;
  readonly maxConcurrentProcesses: number;
  readonly minRunSlots?: number;
  readonly minMemoryMB?: number;
  readonly headroom?: ProcessRegistryOptions["headroom"];
  readonly now: () => number;
  readonly callsigns: CallsignAllocator;
  readonly onTrace?: (event: LogEvent) => void;
  readonly onOutput?: (decision: OutputDecision) => void;
  readonly onHalt?: (upid: string) => void;
  readonly #ideaBuilds: IdeaBuildRegistry | null;
  readonly #orchestrator: BuildLoopOrchestrator | null;
  readonly #execution: ExecutionLaneRegistry | null;
  readonly #namer: ((pitch: string) => Promise<InferredProjectName | null>) | null;
  readonly #processes = new Map<string, RegistryProcess>();
  // Kickoff seed facts kept per UPID so a later execute() can commission the
  // durable run with the same pitch/steering-window contract the accept carried.
  readonly #seeds = new Map<
    string,
    { workflow: string; prompt: string; input: Record<string, unknown> | undefined; steeringWindowId: string | null; parentId: string | null }
  >();
  // UPIDs whose durable subscription run HAS been launched (commissioned).
  // Client-side steer/pause/resume/halt only reach the smithers client for
  // these — a kickoff-only process has no gateway run to signal.
  readonly #durableRuns = new Map<string, { runId: string; startedAtMs: number }>();
  // Commissions currently launching: a racing second execute() reports
  // already-executing instead of double-spawning (the stable idempotency key
  // additionally protects the gateway itself).
  readonly #executeInFlight = new Set<string>();
  #runIdNonce: string | null = null;
  #selectedUPID: string | null = null;
  #upidSeq = 0;

  constructor(options: ProcessRegistryOptions) {
    this.client = options.client;
    this.sessionId = options.sessionId ?? "vibersyn-process";
    this.maxConcurrentProcesses = options.maxConcurrentProcesses ?? DEFAULT_MAX_CONCURRENT_PROCESSES;
    this.minRunSlots = options.minRunSlots;
    this.minMemoryMB = options.minMemoryMB;
    this.headroom = options.headroom;
    this.now = options.now ?? (() => Date.now());
    this.callsigns = options.callsigns ?? new CallsignAllocator();
    this.onTrace = options.onTrace;
    this.onOutput = options.onOutput;
    this.onHalt = options.onHalt;
    this.#ideaBuilds = options.ideaBuilds ?? null;
    this.#orchestrator = options.orchestrator ?? null;
    this.#execution = options.execution ?? null;
    this.#namer = options.namer !== undefined ? options.namer : defaultNamerFromEnv();
    this.#runIdNonce = options.runIdNonce ?? null;
  }

  // The multi-backend builds[] snapshot fragment for one process — the runtime
  // merges this into the per-process snapshot entry. Empty when no orchestrator
  // is wired or the UPID never fanned out. Since the pivot these are the
  // kickoff CONCEPT MOCK lanes.
  builds(upid: string): ProcessBuildSnapshot[] {
    return this.#orchestrator?.builds(upid) ?? [];
  }

  // The commission-stage execution lane for one process, or null before the
  // room has commissioned it. Prefers the wired ExecutionRegistry's snapshot
  // (live percent + artifacts preview); without one, a minimal lane is
  // synthesized from the launch record so the stage is still visible.
  execution(upid: string): ExecutionSnapshot | null {
    const launched = this.#durableRuns.get(upid);
    if (launched === undefined) {
      return null;
    }
    const lane = this.#execution?.snapshot(upid);
    if (lane !== null && lane !== undefined) {
      return lane;
    }
    return {
      status: "executing",
      runId: launched.runId,
      percent: 0,
      label: "commissioned",
      previewUrl: null,
      startedAtMs: launched.startedAtMs,
      error: null,
    };
  }

  // Has this process's durable subscription run been launched (commissioned)?
  hasDurableRun(upid: string): boolean {
    return this.#durableRuns.has(upid);
  }

  records(): RegistryProcess[] {
    return [...this.#processes.values()].map(cloneProcess);
  }

  activeRecords(): RegistryProcess[] {
    return this.records().filter((record) => record.state !== "dead");
  }

  selectedUPID(): string | null {
    return this.#selectedUPID;
  }

  // `title` pins the display title (the SELF-mode "Vibersyn Room" card and any
  // other caller that already knows its name): inference AND the fire-and-forget
  // LLM namer are both skipped so a pinned title never renames mid-session.
  async spawn(
    seed: Partial<SpawnSeed> & { correlationId: string; build?: boolean; title?: string | null },
  ): Promise<RegistrySpawnResult> {
    const resourceCheck = await checkPreSpawnResources({
      activeProcessCount: this.activeRecords().length,
      correlationId: seed.correlationId,
      sessionId: this.sessionId,
      maxConcurrentProcesses: this.maxConcurrentProcesses,
      minRunSlots: this.minRunSlots,
      minMemoryMB: this.minMemoryMB,
      headroom: this.headroom,
    });
    if (!resourceCheck.ok) {
      this.onTrace?.(resourceCheck.event);
      this.onOutput?.({ channel: "tts", text: resourceCheck.spokenAck, wordCount: wordCount(resourceCheck.spokenAck), summarized: false });
      return {
        accepted: false,
        reason: resourceCheck.reason,
        spokenAck: resourceCheck.spokenAck,
        event: resourceCheck.event,
        resourceCheck,
      };
    }

    const upid = seed.upid ?? `upid-${++this.#upidSeq}`;
    // Name the process after the idea, not a codename: infer a display title +
    // a one-word spoken handle from the pitch. The handle goes through the
    // allocator's phonetic collision guard — on a collision (or an empty
    // inference) fall back to the codename pool rather than failing the spawn.
    const inferred = inferProjectName(seed.prompt);
    let assignment: CallsignAssignment;
    try {
      assignment = this.callsigns.assign(upid, seed.callsign ?? (inferred.handle || null));
    } catch {
      assignment = this.callsigns.assign(upid, null);
    }
    // KICKOFF ONLY — the durable gateway run is NOT launched here anymore.
    // Accepting an idea produces the fast concept mocks (orchestrator fan-out
    // below) + deck; the heavyweight subscription run is the separate,
    // user-triggered COMMISSION stage (execute()). The runId is pre-assigned
    // deterministically (matching the gateway client's own `vibersyn-<upid>`
    // default) so it stays stable when execute() launches the run later.
    const workflow = seed.workflow ?? "vibersyn-process";
    const spawn: SpawnResult = {
      upid,
      runId: seed.runId ?? (this.#runIdNonce === null ? `vibersyn-${upid}` : `vibersyn-${upid}-${this.#runIdNonce}`),
      workflow,
      parentId: seed.parentId ?? null,
    };
    this.#seeds.set(upid, {
      workflow,
      prompt: seed.prompt ?? "",
      input: seed.input,
      steeringWindowId: seed.steeringWindowId ?? `window-${assignment.callsign}`,
      parentId: seed.parentId ?? null,
    });
    for (const record of this.#processes.values()) {
      record.selected = false;
    }
    const process = {
      upid,
      runId: spawn.runId,
      callsign: assignment.callsign,
      title: seed.title !== undefined && seed.title !== null ? seed.title : inferred.title || null,
      state: "planning" as const,
      selected: true,
      progressSeq: 0,
      lastAction: "spawn",
      updatedAtMs: this.now(),
    };
    this.#processes.set(upid, process);
    this.#selectedUPID = upid;
    this.trace("process.spawn", seed.correlationId, upid, {
      runId: spawn.runId,
      callsign: process.callsign,
      state: process.state,
    });

    // LLM naming upgrade, fire-and-forget: the deterministic title above is the
    // instant placeholder; when the namer resolves, the card renames on the next
    // snapshot publish (the trace tick nudges one). Callsign is left alone —
    // renaming the spoken handle mid-session would break voice addressing.
    const namePitch = typeof seed.prompt === "string" && seed.prompt.length > 0 ? seed.prompt : pitchFromInput(seed.input);
    if (this.#namer !== null && namePitch.length > 0 && (seed.title === undefined || seed.title === null)) {
      void this.#namer(namePitch)
        .then((named) => {
          const record = this.#processes.get(upid);
          if (named === null || record === undefined || record.state === "dead") {
            return;
          }
          record.title = named.title;
          record.updatedAtMs = this.now();
          this.trace("process.renamed", seed.correlationId, upid, { title: named.title });
        })
        .catch(() => undefined);
    }

    // Real accept->build->preview: a voice-accepted spawn (build === true)
    // builds a runnable artifact. Fire-and-forget — the build(s) flip 'building'
    // -> 'ready'/'failed'; the trailing `process.build` trace lets the runtime
    // republish so the snapshot reflects the live preview. The demo seed skips
    // this. With the multi-backend orchestrator wired, the idea fans out to
    // every enabled backend (builds/<upid>/<backendId>/) and the legacy
    // single-build ideaBuilds path is skipped — running both would double-spawn
    // the claude CLI and race each other's builds/<upid>/ directory.
    if (seed.build === true) {
      const pitch =
        typeof seed.prompt === "string" && seed.prompt.length > 0 ? seed.prompt : pitchFromInput(seed.input);
      if (this.#orchestrator !== null) {
        const orchestrator = this.#orchestrator;
        void orchestrator
          .start({ upid, ideaId: ideaIdFromInput(seed.input) ?? upid, prompt: pitch, callsign: assignment.callsign })
          .then(
            () => {
              this.trace("process.build", seed.correlationId, upid, {
                builds: orchestrator.builds(upid).map((build) => ({ backend: build.backend, status: build.status })),
              });
            },
            () => undefined,
          );
      } else if (this.#ideaBuilds !== null) {
        void this.#ideaBuilds.start(pitch, upid).then(
          () => {
            const state = this.#ideaBuilds?.state(upid);
            this.trace("process.build", seed.correlationId, upid, {
              status: state?.status ?? "failed",
              previewUrl: state?.previewUrl ?? null,
            });
          },
          () => undefined,
        );
      }
    }

    return {
      accepted: true,
      process: cloneProcess(process),
      spawn,
      spokenAck: `${process.callsign} spawned.`,
    };
  }

  // COMMISSION: launch the durable subscription run for a kicked-off process.
  // This is the explicit, user-triggered EXECUTION stage — the heavyweight full
  // build the mocks pitched. It spawns the `vibersyn-process` durable run on
  // the gateway (claude subscription via the existing shim + steer-window
  // workflow) and opens the execution lane the snapshot exposes. Idempotent:
  // a process already executing (or built) reports started:false, and the
  // stable per-UPID correlation id doubles as the gateway idempotency key.
  // NO Cerebras on this path — kickoff-only concerns (mocks/decider/namer/deck
  // copy) never run here.
  async execute(upid: string, options: RegistryExecuteOptions = {}): Promise<RegistryExecuteResult> {
    const process = this.requireLive(upid);
    const existing = this.#durableRuns.get(upid);
    if (existing !== undefined || this.#executeInFlight.has(upid)) {
      const lane = this.execution(upid);
      return {
        started: false,
        reason: lane?.status === "built" ? "already-built" : "already-executing",
        execution: lane,
      };
    }
    this.#executeInFlight.add(upid);
    try {
      const correlationId = options.correlationId ?? `corr-execute-${upid}`;
      const seed = this.#seeds.get(upid);
      const prompt = options.prompt ?? (seed !== undefined && seed.prompt.length > 0 ? seed.prompt : pitchFromInput(seed?.input));
      const spawn = await this.client.spawn({
        upid,
        runId: process.runId,
        workflow: seed?.workflow ?? "vibersyn-process",
        prompt,
        callsign: process.callsign,
        steeringWindowId: seed?.steeringWindowId ?? `window-${process.callsign}`,
        parentId: seed?.parentId ?? null,
        input: seed?.input,
        correlationId,
      });
      this.#durableRuns.set(upid, { runId: spawn.runId, startedAtMs: this.now() });
      this.#execution?.start(upid, spawn.runId);
      this.patch(upid, {
        runId: spawn.runId,
        lastAction: "execute",
        updatedAtMs: this.now(),
      });
      this.trace("process.execute", correlationId, upid, {
        runId: spawn.runId,
        workflow: spawn.workflow,
        callsign: process.callsign,
      });
      return { started: true, runId: spawn.runId, execution: this.execution(upid) };
    } finally {
      this.#executeInFlight.delete(upid);
    }
  }

  async steer(upid: string, payload: unknown, correlationId: string): Promise<void> {
    const before = this.requireLive(upid);
    // The smithers-client steer signal only exists for a COMMISSIONED process —
    // a kickoff-only process has no durable run parked in a steer window.
    if (this.#durableRuns.has(upid)) {
      await this.client.steer(upid, payload);
    }
    // REAL steering of the built artifacts: forward the spoken correction to the
    // multi-backend orchestrator, which re-runs every ready build with it (in
    // place, version-bumped). Fire-and-forget — a correction re-run takes
    // minutes and must never stall the live transcript path awaiting steer().
    const correction = steerText(payload);
    if (this.#orchestrator !== null && correction !== null) {
      const orchestrator = this.#orchestrator;
      void orchestrator.steer(upid, correction).then(
        () => {
          this.trace("process.steer.build", correlationId, upid, {
            builds: orchestrator.builds(upid).map((build) => ({ backend: build.backend, status: build.status })),
          });
        },
        () => undefined,
      );
    }
    this.patch(upid, {
      progressSeq: before.progressSeq + 1,
      lastAction: "steer",
      updatedAtMs: this.now(),
    });
    if (process.env.VIBERSYN_RBG_LEAK_STEER_TO_SIBLINGS === "1") {
      for (const process of this.#processes.values()) {
        if (process.upid !== upid && process.state !== "dead") {
          process.progressSeq += 1;
          process.lastAction = "leaked-steer";
          process.updatedAtMs = this.now();
        }
      }
    }
    this.trace("process.steer", correlationId, upid, { payloadKind: payloadKind(payload) });
  }

  async pause(upid: string, correlationId: string): Promise<void> {
    const process = this.requireLive(upid);
    if (process.state === "paused") {
      return;
    }
    // Only a commissioned process has a durable run to pause; a kickoff-only
    // process just flips its registry state.
    if (this.#durableRuns.has(upid)) {
      await this.client.pause(upid);
    }
    this.patch(upid, { state: "paused", lastAction: "pause", updatedAtMs: this.now() });
    this.trace("process.pause", correlationId, upid, { scope: "single-upid" });
  }

  async resume(upid: string, correlationId: string): Promise<void> {
    const process = this.requireLive(upid);
    if (process.state !== "paused") {
      throw new Error(`Cannot resume ${upid} from ${process.state}.`);
    }
    if (this.#durableRuns.has(upid)) {
      await this.client.resume(upid);
    }
    this.patch(upid, { state: "active", lastAction: "resume", updatedAtMs: this.now() });
    this.trace("process.resume", correlationId, upid, { scope: "single-upid" });
  }

  async pauseAll(correlationId: string): Promise<void> {
    for (const process of this.activeRecords()) {
      if (process.state !== "paused") {
        await this.pause(process.upid, correlationId);
      }
    }
  }

  async halt(upid: string, correlationId: string, trigger = "panic"): Promise<void> {
    this.requireLive(upid);
    // Cancel the durable run only when one was commissioned — a kickoff-only
    // process has no gateway run, and the gateway client would throw looking up
    // a correlation record that never existed (breaking the emergency stop).
    if (this.#durableRuns.has(upid)) {
      await this.client.halt(upid);
      this.#durableRuns.delete(upid);
    }
    // Tear down this process's live preview servers (mock lanes + execution
    // lane): a halted build must not leave a reachable loopback preview up. The
    // orchestrator abort SIGKILLs every in-flight backend build within the
    // emergency budget and stops the per-UPID preview server.
    await this.#ideaBuilds?.stop(upid).catch(() => undefined);
    await this.#orchestrator?.abortAll(upid).catch(() => undefined);
    await this.#execution?.stop(upid).catch(() => undefined);
    this.onHalt?.(upid);
    this.patch(upid, { state: "dead", selected: false, lastAction: "halt", updatedAtMs: this.now() });
    this.callsigns.release(upid);
    this.#seeds.delete(upid);
    if (this.#selectedUPID === upid) {
      this.#selectedUPID = null;
    }
    this.trace("process.halt", correlationId, upid, { trigger });
  }

  select(upid: string, correlationId: string): void {
    this.requireLive(upid);
    for (const process of this.#processes.values()) {
      process.selected = process.upid === upid;
      process.updatedAtMs = process.upid === upid ? this.now() : process.updatedAtMs;
    }
    this.#selectedUPID = upid;
    this.trace("process.select", correlationId, upid, { selected: true });
  }

  clearSelection(correlationId: string): void {
    for (const process of this.#processes.values()) {
      process.selected = false;
    }
    this.#selectedUPID = null;
    this.trace("process.unselected", correlationId, undefined, { activeCount: this.activeRecords().length });
  }

  advanceAutonomousTick(correlationId: string): void {
    for (const record of this.#processes.values()) {
      if (record.state === "planning") {
        record.state = "active";
      }
      if (record.state === "active") {
        if (record.selected === false && process.env.VIBERSYN_RBG_STALL_UNSELECTED === "1") {
          continue;
        }
        record.progressSeq += 1;
        record.lastAction = record.selected ? "selected-progress" : "unselected-progress";
        record.updatedAtMs = this.now();
        this.trace("process.run", correlationId, record.upid, {
          state: record.state,
          progressSeq: record.progressSeq,
          selected: record.selected,
        });
      }
    }
  }

  statusSummary(): string {
    return summarizeFleetStatus(this.activeRecords());
  }

  private patch(upid: string, patch: Partial<RegistryProcess>): RegistryProcess {
    const current = this.require(upid);
    const next = { ...current, ...patch, upid };
    this.#processes.set(upid, next);
    return cloneProcess(next);
  }

  private require(upid: string): RegistryProcess {
    const process = this.#processes.get(upid);
    if (process === undefined) {
      throw new Error(`No process is registered for UPID ${upid}.`);
    }
    return process;
  }

  private requireLive(upid: string): RegistryProcess {
    const process = this.require(upid);
    if (process.state === "dead") {
      throw new Error(`Process ${upid} is dead.`);
    }
    return process;
  }

  private trace(event: string, correlationId: string, upid: string | undefined, meta: Record<string, unknown>): void {
    this.onTrace?.({
      level: event === "spawn.refused" ? "warn" : "info",
      event,
      sessionId: this.sessionId,
      correlationId,
      upid,
      latencyMs: 0,
      meta,
    });
  }
}

export function summarizeFleetStatus(records: readonly { callsign: string | null; upid?: string; state: string }[]): string {
  if (records.length === 0) {
    return "No active processes.";
  }
  return clampWords(records.map((record) => `${record.callsign ?? record.upid ?? "process"} ${record.state}`).join("; "), 15);
}

export { CAPACITY_REFUSAL_ACK };

function cloneProcess(process: RegistryProcess): RegistryProcess {
  return { ...process };
}

// Recover the build pitch from the spawn input when the prompt is empty. The
// acceptance seam carries the accepted idea's pitch on both `prompt` and
// `input.pitch`; fall back to the latter so the scaffolded page still reflects
// the idea even if the prompt was dropped.
// Default LLM namer: Cerebras when a key is in the environment, else disabled
// (deterministic titles stand). Kept here so composition needs no extra wiring.
function defaultNamerFromEnv(): ((pitch: string) => Promise<InferredProjectName | null>) | null {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    return null;
  }
  return (pitch) => llmProjectName(pitch, { apiKey });
}

function pitchFromInput(input: unknown): string {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const pitch = (input as Record<string, unknown>).pitch;
    if (typeof pitch === "string" && pitch.length > 0) {
      return pitch;
    }
  }
  return "An accepted idea, scaffolded live.";
}

// The spoken correction text inside a steer payload: the live transcript path
// sends { text, source }, the HTTP steer endpoint sends { text }, and a bare
// string is accepted for direct callers. Anything else carries no correction.
export function steerText(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim().length > 0) {
    return payload.trim();
  }
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    const text = (payload as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim().length > 0) {
      return text.trim();
    }
  }
  return null;
}

// The originating idea id when the accept path carried one on the spawn input;
// callers fall back to the UPID (the acceptance seed has no idea id today).
function ideaIdFromInput(input: unknown): string | null {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    const record = input as Record<string, unknown>;
    for (const key of ["ideaId", "id"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

function clampWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/u).filter(Boolean);
  return words.length <= maxWords ? text : `${words.slice(0, maxWords).join(" ")}...`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function payloadKind(payload: unknown): string {
  if (payload === null) {
    return "null";
  }
  if (Array.isArray(payload)) {
    return "array";
  }
  return typeof payload;
}
