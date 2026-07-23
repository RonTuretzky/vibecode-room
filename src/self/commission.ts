// SELF-HOSTING MODE (VIBERSYN_SELF_MODE=1): the project being built by the
// vibecoding room is the vibecoding room itself.
//
// This module owns the room's standing SELF project and its commission loop:
//
//   - The SELF project is pinned at boot (composition.pinSelfProject): a
//     registry process with the reserved UPID "self", the spoken callsign
//     "mirror" ("vibersyn" is the wake word — the callsign must never collide
//     with it), and the fixed title "Vibersyn Room". It renders like any other
//     project (scene node + card) but is stage-labeled SELF and has NO kickoff
//     mock lanes — steering it is the only way it changes.
//
//   - STEERING THE ROOM: click-steer or "mirror, <instruction>" routes the
//     correction here (via selfRoutingOrchestrator, the registry's one steer
//     chokepoint), and the SelfCommissioner launches a durable `vibersyn-self`
//     gateway run (claude subscription — the sibling of vibersyn-process, see
//     .smithers/workflows/vibersyn-self.tsx) whose agent edits the room's OWN
//     repository under hard guardrails, runs the green gate
//     (`bunx tsc --noEmit && bun run build`), and commits "self: <summary>".
//
//   - GREEN GATE, verified ROOM-SIDE: the run "reporting green" is never
//     trusted on its own. When the run reaches a terminal state the
//     commissioner re-reads git HEAD: only a NEW commit whose subject starts
//     with "self:" counts as green. Green fires onGreen (the runtime's
//     serialized exit-87 reload trigger); anything else surfaces as a failed
//     lane on the self card — no reload, no broken state.
//
//   - SERIALIZATION: one self-run at a time. A steer while a run is executing
//     (or while the room is reloading) is refused politely with a spoken ack
//     and a trace — nothing queues silently, nothing double-launches.

import type { ExecutionSnapshot } from "../buildloop/execution";
import type { BuildLoopOrchestrator } from "../process/registry";
import type { SpawnResult, SpawnSeed } from "../seam/smithers-client";
import type { LogEvent, OutputDecision } from "../types";

export const SELF_UPID = "self";
export const SELF_CALLSIGN = "mirror";
export const SELF_TITLE = "Vibersyn Room";
export const SELF_WORKFLOW = "vibersyn-self";

// The pinned card's pitch/task line. Also what a later execute() would have
// commissioned — which is why executeProcess refuses the SELF upid outright.
export const SELF_PIN_PROMPT =
  'The Vibersyn room itself, self-hosting. Steer mirror to change the room\'s own source: say "mirror, <instruction>" or click-steer this card.';

// Spoken refusals for the serialized self loop (word-clamped, TTS-safe).
export const SELF_BUSY_ACK = "Mirror is mid-change. One correction at a time.";
export const SELF_RELOADING_ACK = "The room is reloading itself. Try again in a moment.";

export function selfModeEnabled(env: Record<string, string | undefined>): boolean {
  const raw = env.VIBERSYN_SELF_MODE?.trim();
  return raw === "1" || raw === "true";
}

// The snapshot fragment the wall consumes: the SELF card's execution lane is
// shape-compatible with the commission ExecutionSnapshot so the existing
// ExecutionChip / stage seams render it with no new UI contract. `instruction`
// rides along for traces/tests.
export interface SelfRunLane extends ExecutionSnapshot {
  instruction: string;
}

// The snapshot's top-level self surface (snapshot.self): enough for the wall
// to label the mirror and show the "room is reloading itself…" overlay.
export interface SelfSurface {
  upid: string;
  callsign: string;
  reloadPending: boolean;
}

export type SelfSteerRefusal = "empty" | "busy" | "reloading" | "launch-failed";
export type SelfSteerResult = { accepted: true; runId: string } | { accepted: false; reason: SelfSteerRefusal };

export interface GitHeadFact {
  sha: string;
  subject: string;
}

// The slice of the registry's smithers client the commissioner drives: spawn
// launches the durable run, halt cancels it (emergency stop / registry halt).
export interface SelfSpawnClient {
  spawn(seed: SpawnSeed): Promise<SpawnResult>;
  halt(upid: string): Promise<unknown>;
}

