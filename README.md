# Panopticon

**An operating system for AI-agent work.** Talk in a room; the system passively
listens, floats *idea bubbles* proposing things to build, and lets you spawn and
steer many concurrent agent **processes** at once — by click+type or by voice.

This is the **V0** of the design captured in
[`.context/attachments/.../panopticon-session-1-guide.md`](.) — implemented as a
runnable system today, with clean seams where Smithers, cue and local-inference
plug in (see [ARCHITECTURE.md](ARCHITECTURE.md)). Smithers is the described
backend now; Eliza support is planned later.
<!-- TODO(eliza): add Eliza as a pluggable backend adapter later. -->

```
                          META-SESSION  (always-on outer loop · Smithers-backed)
                                │
        ┌───────────────────────┼───────────────────────────┐
   SUGGESTION ENGINE        INPUT ROUTER                PROCESS MANAGER
   (cue-style wake policy)  (steer vs. suggest, C2/C3)  (create/fork/kill/…)
   always-on transcript →   targeted → process queue          │
   idea bubbles             ambient  → suggestion engine   PROCESS #n
                                                            (session loop:
                                                             input→pre→action→post→output)
```

## Run it

Requires [Bun](https://bun.sh) (≥ 1.2). No build step.

```bash
bun install            # types only; the app needs no runtime deps
bun start              # → http://localhost:7777
```

Optional: set `ANTHROPIC_API_KEY` to use real models instead of the deterministic
mock brain. With no key it runs fully offline with a built-in mock that still
exercises the entire loop.

```bash
ANTHROPIC_API_KEY=sk-... bun start
# model tiers (spec §5.9 / P-Cost-fit):
PANOPTICON_IO_MODEL=claude-haiku-4-5-20251001 \   # the cheap always-on suggest loop
PANOPTICON_PROCESS_MODEL=claude-fable-5 \         # per-process orchestration
ANTHROPIC_API_KEY=sk-... bun start
```

### Try the flow

1. Open `http://localhost:7777`.
2. In the **room** bar at the bottom, type something buildable — e.g.
   *"we should build a tool to track all our running agents"* — or hit 🎤 to
   talk (Web Speech API). This is the **ambient** channel.
3. An **idea bubble** appears on the right with a live demo + multiple-choice
   questions. Answer some, click **Accept → spawn**. A **process** is born and
   auto-selected.
4. Steer it: with the process selected, type into the steer panel and hit Enter
   (the spec's highest-value flow: *click → type → Enter → effect*).
5. **Fork / pause / kill** from the card. Click **▦** to get a QR code that
   pairs a phone (`/m/:token`) as a mic+chat steering device.

Or drive it hands-free against a running server:

```bash
bun run seed           # plays a scripted room conversation
```

## What's implemented (spec §6.1 V0)

- [x] Always-on **suggestion engine** → idea bubbles with demo + clarifying
      questions, TTL, merge-in-place, model-initiated cadence (§5.5)
- [x] **Process Manager**: create · modify · kill · fork/spawn · merge ·
      import/export · pause · resume · switch_mode (§5.1)
- [x] Per-process **session loop** with pre/post **hooks** incl. pre-spawn
      resource check & pre-kill context archive (§5.3, C6)
- [x] **Input router** with the two-channel rule: ambient→suggest,
      selected→steer (§5.4, C2/C3)
- [x] **Pro** click→type→Enter UI on a spatial board with live per-process
      visualizers that auto-pick by artifact kind (§5.6, G5)
- [x] **Mobile** QR pairing → mic+chat device feeding a process input queue (§5.7)
- [x] Tunable knobs: bubbles/min, suggestion TTL, safe/dangerous,
      optimistic/explicit (§4)
- [x] Swappable **brain** (mock ↔ Anthropic) and `agent`/`model`/`container`
      metadata fields (C7)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the file-by-file map to the spec and
the integration seams for Smithers / cue / plugin-local-inference. Eliza support
is planned later.
<!-- TODO(eliza): include Eliza in the documented seams once the adapter exists. -->

## Layout

```
src/core/      domain: meta-session, process-manager, process, suggestion-engine,
               input-router, hooks, brain (mock | anthropic)
src/server/    Bun.serve — REST commands + /ws event stream + mobile pairing
src/web/       Pro spatial UI (index/app/style) + mobile device (mobile.*)
src/scripts/   seed-demo — scripted room conversation
```
