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

  steer(upid: string, text: string) {
    return this.client.submitSignal({
      runId: upid,
      correlationKey: "steer",
      signalName: "steer",
      payload: { text },
    });
  }

  pause(upid: string) {
    return this.client.cancelRun({ runId: upid });
  }

  resume(upid: string) {
    return this.client.resumeRun({ runId: upid, options: { force: true } });
  }

  kill(upid: string) {
    return this.client.cancelRun({ runId: upid });
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
