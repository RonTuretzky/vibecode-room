import { SmithersGatewayClient } from "smithers-orchestrator/gateway-client";
import { appGatewayUrl } from "./gateway.ts";

export type ProcessWorkflowInput = {
  directive: string;
  processTitle: string;
  visualizer: string;
  model: string;
};

export type StreamEventsOptions = {
  onError?: (error: unknown) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGatewayRpcCode(error: unknown, code: string) {
  return isRecord(error) && error.code === code;
}

function isWaitingEventRun(run: unknown) {
  return isRecord(run) && run.status === "waiting-event";
}

function isTerminalRun(run: unknown) {
  return isRecord(run) &&
    (run.status === "finished" || run.status === "failed" || run.status === "cancelled");
}

function waitingEventCorrelationKey(run: unknown) {
  if (!isRecord(run) || !isRecord(run.runState) || !isRecord(run.runState.blocked)) {
    return undefined;
  }
  const blocked = run.runState.blocked;
  const nodeId = typeof blocked.nodeId === "string" ? blocked.nodeId : "";
  if (blocked.kind !== "event" || (nodeId !== "steer" && !nodeId.startsWith("steer@@"))) {
    return undefined;
  }
  if (typeof blocked.correlationKey === "string" && blocked.correlationKey.length > 0) {
    return blocked.correlationKey;
  }

  return undefined;
}

function attemptCorrelationKey(attempt: unknown) {
  if (!isRecord(attempt) || attempt.state !== "waiting-event" || typeof attempt.metaJson !== "string") {
    return undefined;
  }

  const parsed = JSON.parse(attempt.metaJson) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.waitForEvent)) {
    return undefined;
  }

  const correlationId = parsed.waitForEvent.correlationId;
  return typeof correlationId === "string" && correlationId.length > 0 ? correlationId : undefined;
}

export class SmithersControlPlane {
  private readonly client: SmithersGatewayClient;

  constructor(opts?: { baseUrl?: string }) {
    this.client = new SmithersGatewayClient({ baseUrl: opts?.baseUrl ?? appGatewayUrl() });
  }

  launchProcess(upid: string, input: ProcessWorkflowInput) {
    return this.client.launchRun({
      workflow: "process",
      input,
      options: { runId: upid },
    });
  }

  async steer(upid: string, text: string) {
    const correlationKey = await this.waitingSteerCorrelationKey(upid);
    if (correlationKey === undefined) {
      throw new Error(`Run ${upid} is not waiting for steer.`);
    }
    return this.client.submitSignal({
      runId: upid,
      correlationKey,
      signalName: "steer",
      payload: { text },
    });
  }

  async pause(upid: string) {
    const run = await this.client.getRun({ runId: upid });
    if (isWaitingEventRun(run) || isTerminalRun(run)) {
      return { runId: upid, status: run.status };
    }

    const status = isRecord(run) && typeof run.status === "string" ? run.status : "unknown";
    throw new Error(`Run ${upid} is ${status}; pause only succeeds once the process is suspended.`);
  }

  resume(upid: string) {
    return this.client.resumeRun({ runId: upid, options: { force: true } });
  }

  async kill(upid: string) {
    const run = await this.client.getRun({ runId: upid });
    const correlationKey = await this.waitingSteerCorrelationKey(upid, run);
    if (correlationKey !== undefined) {
      return this.client.submitSignal({
        runId: upid,
        correlationKey,
        signalName: "steer",
        payload: { text: "", stop: true },
      });
    }

    if (isTerminalRun(run)) {
      return { runId: upid, status: run.status };
    }

    try {
      return await this.client.cancelRun({ runId: upid });
    } catch (error) {
      if (isGatewayRpcCode(error, "RUN_NOT_ACTIVE")) {
        const latest = await this.client.getRun({ runId: upid });
        if (isTerminalRun(latest)) {
          return { runId: upid, status: latest.status };
        }
      }
      throw error;
    }
  }

  private async waitingSteerCorrelationKey(upid: string, currentRun?: unknown) {
    const run = currentRun ?? await this.client.getRun({ runId: upid });
    if (!isWaitingEventRun(run)) {
      return undefined;
    }

    const blockedKey = waitingEventCorrelationKey(run);
    if (blockedKey !== undefined) {
      return blockedKey;
    }

    const attempts = await this.client.rpcRaw("attempts.list", { runId: upid });
    if (!Array.isArray(attempts)) {
      throw new Error(`Run ${upid} did not return task attempts.`);
    }

    const waitingSteerAttempts = attempts.filter((attempt) => {
      if (!isRecord(attempt) || attempt.nodeId !== "steer" && !(typeof attempt.nodeId === "string" && attempt.nodeId.startsWith("steer@@"))) {
        return false;
      }
      return attemptCorrelationKey(attempt) !== undefined;
    });

    if (waitingSteerAttempts.length !== 1) {
      throw new Error(`Run ${upid} has ${waitingSteerAttempts.length} waiting steer attempts.`);
    }

    return attemptCorrelationKey(waitingSteerAttempts[0]);
  }

  getRun(upid: string) {
    return this.client.getRun({ runId: upid });
  }

  listRuns() {
    return this.client.listRuns();
  }

  async streamEvents(
    upid: string,
    onEvent: (event: unknown) => void,
    options: StreamEventsOptions = {},
  ): Promise<() => void> {
    const abort = new AbortController();

    void (async () => {
      try {
        for await (const event of this.client.streamRunEvents(
          { runId: upid },
          { signal: abort.signal },
        )) {
          onEvent(event);
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          options.onError?.(error);
        }
      }
    })();

    return () => abort.abort();
  }
}
