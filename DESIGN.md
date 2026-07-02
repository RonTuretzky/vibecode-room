# Vibersyn — Projector UI Design System ("The Deep")

> Source of truth for the shared mission-control surface (REQ-16, design doc §9).
> Read this with `docs/planning/02-design.md` §9 (projector UI) and `src/types.ts` (data contract).

## North star

A calm, dark, **bioluminescent control room**. The room's ideas surface as luminous
glass **bubbles** rising through a deep abyss. Gorgeous and artistic from across a
room — **glanceable on a large projector**, never a point-and-click app. Mission-control
legibility (instant status reading) fused with generative-art beauty.

This is **read-only / non-authoritative / off the critical path**. The spoken loop is
authoritative; the projector never gates voice. The only operational controls are the
two bounded safety hatches: **on-screen Unmute** and **Emergency kill-all**.

## Hard rules (from the design doc — do not violate)

- **Projector-first.** Large type, high contrast, readable from 3–5 m. Base font ≥16px;
  callsigns 28–44px. No dense point-and-click chrome.
- **Status color semantics are fixed (human factors / STARS audit):**
  - active / nominal → `--active: #00ff88`
  - paused / pending → `--paused: #f5a623`
  - halted / error → `--halted: #ff3b30`
  - selected / in-focus → `--selected: #00bcd4` (cyan)
  - planning → `--planning: #38bdf8` (blue) — **never violet**
  - completed → `--completed: #9affc9`
- **Violet/purple is PROHIBITED as a status color.** It may appear only as faint ambient
  atmosphere in the background nebula, never to signal process state.
- **Blink is reserved for exactly one state:** emergency-stop triggered (red). Nothing
  else blinks.
- **Trace auto-scroll is disabled.** When new events arrive while scrolled up, show a
  "NEW" pill; clicking it scrolls to bottom (navigational, not operational).
- **Renders before any backend** via a deterministic demo snapshot.

## Aesthetic pillars

1. **Atmosphere.** Background is not flat black — a vertical abyss gradient
   (`#05070d` → `#070e16`) with 2–3 very-soft, slowly drifting radial "aurora" glows
   (deep teal + faint indigo, low alpha), a subtle vignette, and an optional ~3% grain so
   the projector never bands. A slow particle drift adds life. All cheap (transform/opacity).

2. **Bubbles that truly look like bubbles.** Each process/idea is a translucent glass
   sphere: radial-gradient body, a bright specular hotspot top-left, a rim light,
   `backdrop-filter: blur()` so the abyss refracts through it, and a soft outer bloom tinted
   by its **state color**. They **float**: each bobs on a slow sine (translateY), drifts
   slightly (translateX), and "breathes" (micro-scale) with staggered per-bubble phases so
   the field feels alive but calm.
   - **Ideas** (pending suggestions) = smaller, lighter, "forming" bubbles with a shimmering
     dashed aura — an idea not yet committed.
   - **Processes** (accepted → builds) = full bubbles; size grows with significance
     (selected/active+recent are largest). Active builds carry a thin progress ring.
   - Callsign centered (large display), state word beneath, a tiny id line.

3. **Lineage / tree-growth.** When an idea was accepted into a process, draw a thin
   luminous filament from idea→process (parent→child). Subtle; optional for v1.

4. **Click into a bubble → build detail.** The bubble expands/zooms into a glass detail
   card; the rest of the field dims + blurs (depth of field). Detail shows: callsign, state,
   posture, model, task, last spoken output, last action, UPID/runId, the recent action log,
   and the per-UPID trace breadcrumbs ("see how the build is going"). Closeable via click-away,
   a back control, or `Escape`. Keyboard digits 1–9 also select bubbles (projector-friendly).

5. **Z-pattern status bar** (glanceable):
   - top-left: **listening / mute** orb (highest criticality) — green pulse = listening,
     amber steady = muted — with ASR provider label.
   - top-center: **active cue** + suggestion budget / gate progress.
   - top-right: **emergency** status — calm "CLEAR"; on trigger, the one red blink, full alert.
   - a READ-ONLY · NON-AUTHORITATIVE tag.

6. **Trace rail.** Refined monospaced, color-coded event stream (OBS/PASS/FIRE/ACT/HALT)
   with the disabled-auto-scroll + NEW-pill behavior.

## Motion

Slow, organic, GPU-friendly — **transform/opacity only**, no per-frame layout or heavy
animated filters. Background aurora drifts on a 60–120 s loop. Honor
`prefers-reduced-motion` (freeze float, keep static beauty).

> **Why CSS/SVG glass and not WebGL/three.js:** a prior 3D bubble world repeatedly crashed
> to blank on the real projector GPU (WebGL context loss from postprocessing/shadows), and
> Playwright screenshots did not match the real GPU. We get the gorgeous bubble look with
> CSS radial gradients + backdrop-filter + SVG filters — beautiful, stable, and assertable
> by state (not screenshots).

## Test contract (do not break — the e2e suite depends on it)

The UI must keep these stable hooks. `src/ui/App.tsx` exposes `window.__VIBERSYN__`, and
`src/ui/demo-data.ts` provides the deterministic snapshot used before a live backend is attached.
Presentation components must render the listed `data-testid`s and `data-*` attributes.

`window.__VIBERSYN__`:
- `ready: true`
- `getSnapshot(): Snapshot`
- `applySnapshot(s: Snapshot): void` — replace state (used by e2e to drive deterministically)
- `select(callsignOrUpid: string | null): void` — open/close build detail
- `getSelected(): string | null`

Required `data-testid` (with attributes):
- `app` — root
- `listening-indicator` — `data-state="listening" | "muted"`
- `emergency-status` — `data-triggered="true" | "false"`
- `active-cue` — text of the active cue
- `bubble` (one per process & idea) — `data-callsign`, `data-kind="process" | "idea"`,
  `data-state`, `data-selected="true" | "false"`
- `bubble-field` — the container of all bubbles
- `trace-rail` containing `trace-event` rows (each `data-event` = the event name)
- `new-events-pill` — present only when scrolled up with unseen events
- `build-detail` — present only when a bubble is selected; contains `detail-callsign`,
  `detail-state`, `detail-action-log`, `detail-trace`
- `unmute-button` — present/visible only when muted
- `emergency-button` — always present
