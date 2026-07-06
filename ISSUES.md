# Vibersyn Codebase Review Issues

Review date: 2026-06-16

## Verification Run

- `bun run typecheck`: passed.
- `bun test`: passed, 302 pass / 2 skip / 0 fail.
- `bun run test:e2e`: passed, 9/9 Playwright projector tests.
- Manual browser visual check: desktop `1440x900` looked coherent; narrow `390x844` clips process bubbles.
- `bun run seed`: failed because `src/scripts/seed-demo.ts` is missing.

## Findings

### P0 - No Production Composition Root For The Full Voice Loop

The implementation has strong slices and test harnesses, but `bun run start` only starts the projector Hono server (`package.json:12`). That server seeds and serves `demoProjectorSnapshot` (`src/server/index.ts:3`, `src/server/index.ts:8`, `src/server/index.ts:11`) and does not construct the production ASR -> Cue -> suggestion -> acceptance -> process registry -> Smithers seam -> trace -> projector pipeline.

Evidence:
- `src/spine/canonical.ts:47` builds the full loop only inside the test harness.
- `rg` finds `new AudioCaptureAsrBridge`, `new SuggestionEngine`, `new AcceptanceController`, `new ProcessRegistry`, and `new SeamDispatcher` only in tests/harnesses, not in `src/server/index.ts`.
- The browser "live backend" e2e explicitly expects the server's deterministic demo fleet (`e2e/projector.e2e-pw.ts:132`, `e2e/projector.e2e-pw.ts:137`).

Impact: the app can render and many seams are tested, but the shipped `start` path cannot actually run the audio-first product described by the PRD.

Suggested fix: add a real application composition root that wires provider selection, ASR bridge, Cue adapter/programs, mute controller, suggestion engine, acceptance controller, process registry, seam dispatcher, trace processor, and projector snapshot publishing. Then make Playwright or a separate e2e hit that composed runtime, not the demo snapshot.

### P0 - Projector Unmute And Emergency Controls Are Cosmetic In The Production Server

REQ-2 requires the on-screen unmute button to resume the pipeline (`docs/planning/01-prd.md:176`), and REQ-14 requires the emergency control to stop streaming and halt all processes within 2 seconds (`docs/planning/01-prd.md:451`, `docs/planning/01-prd.md:455`). The UI calls `/api/unmute` and `/api/emergency-stop` (`src/ui/App.tsx:98`, `src/ui/App.tsx:114`), but the production server only mutates the projector snapshot (`src/server/index.ts:13`, `src/server/index.ts:18`).

The real controllers exist (`src/audio/mute-controller.ts:193`, `src/emergency/stop.ts:69`), but `src/server/index.ts` does not use them. The Playwright tests only assert that the DOM flips visible state (`e2e/projector.e2e-pw.ts:122`) rather than asserting a muted pipeline resumes or active processes halt.

Impact: a user pressing the visible safety controls in the production server path gets UI feedback without the required operational effect.

Suggested fix: wire `/api/unmute` to `MuteController.releaseFromButton()` and `/api/emergency-stop` to `EmergencyStopController.trigger()` against the live registry/listener. Add production-path e2e tests with at least one muted pipeline and at least one active process.

### P0 - Spoken Panic/Abort Does Not Halt The Target Process

REQ-12 says the spoken stop/panic word halts the in-focus process within 1 second and logs `process.halt` (`docs/planning/01-prd.md:413`, `docs/planning/01-prd.md:417`, `docs/planning/01-prd.md:427`). Dispatch recognizes panic (`src/routing/dispatch.ts:298`), but the command handler maps it to a local effect only (`src/routing/handlers.ts:91`). The steering-window path closes the window on `Abort` (`src/routing/steering-window.ts:109`) but does not call `ProcessRegistry.halt()` (`src/process/registry.ts:200`) or the seam halt action.

Impact: the highest-priority spoken safety affordance can close routing state without stopping the running process.

Suggested fix: convert panic into a real halt path for the selected/current process, preserving mute > panic priority. Add tests that start a process, speak `Abort`, assert `process.halt` within 1s, assert E5 + <=15-word TTS, and assert siblings keep running.

### P0 - The Claimed 100% Live E2E Bar Is Not Met

