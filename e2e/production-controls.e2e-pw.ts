import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import type { ProjectorSnapshot } from "../src/ui/types";

test.describe.configure({ mode: "serial" });

test.describe("production projector controls", () => {
  test("unmute resumes the muted production pipeline", async ({ request }) => {
    const before = await state(request);
    expect(before.muted).toBe(true);
    expect(before.listening).toBe(false);

    const response = await request.post("/api/unmute");
    expect(response.ok()).toBe(true);
    const snapshot = (await response.json()) as ProjectorSnapshot;

    expect(snapshot.listening).toBe(true);
    expect(snapshot.muted).toBe(false);
    expect(snapshot.emergencyStopTriggered).toBe(false);
  });

  test("emergency stop halts previously active production processes", async ({ request }) => {
    const before = await state(request);
    const liveUpids = before.processes
      .filter((process) => process.state === "active" || process.state === "planning" || process.state === "paused")
      .map((process) => process.upid);
    expect(liveUpids.length).toBeGreaterThan(0);

    const response = await request.post("/api/emergency-stop");
    expect(response.ok()).toBe(true);
    const snapshot = (await response.json()) as ProjectorSnapshot;

    expect(snapshot.emergencyStopTriggered).toBe(true);
    expect(snapshot.listening).toBe(false);
    expect(snapshot.muted).toBe(true);
    for (const upid of liveUpids) {
      expect(snapshot.processes.find((process) => process.upid === upid)?.state).toBe("halted");
    }
  });
});

async function state(request: APIRequestContext): Promise<ProjectorSnapshot> {
  const response = await request.get("/api/state");
  expect(response.ok()).toBe(true);
  return (await response.json()) as ProjectorSnapshot;
}
