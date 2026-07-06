# Intake — Vibersyn (voice-only, Cue-powered)

> Written 2026-06-13. The intake/classification step of the smithering build pipeline.
> Source of truth: `PROMPT.md` (the build brief) + the two standing constraints attached to
> this task (audio-only; all interaction on **Cue**). Reads the existing repo on disk.
> **Decisions here are recorded, not just considered** — downstream steps (brainstorm → PRD →
> eng doc) inherit this classification.

---

## Classification: **existing-codebase**

`vibecode-room/` is **not** a blank directory. It is an established project that already
carries real, load-bearing conventions the build must honor — even though the *product source*
is mid-pivot. What's on disk today:

- **`package.json`** — name `vibersyn`, `private`, `type: module`, Bun runtime. Deps:
  `smithers-orchestrator@0.23.0`, `zod@4.4.3`. Scripts: `dev`/`start` (`bun src/server/index.ts`),
  `typecheck` (`tsc --noEmit`), `test` (`bun test`), `seed`.
- **`tsconfig.json`** — strict, ESNext, `moduleResolution: bundler`, `allowImportingTsExtensions`,
  `jsx: react-jsx` with `jsxImportSource: smithers-orchestrator`, `include: ["src"]`.
- **`ARCHITECTURE.md` + `README.md`** — document the V0 design: the §5 decomposition
  (meta-session / process-manager / process / suggestion-engine / input-router / hooks / brain),
  the file→spec map, and the **adapter seams** where Smithers / cue / plugin-local-inference plug in.
- **`.smithers/`** — a full **dev-workflow harness** (the `smithering` pipeline this very step
  runs in, plus `implement`/`review`/`ralph`/`audit`/… workflows, prompts, specs, agents).
  `.smithers/VIBERSYN_BUILD.md` records standing user directives.
