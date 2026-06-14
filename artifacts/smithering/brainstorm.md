# Brainstorm — Panopticon (V0, audio-only on Cue)

> Mapping the problem space for building Panopticon from scratch.
> Grounded in: the build brief (`PROMPT.md`), the **two standing constraints** attached to this
> task — (1) **audio-only**: voice is the sole interaction modality, the user cannot see a screen
> or type; (2) all agent interaction and command-triggering ("magic words") **MUST be built on
> Cue** (`github.com/jameslbarnes/cue`) — plus the upstream `intake.md` and the two research
> artifacts (`research/domain.md`, `research/prior-art.md`) that postdate the first draft and add
> evidence + a confirmed read of Cue's API surface.
>
> **The two standing constraints OVERRIDE the PROMPT wherever they conflict.** The PROMPT is a
> heavily *visual* spec (React/Vite spatial board, `click → type → Enter` as "the highest-value
> flow," an idea-bubble sidebar with live HTML demos, iframe visualizers, mobile QR pages, Web
> Speech API). The standing constraints retire all of that as the *primary* surface. What survives
> — and what this brainstorm re-anchors everything to — is the PROMPT's deeper, modality-agnostic
> architecture (§5: meta-session / process-manager / session-loop-with-hooks / suggestion-engine /
> input-router; the C2/C3 two-channel routing rule; durable Smithers processes; Fable planning;
> cost-fit model tiering). **All recommendations below are recorded decisions** — downstream steps
> auto-adopt them when a human is unavailable, *except* the two items in §7 explicitly escalated
> to a human gate.

---

## 1. Problem statement

Building software with AI still means *commanding a computer*: you stop talking, look at a screen,
type a precise instruction, wait, and babysit one agent at a time. That friction kills the most
valuable mode — **building while you talk** — and a research-grounded interrupt tax makes it
concrete: a programming interruption costs ~23 minutes of recovery, interrupted tasks take ~2×
longer with ~2× the errors, and context-switching burns 6+ hours/week (`research/domain.md` §1).
As orchestration models (Fable) cross the line where they plan *how* better than a human PM, the
bottleneck moves from "can a model do it" to "**can a room of humans express intent and operate
many agents at once, hands-free, without drowning in command overhead or being talked over by
their own tools.**" 85% of developers already use AI coding tools and 70% juggle 2–4 at once
(`domain.md` §1) — they are *already* multi-agent operators; the missing piece is an ambient,
voice-only interface, which **no shipping product provides** (`domain.md` §3 / `prior-art.md` §8:
gap confirmed).

**Panopticon is an audio-only operating system for AI-agent work.** A small trusted team talks in
a shared room; the system **passively listens** through **Cue** (continuous audio → transcript
observations → cue policies → decide-or-`observe.pass`) and — sparingly, by voice — proposes
things to build. When the room accepts a proposal, Panopticon **spawns a durable agent "process"**
(a Smithers run) that the room can **steer by voice** and **operate alongside others** (pause /
resume / fork / kill — independently). Because there is no screen to look at, "render the right
thing" (G5) becomes "**tell** the right thing" (G5′): a process's output is a *spoken* summary the
agent volunteers rarely (~90% of ticks are silent), not a rendered demo. The unifying metaphor is
still an OS **Process Manager**: a long-running **meta-session** owns N concurrent **processes**,
each running `input → pre-hooks → action → post-hooks → output`.

The hard two-channel routing rule (**C2/C3**) survives verbatim and is, in fact, *native to Cue*:
the transcript is **always-on for spawning new-process suggestions only** (one continuous Cue
program); steering an *existing* process requires **explicit voice selection first** (speaking the
process's magic word, which scopes subsequent speech to it); every utterance routes to exactly one
target or to nothing — and "to nothing" is Cue's first-class **`observe.pass`**, which *still*
feeds the suggestion engine. One mic, two channels, expressed directly in Cue's primitives (two
`Program`s — one ambient, one scoped — over the same observation stream; `prior-art.md` §1).