export interface SelfCommissionerOptions {
  client: SelfSpawnClient;
  // Per-boot nonce folded into self runIds ("vibersyn-self-<nonce>-<n>") so a
  // restarted room never collides with a previous session's durable runs
  // (mirrors the registry's runIdNonce contract).
  runIdNonce?: string;
  sessionId?: string;
  now?: () => number;
  // Republish hook — fired on every lane transition.
  onUpdate?: () => void;
  onTrace?: (event: LogEvent) => void;
  // Spoken refusal ack sink (the runtime's recordOutput).
  onOutput?: (decision: OutputDecision) => void;
  // Fired after a successful launch so the runtime can subscribe the run's
  // live telemetry (RunEventDriver) into this lane.
  onLaunched?: (runId: string) => void;
  // Fired exactly once per green run — the runtime's reload trigger.
  onGreen?: (lane: SelfRunLane) => void;
  // Green-gate git probe (injectable; default shells out to `git log -1`).
  gitHead?: () => Promise<GitHeadFact | null>;
  // Terminal-status prober (gateway getRun). Null in memory mode — no durable
  // run exists to poll, so completion can only arrive via the event overlay.
  getRunStatus?: ((runId: string) => Promise<string | null>) | null;
  pollMs?: number;
}

export class SelfCommissioner {
  readonly #client: SelfSpawnClient;
  readonly #runIdNonce: string;
  readonly #sessionId: string;
  readonly #now: () => number;
  readonly #onUpdate: () => void;
  readonly #onTrace?: (event: LogEvent) => void;
  readonly #onOutput?: (decision: OutputDecision) => void;
  readonly #onLaunched?: (runId: string) => void;
  readonly #onGreen?: (lane: SelfRunLane) => void;
  readonly #gitHead: () => Promise<GitHeadFact | null>;
  readonly #getRunStatus: ((runId: string) => Promise<string | null>) | null;
  readonly #pollMs: number;
  #lane: SelfRunLane | null = null;
  #headAtLaunch: GitHeadFact | null = null;
  #launching = false;
  #completing = false;
  // The last settled self-run verified green (a fresh "self:" commit landed).
  // The runtime's reload trigger re-checks this before exiting 87.
  #lastGreen = false;
  // Green fired → the room is about to reload; further steers are refused
  // until the process is replaced (serialized reloads).
  #reloadArmed = false;
  #seq = 0;

  constructor(options: SelfCommissionerOptions) {
    this.#client = options.client;
    this.#runIdNonce = options.runIdNonce ?? Date.now().toString(36);
    this.#sessionId = options.sessionId ?? "vibersyn-self";
    this.#now = options.now ?? (() => Date.now());
    this.#onUpdate = options.onUpdate ?? (() => undefined);
    this.#onTrace = options.onTrace;
    this.#onOutput = options.onOutput;
    this.#onLaunched = options.onLaunched;
    this.#onGreen = options.onGreen;
    this.#gitHead = options.gitHead ?? defaultGitHead;
    this.#getRunStatus = options.getRunStatus ?? null;
    this.#pollMs = options.pollMs ?? 15_000;
  }

  lane(): SelfRunLane | null {
    return this.#lane === null ? null : { ...this.#lane };
  }

  isBusy(): boolean {
    return this.#launching || this.#reloadArmed || this.#lane?.status === "executing";
  }

  lastRunGreen(): boolean {
    return this.#lastGreen;
  }

