import { describe, expect, test } from "bun:test";
import { appGatewayUrl, startAppGateway } from "./gateway.ts";
import { SmithersControlPlane } from "./control-plane.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 120_000,
  intervalMs = 500,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for durable-run smoke condition.");
}

describe("Panopticon durable Smithers process smoke", () => {
  test.skipIf(process.env.PANOPTICON_SMOKE_AGENT !== "1")(
    "boots the app gateway, waits for steer, emits one step, and cancels",
    async () => {
      const gateway = await startAppGateway({ port: 0 });
      const control = new SmithersControlPlane({ baseUrl: appGatewayUrl() });
      const upid = `smoke-${Date.now()}`;
      const events: unknown[] = [];
      let stop = () => {};

      try {
        await control.launchProcess(upid, {
          directive: "Reply with a minimal status update for the smoke test.",
          processTitle: "Durable run smoke",
          visualizer: "text",
          model: "ioAgents",
        });

        await waitFor(async () => {
          const run = await control.getRun(upid);
          return isRecord(run) && run.status === "waiting-event";
        });

        stop = await control.streamEvents(upid, (event) => events.push(event));
        await control.steer(upid, "Produce exactly one concise smoke-test step.");

        await waitFor(async () => events.some((event) => {
          if (!isRecord(event) || !isRecord(event.payload)) {
            return false;
          }
          return event.payload.event === "node.finished" &&
            isRecord(event.payload.payload) &&
            event.payload.payload.nodeId === "step";
        }));

        await control.kill(upid);
        const run = await control.getRun(upid);
        expect(isRecord(run)).toBe(true);
      } finally {
        stop();
        await gateway.close();
      }
    },
  );
});