**The win condition** is a single high-value flow working end-to-end, hands-free, live, in ~12
minutes: **ambient speech → spoken suggestion (concept pitch + 1–3 spoken multiple-choice
questions) → voice-accept → spawn durable process → voice-steer → spoken result/confirmation** —
then a *minimal* second concurrent process operated independently — then deepen durability, the
model stack, and the room knobs.

---

## 2. Summary

Turn room conversation into running, steerable agent work **without anyone touching a keyboard or
looking at a screen**. Cue is the always-on ear and reflex: it transcribes the room, applies cue
policies (keyword / per-speaker keyword / speaker-changed / idle / interval / word-count), and
decides — mostly `observe.pass`, occasionally an action — whether the room just proposed something
buildable or addressed an existing process. Buildable talk surfaces as a **spoken, conservative**
suggestion (a one-line concept pitch + 1–3 spoken clarifying choices); a spoken "accept" spawns a
durable, forkable **Smithers**-backed process; you steer it by voice and it answers by voice; you
operate a small fleet concurrently and independently. **Cue is the ear and reflex; Smithers is the
durable hands; Fable plans per-process; a cheap fast model (Cerebras/Haiku-tier) runs Cue's hot
decision loop — no Opus in the hot loop.** V0 nails one end-to-end voice flow plus a minimal
multi-process story, with safe defaults, a hard mute, tunable cadence, and a bounded non-voice
emergency stop, so the system stays out of the room's way.

---

## 3. Reconciliation — PROMPT vs. the standing constraints (the load-bearing section)

The PROMPT and the standing constraints genuinely conflict on the *surface*; they agree on the
*architecture*. Resolving this explicitly is the most valuable thing this brainstorm can do,
because every downstream step inherits it.

