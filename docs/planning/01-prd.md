# Panopticon — Product Requirements Document (V0)

> **Audio-only operating system for AI-agent work.** A small trusted team talks in a shared
> room; Panopticon passively listens, sparingly proposes things to build, and — on a spoken
> "yes" — spawns durable agent "processes" the room can steer by voice and operate alongside
> one another. **Voice is the sole interaction modality.**
>
> Altitude: this document states **end-user requirements only** — what the product must do for
> the people in the room, the measurable bar for "done," and the tests that prove it. It does
> **not** prescribe implementation. Where a third-party dependency is named, it is named because
> it constrains the user-visible behavior and **must be validated against the real API before any
> code is built on it** (see §6).
>
> Upstream inputs: `artifacts/smithering/brainstorm.md`, `artifacts/smithering/research/domain.md`,
> `artifacts/smithering/research/prior-art.md`, `artifacts/smithering/intake.md`,
> `artifacts/smithering/clarifying-questions.md`. Binding human decisions are recorded in §2.

---

## 1. The problem (why this exists)

Building software with AI still means **commanding a computer**: you stop talking, look at a
screen, type a precise instruction, wait, and babysit one agent at a time. That friction kills
the most valuable mode — **building while you talk** — and the interrupt tax is measurable, not
rhetorical:

- A programming interruption costs **~23 minutes** of recovery; interrupted tasks take **~2×
  longer** with **~2× the errors**; context-switching burns **6+ hours/week**
  (`research/domain.md` §1).
- **85%** of developers already use AI coding tools and **70%** juggle **2–4 at once**
  (`domain.md` §1). They are *already* multi-agent operators — but every shipping tool
  (Cursor, Copilot, Devin/OpenHands, even Aider `/voice`) is **reactive, keyboard-mediated, and
  single-agent at a time**. None are ambient; none watch a continuous stream and decide on their
  own whether something is worth acting on; none let a room operate a fleet hands-free
  (`domain.md` §2–3, `prior-art.md` §8 — gap confirmed).

So the bottleneck has moved. It is no longer "can a model do the work." It is: **can a room of
humans express intent and operate many agents at once, hands-free, without drowning in command
overhead or being talked over by their own tools.**

**Panopticon's bet:** the missing interface is *ambient and audio-only*. The room talks; the
system listens through **Cue** (continuous audio → transcript observations → cue policies →
decide-or-`observe.pass`); when the room accepts a spoken proposal, Panopticon spawns a durable,
steerable agent process. Because there is no screen on the critical path, "render the right
thing" becomes **"tell the right thing"** — a process's output is a *spoken* summary it volunteers
rarely (~90% of ticks are silent), never a rendered demo.

**The single hardest thing — and the thing this product lives or dies on — is restraint.** In
audio, a wrong suggestion does not sit ignorable in a sidebar; it **talks over the room**. The
cost of a false positive is asymmetric and high (the #1 complaint about Copilot is intrusive
suggestions, `domain.md` §4). Under-speaking is recoverable; over-speaking makes the product
unbearable. Every requirement below is shaped by that asymmetry.

**What success looks like (the north star):** a **~12-minute, live, fully hands-free** demo in
which ambient room talk becomes a spoken suggestion → is voice-accepted → spawns a *real* durable
process → is voice-steered → answers with a spoken summary; a spoken stop word halts a process
instantly; and a second process runs concurrently and is steered independently — **with no one
touching a keyboard, mouse, or screen at any step.**

---

## 2. Binding decisions (human-ratified — these govern this PRD)

These were decided by a human and are **binding**. Where they conflict with upstream
recommendations, they win.

- **D1 — Audio is the sole required modality** (q1). Every interaction loop is audio. A visual
  surface is permitted **only** if it costs near-zero, is **non-authoritative**, and is **never on
  the critical path**. Build and test the whole flow **as if no screen exists**.
- **D2 — Build on confirmed Cue primitives first** (q2). Cue is the substrate for agent
  interaction and command-triggering. Any extension we need lives in a **thin adapter layer we
  own**, so Cue gaps never block us. **Every place we must extend Cue is recorded as a risk.**
- **D3 — Ship a small, fixed, documented set of magic words** for the highest-value commands in
  V0 (q3): deterministic and testable. Agent-mediated natural-language commands are a **fast-follow,
  not a V0 requirement**.
- **D4 — Real-time streaming ASR + low-latency TTS pair** from the 2026 benchmark set (q4),
  targeting **sub-second round-trip for command acknowledgement**, with the provider **abstracted
  behind an interface**.
- **D5 — One canonical voice flow is the spine of V0** (q5): **wake/magic word → spoken intent →
  Cue agent action → spoken confirmation.** Everything that does not serve that loop is deferred.
- **D6 — Hybrid audio output** (q6): short **earcons** for state transitions and acknowledgements
  (fast, low-friction) **plus TTS** for substantive agent output; narration stays terse.

