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

  const finishedCount = isRecord(run.summary) && typeof run.summary.finished === "number"
    ? run.summary.finished
    : undefined;
  return typeof finishedCount === "number" ? `steer:${finishedCount}` : undefined;
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
    const run = await this.client.getRun({ runId: upid });
    const correlationKey = waitingEventCorrelationKey(run);
    if (!correlationKey) {
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

    return this.client.cancelRun({ runId: upid });
  }

  resume(upid: string) {
    return this.client.resumeRun({ runId: upid, options: { force: true } });
  }

  async kill(upid: string) {
    const run = await this.client.getRun({ runId: upid });
    const correlationKey = waitingEventCorrelationKey(run);
    if (correlationKey) {
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
