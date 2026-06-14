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

function stepFinishedCount(events: unknown[]) {
  return events.filter((event) => {
    if (!isRecord(event) || !isRecord(event.payload)) {
      return false;
    }
    return event.payload.event === "node.finished" &&
      isRecord(event.payload.payload) &&
      event.payload.payload.nodeId === "step";
  }).length;
}

async function expectNoAdditionalStep(events: unknown[], expectedCount: number) {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  expect(stepFinishedCount(events)).toBe(expectedCount);
}

function isActiveRunStatus(status: unknown) {
  return status === "running" ||
    status === "waiting-event" ||
    status === "waiting-approval" ||
    status === "waiting-timer";
}

describe("Panopticon durable Smithers process smoke", () => {
  test.skipIf(process.env.PANOPTICON_SMOKE_AGENT !== "1")(
    "boots the app gateway, waits for steer, emits one step per steer, and kills cleanly",
    async () => {
      const gateway = await startAppGateway({ port: 0 });
      const control = new SmithersControlPlane({ baseUrl: appGatewayUrl() });
      const upid = `smoke-${Date.now()}`;
      const events: unknown[] = [];
      let stop = () => {};

      try {
        stop = await control.streamEvents(upid, (event) => events.push(event));
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

        await control.steer(upid, "Produce exactly one concise smoke-test step.");

        await waitFor(async () => stepFinishedCount(events) === 1);
        await waitFor(async () => {
          const run = await control.getRun(upid);
          return isRecord(run) && run.status === "waiting-event";
        });
        await expectNoAdditionalStep(events, 1);

        await control.steer(upid, "Produce exactly one second smoke-test step.");
        await waitFor(async () => stepFinishedCount(events) === 2);
        await waitFor(async () => {
          const run = await control.getRun(upid);
          return isRecord(run) && run.status === "waiting-event";
        });
        await expectNoAdditionalStep(events, 2);

        await expect(control.pause(upid)).resolves.toMatchObject({
          runId: upid,
          status: "waiting-event",
        });

        await control.kill(upid);
        await waitFor(async () => {
          const run = await control.getRun(upid);
          return isRecord(run) && !isActiveRunStatus(run.status);
        });
        const run = await control.getRun(upid);
        expect(isRecord(run)).toBe(true);
        expect(isRecord(run) ? run.status : undefined).toBe("finished");
        expect(stepFinishedCount(events)).toBe(2);
      } finally {
        stop();
        await gateway.close();
      }
    },
    { timeout: 180_000 },
  );
});
