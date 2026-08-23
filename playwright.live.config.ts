import { defineConfig, devices } from "@playwright/test";

/**
 * LIVE-ROOM browser e2e — the UX harness.
 *
 * Specs live in `e2e/*.live-pw.ts`. Two suffix rules are at work:
 *   • `-pw` keeps them out of `bun test` (which matches *.test.ts / *.spec.ts);
 *   • `.live-pw.ts` (not `.e2e-pw.ts`) keeps them out of the DEFAULT playwright
 *     config, whose specs load `?live=0` and drive fixtures through
 *     window.__VIBERSYN__.applySnapshot. These specs do the opposite: they boot
 *     a REAL server (src/testing/room-harness.ts), inject REAL speech through
 *     the REAL /api/mic WebSocket, and load the REAL wall URL the operator uses
 *     — `/?wall=A&flat=1` with ?remote at its production default.
 *
 * There is deliberately NO `webServer` here. Each spec boots its own scratch
 * room on its own free port (never 8788, the live room), so specs are
 * parallel-safe, never fight over 8787, and tear their own server down.
 *
 * Screenshots ARE captured on failure. The house rule ("assert UI STATE, never
 * screenshots") still holds for ASSERTIONS — every assertion below is DOM text,
 * a testid, or the window hook. The screenshot is evidence for a human reading
 * a red run, not an oracle.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.live-pw\.ts$/,
  outputDir: "test-results-live",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  // Each worker boots a full server; two is plenty of parallelism and keeps the
  // machine (which may be running the real room next door) unloaded.
  workers: Number(process.env.VIBERSYN_LIVE_WORKERS ?? 2),
  reporter: "list",
  // Boot + build + a scripted conversation played at human speed.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    // The wall is a projector surface; assert at projector resolution.
    viewport: { width: 1920, height: 1080 },
    // The UI honors prefers-reduced-motion, freezing bubble float so click
    // targets are stable.
    reducedMotion: "reduce",
  },
  // HARNESS FIX: the device preset carries its own viewport (1280x720) and a
  // project-level `use` OVERRIDES the top-level one — so every spec here was
  // silently asserting against a laptop window, not a projector. The viewport
  // is re-applied AFTER the spread so the wall is 1920x1080 for real.
  projects: [
    { name: "live-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } } },
  ],
});
