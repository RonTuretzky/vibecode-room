import { Hono } from "hono";
import type { LogEvent, OutputDecision } from "../types";

export const EMERGENCY_STOP_ROUTE = "/emergency-stop";
export const EMERGENCY_STOP_SIGNAL_TEXT = "Emergency stop. Session ended.";
export const EMERGENCY_STOP_LATENCY_BUDGET_MS = 2_000;

export interface EmergencyProcessRecord {
  upid: string;
  state?: string;
}

export interface EmergencyProcessRegistry {
  activeRecords(): EmergencyProcessRecord[];
  halt(upid: string, correlationId: string, trigger?: string): Promise<void>;
}

export interface EmergencyListeningSession {
  readonly sessionId: string;
  isListening(): boolean;
  isSessionEnded(): boolean;
  stopListening(correlationId: string): Promise<void> | void;
  endSession(correlationId: string): Promise<void> | void;
}

export interface EmergencyStopControllerOptions {
  registry: EmergencyProcessRegistry;
  listener: EmergencyListeningSession;
  sessionId?: string;
  now?: () => number;
  latencyBudgetMs?: number;
  onTrace?: (event: LogEvent) => void;
  onOutput?: (decision: OutputDecision) => void;
}

export interface EmergencyStopResult {
  ok: boolean;
  trigger: "non-voice";
  processesHalted: number;
  latencyMs: number;
  sessionEnded: true;
  listening: false;
  signal: {
    audible: true;
    visible: true;
    text: string;
  };
}

export class EmergencyStopController {
  readonly registry: EmergencyProcessRegistry;
  readonly listener: EmergencyListeningSession;
  readonly sessionId: string;
  readonly now: () => number;
  readonly latencyBudgetMs: number;
  readonly onTrace?: (event: LogEvent) => void;
  readonly onOutput?: (decision: OutputDecision) => void;

  constructor(options: EmergencyStopControllerOptions) {
    this.registry = options.registry;
    this.listener = options.listener;
    this.sessionId = options.sessionId ?? options.listener.sessionId;
    this.now = options.now ?? (() => performance.now());
    this.latencyBudgetMs = options.latencyBudgetMs ?? EMERGENCY_STOP_LATENCY_BUDGET_MS;
    this.onTrace = options.onTrace;
    this.onOutput = options.onOutput;
  }

  async trigger(correlationId = `emergency-${crypto.randomUUID()}`): Promise<EmergencyStopResult> {
    const startedAtMs = this.now();
    const active = this.registry.activeRecords();
    const haltTargets = process.env.PANOP_RBG_LEAVE_PROCESS_RUNNING === "1" ? active.slice(0, -1) : active;

    await Promise.all(haltTargets.map((record) => this.registry.halt(record.upid, correlationId, "emergency")));
    await this.listener.stopListening(correlationId);
    if (process.env.PANOP_RBG_RESUME_IN_PLACE !== "1") {
      await this.listener.endSession(correlationId);
    }

    const latencyMs = Math.max(0, this.now() - startedAtMs);
    const result: EmergencyStopResult = {
      ok: latencyMs <= this.latencyBudgetMs && this.registry.activeRecords().length === 0 && this.listener.isSessionEnded(),
      trigger: "non-voice",
      processesHalted: haltTargets.length,
      latencyMs,
      sessionEnded: true,
      listening: false,
      signal: {
        audible: true,
        visible: true,
        text: EMERGENCY_STOP_SIGNAL_TEXT,
      },
    };

    if (process.env.PANOP_RBG_SUPPRESS_EMERGENCY_SIGNAL !== "1") {
      this.emitSignal();
    }
    this.emitTrace(result, correlationId);
    return result;
  }

  private emitSignal(): void {
    this.onOutput?.({ channel: "earcon", id: "E5" });
    this.onOutput?.({
      channel: "tts",
      text: EMERGENCY_STOP_SIGNAL_TEXT,
      wordCount: wordCount(EMERGENCY_STOP_SIGNAL_TEXT),
      summarized: false,
    });
  }

  private emitTrace(result: EmergencyStopResult, correlationId: string): void {
    this.onTrace?.({
      level: result.ok ? "info" : "error",
      event: "emergency.stop",
      sessionId: this.sessionId,
      correlationId,
      latencyMs: result.latencyMs,
      meta: {
        trigger: result.trigger,
        processesHalted: result.processesHalted,
        sessionEnded: true,
        listening: false,
        signal: result.signal.text,
      },
    });
  }
}

export class EmergencySessionState implements EmergencyListeningSession {
  readonly sessionId: string;
  #listening: boolean;
  #sessionEnded: boolean;
  #muted: boolean;
  #consentAnnouncements = 0;

  constructor(options: { sessionId: string; listening?: boolean; muted?: boolean; sessionEnded?: boolean }) {
    this.sessionId = options.sessionId;
    this.#listening = options.listening ?? true;
    this.#muted = options.muted ?? false;
    this.#sessionEnded = options.sessionEnded ?? false;
  }

  isListening(): boolean {
    return this.#listening;
  }

  isSessionEnded(): boolean {
    return this.#sessionEnded;
  }

  isMuted(): boolean {
    return this.#muted;
  }

  consentAnnouncements(): number {
    return this.#consentAnnouncements;
  }

  stopListening(): void {
    this.#listening = false;
  }

  endSession(): void {
    this.#listening = false;
    this.#sessionEnded = true;
  }

  startFreshSession(): void {
    this.#listening = true;
    this.#muted = false;
    this.#sessionEnded = false;
    this.#consentAnnouncements += 1;
  }
}

export function createEmergencyStopApp(controller: EmergencyStopController): Hono {
  const app = new Hono();
  app.post(EMERGENCY_STOP_ROUTE, async (context) => {
    const result = await controller.trigger(`corr-emergency-${crypto.randomUUID()}`);
    return context.json(result, result.ok ? 202 : 500);
  });

  if (process.env.PANOP_RBG_ADD_STEER_ROUTE === "1") {
    app.post("/steer", (context) => context.json({ accepted: true, verb: "steer" }));
  }
  if (process.env.PANOP_RBG_ADD_UNMUTE_ROUTE === "1") {
    app.post("/unmute", (context) => context.json({ accepted: true, verb: "unmute" }));
  }

  return app;
}

export function emergencyControlRoutes(): readonly string[] {
  const routes = [`POST ${EMERGENCY_STOP_ROUTE}`];
  if (process.env.PANOP_RBG_ADD_STEER_ROUTE === "1") {
    routes.push("POST /steer");
  }
  if (process.env.PANOP_RBG_ADD_UNMUTE_ROUTE === "1") {
    routes.push("POST /unmute");
  }
  return routes;
}

export function emergencyControlVerbs(): readonly string[] {
  const verbs = ["kill-all"];
  if (process.env.PANOP_RBG_ADD_STEER_ROUTE === "1") {
    verbs.push("steer");
  }
  if (process.env.PANOP_RBG_ADD_UNMUTE_ROUTE === "1") {
    verbs.push("unmute");
  }
  return verbs;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}
