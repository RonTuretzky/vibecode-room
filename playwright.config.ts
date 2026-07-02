import { defineConfig, devices } from "@playwright/test";

/**
 * Browser e2e for the Vibersyn projector UI.
 *
 * Specs live in `e2e/*.e2e-pw.ts` — named so the Bun test runner (which matches
 * `*.test.ts` / `*.spec.ts`) never tries to execute them. They assert UI STATE
 * via the `window.__VIBERSYN__` hook and the DOM, never screenshots (a prior
 * 3D build proved screenshots unreliable on the real projector GPU).
 *
 * The webServer builds the Vite SPA and serves it (plus the /api surface) through
 * the production Hono server, so e2e exercises the real production path.
 */
const PORT = Number(process.env.VIBERSYN_PORT ?? 8787);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e-pw\.ts$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    // Freeze the bubble float (the UI honors prefers-reduced-motion) so the
    // suite is deterministic and click targets are stable, not moving.
    reducedMotion: "reduce",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `bun run build && VIBERSYN_PORT=${PORT} bun run start`,
    url: `${BASE_URL}/api/health`,
    // Default to a fresh build+start every run so e2e never tests a stale dist.
    // Opt into reuse for fast local iteration with VIBERSYN_REUSE=1 (after a manual build).
    reuseExistingServer: !process.env.CI && process.env.VIBERSYN_REUSE === "1",
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