  // Route one steering correction into a SELF-COMMISSION: a durable
  // vibersyn-self run editing the room's own source. Serialized — a second
  // steer while one is in flight (or a reload is pending) refuses politely.
  async steer(instruction: string, correlationId = `corr-self-steer-${crypto.randomUUID()}`): Promise<SelfSteerResult> {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) {
      return { accepted: false, reason: "empty" };
    }
    if (this.isBusy()) {
      const reason: SelfSteerRefusal = this.#reloadArmed ? "reloading" : "busy";
      const ack = reason === "reloading" ? SELF_RELOADING_ACK : SELF_BUSY_ACK;
      this.trace("warn", "self.steer.refused", correlationId, { reason, instruction: trimmed });
      this.#onOutput?.({ channel: "tts", text: ack, wordCount: countWords(ack), summarized: false });
      this.#onUpdate();
      return { accepted: false, reason };
    }
    this.#launching = true;
    const runId = `vibersyn-self-${this.#runIdNonce}-${++this.#seq}`;
    try {
      // Snapshot git HEAD BEFORE the run so green can only mean "a NEW self:
      // commit landed" — a stale commit from a previous run never re-arms.
      this.#headAtLaunch = await this.#gitHead().catch(() => null);
      const lane: SelfRunLane = {
        status: "executing",
        runId,
        percent: 0,
        label:
          this.#getRunStatus === null
            ? "self-commissioned (no gateway — completion telemetry unavailable)"
            : "self-commissioned",
        previewUrl: null,
        startedAtMs: this.#now(),
        error: null,
        instruction: trimmed,
      };
      this.#lane = lane;
      this.#onUpdate();
      try {
        await this.#client.spawn({
          upid: SELF_UPID,
          workflow: SELF_WORKFLOW,
          runId,
          prompt: trimmed,
          callsign: SELF_CALLSIGN,
          steeringWindowId: null,
          parentId: null,
          input: { instruction: trimmed, source: "self-steer" },
          correlationId,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.settle(lane, "failed", "launch failed", message);
        this.trace("error", "self.commission.error", correlationId, { runId, message });
        return { accepted: false, reason: "launch-failed" };
      }
      this.trace("info", "self.commission", correlationId, { runId, instruction: trimmed });
      this.#onLaunched?.(runId);
      this.#watchCompletion(lane, runId);
      return { accepted: true, runId };
    } finally {
      this.#launching = false;
    }
  }

  // Fold live run-event telemetry into the executing lane (the RunEventDriver
  // overlay feeds this through the runtime). Capped below 100 — the lane is
  // only green once the git gate verifies the commit.
  progress(update: { percent?: number; label?: string }): void {
    const lane = this.#lane;
    if (lane === null || lane.status !== "executing") {
      return;
    }
    if (typeof update.percent === "number" && Number.isFinite(update.percent)) {
      lane.percent = Math.min(99, Math.max(lane.percent, Math.max(0, Math.round(update.percent))));
    }
    if (typeof update.label === "string" && update.label.trim().length > 0) {
      lane.label = update.label.trim();
    }
    this.#onUpdate();
  }

  // The run reached a terminal state (stream overlay or the poll watchdog).
  // GREEN GATE: re-verify against git — a finished run only counts as green
  // when a NEW commit with a "self:" subject landed. Idempotent per lane.
  async completeFromRun(status: "finished" | "failed" | "cancelled"): Promise<void> {
    const lane = this.#lane;
    if (lane === null || lane.status !== "executing" || this.#completing) {
      return;
    }
    this.#completing = true;
    try {
      if (status !== "finished") {
        this.settle(lane, "failed", `run ${status}`, `the self-run ended ${status} — nothing was committed, no reload.`);
        this.trace("warn", "self.gate.failed", `corr-self-gate-${lane.runId}`, { runId: lane.runId, status });
        return;
      }
      const head = await this.#gitHead().catch(() => null);
      const before = this.#headAtLaunch;
      const green =
        head !== null && before !== null && head.sha !== before.sha && head.subject.trimStart().startsWith("self:");
      if (!green) {
        this.settle(
          lane,
          "failed",
          "gate failed",
          head === null || before === null
            ? "the green gate could not read git HEAD — refusing to reload."
            : `the self-run finished but no new "self:" commit landed (HEAD ${head.sha.slice(0, 8)}: ${head.subject}) — refusing to reload.`,
        );
        this.trace("warn", "self.gate.failed", `corr-self-gate-${lane.runId}`, {
          runId: lane.runId,
          status,
          headSha: head?.sha ?? null,
          headSubject: head?.subject ?? null,
        });
        return;
      }
      lane.status = "built";
      lane.percent = 100;
      lane.label = `green: ${head.subject}`;
      lane.error = null;
      this.#lastGreen = true;
      this.#reloadArmed = true;
      this.trace("info", "self.green", `corr-self-gate-${lane.runId}`, {
        runId: lane.runId,
        commitSha: head.sha,
        subject: head.subject,
      });
      this.#onUpdate();
      this.#onGreen?.({ ...lane });
    } finally {
      this.#completing = false;
    }
  }

  // Abort the in-flight self-run (registry halt / emergency stop). Cancels the
  // durable run through the client and settles the lane failed — a reload can
  // never fire from an aborted run.
  async abort(): Promise<void> {
    const lane = this.#lane;
    if (lane === null || lane.status !== "executing") {
      return;
    }
    await this.#client.halt(SELF_UPID).catch(() => undefined);
    this.settle(lane, "failed", "aborted", "the self-run was aborted.");
    this.trace("warn", "self.commission.aborted", `corr-self-abort-${lane.runId}`, { runId: lane.runId });
  }

  // Terminal-status poll watchdog (mirrors composition.watchRunCompletion): the
  // live stream can miss the terminal frame across reconnects, so while the
  // lane executes, poll getRun and settle from its status.
  #watchCompletion(lane: SelfRunLane, runId: string): void {
    const probe = this.#getRunStatus;
    if (probe === null) {
      return;
    }
    void (async () => {
      while (this.#lane === lane && lane.status === "executing") {
        await delay(this.#pollMs);
        if (this.#lane !== lane || lane.status !== "executing") {
          return;
        }
        const status = await probe(runId).catch(() => null);
        if (status === "finished" || status === "failed" || status === "cancelled") {
          await this.completeFromRun(status);
          return;
        }
      }
    })();
  }

  private settle(lane: SelfRunLane, status: "failed", label: string, error: string): void {
    lane.status = status;
    lane.label = label;
    lane.error = error;
    this.#lastGreen = false;
    this.#onUpdate();
  }

  private trace(level: LogEvent["level"], event: string, correlationId: string, meta: Record<string, unknown>): void {
    this.#onTrace?.({
      level,
      event,
      sessionId: this.#sessionId,
      correlationId,
      upid: SELF_UPID,
      latencyMs: 0,
      meta,
    });
  }
}