- **A prior `src/` implementation** — tracked in HEAD (`git ls-files src` → ~29 files:
  `core/{meta-session,process-manager,process,hooks,suggestion-engine,input-router,bus,
  control-plane,gateway,types,util}.ts`, `core/brain/*`, `core/workflows/*.tsx`, `server/index.ts`,
  `web/*`, `scripts/seed-demo.ts`). It is **deleted in the working tree** (the entire `src/` is
  `git rm`'d in the current diff) as part of re-pointing to the voice-only model.

**Why existing-codebase, not greenfield:** the PROMPT says "build from scratch … not bound to the
previous implementation," but that refers to *product/UX choices*, not the repo. VCS is already
initialized (both `jj` and `git` present), the toolchain (Bun + strict TS), the durable backend
(Smithers), and the **app-vs-dev workflow split** are fixed conventions. The deleted `src/` is a
**reference, not a constraint** — recoverable from git for patterns, but the voice-only product is
re-derived. Treating this as greenfield would discard the harness the pipeline itself depends on.

## Product type: **webapp**

Engineering decisions §9 specify a **React + Vite** frontend (output-only "living garden board",
idea-bubbles sidebar, steering banner, listening indicator, mobile paired-mic page) served by a
**Hono** backend exposing a command API + a **WebSocket/SSE realtime stream**. Even though voice
is the sole *interaction* modality and the screen is demoted to optional observability, the
shipped artifact is a web application (realtime server + browser display surface + phone pages).
Among the enum, `webapp` fits best; `service` (the always-on meta-session) is a secondary read but
under-captures the browser/display + mobile surfaces.

## Target repo: **`.`** (the current repo, `vibecode-room/`)

All build work happens in the current repo root. App **runtime** workflows live under `src/`; dev
**build** workflows live under `.smithers/` — **never mixed** (standing directive). VCS already
initialized; no new directory or `git init` needed. The sibling `../smithers` (`~/smithers`) is
**reused** (the `report-slideshow` workflow for the commit/PR explainer) but is not the build target.

---

## Constraints already visible (recorded)

**Product / interaction (standing, override the PROMPT where they conflict):**
1. **C0 — Audio-only.** Voice is the sole interaction modality; no mouse/keyboard/touch/click/
   drag/scroll/pinch/point/gesture. The display is **output-only** (watched, never touched).
2. **Built on Cue** (`github.com/jameslbarnes/cue`) — magic words, the suggestion engine, and every
   spoken command are **cue policies** over the transcript stream; `observe.pass` is first-class.
   Use Cue's provider slots (transcription/LLM/output), not a custom STT/turn-taking/wake stack.
3. **C1/C4** — multiple concurrent processes, each independently controllable by voice
   (pause/resume/fork/kill/steer) without affecting siblings.
4. **C2/C3 — two-channel routing.** Always-on transcript feeds **suggestions only**; steering an
   existing process requires **magic-word selection first**; every utterance → one target or
   `observe.pass`.
5. **C5/C6** — a spoken **panic/stop word** that always wins; magic words phonetically distinct &
   accident-resistant, shown prominently.
6. **C7/C8** — context preserved across lifecycle (pre-kill archive, pre-spawn check); per-process
   **swappable** agent/model behind a clean seam.
7. **C9/C10** — low latency (streamed STT→LLM→TTS); legible + consentful listening (visible
   indicator, spoken mute, **transcript-only persistence — no raw audio** in V0).
8. **Spoken output is rationed** (G6 / P-Restraint): ~90% of ticks silent; no constant narration.

**Engineering / stack (from §9 + repo):**
9. **Bun + TypeScript** (strict, ESNext, `moduleResolution: bundler`, `bun test` as the test cmd).
10. **Smithers** is the durable process backend — each process is a durable, forkable, resumable
    Smithers run. **All model calls route through Smithers subscriptions — never a raw API key**,
    even trivial one-shots.
11. **Cost-fit model tiering** — cheap/local tier in the always-on hot loop; **Fable** for
    per-process orchestration; **no Opus in the hot loop**.
12. **Voice kernels via `plugin-local-inference`** (whisper.cpp / llama.cpp / Kokoro), or Cue's
    hosted providers (Deepgram ASR / Cerebras LLM) behind the same provider slots.
13. **Frontend React + Vite (output-only); backend Hono + WebSocket/SSE realtime.**
14. **App (`src/`) vs dev (`.smithers/`) workflow split — never mix.**
15. **Reuse `../smithers` `report-slideshow`** for the commit/PR explainer deck; don't rebuild it.
16. **Preserve the §5 architecture decomposition + C2/C3 routing as product requirements** behind
    a clean swappable seam.

**Validation & observability bar (non-negotiable):**
17. Unit **AND** e2e for every behavior; assume nothing works until a test that could fail proves it
    (expect 10×–100× more tests than usual).
18. **Validate third-party APIs against the real library before building** — Cue,
    `plugin-local-inference`, and Smithers (provider interfaces, cue-policy + observation/action
    schemas, subscription/`streamRunEvents`/fork/resume). React/standard libs exempt.
19. **Build for observability** — structured, leveled logging; traceable IDs (UPID, Smithers run-id,
    Cue session-id) so a context-free agent can debug a stuck process.

---

## Unknowns for later research / questions to resolve

- **Cue's real API surface** — provider interfaces (transcription/LLM/output/frame), cue-policy
  classes (`TextCue`/`SpeakerWordCue`/`SpeakerChangedCue`/`IdleCue`/`IntervalCue`/`WordCountCue`?),
  the observation + action schema, `CueHarness`/`Program`/`MappedActionTool`, HTTP routes. Known
  only from the README (fetched 2026-06-13); **must be exercised before code is built on it** (P0).
- **`plugin-local-inference` real streaming API + latency**, and the V0 provider choice: local
  kernels (cost/offline) vs Cue's hosted Deepgram/Cerebras (quality/latency) vs a split (open Q3).
- **Smithers fork/pause/resume/subscription/`streamRunEvents` semantics** vs the product's
  lifecycle mental model (fork may need fresh-seeded-run + parentId lineage, not a native fork).
- **Is Fable actually reachable** as a model via Smithers subscriptions in this environment? The
  `smithering` dev workflow notes "fable is disabled; the brain runs on opus," and only `codex-1`/
  `gemini-1` subscriptions are verified (`kimi-1` OAuth expired). The per-process orchestrator model
  may need to fall back.
- **The Cue↔Smithers seam** — action dispatch out of Cue, durable-state observations back into Cue
  to keep voice-out coherent (novel integration risk; neither library assumes the other).
- **Magic-word scheme + wake discipline** — NATO / colors / codenames / generated; is a magic word
  alone enough or is a global wake word needed to suppress accidental selection (open Q1/Q2).
- **Suggestion threshold + cadence** — what makes ambient talk "rise to" a suggestion; bubbles/min
  default; interruption-asymmetry makes over-firing the top product risk (open Q5).
- **Steering-window boundary** — silence-based ~20s chunks vs explicit end word (open Q6, needs a
  live mic to tune).
- **Mobile mic affordance under "no clicking"** — is hold-to-talk acceptable or must the paired
  phone be open-mic (open Q4)?
- **Safety fallback (conflict to resolve)** — does V0 ship a minimal **non-voice** emergency stop?
  `clarifying-questions.md` (q-safety-fallback) flags that the brainstorm left it open and it
  conflicts with the research's strictly-read-only-screen decision.
- **V0 fleet scope (conflict to resolve)** — is concurrent multi-process operation in V0 or deferred
  to V1? The success criterion bakes in ≥2 concurrent processes, but the build-order directive and
  R-Demo-chain-fragility argue for one flow first (`clarifying-questions.md` q-fleet-scope-v0).
- **Always-on cloud-STT privacy/consent + recurring cost** — single-room/trusted-users assumption
  vs a real mic streaming continuously to a third party.

---

## Summary

Existing Bun+TypeScript repo (`vibersyn`) being **re-pointed** from a click+type+voice V0 (prior
`src/` deleted in-tree, recoverable from git) to a **voice-only, Cue-driven** rebuild. Target is the
current repo (`.`); product type is a **webapp** (Hono realtime backend + output-only React/Vite
display + paired-phone mic pages), operated entirely by voice. Honor the repo's fixed conventions
(Bun, strict TS, Smithers durable backend, all model calls via Smithers subscriptions, `src/` vs
`.smithers/` split) and the standing constraints (audio-only, everything on Cue, cost-fit tiering
with no Opus in the hot loop, the validation/observability bar). The biggest pre-build unknown is
the **real Cue / plugin-local-inference / Smithers API behavior**, which the validation bar requires
exercising against the actual libraries before anything is built on them.