**Recorded reconciliations** (from upstream escalations, adopted consistent with the binding
decisions above):

- **Fleet scope** (`clarifying-questions.md` q-fleet-scope-v0): D5 makes the *single* canonical
  loop the spine. A **minimal 2-process concurrent fleet** is retained as the product's
  differentiator (REQ-13) but is **built last and must degrade gracefully to a single-process
  story** — it does not block the spine.
- **Non-voice emergency stop** (`clarifying-questions.md` q-safety-fallback): a **bounded,
  emergency-only** non-voice kill-all is included (REQ-14). It is an off-path safety hatch, not an
  operational control, so it does **not** violate D1's "never on the critical path."
- **Execution posture** (`domain.md` §5-Q7, brainstorm q-posture): **Safe + Optimistic**
  (REQ-11). The earlier "Explicit + Safe" note in `clarifying-questions.md` is **superseded** —
  approving every step aloud is more exhausting than typing and defeats voice-only operation.

---

## 3. Personas & scope of use

- **The room (primary user):** a small (**2–5**) trusted, co-located **technical team** sharing
  one physical space and one always-on meta-session. No auth, no multi-tenant isolation, no
  per-user identity beyond speaker diarization labels (`domain.md` §5-Q1/Q8).
- **The debugging engineer (secondary):** consults an **optional, read-only** observability
  surface to debug a stuck process. Never required to operate the product.
- **Operable with zero screen and zero keyboard.** A blind user, or a room with no display, can
  run the entire flow by voice alone.

---

## 4. Requirements

> Convention: each requirement has a stable id, a one-line statement, **measurable acceptance
> criteria** ("done means these checks pass"), a **Verification** block enumerating *both*
> unit/integration **and** end-to-end tests (it is an AND — either layer alone should leave us
> fairly confident), the **third-party APIs** it depends on (each requiring a real-API probe per
> §6), and the **observability** it must emit. Every listed test **must be able to fail** —
> red-before-green evidence is required; "the agent said it works" is never evidence.
>
> Test-volume expectation per the validation bar: **10×–100× more verification than a human would
> normally write** — the criteria below are the *floor*, not the ceiling. Each requirement's
> verification must additionally cover corner cases, error paths, and boundary conditions
> (empty/longest inputs, silence, simultaneous speakers, mis-transcription) even where not spelled
> out individually.

