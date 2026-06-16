# Clarifying Questions — Panopticon V0 (audio-only on Cue)

> Written 2026-06-13. Source: brainstorm.md §7 open questions, cross-checked against
> research/domain.md and research/prior-art.md. Discipline: keep only PRODUCT questions
> (who it's for / what success is / scope boundaries) whose answer materially changes the
> PRD and that evidence cannot settle. Everything else is recorded as already-resolved.

---

## Kept questions (need a human)

### q-safety-fallback — Does V0 ship a minimal NON-voice emergency control?
Audio-only is the sole *operational* modality, but if STT fails, the mute sticks, or a
mishear loop starts, the room has **no way in** (risk **R-No-fallback-modality**, which the
brainstorm explicitly marks "flagged, not yet decided"). Domain research §5-Q1 separately
decided the observability screen should stay **strictly read-only** — which actively conflicts
with adding any emergency control there. So the two upstream artifacts disagree, and the
brainstorm left it open.

**Recommended answer:** **Yes** — ship a non-voice emergency stop: a physical hard-mute /
kill-all (keyboard or hardware) plus a single "stop all" control on the observability screen,
clearly scoped as **emergency-only**, never a routine control surface. Voice stays the sole
operational modality. Rationale: voice-sole control over autonomous code-writing agents that
hold git creds, combined with mistranscription as the *normal* failure mode
(R-Mistranscription-blast-radius), makes "no way to stop it" an unacceptable safety hole; a
tiny, clearly-bounded escape hatch is cheap insurance and doesn't compromise the audio-only
product thesis.

**Why it matters:** It's the one item the brainstorm itself left undecided, and it directly
contradicts the research's read-only-screen decision. The answer sets a hard safety boundary
in the PRD (what non-voice affordances exist, if any) — a product/values call between
audio-only purity and operator safety that evidence cannot resolve.

### q-fleet-scope-v0 — Is concurrent multi-process operation in V0, or deferred to V1?
The brainstorm bakes "**≥2 concurrent processes operated independently by voice**" into the
V0 success criterion (Q2), yet the PROMPT's build-order directive says "one high-value flow
over many half-flows," and **R-Demo-chain-fragility** flags the long hands-free happy-path
chain as the biggest demo risk. So there's genuine tension over whether the fleet belongs in
V0 at all.

**Recommended answer:** Keep a **minimal** fleet in V0 — exactly **two** concurrent processes
with independent voice pause/steer — because operating *many* agents hands-free is
Panopticon's core differentiator (G2); a single-process demo is hard to distinguish from
existing voice coding tools (Aider `/voice`). But cap it hard: two processes, basic
independent pause/steer only; defer fork/replay/advanced fleet controls to V1. Build the
single end-to-end loop first and add the second process **last**, so the demo degrades
gracefully to a single-process story if the fleet link proves fragile.

**Why it matters:** Fleet concurrency is the largest single chunk of V0 complexity and the
main demo-fragility risk, and it's the line between Panopticon and a single-agent voice tool.
V0-vs-V1 placement materially reshapes scope, effort, and the success criterion — a
scope-boundary decision no external evidence settles.

---

## Surfaced blocker (for the orchestrator's gate — not a product fork)

**Cue repository availability could not be confirmed.** Domain research §7 and prior-art §1
could not confirm `github.com/jameslbarnes/cue` is a public/accessible repo as of 2026-06-13.
Cue is the mandated, load-bearing foundation for the *entire* input / suggestion / routing
layer and a P0 validate-before-build gate (**R-Cue-unvalidated**). If the repo is
private/unavailable, or its real API differs from the README-derived assumptions, the
integration plan and PRD must be revised. Required before implementation: confirm access and
run a live probe against Cue's real API (observation schema, cue-policy constructors,
`Program`/`CueHarness`/`MappedActionTool`, provider interfaces, HTTP routes). This is an
availability/feasibility blocker, not a product question, so it is surfaced here rather than
kept as a clarifying question.

---

## Dropped — already answered (by research) or settled (by the standing constraints)

- **Q1 (user / is a screen allowed):** RESOLVED — domain §5-Q1 + brainstorm Q1: V0 = small
  trusted single-room team, audio-only operation, screen = optional **read-only**
  observability only, no auth/multi-tenant.
- **Q2 (success criterion):** Mostly settled (≈12-min hands-free end-to-end demo). The only
  contested part — whether ≥2 concurrent processes is required for V0 — is escalated as
  **q-fleet-scope-v0**.
- **Q3 (suggestion cadence):** RESOLVED — domain §5-Q2: `observe.pass`-first, conservative,
  concrete defaults (60-word / 90-s gate, ~1 per several minutes), exposed as live tunable
  knobs. Cadence is a knob, not a product fork.
- **Q4 (what a suggestion's "demo" is with no screen):** RESOLVED by the audio-only standing
  constraint — spoken one-line pitch + 1–3 spoken MCQs; live HTML demo deferred to an optional
  observability artifact.
- **Q5 (select/steer an existing process by voice, C3):** RESOLVED — research/prior-art: a
  `ProcessSelectCue` (TextCue/SpeakerWordCue on a per-process callsign); un-addressed speech
  only feeds suggestions. Callsign style is an implementation detail.
- **Q6 (process output sound, G5′):** RESOLVED by audio-only constraint + PROMPT silent-tick
  design — concise spoken summary, volunteered sparingly, ~90% of ticks silent.
- **Q7 (execution posture):** RESOLVED — V0 ships a **single dangerous run-to-completion mode**:
  no Safe/Explicit/Dangerous mode switching, no per-action spoken read-back/confirm gate, no
  dead-man timer. We run to completion and minimize approvals; where a confirmation is genuinely
  needed, the voice library (Cue) handles it. If we want safety later we **sandbox the whole
  process**, not gate via permissions. (Reverses the earlier Safe-by-default posture.)
- **Q8 (multi-speaker: pairing vs diarization):** RESOLVED — domain §5-Q4 + prior-art:
  Deepgram Nova-3 native diarization via `SpeakerChangedCue`/`SpeakerWordCue`; QR pairing
  demoted to wishlist.
- **Q9 (unselected process keeps working):** RESOLVED by product vision (G2/G3) — processes
  advance autonomously; steering only redirects. Definitional.
- **Q10 (consent/trust for always-on cloud mic):** RESOLVED within V0 scope by the
  trusted-single-room assumption (Q1) — listening indicator, a hard mute (say **“mute”** or press
  the on-screen mute button), transcript-only persistence (no raw audio), explicit third-party STT
  disclosure. While muted, audio is no longer fed into the suggestion/routing pipeline; to unmute,
  **say “unmute” or press the on-screen unmute button** — the voice library (Cue) keeps listening
  for the keyword even while the cloud pipeline is paused, so there is **no bespoke on-device
  spotter** to build. Broader external-user consent is out of V0 scope.
- **Q11 (adopt Cue's provider stack + the Smithers/Fable seam):** RESOLVED — Deepgram Nova-3
  (domain §5-Q4) for transcription; seam = Cue decides *when* (it is essentially I/O into the
  event loop), Smithers just runs background jobs durably, and Cue ↔ Smithers do not know about
  each other. No raw API keys and no elaborate credential-provider abstraction: **assume the host
  machine is already logged in to its OpenAI Codex and Anthropic Claude subscriptions** and call
  through those (no Cerebras/Haiku hot-loop specifics; model choice follows the assignment matrix).
  Provider/seam are architecture, not product.