The PRD requires the canonical scenario to run against the live stack at least 10 times and pass at least 9 (`docs/planning/01-prd.md:255`, `docs/planning/01-prd.md:265`). Current canonical e2e is deterministic in-process replay (`test/e2e/canonical-spine.e2e.ts:7`, `test/e2e/canonical-spine.e2e.ts:57`), and the Smithers/Cue slices use in-process gateways rather than a live room audio path (`test/e2e/spine.e2e.ts:68`).

Also, live ASR is explicitly skipped when `DEEPGRAM_API_KEY` is missing (`test/e2e/latency-benchmark.e2e.ts:144`, `test/probes/probe-asr-deepgram.test.ts:71`). The persisted P-ASR verdict is still `"status": "passed"` while `liveDeepgram.status` is `"skipped"` (`artifacts/smithering/probes/probe-asr-deepgram/verdict.json:3`, `artifacts/smithering/probes/probe-asr-deepgram/verdict.json:5`).

Impact: important live-system risks remain unproven: real ASR diarization/finalization, live mute/unmute, live wake/accept/spawn/steer/ack, and the 9/10 reliability threshold.

Suggested fix: split deterministic replay tests from release-blocking live e2e. A missing live credential should mark the live gate blocked/skipped, not passed. Add the scripted-audio 10-run live stack test and publish per-run failure causes.

### P1 - Projector Browser E2E Is Not In CI

CI runs only `bun test` and `bunx tsc --noEmit` (`.github/workflows/ci.yml:15`, `.github/workflows/ci.yml:16`, `.github/workflows/ci.yml:17`). It does not run `bun run test:e2e` / Playwright, even though browser e2e is the only suite exercising the production Vite build plus Hono static server path.

Impact: projector regressions, API route regressions, and production build/server regressions can merge while CI is green.

Suggested fix: install Playwright browser dependencies in CI and run `bun run test:e2e`, or replace the CI commands with `bun run test:all`.

### P1 - Playwright Custom Port Setting Is Broken

`playwright.config.ts` derives the base URL from `VIBERSYN_PORT` (`playwright.config.ts:14`) and starts the server with `VIBERSYN_PORT=${PORT}` (`playwright.config.ts:34`), but `src/server/index.ts` reads `PORT`, not `VIBERSYN_PORT` (`src/server/index.ts:33`, `src/server/index.ts:34`). I confirmed `VIBERSYN_PORT=8791 bun run start` still listens on `8787`.

Impact: `VIBERSYN_PORT=<non-default> bun run test:e2e` waits on the wrong URL and fails/hangs until the web server timeout.

Suggested fix: either change the Playwright webServer command to `PORT=${PORT} bun run start` or make `src/server/index.ts` accept `VIBERSYN_PORT` as an alias.

### P1 - Narrow Viewports Clip Process Bubbles

On a `390x844` viewport, the bubble field clipped Atlas and hid Cobalt entirely. The field has `overflow: hidden` (`src/ui/styles.css:443`) and, under the mobile media query, only `min-height: 60vh` (`src/ui/styles.css:1214`). The absolutely positioned `.field-inner` wraps large fixed-size bubbles inside that clipped field (`src/ui/styles.css:482`, `src/ui/styles.css:496`), while the rail starts immediately after the field (`src/ui/App.tsx:328`).

Measured during review:
- bubble field bottom: `758px`
- Atlas bottom: `794px`
- Cobalt top/bottom: `820px / 1056px`

Impact: the projector UI is strong on desktop, but narrow windows lose active process visibility and make the fleet view incomplete.

Suggested fix: add a mobile/narrow layout for the bubble field: remove clipping or make the field height content-driven, reduce bubble sizes with container rules, and add a Playwright mobile viewport assertion that all bubbles are visible.

### P2 - `bun run seed` References A Missing File

`package.json` exposes `"seed": "bun src/scripts/seed-demo.ts"` (`package.json:17`), but `src/scripts/seed-demo.ts` does not exist. Running `bun run seed` fails with `Module not found "src/scripts/seed-demo.ts"`.

Impact: the demo/setup command advertised by the package is broken.

Suggested fix: either implement `src/scripts/seed-demo.ts` or remove/update the `seed` script.
