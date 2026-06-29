# Vibersyn ← Smithers build plan (dev notes)

This file is **dev tooling** (lives in `.smithers/`). It records how we use the
Smithers dev workflows here to build Vibersyn's app code. It is NOT app code.

## Golden rule (user directive)
- **App workflows** (Vibersyn runtime Smithers workflows — the durable "Process"
  loop, the suggestion engine) live in the **app** under `src/` and run at
  Vibersyn runtime. They are the product.
- **Dev workflows** (`implement`, `review`, `ralph`, `_smoke`, …) live in
  `.smithers/` and are operated by the AI to *build* the app.
- **Never mix the two.**

## Other user directives
- Replace every **Eliza** reference with **Smithers + the design**; leave a
  `// TODO(eliza): ...` marker — Eliza adapter comes later.
- **All AI interactions run through Smithers** (subscription harness), never a raw
  API key — even trivial one-shots.
- Use **subscriptions** + the **implement / ValidationLoop / Review** loops where
  appropriate.
- Do the build **by operating Smithers** ("use Smithers to implement Smithers").

## Verified harness facts (this environment)
- `smithers-orchestrator@0.23.0` installed in `.smithers/`; project-local bin:
  `.smithers/node_modules/.bin/smithers` (global `smithers` is older 0.20.3 — use local).
- Subscriptions registered: `codex-1` (gpt-5.3-codex), `gemini-1` (gemini-3.1-pro)
  WORK; `kimi-1` OAuth is **expired** (needs `kimi login`).
- Run a local workflow: `smithers up <file.tsx> --input '{json}' --run-id <id>`.
  Launch from **`.smithers/`** (bunfig preload + module/path resolution apply).
- **cwd gotcha:** agents default to the workflow file's dir (`.smithers/workflows`),
  NOT the app. Fixed in `agents.ts`: `codexApp`/`geminiApp` pin `cwd: APP_ROOT`
  (parent of `.smithers/`), and `agents.{cheapFast,smart,smartTool}` now lead with them.
- Monitor a run: `smithers ps`, `smithers inspect <id>`, `smithers chat <id>`,
  `smithers logs <id>`. Resume: `smithers up <file> --run-id <id> --resume true`.

## Build decomposition (each = one `implement` dev-run, validated + reviewed)
- **A. Eliza → Smithers swap** — `src/core/{types.ts,process.ts,meta-session.ts}`,
  `ARCHITECTURE.md`, `README.md`. Replace Eliza-as-backend with Smithers + design;
  add `// TODO(eliza)` markers. Smallest, highest-confidence first run.
- **B. SmithersBrain** — `src/core/brain/smithers.ts implements Brain`: every AI call
  goes through a Smithers run (gateway-client / `runWorkflow`), subscription-backed,
  no raw API. Selected by `makeBrain()` when agent === "smithers".
- **C. App runtime workflows** — `src/core/workflows/{process,suggest}.tsx` (APP, not
  `.smithers/`). The durable Process loop + the bubble/suggestion engine.
- **D. Wire control plane** — `process-manager.ts` / `meta-session.ts` map §5.1
  functions → gateway-client RPCs (launchRun/resumeRun/cancelRun/submitSignal/…);
  `bus.ts` ← `streamRunEvents`.

## ENG-T-10 audio capture ASR bridge
- **§1 Component:** `src/cue/asr-bridge.ts` owns Vibersyn's mic/PCM → `ASRProvider`
  → Cue transcription ingress path. Cue is treated as a transcription receiver via
  `/sessions/:id/transcription`; Vibersyn owns Deepgram/VAD/replay ASR upstream.
- **§3 Wiring:** live mode requires `DEEPGRAM_API_KEY` plus a supplied microphone PCM
  capture. Without the key, the bridge emits `live capture skipped — needs
  DEEPGRAM_API_KEY` and runs replay PCM/transcript fixtures through the same
  normalization, correlation, and Cue ingress pipeline.

## Validation gate
- Set `.smithers/smithers.config.ts` `repoCommands.test = "bun run typecheck"` so the
  ValidationLoop's validate step actually gates on the app's `tsc --noEmit`.