// The registry's ONE steer chokepoint for built artifacts is its orchestrator
// seam (registry.steer -> orchestrator.steer, fire-and-forget). Wrapping it
// routes EVERY steer surface — click-steer, "mirror, <instruction>", the HTTP
// steer endpoint, the seam API, the routing grammar — into the self commission
// for the SELF upid, while every other UPID keeps the real orchestrator.
export function selfRoutingOrchestrator(
  base: BuildLoopOrchestrator | null,
  self: () => Pick<SelfCommissioner, "steer" | "abort"> | null,
): BuildLoopOrchestrator {
  return {
    async start(input) {
      // The SELF project has no kickoff mock lanes; everything else fans out.
      if (input.upid !== SELF_UPID && base !== null) {
        await base.start(input);
      }
    },
    async steer(upid, text) {
      if (upid === SELF_UPID) {
        await self()?.steer(text);
        return;
      }
      await base?.steer(upid, text);
    },
    async abortAll(upid) {
      if (upid === SELF_UPID) {
        await self()?.abort();
        return;
      }
      await base?.abortAll(upid);
    },
    builds(upid) {
      if (upid === SELF_UPID) {
        return [];
      }
      return base?.builds(upid) ?? [];
    },
  };
}

// Default green-gate git probe: HEAD's sha + subject via `git log -1`, run in
// the room's own working directory. Null (never a throw) when git is absent —
// the gate then refuses to reload, which is the safe failure.
export async function defaultGitHead(): Promise<GitHeadFact | null> {
  try {
    const proc = Bun.spawn(["git", "log", "-1", "--format=%H%n%s"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) {
      return null;
    }
    const [sha, subject] = out.trim().split("\n");
    return sha !== undefined && sha.length > 0 ? { sha, subject: subject ?? "" } : null;
  } catch {
    return null;
  }
}

function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
