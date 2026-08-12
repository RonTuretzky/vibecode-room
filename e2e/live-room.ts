// Shared fixture for the live-room UX harness (e2e/*.live-pw.ts).
//
// Gives every spec:
//   • `room`  — a REAL Vibersyn server booted on its own scratch port with the
//               speech injector wired in (src/testing/room-harness.ts).
//   • `wall`  — a real browser page already pointed at the real wall URL, with
//               a DOM-paint recorder installed so every assertion can report
//               the MEASURED spoken→painted latency instead of just passing.
//
// Not named *.live-pw.ts / *.e2e-pw.ts on purpose: neither playwright config
// should collect this file as a spec.

import { test as base, expect, type Page } from "@playwright/test";
import { startRoom, type RoomOptions, type RoomUnderTest } from "../src/testing/room-harness";
import type { ObservationRecord } from "../src/testing/latency-ledger";

/** The URL the operator actually projects: wall A, continuous flat picture. */
export const WALL_URL = "/?wall=A&flat=1";

/**
 * Selectors the paint recorder watches, with the ledger stage each one reports
 * under. `dom` is the wall's transcript panel — the surface the operator says
 * renders empty while /api/state carries lines.
 */
const PAINT_TARGETS: Array<{ stage: string; selector: string }> = [
  { stage: "dom", selector: '[data-region="transcript"] .tx-line p' },
  { stage: "record-echo", selector: '[data-testid="record-steer-heard"] .record-steer-heard-line' },
  { stage: "record-dispatched", selector: '[data-testid="record-steer-dispatched"] .record-steer-heard-line' },
];

declare global {
  interface Window {
    __UXH__?: {
      paints: ObservationRecord[];
      seen: Record<string, true>;
    };
  }
}

export interface WallProbe {
  page: Page;
  /** Navigate to a wall URL and wait for the real app to report ready. */
  open(path?: string): Promise<void>;
  /** Everything the recorder has seen paint, with epoch-ms timestamps. */
  paints(): Promise<ObservationRecord[]>;
  /** Visible text of the wall's transcript panel, one entry per rendered line. */
  transcriptLines(): Promise<string[]>;
}

export const test = base.extend<{ roomOptions: RoomOptions; room: RoomUnderTest; wall: WallProbe }>({
  // Per-file override: `test.use({ roomOptions: { seedDemoFleet: false } })`.
  // A journey that must start from an EMPTY garden (speak → the first tree
  // grows) cannot use the seeded Atlas/Cobalt fleet, and a journey about the
  // seeded fleet must say so out loud — that fleet is fixture data.
  roomOptions: [{}, { option: true }],

  // Test-scoped: one server per test. Boot is ~1s and it makes every spec
  // deterministic (no transcript bleed between tests) and parallel-safe.
  room: async ({ roomOptions }, use, testInfo) => {
    const fromProject: RoomOptions = (testInfo.project.metadata.roomOptions as RoomOptions | undefined) ?? {};
    const room = await startRoom({ ...fromProject, ...roomOptions });
    room.startSseRecorder();
    try {
      await use(room);
    } finally {
      // Teardown runs even when the test throws — no orphan ports, ever.
      await room.stop();
    }
  },

  wall: async ({ page, room }, use) => {
    // Installed before any page script: a 16ms scan that stamps the FIRST time
    // each piece of text becomes visible. That is the "a human can see it now"
    // clock; 16ms is the quantization and is reported as such.
    await page.addInitScript(
      ({ targets }: { targets: Array<{ stage: string; selector: string }> }) => {
        window.__UXH__ = { paints: [], seen: {} };
        const scan = () => {
          const store = window.__UXH__;
          if (store === undefined) {
            return;
          }
          for (const target of targets) {
            for (const node of Array.from(document.querySelectorAll(target.selector))) {
              const text = (node.textContent ?? "").trim();
              if (text.length === 0) {
                continue;
              }
              const key = `${target.stage}::${text}`;
              if (store.seen[key] === true) {
                continue;
              }
              store.seen[key] = true;
              store.paints.push({ stage: target.stage, text, atMs: Date.now() });
            }
          }
        };
        setInterval(scan, 16);
      },
      { targets: PAINT_TARGETS },
    );

    const probe: WallProbe = {
      page,
      async open(path = WALL_URL) {
        await page.goto(`${room.baseUrl}${path}`);
        // The real app, not a fixture: wait for its own readiness hook.
        await page.waitForFunction(() => window.__VIBERSYN__?.ready === true, undefined, { timeout: 60_000 });
      },
      async paints() {
        return page.evaluate(() => window.__UXH__?.paints ?? []);
      },
      async transcriptLines() {
        return page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-region="transcript"] .tx-line p')).map((node) =>
            (node.textContent ?? "").trim(),
          ),
        );
      },
    };
    await use(probe);
  },
});

export { expect };

/**
 * Print the honesty block. Every spec calls this so a passing run always states
 * which legs were faked and which production code was NOT on the path.
 */
export async function reportCoverage(room: RoomUnderTest, label: string): Promise<void> {
  const capabilities = await room.capabilities();
  console.log(`\n[${label}] asr=${capabilities.asrMode} degraded=[${capabilities.degradedLegs.join(", ")}]`);
  for (const gap of capabilities.notExercised) {
    console.log(`[${label}] NOT EXERCISED: ${gap}`);
  }
}