| PROMPT (visual) | Standing constraint | Resolution (recorded decision) |
|---|---|---|
| React/Vite **spatial board** is the primary surface | Audio-only; user can't see a screen | The board is **optional read-only observability "mission control"** — required by the validation bar for debugging engineers, **never required to operate the product**. All control is voice. |
| **"click → type → Enter → effect"** is the highest-value flow | Voice is the sole modality | New highest-value flow: **speak → Cue decides → spoken confirm/act**. "Enter" becomes a spoken confirm or a dead-man timer; "click to select" becomes a **voice select** (speak the process's magic word). |
| Idea **bubbles** with a **live HTML demo** in a sidebar | No screen; voice out is *sparing* | A suggestion is a **spoken one-line concept pitch + 1–3 spoken MCQs**. The live HTML demo is **deferred** (optional visual bonus on the observability screen only). |
| **Web Speech API** as the V0 ambient mic | Build on Cue | **Out.** V0 ambient mic is **Cue's transcription provider** (Deepgram Nova-3), which is more robust and gives **speaker diarization** for free — strictly an upgrade. |
| Custom STT / turn-taking / input router | Magic words = **Cue cue policies**; `observe.pass` first-class | The §5.4 input pipeline (`identify → select → parse → action`) **is** Cue's loop (`observation → cue policy → Program → LLM picks tool or observe.pass → MappedActionTool → action`). We do not roll our own. |
| **Mobile QR** pairing (scan → page with mic+text) | Audio-only; QR/text are visual | QR pairing **demoted to wishlist**. "Who is talking / multiple operators" is handled by **Cue speaker diarization** (`SpeakerChangedCue`, `speaker` in the observation payload), not per-phone pairing. A phone, if used, is "just another audio input." |
| **G5 "render the right viz"** (web/art/book/data) | No screen | Reinterpreted as **G5′ "speak the right summary"**: the agent *tells* you what it built, sparingly. One first-class output path (spoken summary/confirm) + an optional visual viz on the observability screen as a bonus. |

**Preserved verbatim (modality-agnostic product requirements, §8):** the §5 decomposition; the
**C2/C3** two-channel routing rule; **Smithers** as the durable/forkable/resumable process backend;
**Fable** for per-process planning; cost-fit model tiering (cheap tier in the hot loop, Fable to
orchestrate, **no Opus in the hot loop**); per-process **swappable agent/model** (C8); context
preserved across lifecycle (pre-kill archive, pre-spawn check, C7); the escape/stop affordance
(C5); tunable knobs.

---

## 4. The layered architecture (how the two mandated libraries compose)

Both mandates click into place because they live on **different layers**. Cue's real primitives
are now confirmed from the repo/README (`prior-art.md` §1) — though still pending live exercise per
the validation bar (§6 R-Cue-unvalidated):

```
ROOM AUDIO ─► CUE  (always-on ear + reflex — the meta-session front end)
              • transcriptionProvider (Deepgram Nova-3) → observations {transcript.segment: text,isFinal,speaker}
              • cue policies = the "magic words": TextCue / SpeakerWordCue / SpeakerChangedCue
                / IdleCue / IntervalCue / WordCountCue / SignalThresholdCue   ⇐ §5.4 identify+select
              • Program + cheap/fast llmProvider (Cerebras/Haiku) picks ONE tool or observe.pass
                ⇐ §5.4 parse+select-action;  observe.pass ⇐ C2 "route to nothing"
              • MappedActionTool (cooldownSeconds) emits a structured action ──────┐
              • built-in JSONL trace: observations / decisions / actions          │
                                                                                  ▼
            PANOPTICON ACTION DISPATCHER  (Hono API + WebSocket/SSE)
              • validates Cue action against the live process registry; enforces the C3 invariant
                                                                                  ▼
            SMITHERS  (durable hands — Process Manager + each Process)
              • each Process = a durable, forkable, resumable Smithers run  ⇐ §5.2 / §8
              • Process-Manager verbs (spawn/steer/pause/resume/kill/fork/select) are the tool set
              • per-process planning by FABLE; model calls via Smithers subscriptions (never raw keys)
              • session loop input→pre-hooks→action→post-hooks→output  ⇐ §5.3
              • output: Smithers text event → dispatcher → Cue outputProvider → TTS → room (sparingly)
```

- **Cue = Input Router (§5.4) + Suggestion-Engine trigger (§5.5).** The always-on suggestion
  channel is a Cue program gated by `WordCountCue`/`IntervalCue`/`IdleCue` + a buildable-intent LLM
  check that mostly returns `observe.pass`. Steering is a *separate* program gated behind a
  selection cue (the process magic word) so un-addressed speech can never steer (C3).
- **Smithers = Process Manager + Processes (§5.1–5.3).** Cue's emitted actions dispatch here;
  durability/fork/pause/resume are *real* because each process is a durable run.
- **Fable = per-process planning (§5.11); cheap fast model = Cue's hot loop.** The two libraries'
  division of labor *is* the PROMPT's cost-fit tiering — no Opus in either hot path.

This is the single most important design decision recorded here: **Cue decides *when/whether* to
act (listen → decide → wake); Smithers decides *what* durably happens.** The seam between them — a
structured-JSON action out of Cue, durable-state observations back into Cue to keep voice-out
coherent — is Panopticon's novel contribution and a top integration risk (§6).

---

## 5. Core capabilities a 10/10 version needs

1. **Ambient suggestion that is welcome, not intrusive (the headline — and the hardest thing in
   audio).** Always-on Cue listening → *spoken* buildable-intent suggestions at a **very
   conservative, tunable** cadence, defaulting to `observe.pass`. In audio a wrong suggestion isn't
   a glanceable sidebar card you ignore — it **talks over the room**. Welcome-ness is the whole
   product; intrusiveness kills it faster than silence does (the #1 complaint about Copilot is
   intrusive suggestions, `domain.md` §4).
2. **Hands-free spawn from a spoken proposal → durable process.** A spoken "accept" spawns →
   **auto-selects** → enters `planning`, seeded with the concept pitch + whatever MCQs the room
   answered aloud. Zero ceremony, zero typing.
3. **Fleet operation by voice — concurrent, independently controllable processes (C1/C4).** pause /
   resume / fork / kill / steer one process without touching siblings, each verb a Cue action
   mapped to the Smithers Process Manager. (V0 scope of *how many* is escalated — §7 q-fleet.)
4. **The highest-value steering flow, audio edition: select → speak → confirm → effect.** Speaking
   a process's magic word scopes transcription to it (C3); a spoken **escape/stop** affordance (C5)
   and a dead-man timer handle runaway or **mis-transcribed** prompts — the *normal* failure mode in
   an audio-only product, not an edge case.
5. **Legible, audible two-channel routing (C2/C3).** The room can always *hear* where speech went —
   an earcon or one-word spoken ack distinguishing "fed the idea engine" vs. "steering process X"
   vs. "ignored." Routing that's correct but inaudible breaks trust as badly as a silent screen; in
   audio the only feedback channel is sound.
6. **Spoken output — "tell what it built" (G5′).** The agent volunteers a concise (≤~15-word)
   spoken summary/confirmation, rarely; ~90% of ticks stay silent. Triggered cases only:
   completion, blocker, safety read-back, explicit ask. A visual viz is an optional observability
   bonus, never the deliverable.
7. **Real-time shared meta-session.** One always-on session the whole room shares; Cue's
   `GET /sessions/:id/events` SSE stream is the live spine; any observability screen subscribes to
   it. Shared by construction.
8. **Durable, forkable, resumable processes (Smithers-backed).** pause/resume/fork/replay are
   *real* because each process is a durable run; context preserved across lifecycle — pre-kill
   archives context, pre-spawn checks resources (C7).
9. **A hard, instant mute / "stop listening" — plus a bounded non-voice emergency stop.** A
   first-class spoken command halts the always-on channel immediately; paired with a **physical /
   single-control emergency kill-all** (escalated — §7 q-safety). With real cloud STT on
   continuously, the mute is a *capability*, not a setting — people won't talk freely without it.
10. **Tunable room cadence.** suggestions-per-minute (audio analog of bubbles/min), suggestion TTL,
    per-process safe/dangerous and optimistic/explicit flags — the room dials how much it speaks up.
11. **Swappable agent/model per process behind a clean seam (C8).** Model is a metadata field; an
    agent = container image + model + evolving directive; cost-tiered (cheap fast model in Cue's
    loop, Fable to orchestrate, no Opus hot loop); process model calls via Smithers subscriptions.
12. **Observability for context-free debugging.** Cue records every decision in JSONL traces
    (`observations` / `decisions` / `actions`, including every `observe.pass`); Smithers gives
    run-ids and durable state; OTel GenAI spans → Langfuse for the Smithers side (`prior-art.md`
    §7). Structured, leveled logs with traceable IDs (UPID, Smithers run-id, Cue session-id) so a
    later agent with no context can debug a stuck process — paired with the validation bar (unit AND
    e2e; **validate real Cue + Smithers APIs before building on them**).
13. **Record-replay test harness for the non-deterministic core.** Temperature-0 decision calls,
    every input→output hashed and logged, replay mode returns cached output deterministically — the
    audio-domain analog of snapshot testing, and the only way to satisfy the validation bar over an
    LLM/STT core (`domain.md` §5 Q3, `prior-art.md` §7).

---

## 6. Real risks

- **R-Interruption-asymmetry (highest — new under audio-only).** A spoken suggestion *talks over
  the room*; a visual one doesn't. The cost of a false-positive firing is far higher than the
  PROMPT's "idea diarrhea" implied. Default cadence must be *aggressively* conservative,
  `observe.pass`-first (Cue's own philosophy: "avoid dumb wakeups"). Over-eager voice-out is the
  single most likely way this product becomes unbearable in a real room.
- **R-Mistranscription-blast-radius (raised under audio-only).** The *only* input is transcribed
  speech, so every command rides on STT accuracy (~7.4% WER on technical speech, `domain.md` §5 Q4).
  Spawning autonomous code-writing agents — with git creds, "make a repo" directives, possibly
  *dangerous* mode — from a *misheard* sentence is a real safety hazard. The C5 escape, the dead-man
  timer, voice-confirmation + read-back on destructive acts, and **Safe-by-default** are the
  guardrails — and they matter more here than in the visual spec.
- **R-Cue-unvalidated (P0 gate).** The entire input/suggestion layer rests on Cue. Its API surface
  is now read from the repo/README (cue types, `CueHarness`/`Program`/`MappedActionTool`, provider
  slots, JSONL trace, HTTP routes, MCP control plane — `prior-art.md` §1) **but not yet exercised
  against the running library**. Per the validation bar, prove the real providers, cue-policy
  classes, the observation/action schema, and the routes behave as documented **before** building
  on them. Treat Cue validation as the first build task. **Note a conflict in the evidence:**
  `domain.md` §7 reports the public repo could **not** be confirmed accessible on 2026-06-13, while
  `prior-art.md` §1 documents it as found (63 commits) — so repo *availability* is itself an open
  feasibility blocker, surfaced to the gate below.
- **R-Two-orchestrators-seam.** Cue and Smithers are two independent stateful systems wired together
  (Cue emits actions; Smithers executes durably; Smithers state must flow back to Cue's session as
  observations to keep voice-out coherent). No prior art integrates exactly this (`prior-art.md`
  §8). The seam is novel integration risk — neither library was designed assuming the other.
- **R-Smithers-semantics-mismatch.** The fork/pause/resume mental model may not map 1:1 onto
  Smithers durability (fork may need a fresh seeded run + parentId lineage rather than a native
  `forkRun`; run-events must be faithfully translated into the app/Cue event bus). Validate actual
  subscription / `streamRunEvents` / fork / resume / pause behavior first.
- **R-STT-privacy-cost.** An always-on mic streaming to third-party cloud STT (Deepgram) is a
  privacy and recurring-cost surface the Web-Speech stand-in didn't have. Continuous transcription
  of a room has real consent implications. Mitigations: hard mute (cap. #9), transcript-only
  persistence (no raw audio), the single-room/trusted-users assumption (§7 Q-user), and a documented
  V1 local-STT fallback (VoxTerm / whisper.cpp).
- **R-Suggestion-quality.** Even at the right cadence, *what* rises to a suggestion (buildable
  intent vs. ordinary chatter) is the make-or-break heuristic. A wrong-firing engine reads as broken
  no matter how solid the plumbing. Product question, not a tuning detail (§7 Q-cadence).
- **R-No-fallback-modality.** With voice as the *sole* modality, any failure (STT outage, mute
  stuck, mishear loop) can leave the room with **no way in**. This directly conflicts with the
  research decision that the observability screen stay strictly read-only — the two upstream
  artifacts disagree, so it is **escalated** (§7 q-safety), not silently decided.
- **R-Demo-chain-fragility.** The 12-minute story is a long hands-free happy-path chain (ambient →
  spoken suggestion → voice-accept → spawn → voice-steer → spoken result); any weak link (mishear,
  slow decision loop, awkward voice-out timing) breaks the whole narrative. The build-order
  directive — *one high-value flow over many half-flows* — is the mitigation, and the main argument
  for capping fleet scope in V0 (§7 q-fleet).
- **R-Validation-vs-nondeterminism.** The 10×–100× test bar collides with a core whose key outputs
  (when to fire, what to say) are non-deterministic LLM/STT results. Test the *plumbing and
  contracts* hard (Cue policy wiring, action dispatch, Smithers lifecycle, routing invariants);
  assert *shape/invariants* (not exact text) on the AI surface; lean on Cue's deterministic cue
  policies + JSONL traces and the record-replay harness (cap. #13) as the testable seam.

---

## 7. Open questions (product) — with recommended answers

> Discipline: **product** questions (who it's for, what success is, scope boundaries), each with a
> recommended answer that downstream auto-adopts when a human is unavailable. The first two are
> **genuinely contested forks escalated to the human gate** (the upstream artifacts disagree, or the
> brainstorm itself left them open); the rest are recommended-and-recorded. Pure implementation
> choices are left to the implementer per §3/§8.

### q-safety — Does V0 ship a minimal NON-voice emergency control? **(ESCALATED — artifacts conflict)**
Audio-only is the sole *operational* modality, but if STT fails, the mute sticks, or a mishear loop
starts, the room has **no way in** (R-No-fallback-modality, which the first brainstorm marked
"flagged, not yet decided"). `domain.md` §5-Q1 separately decided the observability screen stays
**strictly read-only** — which directly conflicts with adding any emergency control there.
**Recommended answer:** **Yes — ship a bounded non-voice emergency stop:** a physical hard-mute /
kill-all (keyboard or hardware) plus a single "stop all" control on the observability screen,
clearly scoped as **emergency-only**, never a routine control surface. Voice stays the sole
*operational* modality.
**Why it matters:** Voice-sole control over autonomous code-writing agents that hold git creds,
combined with mistranscription as the *normal* failure mode (R-Mistranscription-blast-radius), makes
"no way to stop it" an unacceptable safety hole. A tiny, clearly-bounded escape hatch is cheap
insurance and doesn't compromise the audio-only thesis — but it's a product/values call between
audio-only purity and operator safety that no evidence can settle, and it overrides a recorded
research decision, so a human should ratify it.

### q-fleet — Is concurrent multi-process operation in V0, or deferred to V1? **(ESCALATED — scope/risk tension)**
The success criterion bakes in "**≥2 concurrent processes operated independently by voice**," yet
the build-order directive says "one high-value flow over many half-flows," and
R-Demo-chain-fragility flags the long hands-free chain as the biggest demo risk.
**Recommended answer:** Keep a **minimal** fleet in V0 — exactly **two** concurrent processes with
independent voice pause/steer — because operating *many* agents hands-free is Panopticon's core
differentiator (G2) and the line between it and a single-agent voice tool (Aider `/voice`). But cap
it hard: two processes, basic independent pause/steer only; defer fork/replay/advanced fleet
controls to V1. Build the single end-to-end loop first and add the second process **last**, so the
demo degrades gracefully to a single-process story if the fleet link proves fragile.
**Why it matters:** Fleet concurrency is the largest single chunk of V0 complexity and the main
demo-fragility risk, and it's the differentiation line. V0-vs-V1 placement materially reshapes
scope, effort, and the success criterion — a scope-boundary call no external evidence settles.

### q-user — Who is the V0 user, and is a screen ever allowed?
**Recommendation:** V0 targets **a small (2–5) trusted technical team in one shared room**,
hands-free. The product is **operable with zero screen and zero keyboard**; a screen may exist
*only* as **optional read-only observability "mission control"** (mandated by the validation bar for
debugging), never as a control surface. One shared meta-session, no auth, no multi-tenant isolation.
**Why it matters:** Resolves the central PROMPT-vs-constraint tension and collapses huge scope
(identity, auth, per-user views). Makes the 12-minute *hands-free* room demo the unambiguous north
star while satisfying the observability bar.

### q-success — What is the single success criterion for V0?
**Recommendation:** A **~12-minute end-to-end voice demo, live and hands-free**: ≥1 ambient
utterance becomes a *spoken* suggestion (pitch + 1–3 spoken MCQs) → voice-accepted → spawns a *real*
durable Smithers process → voice-steered → answers with a spoken summary; the stop word halts a
process immediately; and (per q-fleet) a second process runs concurrently and is steered/paused
independently. No keyboard, no screen required at any step.
**Why it matters:** A crisp, demoable, audio-only acceptance target that forces the *whole loop*
end-to-end (honoring the build-order directive) instead of deep, disconnected half-features.

### q-cadence — How conservative should the suggestion cadence be, given spoken suggestions interrupt?
**Recommendation:** Default **very conservative — at most ~1 spoken suggestion per several minutes**,
gated on a buildable-intent check ("we should build…", "it'd be cool if…") *plus* a confidence
threshold *plus* a `WordCountCue`/`IntervalCue` floor (concrete starting point: ~60 words OR ~90 s
of substantive talk; `domain.md` §5-Q3). Prefer to surface a queued idea **when the room goes idle**
(`IdleCue`) over interrupting mid-conversation. Expose suggestions-per-minute + TTL as live knobs;
start low, tune up only via record-replay against annotated ground truth.
**Why it matters:** In audio, interruption cost is asymmetric (R-Interruption-asymmetry) — the
fastest way to make Panopticon unbearable is to talk over people. Conservative-by-default protects
the demo and matches Cue's "avoid dumb wakeups." Firing policy is product, not a tuning detail.

### q-posture — What is the default execution posture per process? **(refined from the first draft)**
**Recommendation:** Default **Safe + Optimistic** — processes **advance autonomously** without
asking approval at each step, but **read back and require a spoken confirm before destructive /
irreversible actions** (delete, overwrite, force-push); a dead-man timer is **on for
destructive/dangerous actions** so a missed "stop" still aborts. Dangerous mode (confirmation gate
off) and fully-Explicit mode are opt-in voice knobs.
**Why it matters:** This *refines* the first brainstorm's "Explicit + Safe": `domain.md` §5-Q7
showed that approving every step aloud is more exhausting than typing and defeats "steer, don't
micromanage" (G3) — so autonomy is the right default, with the spoken-confirm gate retained exactly
where mistranscription is dangerous (R-Mistranscription-blast-radius). Safe-by-default protects the
room and the operator's machine while preserving the optimistic vision as a deliberate posture.

### q-consent — Consent and trust for an always-on cloud mic?
**Recommendation:** A **clear always-on listening indicator**, a **hard spoken "mute / stop
listening"** that halts the ambient channel instantly (with the physical fallback from q-safety), a
start-of-session **spoken consent announcement**, **transcript-only persistence (never raw audio)**,
and explicit disclosure that audio is streamed to a third-party STT (Deepgram). Rely on the
single-room/trusted-users assumption (q-user) for the rest; document the V1 local-STT fallback.
**Why it matters:** An always-on cloud mic is a trust/adoption blocker — and the free, unguarded
talk it captures is the raw material for the whole product (G1). Cheap, visible controls directly
protect the behavior Panopticon depends on (R-STT-privacy-cost).

### q-seam — Do we adopt Cue's bundled provider stack for V0, and where is the seam to Smithers/Fable?
**Recommendation:** **Yes for V0** — Cue's `transcriptionProvider` = **Deepgram Nova-3** (sub-500ms,
native diarization, ~$0.26–0.46/hr) and a **cheap, fast `llmProvider`** (Cerebras/Haiku-tier) for
Cue's hot *decision* loop. Keep the seam sharp: **Cue decides *when/whether* → emits a structured
action → Panopticon dispatcher validates against the process registry → Smithers executes *what*
durably → Fable plans per-process → all process model calls via Smithers subscriptions (never raw
keys).** No Opus in either hot path. VoxTerm as the offline-dev transcription provider.
**Why it matters:** Names the integration contract between the two mandated systems and binds the
PROMPT's cost-fit tiering to concrete layers. Getting this seam wrong (an expensive model in the
always-on path, or running the orchestrator inside Cue's reflex loop) breaks both P-Latency and
P-Cost-fit and muddies durability. (Architecture/contract, recorded; the cross-system seam is also
the top integration *risk* — R-Two-orchestrators-seam.)

---

## 8. Decisions recorded here (for downstream)

- **North star:** the ~12-minute **hands-free, audio-only** end-to-end flow (q-success); build it
  whole before deepening any part. One high-value flow over many half-flows.
- **Surface:** audio-only is the product; a screen is **optional read-only observability only**,
  never a routine control surface (q-user). Single shared room, one meta-session, trusted users, no
  auth.
- **Architecture seam:** **Cue = ear + reflex** (Input Router §5.4 + Suggestion-Engine trigger §5.5);
  **Smithers = durable hands** (Process Manager + Processes §5.1–5.3); **Fable** plans per-process;
  **cheap fast model in Cue's hot loop, no Opus** (§4, q-seam). The §5 decomposition and C2/C3
  routing are expressed directly in Cue primitives (two `Program`s + `observe.pass`).
- **Suggestion engine:** *very* conservative, `observe.pass`-first, idle-preferring; buildable-intent
  + confidence gate over a ~60-word/~90-s floor; tunable suggestions/min + TTL (q-cadence). A
  suggestion is a **spoken** concept pitch + 1–3 spoken MCQs; live HTML demo deferred.
- **Selection/steering:** speaking a process's **magic word** scopes speech to it (C3); window closes
  on ~20-s idle, an explicit end word, or the panic word; un-addressed speech only feeds suggestions.
  Audible routing acks (cap. #5). The C3 "select-first" invariant is enforced **at dispatch**, not in
  the LLM.
- **Output:** **spoken summary**, volunteered sparingly (~90% ticks silent); visual viz optional (G5′).
- **Safety / posture:** default **Safe + Optimistic** — autonomous, with spoken confirm + read-back
  on destructive acts and a dead-man timer on dangerous actions; dangerous/explicit opt-in
  (q-posture). Plus the bounded **non-voice emergency stop** pending the q-safety gate.
- **Multi-speaker:** Cue/Deepgram **diarization** for who-said-what; mobile QR pairing demoted to
  wishlist (per §3).
- **Autonomy:** processes advance on their own; voice steering only *redirects* (cap. #6, G3).
- **Trust:** listening indicator + **hard spoken mute**; transcript-only persistence; STT is
  third-party cloud, disclosed (q-consent).
- **Stack:** Cue providers (Deepgram + cheap/fast LLM; VoxTerm offline) for V0; process calls via
  Smithers subscriptions; Fable per-process (q-seam). Langfuse + Cue JSONL for observability.
- **Determinism / test harness:** temperature-0 decision calls + input/output hashing + replay mode
  (cap. #13); test plumbing/contracts/invariants hard, assert shape (not exact text) on AI surfaces.
- **Validate-before-build flags (carry into research/probes, P0):**
  1. **Cue** — exercise the real `transcriptionProvider`/`llmProvider`/`outputProvider`, the
     cue-policy classes, the observation + action schema, `CueHarness`/`Program`/`MappedActionTool`,
     the JSONL traces, and the HTTP routes against the actual library (R-Cue-unvalidated). **First
     confirm repo availability** — the two research files disagree on it.
  2. **Smithers** — subscription harness + `streamRunEvents` + fork / resume / pause semantics
     (R-Smithers-semantics-mismatch).
  3. **The Cue↔Smithers seam** — action dispatch out of Cue and durable-state observations back into
     Cue (R-Two-orchestrators-seam).
- **Non-negotiables carried forward:** the §5 decomposition, C2/C3 two-channel routing, all process
  model calls through Smithers subscriptions, cost-fit tiering (no Opus hot loop), per-process
  swappable agent+model (C8), app workflows in `src/` vs dev workflows in `.smithers/` (never mixed),
  and the validation bar (unit AND e2e; validate real Cue + Smithers before building).
- **Explicitly retired by the standing constraints:** the React/Vite board as the *primary* surface,
  `click → type → Enter` as the highest-value flow, the visual idea-bubble sidebar with live HTML
  demos, iframe visualizers as the deliverable, mobile QR/text pages, and the Web Speech API.

---

## 9. Surfaced blocker (for the orchestrator's gate)

**Cue repository availability is unconfirmed and the evidence disagrees.** `domain.md` §7 reports no
public `github.com/jameslbarnes/cue` repo could be confirmed on 2026-06-13; `prior-art.md` §1
documents the repo's API as if found. Cue is the mandated, load-bearing foundation for the *entire*
input / suggestion / routing layer and a P0 validate-before-build gate (R-Cue-unvalidated). Before
implementation: **confirm access and run a live probe against Cue's real API** (observation schema,
cue-policy constructors, `Program`/`CueHarness`/`MappedActionTool`, provider interfaces, HTTP
routes). This is an availability/feasibility blocker, not a product question — surfaced here for the
gate, not kept as a clarifying question.