### REQ-1 — Always-on, legible, consentful ambient listening
**Statement:** The system continuously listens to the room and transcribes speech, with listening
made obvious and consentful.
**Acceptance criteria:**
- AC1.1 On session start the system emits a **spoken consent announcement** ("Panopticon is
  listening. Say '<mute word>' to stop. Only transcripts are saved.") within 3 s of start.
- AC1.2 A **persistent always-on listening indicator** is active whenever the mic is streaming
  (audible/earcon cue is authoritative; a visual badge is optional per D1).
- AC1.3 **Transcript-only persistence:** no raw audio is written to disk or logs at any point. A
  filesystem/log scan after a session finds **zero** audio artifacts.
- AC1.4 Each finalized utterance becomes a transcript observation carrying at least `{text,
  isFinal, speaker}` and a traceable session id.
**Verification:**
- *Unit/integration:* transcript-observation mapper produces `{text,isFinal,speaker}` from
  provider frames; consent-announcement scheduler fires once per session and is idempotent;
  **persistence guard test** asserts the audio buffer is never handed to any writer (mock the
  writer, assert never-called) — must fail if a raw-audio write path is introduced.
- *E2e:* feed a recorded room session through the live pipeline; assert the consent line is spoken
  first, the listening indicator is active for the whole session, and a post-run disk/log scan
  finds **no** audio files (test fails if a `.wav`/`.pcm`/raw blob appears).
- *Third-party:* streaming ASR (D4) — see §6 probe P-ASR.
- *Observability:* structured log line per session start (`session.start`, session id, provider,
  consent-spoken=true); one observation trace row per finalized segment.

### REQ-2 — Hard spoken mute ("stop listening") that always wins
**Statement:** A spoken mute command instantly and verifiably halts all listening/streaming.
**Acceptance criteria:**
- AC2.1 Speaking the mute word stops audio streaming to the ASR provider within **500 ms**.
- AC2.2 Mute **pre-empts every other cue** — if the mute word and any other trigger co-occur in an
  utterance, mute wins.
- AC2.3 While muted, **no** observations are produced and **no** suggestions or actions fire.
- AC2.4 The mute state is announced (earcon + one-word TTS) and reflected in the listening
  indicator.
**Verification:**
- *Unit/integration:* cue-priority test proves the mute cue out-ranks suggestion/select/global
  cues on a co-occurring utterance; state-machine test proves no observation is emitted in the
  muted state; latency unit test asserts stop signal ≤500 ms from mute detection (mocked clock).
- *E2e:* live session — speak the mute word; assert streaming stops ≤500 ms (measured), the
  indicator flips, and subsequent speech produces zero observations/actions until unmuted.
- *Observability:* `mute.engaged`/`mute.released` log lines with timestamps and the triggering
  utterance id.

### REQ-3 — Conservative ambient suggestion engine (`observe.pass`-first)
**Statement:** Buildable intent overheard in ordinary conversation surfaces as a **spoken,
conservative** suggestion; the overwhelming default is to stay silent.
**Acceptance criteria:**
- AC3.1 A suggestion is gated behind a floor of **≥60 words OR ≥90 s** of substantive talk **and**
  a buildable-intent + confidence check; below the floor the engine **must** `observe.pass`.
- AC3.2 Default cadence ≤ **1 spoken suggestion per 3 minutes** of conversation; the engine
  **prefers to surface a queued idea on room idle** rather than interrupt mid-conversation.
- AC3.3 A suggestion is delivered as a **spoken one-line concept pitch + 1–3 spoken
  multiple-choice questions** (never >3), answerable aloud.
- AC3.4 On a fixed annotated replay set, the engine fires on **≥80%** of ground-truth "should
  suggest" segments and produces **≤1 false-positive per 10 minutes** of "should pass" audio.
- AC3.5 Cadence and TTL are **live-tunable knobs** without restart.
**Verification:**
- *Unit/integration:* gate-threshold tests (59 words → pass, 61 words → eligible; 89 s → pass,
  91 s → eligible); MCQ-count invariant (never emits >3 questions); knob-patch test changes
  cadence at runtime; **boundary/fuzz:** empty transcript, single-word utterances, 10k-word
  monologue, all-silence → all resolve to `observe.pass`.
- *E2e:* run the annotated replay suite (record-replay harness, temperature-0 decision calls);
  assert the recall/false-positive bar in AC3.4 against ground truth; assert idle-preference (a
  queued suggestion is held until an idle gap, not spoken over active talk).
- *Third-party:* Cue cue-policies + cheap/fast decision LLM — see §6 probes P-CUE, P-LLM.
- *Observability:* every decision (fire **and** every `observe.pass`) recorded with policy name,
  gate values (word count/elapsed), confidence, and decision id.

### REQ-4 — Hands-free spawn from a spoken acceptance → durable process
**Statement:** A spoken acceptance of a suggestion spawns a durable agent process with zero typing
or clicking.
**Acceptance criteria:**
- AC4.1 A spoken "yes/accept" spawns a process, **auto-selects** it, and enters a planning state,
  seeded with the concept pitch + any MCQ answers given aloud.
- AC4.2 A **spoken confirmation** (earcon + ≤15-word TTS) acknowledges the spawn, including the
  process's magic word/callsign.
- AC4.3 Spawn-to-spoken-confirmation completes within **3 s** under nominal conditions.
- AC4.4 A declined/ignored suggestion spawns **nothing** and leaves no process registry change.
**Verification:**
- *Unit/integration:* acceptance-intent classifier maps "yes/accept/do it" → spawn and
  "no/nah/skip" → no-op; seeding test asserts pitch + MCQ answers are attached to the new process;
  registry test asserts exactly one process added on accept, zero on decline.
- *E2e:* live — suggestion fires → speak "accept" → assert a real durable process exists, is
  selected, is in planning, and a spoken confirmation naming its callsign is heard within 3 s.
- *Third-party:* Smithers durable run lifecycle — see §6 probe P-SMITHERS.
- *Observability:* `process.spawn` log with UPID, Smithers run-id, seed payload hash, and the
  originating suggestion/decision id (full causal chain).

### REQ-5 — The canonical voice loop is the spine
**Statement:** The end-to-end loop **wake/magic word → spoken intent → agent action → spoken
confirmation** works reliably, hands-free, as the product's backbone (D5).
**Acceptance criteria:**
- AC5.1 The full loop completes hands-free with **no keyboard/mouse/screen** input at any step.
- AC5.2 The loop succeeds end-to-end on **≥9 of 10** scripted live runs (the 12-minute demo
  scenario), with each failure attributable to a logged, identifiable cause.
- AC5.3 Every stage transition is **audibly legible** (earcon or one-word ack) so the room always
  knows which stage it is in.
- AC5.4 The loop is the integration spine: a single automated scenario test exercises all four
  stages in sequence.
**Verification:**
- *Unit/integration:* a stage-sequencer test drives the four-stage state machine through the happy
  path and each single-stage failure (mis-heard wake, empty intent, action error, TTS failure),
  asserting correct recovery/ack at each boundary.
- *E2e:* the **canonical scenario test** — scripted audio drives wake→intent→action→confirm
  against the live stack and asserts the spoken confirmation reflects the intent; run ≥10×, assert
  ≥9 pass (AC5.2); a "no-screen" harness asserts zero GUI/keyboard events were consumed (AC5.1).
- *Third-party:* Cue + ASR + TTS + Smithers (all of §6).
- *Observability:* one correlation id threads the whole loop (wake id → intent id → action id →
  confirmation id); a single trace query reconstructs the full loop.

### REQ-6 — Two-channel routing (C2/C3) with audible routing acks
**Statement:** Ambient speech feeds **suggestions only**; steering an existing process requires
**magic-word selection first**; every utterance routes to **exactly one** target or to
`observe.pass`, and the room can always **hear** where it went.
**Acceptance criteria:**
- AC6.1 An utterance that does **not** contain a process magic word can **never** steer a process
  (enforced at dispatch, not by the LLM).
- AC6.2 Speaking a process's magic word opens a **steering window** scoped to that process;
  subsequent speech routes to it until the window closes.
- AC6.3 The window closes on **~20 s idle**, an explicit end word, or the panic word.
- AC6.4 Each routed utterance produces a distinct **audible ack** distinguishing: fed-the-idea-
  engine vs. steering-process-X vs. ignored (`observe.pass`).
- AC6.5 "One-breath" select-and-steer ("Atlas, make the header blue") routes correctly in a single
  utterance.
**Verification:**
- *Unit/integration:* **dispatch invariant test** — a steering verb with no selected target and no
  in-utterance magic word is rejected (must fail if the guard is removed); window lifecycle test
  (open on magic word, close on 20 s idle / end word / panic); routing-exclusivity test (each
  utterance → exactly one of {suggestion, steer:X, pass}).
- *E2e:* live multi-utterance script — un-addressed talk only ever feeds suggestions (never
  steers); magic-word + instruction steers the right process; distinct earcons are emitted per
  route; one-breath select-and-steer works.
- *Third-party:* Cue cue-policies / two-Program routing — see §6 probe P-CUE.
- *Observability:* per-utterance routing decision recorded with `{utteranceId, route,
  targetUPID|null, ackKind}`.

### REQ-7 — Fixed, documented magic-word command vocabulary (deterministic)
**Statement:** V0 ships a **small, fixed, documented** set of magic words / commands for the
highest-value actions; they are deterministic and testable (D3).
**Acceptance criteria:**
- AC7.1 The command set is enumerated in product docs and includes at minimum: select/callsign per
  process, accept, stop/panic, mute, and global "pause all"/"status".
- AC7.2 Process callsigns are **phonetically distinct** and **accident-resistant** (no two active
  callsigns within a small edit/phonetic distance; not common conversational words).
- AC7.3 Command recognition is **deterministic** for the fixed set: the same transcript yields the
  same routing decision every time (record-replay confirms).
- AC7.4 Natural-language/agent-mediated commands are **explicitly out of V0 scope** (see §5).
**Verification:**
- *Unit/integration:* vocabulary table test (every documented command maps to exactly one
  handler); **collision test** rejects a callsign within the distance threshold of an existing one;
  determinism test replays the same transcript N× and asserts identical decisions.
- *E2e:* live — each documented command produces its documented effect; an undocumented phrase
  produces no command (falls to suggestion/pass); a near-homophone of a callsign in casual speech
  does **not** mis-trigger selection.
- *Observability:* command-recognition log with `{phrase, matchedCommand|null, distanceScore}`.

### REQ-8 — Voice steering of a selected process
**Statement:** A selected process can be redirected by spoken instruction, with the effect
reflected back by voice.
**Acceptance criteria:**
- AC8.1 After selection, a spoken instruction is delivered to that process and changes its
  behavior/output (the redirect is observable in the process's next spoken summary or state).
- AC8.2 Steering one process **never** affects a sibling process.
- AC8.3 A mis-transcribed/unintelligible steering instruction is **not** silently applied — it is
  either re-prompted or dropped with an audible ack (never executed as a destructive action; see
  REQ-11).
**Verification:**
- *Unit/integration:* steer-dispatch test routes the instruction to the selected UPID only;
  isolation test mutates process A and asserts process B's state is byte-for-byte unchanged;
  low-confidence-instruction test routes to re-prompt, not execute.
- *E2e:* live — select Atlas, steer it, observe the change in its spoken/recorded output; confirm
  a concurrently-running Bravo is unaffected.
- *Third-party:* Smithers steer/signal semantics — see §6 probe P-SMITHERS.
- *Observability:* `process.steer` log with `{targetUPID, instructionId, accepted|reprompted|
  dropped}`.

### REQ-9 — Rationed spoken output (hybrid earcons + TTS)
**Statement:** Processes speak **rarely** and **tersely**; routine state uses earcons, substantive
output uses short TTS (D6).
**Acceptance criteria:**
- AC9.1 **~90% of process ticks are silent** (no TTS). Over a representative session, measured
  TTS-bearing ticks ≤ **10%**.
- AC9.2 A process speaks substantive TTS **only** on: completion, blocker/decision needed, safety
  read-back, or explicit ask.
- AC9.3 Substantive spoken utterances are **≤15 words**; longer content is summarized, not recited
  (file names, diffs, URLs are never read aloud).
- AC9.4 State transitions and acks use **earcons**, not sentences.
**Verification:**
- *Unit/integration:* output-policy test maps each trigger class → {silent | earcon | TTS};
  length guard truncates/summarizes any TTS candidate >15 words; "never recite" test asserts
  file/diff/URL payloads are not emitted to TTS.
- *E2e:* run a representative session, count TTS-bearing ticks / total ticks, assert ≤10% (AC9.1);
  assert every TTS utterance falls in an allowed trigger class and is ≤15 words.
- *Third-party:* low-latency TTS provider — see §6 probe P-TTS.
- *Observability:* per-tick `output.decision` log `{tickId, class, channel:
  silent|earcon|tts, wordCount}`.

### REQ-10 — Sub-second command acknowledgement (latency)
**Statement:** The room perceives the system as responsive: a spoken command is **acknowledged**
audibly within sub-second time (D4).
**Acceptance criteria:**
- AC10.1 **Earcon acknowledgement** of a recognized command is emitted within **300 ms** of the
  command being finalized.
- AC10.2 End-to-end **command round-trip** (final transcript → acknowledgement) is **< 1 s** at
  p50 and **< 1.5 s** at p95 under nominal load.
- AC10.3 If the round-trip budget is exceeded, the system emits a "working on it" earcon rather
  than going silent.
**Verification:**
- *Unit/integration:* latency-budget unit tests with mocked provider timings assert the
  acknowledgement scheduler fires within budget; timeout path test emits the "working" earcon when
  the budget is blown.
- *E2e:* **latency benchmark** over ≥100 live command round-trips; assert p50 <1 s, p95 <1.5 s,
  earcon <300 ms; benchmark output is recorded as a regression baseline (must fail if a future
  build regresses past threshold).
- *Third-party:* ASR + TTS streaming latency — see §6 probes P-ASR, P-TTS (latency assertions are
  part of the probe).
- *Observability:* per-command latency spans (`asr.final`, `decision`, `ack.emit`) with measured
  millisecond deltas.

### REQ-11 — Safe-by-default execution posture (confirm + read-back on destructive acts)
**Statement:** Processes advance autonomously (optimistic) but **read back and require a spoken
confirmation before destructive/irreversible actions**, with a dead-man timer guarding dangerous
acts.
**Acceptance criteria:**
- AC11.1 In the default posture, a process runs to completion without per-step approval.
- AC11.2 Before any **destructive/irreversible** action (delete, overwrite, force-push), the
  process **speaks a read-back** and waits for an explicit spoken **"confirm"**; absent
  confirmation, the action does **not** execute.
- AC11.3 A **dead-man timer** (20–30 s) is armed on destructive/dangerous actions: a missed/mis-
  heard "stop" still results in **abort**, not execution.
- AC11.4 "Dangerous" mode (confirmation gate off) and fully-"explicit" mode are **opt-in** by
  voice and are off by default.
**Verification:**
- *Unit/integration:* posture state-machine test — destructive verb in Safe mode → read-back +
  wait; no "confirm" within timer → abort (must fail if the action fires without confirmation);
  Dangerous mode bypasses the gate only when explicitly enabled; **error-path/fuzz:** garbled
  confirmation tokens, "confirm" addressed to the wrong process, double-confirm → all resolve
  safely (never double-execute).
- *E2e:* live — instruct a process toward a destructive act; assert it reads back and blocks;
  withholding "confirm" aborts after the timer; speaking "confirm" proceeds exactly once.
- *Observability:* `safety.readback` and `safety.resolution` logs with `{action, confirmed|
  aborted|timedout, timerMs}`.

### REQ-12 — Panic / stop word that always wins
**Statement:** A spoken stop word immediately halts the targeted (or current) process and always
takes priority.
**Acceptance criteria:**
- AC12.1 The stop word halts the in-focus process within **1 s** of being spoken.
- AC12.2 The stop word **out-prioritizes** all other cues except hard-mute (REQ-2), even
  mid-action where the action is interruptible.
- AC12.3 The halt is acknowledged audibly (earcon + ≤15-word TTS).
**Verification:**
- *Unit/integration:* priority test (stop > select/steer/suggest; mute > stop); halt-dispatch test
  transitions the target to a stopped state; interruptible-action test cancels an in-flight
  cancellable action.
- *E2e:* live — start a process working, speak the stop word, assert it halts ≤1 s and acks; assert
  siblings keep running (REQ-8 isolation holds under panic).
- *Observability:* `process.halt` log `{targetUPID, trigger: panic, latencyMs}`.

### REQ-13 — Minimal concurrent fleet (the differentiator; built last, degrades gracefully)
**Statement:** The room can operate **two** processes concurrently, each independently selectable
and pausable/steerable by voice — and the system **degrades to a single-process story** if the
fleet link is unavailable.
**Acceptance criteria:**
- AC13.1 Two processes run concurrently; selecting/steering/pausing one **does not** affect the
  other (extends REQ-8 isolation to concurrent operation).
- AC13.2 Each process has a **distinct, non-colliding** callsign (REQ-7) and routes correctly with
  no cross-talk.
- AC13.3 An **unselected** process keeps running autonomously ("unselected" ≠ "paused").
- AC13.4 If concurrent operation fails or is disabled, the **single-process canonical loop
  (REQ-5) still passes** — fleet is additive, never a dependency of the spine.
**Verification:**
- *Unit/integration:* concurrent-registry test (two live processes, independent state); routing
  test (interleaved utterances to A and B route correctly); degradation test — disable the fleet
  path and assert REQ-5's scenario test still passes.
- *E2e:* live — spawn two processes, steer A, pause B, confirm A advanced and B paused
  independently; leave both unselected for a fixed interval and confirm both made progress
  (AC13.3).
- *Third-party:* Smithers concurrent durable runs — see §6 probe P-SMITHERS.
- *Observability:* fleet snapshot log enumerating all UPIDs, states, and last-action per process.

### REQ-14 — Bounded non-voice emergency stop (emergency-only)
**Statement:** A single non-voice control can **kill all** processes and stop listening, for the
failure case where voice is unavailable (STT outage, stuck mute, mis-hear loop).
**Acceptance criteria:**
- AC14.1 A single physical/keyboard/one-control action stops all streaming and halts all processes
  within **2 s**.
- AC14.2 It is **clearly scoped as emergency-only** — it is **not** a routine control surface and
  does not provide steering, selection, or any operational verb (preserving D1: voice is the sole
  *operational* modality).
- AC14.3 Triggering it is loud and unambiguous (audible +, if a display exists, visible).
**Verification:**
- *Unit/integration:* emergency-stop handler test halts every registered process and the listener;
  scope test asserts the control exposes **only** kill-all (no steer/select/spawn).
- *E2e:* with several processes running, trigger the emergency control; assert all processes halt
  and listening stops ≤2 s, with an unambiguous signal.
- *Observability:* `emergency.stop` log `{trigger: non-voice, processesHalted, latencyMs}`.

### REQ-15 — Durable processes (persist, keep running, survive restart)
**Statement:** A spawned process is **durable**: it keeps making progress when unselected and its
state survives a process/host restart.
**Acceptance criteria:**
- AC15.1 A spawned process continues advancing while the room is silent / it is unselected.
- AC15.2 Context is preserved across lifecycle: **pre-kill archive** of context and **pre-spawn
  resource check** occur (C7).
- AC15.3 After a backend restart, an in-flight process is **recoverable** to its last durable
  state (no silent loss of work).
**Verification:**
- *Unit/integration:* lifecycle test (planning → active ⇄ paused → dead) with state assertions at
  each edge; pre-kill archive test asserts context is persisted before teardown; recovery test
  reloads durable state and asserts equality to pre-restart snapshot.
- *E2e:* spawn a process, kill the backend mid-run, restart, and assert the process resumes from
  its last durable checkpoint (work not lost).
- *Third-party:* Smithers durability/resume/`streamRunEvents` — see §6 probe P-SMITHERS.
- *Observability:* durable checkpoint log with run-id, sequence, and state digest per checkpoint.

### REQ-16 — Read-only observability surface + structured tracing (debug-only, off the critical path)
**Statement:** A later engineer with **no context** can debug a stuck process from traces alone; an
**optional, read-only** visual board reflects live state but is never required to operate the
product.
**Acceptance criteria:**
- AC16.1 Every decision (including every `observe.pass`), action, routing choice, and process
  state transition is recorded with a **traceable id** (Cue session id, UPID, Smithers run-id) and
  is queryable after the fact.
- AC16.2 The optional board is **strictly read-only** (no operational control) and **non-
  authoritative**: with the board closed, every requirement above still passes (D1).
- AC16.3 From traces alone (no live system), an engineer can reconstruct, for any given utterance,
  the full chain: observation → decision → action → outcome.
**Verification:**
- *Unit/integration:* trace-schema test asserts required ids/fields on every record; "board is
  read-only" test asserts the board exposes no mutating endpoint/handler; **causal-chain
  reconstruction test** rebuilds an utterance's full chain purely from recorded traces.
- *E2e:* run a session, then — using **only** the persisted traces — programmatically reconstruct
  the canonical loop's chain and assert it matches the live run; run the full REQ-5 scenario with
  the board disabled and assert it still passes.
- *Observability:* this requirement *is* the observability contract — leveled, structured logs with
  meaningful messages and stable ids across Cue, the dispatcher, and Smithers.

---

## 5. Non-goals (scope boundary — additions require amending this document)

Adding any of these to V0 scope requires an explicit amendment to this PRD.

- **NG-1 — No GUI/CLI as an operational surface.** No click/type/touch/drag/scroll control path.
  The only visual surface is the optional read-only board (REQ-16).
- **NG-2 — No agent-mediated natural-language command parsing in V0.** Commands are the fixed magic-
  word set (REQ-7/D3); free-form NL command understanding is a fast-follow.
- **NG-3 — No fleet beyond two concurrent processes**, and no fork/replay/advanced fleet controls
  in V0 (deferred to V1). REQ-13 caps V0 at two.
- **NG-4 — No multi-tenant / auth / per-user identity.** Single shared room, trusted users, one
  meta-session; speaker labels come from diarization, not accounts (`domain.md` §5-Q1/Q8).
- **NG-5 — No per-user phone pairing / QR mic onboarding.** Multi-speaker handling is diarization
  only; a phone, if used, is "just another audio input."
- **NG-6 — No raw-audio persistence.** Transcript-only (REQ-1); raw audio is never stored.
- **NG-7 — No visual "live HTML demo" as part of the product.** A suggestion's "demo" is the spoken
  pitch + spoken MCQs; any HTML demo strip is an optional observability bonus only.
- **NG-8 — No on-device/local STT requirement in V0.** Hosted streaming providers are the V0
  default; local inference (whisper.cpp etc.) is a documented V1 fallback only.
- **NG-9 — No Opus (or other premium model) in the always-on hot decision loop.** Cost-fit tiering:
  cheap/fast model in Cue's loop; richer planning per-process only.
- **NG-10 — No general continuous narration.** Spoken output stays rationed (REQ-9); "status
  dashboards read aloud" are out.

---

## 6. Dependencies & validate-before-build gates (third-party APIs)

Per the validation bar, **every non-framework third-party dependency must be exercised against the
real API with a probe/PoC that asserts the exact behavior we rely on, before any product code is
built on it.** A probe that *could* fail and *passed* is the evidence; docs and memory are not.
React/standard libraries are exempt.

- **P-CUE (P0, blocking) — Cue** (`github.com/jameslbarnes/cue`). Probe must exercise, against the
  **real** library: the transcription/LLM/output provider slots; the cue-policy classes
  (`TextCue`/`SpeakerWordCue`/`SpeakerChangedCue`/`IdleCue`/`IntervalCue`/`WordCountCue`); the
  **observation + action schema**; `CueHarness`/`Program`/`MappedActionTool` (incl.
  `cooldownSeconds`); `observe.pass`; the JSONL trace files; and the HTTP/SSE routes. Per **D2**,
  build only on **confirmed** primitives; record any required extension in our thin adapter layer
  as a risk.
  - **⚠ Open blocker:** the upstream artifacts **disagree on whether the Cue repo is publicly
    accessible** — `domain.md` §7 could not confirm the repo on 2026-06-13, while `prior-art.md` §1
    documents its API as found (63 commits). **Confirming repo access and running P-CUE is the
    first build task.** If the repo is unavailable or its API differs from the README-derived
    assumptions, this PRD's input/suggestion/routing requirements (REQ-1, 3, 5, 6, 7) must be
    revised. *(Surfaced to the orchestrator's gate; see structured-output blockers.)*
- **P-ASR (P0) — streaming ASR** (D4; candidate: Deepgram Nova-3, the top streaming option in
  `domain.md` §5-Q4). Probe asserts: word/segment observations, `isFinal` flag shape, speaker
  diarization labels, and **measured streaming latency** against our budget (REQ-10). Provider sits
  behind an interface (D4) so it is swappable.
- **P-TTS (P0) — low-latency streaming TTS** (D4/D6). Probe asserts streaming start latency within
  REQ-10's budget and the output-provider contract. **Honest gap:** the research benchmarked ASR,
  **not** TTS — so the specific TTS provider is **unverified** and the probe is also a selection
  benchmark across the 2026 low-latency TTS candidates. Provider sits behind the same interface.
- **P-LLM (P0) — cheap/fast decision LLM** for Cue's hot loop (Cerebras/Haiku-tier). Probe asserts
  latency, temperature-0 determinism behavior, and the decision/tool-selection contract.
  **No Opus in the hot loop** (NG-9).
- **P-SMITHERS (P0) — Smithers durable runs.** Probe asserts the **real** subscription harness,
  `streamRunEvents`, and **fork/resume/pause/steer** semantics against the product's lifecycle
  model (fork may require a fresh seeded run + parentId lineage rather than a native fork). **All
  model calls route through Smithers subscriptions — never a raw API key.**
- **P-SEAM (P0) — the Cue↔Smithers seam.** Probe asserts action dispatch out of Cue (validated
  against the real `MappedActionTool` action schema) and durable-state observations flowing back
  into Cue to keep voice-out coherent. This is the **novel integration** (`prior-art.md` §8) and the
  top integration risk.

---

## 7. Cross-cutting determinism & test-harness requirement

Because the core is non-deterministic (ASR + LLM), the verification strategy is:

- **Record-replay harness:** temperature-0 for all decision-loop LLM calls; every decision's
  `input → output` is hashed and recorded; replay mode returns cached output **deterministically**.
  This is the testable seam over the AI surface and the audio-domain analog of snapshot testing
  (`domain.md` §5-Q3, `prior-art.md` §7).
- **Test the plumbing/contracts/invariants hard** (Cue policy wiring, action dispatch, Smithers
  lifecycle, routing invariants, safety gates). On AI-output surfaces assert **shape/invariants**
  (e.g., "≤3 MCQs", "≤15 words", "fires within budget"), **not** exact text.
- **Red-before-green is mandatory:** every test above must be demonstrated capable of failing
  before it is trusted; "the agent said it's done" is never accepted as evidence.

---

## 8. Verification at PRD altitude (user-visible acceptance — the V0 gate)

V0 is accepted **only if** all of the following are demonstrated **live, hands-free, with no
keyboard/mouse/screen on the critical path** (this is the user-visible restatement of REQ-1..16;
each maps to its requirement's detailed tests):

1. **V-1 (consent & mute):** Session starts with a spoken consent announcement; the listening
   indicator is active; the spoken mute word stops listening ≤500 ms; no raw audio is persisted.
   *(REQ-1, REQ-2)*
2. **V-2 (welcome suggestion):** Ambient buildable talk surfaces **≤1** spoken suggestion per
   3 minutes, never below the 60-word/90-s floor, as a one-line pitch + ≤3 spoken MCQs; ordinary
   chatter is silently passed. *(REQ-3)*
3. **V-3 (spawn):** A spoken "accept" spawns a real durable process and is confirmed by voice
   (callsign named) within 3 s. *(REQ-4)*
4. **V-4 (the spine):** The canonical loop wake→intent→action→confirm completes hands-free on ≥9
   of 10 scripted live runs, each stage audibly legible. *(REQ-5, REQ-6, REQ-7, REQ-8)*
5. **V-5 (responsiveness):** Recognized commands earcon-ack within 300 ms; round-trip p50 <1 s,
   p95 <1.5 s. *(REQ-10)*
6. **V-6 (restraint):** ≥90% of process ticks are silent; spoken output is ≤15 words and only on
   completion/blocker/safety/explicit-ask. *(REQ-9)*
7. **V-7 (safety):** A destructive action is read back and blocks on spoken "confirm"; withholding
   confirmation aborts via the dead-man timer; the spoken stop word halts a process ≤1 s; the
   non-voice emergency control kills all ≤2 s. *(REQ-11, REQ-12, REQ-14)*
8. **V-8 (the differentiator):** Two processes run concurrently and are steered/paused
   independently; with the fleet disabled, the spine (V-4) still passes. *(REQ-13)*
9. **V-9 (durability):** A process keeps progressing while unselected and is recoverable to its
   last durable state after a backend restart. *(REQ-15)*
10. **V-10 (debuggability):** From persisted traces alone, an engineer reconstructs any utterance's
    full observation→decision→action→outcome chain; the read-only board is non-authoritative
    (everything passes with it closed). *(REQ-16)*

---

## 9. Open risks carried into engineering

- **R-Interruption-asymmetry (highest):** over-eager voice-out is the fastest way to make the
  product unbearable. Default cadence is aggressively conservative, `observe.pass`-first (REQ-3).
- **R-Mistranscription-blast-radius:** every command rides on ASR accuracy (~7.4% WER on technical
  speech). Spawning code-writing agents from a misheard sentence is a safety hazard — mitigated by
  REQ-11 (read-back + dead-man timer), REQ-12 (panic word), REQ-14 (emergency stop), and Safe-by-
  default.
- **R-Cue-unvalidated / repo availability (P0 blocker):** see §6 P-CUE.
- **R-Two-orchestrators-seam:** Cue and Smithers are independent stateful systems wired together;
  no prior art integrates exactly this (§6 P-SEAM).
- **R-No-fallback-modality:** voice as the sole *operational* modality means a failure can leave the
  room with no way in — bounded by REQ-14.
- **R-TTS-unbenchmarked:** the research covered ASR, not TTS; the TTS provider is selected by probe
  (§6 P-TTS), not by prior evidence.
- **R-Fable-reachability:** per `intake.md`, Fable may be disabled in this environment; the per-
  process planning model may need a documented fallback (does not affect the hot loop, which uses a
  cheap/fast model regardless).

---

## 10. End-user interface artifacts

Because the product is audio-only, the "interface" is sound. The artifacts that show *how it
functions* are mockups of (a) the **canonical voice flow** as a storyboard, and (b) the **optional
read-only observability board** — both with mock data:

- `artifacts/smithering/mockups/voice-flow-storyboard.html` — the canonical loop (REQ-5) rendered
  as an audio storyboard: room utterances, earcons, Cue decisions (incl. `observe.pass`), and TTS
  responses, with an audio legend (earcons vs. TTS per D6). This is the primary "how it functions"
  artifact.
- `artifacts/smithering/mockups/observability-board.html` — the optional, read-only "mission
  control" surface (REQ-16): process list with callsigns/states, listening indicator, active cue,
  last action, magic-word legend, and a live trace log. Explicitly non-operational.
