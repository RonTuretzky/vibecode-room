# Panopticon — Design Document (V0, final)

> **Audio-only. Voice is the sole operational modality.** Design, build, and verify as if no
> screen and no keyboard exist on any critical path.
>
> Upstream (read from disk, not assumed): `docs/planning/01-prd.md` (requirements & binding
> decisions D1–D6), `artifacts/smithering/research/design-art.md` (design research),
> `artifacts/smithering/research/domain.md`, `artifacts/smithering/research/prior-art.md`.
> Predecessor: `docs/planning/02-design-draft.md` (reviewed → approved).
>
> This doc translates PRD requirements into concrete design decisions. We verify **our integration**
> with the third-party libraries (Cue, Smithers, ASR, TTS, the decision LLM) — not the libraries'
> own internal correctness. Cue is battle-tested by Etheria; we do not re-verify it. Our job is to
> prove the **seams we own** work: typed provider interfaces at every boundary, mocked/doubled in
> tests, plus a few real-API probes that confirm the shapes we depend on. Tunable parameters are
> passed in via documented ENV vars and tuned by feel later. Each design component below carries an
> inline **Verify** block (integration tests over our adapter, plus targeted e2e), and §13
> consolidates them into a single component→test→observability matrix. Decisions are recorded in §14
> with rationale; significant final-pass judgment calls also have standalone HTML decision docs (§16).
>
> **Reading order for a verifier:** §1 (how verification is treated) → §13 (the consolidated
> matrix and harness) → §11 (the real-API probe gates). The design sections (§2–§10) exist to
> be tested; each ends with its own Verify block so no behavior is described without the test that
> proves it.

---

## 0. What changed in the final orchestrator pass

This document supersedes `02-design-draft.md`. The draft was approved; this pass tightens it,
**cuts scope to ship V0 fast**, and resolves a few concrete gaps. The overall posture: run
dangerously / run-to-completion, trust the voice library, make everything env-tunable and tune by
feel later.

1. **Verification is integration-only.** We verify **our seams** with the third-party libraries, not
   the libraries themselves — Cue is battle-tested by Etheria. The mechanism is typed provider
   interfaces at every boundary (mockable in tests) plus a few real-API probes (§11) for the shapes
   we depend on. Tunable parameters (timeouts, suggestion cadence/gates, thresholds, latency
   budgets, word lists) are passed in via **documented ENV vars** and tuned by feel later. The
   formal labeled "restraint-metric" replay corpus is **dropped**; suggestion restraint is just
   env-tunable params. (Decision **D-DD-25**.)
2. **Concrete mute/unmute words chosen — plain English.** The draft (and PRD) carried a `[mute word]`
   placeholder and used "Mute"/"Listen". Final pass selects the plain words **"mute"** and
   **"unmute"**; the voice library (Cue) handles wake/keyword robustness, so no exotic
   collision-resistant words are needed. (Decision **D-DD-21**.)
3. **Unmuting while muted needs no custom subsystem.** "Muted" means: stop feeding audio into the
   suggestion/routing pipeline. The voice library (Cue) keeps listening for "unmute" even while
   muted, so there are **two ways to unmute: say "unmute", or press the on-screen unmute button.**
   We do **not** build a custom on-device keyword spotter. (Decision **D-DD-22**, §12.)
4. **Ignored ambient speech is silent.** Earcons and acks exist for explicit state transitions
   (wake, spawn, mute, halt, …) and for **addressed** commands, but un-addressed / ignored ambient
   speech (`observe.pass` / `route.pass`) makes **no sound** — by definition, not as a tunable knob.
   The 5 tonal state earcons remain; addressed-command acks remain. (Decision **D-DD-23**.)
5. **No tiered vocabulary in V0.** The always-hot vs. state-gated vocabulary split is **deferred** —
   the voice library handles wake/keyword activation. Revisit later only if it becomes a problem.
   (Decision **D-DD-24**.)
6. **Safety scope cut.** No per-action read-back/confirm gate, no dead-man timer, no
   Safe/Explicit/Dangerous mode switching, no shell-command classifier. V0 runs **dangerously /
   run-to-completion**. Safety later = sandbox the process, not permission gating. (See §8.)
7. **Credentials simplified.** Assume the host is logged in to its OpenAI Codex and Anthropic Claude
   subscriptions; model calls use those. No raw API keys, no elaborate credential-provider
   abstraction, no Cerebras/Haiku hot-loop specifics. (See §11.)

---

## 1. How verification is treated in this document (the bar)

We verify **our integration with the third-party libraries — not the libraries themselves.** Cue is
battle-tested by Etheria; Smithers, the ASR/TTS providers, and the decision LLM each own their own
correctness. Our job is to prove the **seams we own** behave: the adapter, the routing/dispatch
logic, the output policy, the state machine. The mechanism is **typed provider interfaces at every
external boundary, mocked or doubled in tests**, plus a small number of real-API probes (§11) that
confirm the exact shapes we depend on.

- **Test the seams we own, with doubles.** Every external dependency sits behind a typed provider
  interface (§11). Integration tests exercise our adapter/dispatch/policy code against **mocks or
  doubles** of those interfaces, so the tests run fast and deterministically and don't re-prove
  third-party behavior. This is what makes the design mockable end to end.
- **Red-before-green where it's cheap and meaningful.** For the seams we own, a test should be shown
  capable of failing before it is trusted (remove the guard / breach the budget / cross the
  boundary, then restore). Verify blocks below name the failure injection where it adds confidence —
  but this is a tool, not a per-line mandate; we don't gold-plate.
- **Targeted e2e on the spine.** The full voice loop (wake → intent → action → ack) and a few
  isolation/durability scenarios get end-to-end coverage against the live stack. We don't catalog
  exhaustive 10×–100× fuzz matrices for V0 — boundary/error cases are covered where they protect a
  real invariant.
- **Confirm third-party API shapes against the real thing first.** Cue, Smithers, the ASR provider,
  the TTS provider, and the decision LLM are **third-party dependencies**. Per §11, each is exercised
  by a probe that calls the **real** API and asserts the methods, arguments, and return shapes our
  adapter relies on — **before** product code is built on it. We confirm the *shape of the seam*, not
  the library's internal correctness. **P-CUE is a P0 blocker** (see §11.1, §15).
- **Tunable parameters are env-driven.** Timeouts, suggestion cadence/gates, thresholds, latency
  budgets, and word lists are passed in via **documented ENV vars** (each with a default), and tuned
  by feel later from real-world UX. Tests assert invariants ("≤3 MCQs", "fires within the configured
  budget"), not magic numbers.
- **Observability is a build requirement, not a nicety.** Every decision, action, route, and state
  transition emits a structured, leveled log line (schema in §13.3) carrying stable ids
  (`sessionId`, `correlationId`, `upid`) so a later agent with **no context** can reconstruct any
  utterance's full `observation → decision → action → outcome` chain from traces alone (REQ-16).

---

## 2. Wake / mute / panic word design (REQ-1, REQ-2, REQ-7, REQ-12)

### 2.1 Wake word — "Panop"

**Wake word: "Panop"** (2 syllables, /ˈpæn.ɒp/). "Panopticon" is 5 syllables with a soft bilabial
/p/ onset — a poor keyword-detection anchor. "Panop" is rare (not natural English), leads with the
distinguishing /pæn/ cluster, preserves product-name recognition, and lands at 2 syllables (below
the 3–4 ideal — an accepted tradeoff in a team room where false-positive cost dominates recall).
Acoustic-testing fallbacks if "Panop" collides with the team's ambient vocabulary: "Panwatch",
"Opticon". The wake word gates only the general attention/status flow (see §5 tiering); it is
**not** required to address an already-running process by callsign.

### 2.2 Mute / unmute words — "mute" / "unmute" (final-pass decision)

The draft left `[mute word]` unbound. Final pass selects the **plain English words**:

| Function | Word | Why |
|----------|------|-----|
| Mute | **"mute"** | The obvious word for the action; no onboarding friction. |
| Unmute | **"unmute"** | The obvious paired word; recognized by Cue even while muted (§12). |

The voice library (Cue, by Etheria) handles wake/keyword robustness, so we do **not** need exotic
collision-resistant words here. Mute is **highest priority**: it pre-empts every other cue (REQ-2
AC2.2). See **D-DD-21**.

### 2.3 Panic word — "Abort"

**Panic/global-halt word: "Abort."** "Stop" appears constantly in natural speech ("stop the build",
"stop doing that") and is reserved for *targeted* per-process halt; "Abort" is rare in casual team
conversation, 2 syllables, phonetically distinct from all other commands, and is reserved
**exclusively** for global panic — never a synonym for per-process stop. See **D-DD-04**.

### 2.4 Verify (words & priority)

- **Integration (against Cue/ASR doubles):**
  - *Priority ladder test* — on a single utterance containing co-occurring triggers, assert the
    resolved order is **mute > panic > stop > steer > suggest > pass** (REQ-2 AC2.2, REQ-12 AC12.2).
    *Red-before-green:* swap mute below panic in the comparator → test fails; restore → passes.
  - *Collision-guard test* — assert the collision guard rejects a proposed callsign within
    phoneme-Levenshtein ≤2 of an active callsign / wake / mute / unmute / panic word (§5.3).
    *Red-before-green:* add a near-homophone of an active callsign → must reject.
- **E2e:** live session — speak each command word in isolation and assert its documented effect;
  speak "mute"+"abort" in one breath and assert mute wins and nothing is halted-then-heard.
- **Third-party:** P-CUE (`TextCue` match semantics, §11.1), P-ASR (finalization timing, §11.3).
- **Observability:** `wake.detected`, `mute.engaged`, `mute.released`, `process.halt{trigger:panic}`
  — each with `correlationId`, the triggering `utteranceId`, and measured `latencyMs`.

---

## 3. Earcon & routing-ack design (REQ-9, REQ-5 AC5.3) — two intentionally separate layers

The system speaks through **two categorically different non-verbal layers** so they can never be
confused. The guiding rule: **ignored ambient speech is silent.** Earcons and acks fire for explicit
state transitions and for **addressed** commands; un-addressed / ignored ambient speech
(`observe.pass` / `route.pass`) makes **no sound** (see **D-DD-23**).

### 3.1 Layer A — the 5 tonal state earcons (fixed for V0)

Each is acoustically distinct (distinct pitch register, distinct rhythm), discriminability-tested
under conversational noise, and **≤500 ms** — earcons signal, they do not perform.

| # | Name | Pattern | Duration | Trigger |
|---|------|---------|----------|---------|
| E1 | **Wake/Active** | Ascending two-tone (C5→E5) | ≈300 ms | Wake word detected; active-listen window open |
| E2 | **Transcribing-Ambient** | Near-subliminal hum (A2, ≈−20 dBFS) | Continuous | Mic streaming; felt-not-heard presence |
| E3 | **Spawn Confirmed** | Single high note (G5, sharp attack) | ≈200 ms | New durable process spawned |
| E4 | **Resolved/Completed** | Resolution arpeggio (C4→E4→G4) | ≈400 ms | Process completed / significant positive outcome |
| E5 | **Stop/Halt** | Descending two-tone (E5→C4) | ≈300 ms | Stop/panic received; process halted |

**Mute state:** E2 goes silent **and** a distinct persistent low tone (D2, ≈−15 dBFS) plays
continuously while muted. Contrast: *nothing* = listening; *persistent low tone* = muted — the
inverse of E2, unmistakable.

### 3.2 Layer B — addressed-command acks (deliberately non-tonal, so they never collide with Layer A)

Receipts for **addressed** commands use **non-tonal** signatures (clicks/whoosh), categorically
distinct from the tonal earcons. **Ignored ambient speech is silent** — there is no ack for
un-addressed speech:

- `route.steer:X` → brief double-click ("tick-tick") after the wake/ack — "routed to a process".
- `route.suggestion` → single soft "whoosh" — "fed the suggestion engine".
- `route.pass` / `observe.pass` (ignored ambient) → **silence**, by definition. Un-addressed speech
  makes no sound; this is not a tunable knob.

**Roger vs. Wilco (ATC):** receipt ≠ compliance. E1 (wake chime) = "I heard the wake word"; E3
(spawn) = "I'm acting on the acceptance." These must never be the same sound (see **D-DD-17**).

### 3.3 Verify (earcons & acks)

- **Integration (against doubles):**
  - *Earcon-dispatch latency test* (mocked clock) — E1 fires within the configured earcon budget
    (`EARCON_BUDGET_MS`, default 300) after the wake transcript is `isFinal`; dispatch is **never
    gated** on Smithers/LLM/TTS. *Red-before-green:* set the budget env to 100 ms → fails; restore
    default → passes (REQ-10 AC10.1).
  - *Acoustic-distinctness fixture* — assert E1–E5 differ in both pitch register and rhythm
    descriptor, and that every Layer-B ack is non-tonal (no pitched content), so Layer A and Layer B
    are disjoint by construction. *Red-before-green:* give an ack a pitched tone → overlap detector
    flags it → fails.
  - *Output-class → channel map test* — each trigger class resolves to exactly one of
    {silent, earcon, tts} (§7), and ignored ambient (`observe.pass` / `route.pass`) maps to
    **silent**. *Red-before-green:* route "routine tick" or `observe.pass` → tts/earcon → fails.
- **E2e:** representative recorded session — assert each state transition emits its mapped earcon
  (REQ-5 AC5.3), the mute tone replaces E2 on "mute", and **ignored ambient speech emits silence** (a
  positive assertion that no ack was emitted, not merely "nothing logged").
- **Third-party:** P-LLM/P-CUE for the decision that *selects* the class (the class→sound map itself
  is local and framework-free).
- **Observability:** `earcon.emit{id, latencyMs}`, `route.{steer|suggestion|pass}{utteranceId, ackKind}`.

---

## 4. Ambient suggestion engine design (REQ-3)

### 4.1 Gate: room-interrupt cost, not just suggestion quality

The REQ-3 floor (≥60 words **OR** ≥90 s of substantive talk) is the right shape; the thresholds are
**env-tunable** (`SUGGEST_MIN_WORDS` default 60, `SUGGEST_MIN_SECONDS` default 90). The design adds
**room-interrupt cost** as a first-class dimension — a spoken suggestion is a broadcast interrupt
with no per-person opt-out (`design-art.md` §3):

```
fire = gate_passed AND quality >= quality_threshold AND interrupt_cost <= cost_ceiling
```

`interrupt_cost` rises with: active speech velocity (words/min over last 30 s), utterance recency
(ended <5 s ago = high), and any pending steerings (in-flight work = elevated). A suggestion fires
only when `gate_passed AND (interrupt_cost low OR room idle ≥10 s)`. Otherwise it is **queued** and
delivered on the next idle gap (Cue `IdleCue`, §11.1). A queued suggestion **expires after**
`SUGGEST_TTL_SECONDS` (default 90) with no idle gap (logged `suggestion.expired`, **not** spoken) — a
stale idea about a topic the room has moved past should not resurface (see **D-DD-15**). All of these
— quality threshold, cost ceiling, cadence, TTL — are **env-tunable params with documented defaults,
tuned by feel later**; there is no formal labeled corpus or restraint metric for V0.

### 4.2 Delivery format

`[≤12-word spoken concept pitch] [pause] [1–3 MCQs answerable aloud]`. MCQs are enumerated aloud
("First question: …. Second question: …"), **never >3**. Silence for 5 s after the last MCQ = "no
answer" → re-queue once for the next idle gap, then discard on the second non-answer. **Apologetic
language is prohibited** ("I noticed you might want to…" is banned); "Here's an idea: [pitch]" is
the ceiling — brevity signals confidence (`design-art.md` §3). See **D-DD-03**.

### 4.3 Verify (suggestion engine)

- **Integration (against Cue/LLM doubles):**
  - *Gate-boundary tests* — at the configured `SUGGEST_MIN_WORDS`, one-below → `observe.pass`,
    at/above → eligible (likewise for `SUGGEST_MIN_SECONDS`). *Red-before-green:* lower the env
    threshold → the previously-passing case fires → fails.
  - *MCQ-count invariant* — never emit >3 MCQs. *Red-before-green:* force 4 → fails.
  - *Interrupt-cost test* — with speech velocity high / utterance <5 s old, a gate-passed suggestion
    is **queued, not spoken**; with room idle ≥10 s it fires. *Red-before-green:* zero out
    `interrupt_cost` → it fires mid-speech → fails.
  - *Expiry test* — a queued suggestion with no idle gap for `SUGGEST_TTL_SECONDS` is discarded and
    logged `suggestion.expired`, never spoken.
  - *Live-knob test* — cadence and TTL re-read from env without a code change (AC3.5).
- **E2e:** scripted-audio session over the record-replay harness (temperature-0 decisions, §13.1) —
  assert **idle-preference** (a queued idea is held until an idle gap, never spoken over active talk)
  and that ignored ambient yields `observe.pass` with no sound. Suggestion restraint is **tuned by
  feel** against documented env defaults; there is no formal labeled corpus or recall/false-positive
  metric gate for V0.
- **Third-party:** P-CUE (`WordCountCue`, `IdleCue`, `IntervalCue`, `cooldownSeconds`, `observe.pass`),
  P-LLM (cheap/fast scoring, temperature-0 determinism).
- **Observability:** every decision — **fire and every `observe.pass`** — logs `{policy, wordCount,
  elapsedS, quality, interruptCost, decision, decisionId, correlationId}`.

---

## 5. Command vocabulary & callsign design (REQ-6, REQ-7)

Commands are deterministic: **same transcript → same routing decision, every time** (record-replay
confirms, AC7.3).

### 5.1 Vocabulary — flat magic-word set (no tiering in V0)

V0 ships a **flat set of magic words**; the voice library (Cue) handles wake/keyword activation, so
we do **not** implement a tiered always-hot vs. state-gated vocabulary. Context still matters for a
few words — "Yes"/"Accept" only mean *accept* while a suggestion is pending; "Done"/"Back" only
close a steering window when one is open — but this is plain per-state command handling in our
dispatch logic, not a separate vocabulary-tiering subsystem with its own collision bar.

> **Deferred (revisit later only if needed):** the original design split the vocabulary into
> always-hot (rare words matched anytime) vs. state-gated (natural words matched only inside a narrow
> window), with a collision-resistance bar scaling with false-trigger cost. That tiering is **not a
> V0 requirement** — Cue's wake/keyword robustness makes it unnecessary for now (see **D-DD-24**).

### 5.2 V0 magic-word vocabulary

| Command | Spoken form | Effect |
|---------|-------------|--------|
| Wake | "Panop" | Opens active-listen window for next utterance |
| Accept | "Yes" / "Accept" / "Do it" | Accepts pending suggestion → spawns (only while a suggestion is pending) |
| Decline | "No" / "Nah" / "Skip" | Declines pending suggestion → no-op (only while a suggestion is pending) |
| Select-and-steer | "[callsign], [instruction]" | Selects process, opens steering window, routes instruction |
| Select only | "[callsign]" | Selects process, opens steering window |
| Steer | (after select) "[instruction]" | Routes instruction to selected process (inside an open window) |
| End steering | "Done" / "Back" | Closes the steering window |
| Pause all | "Pause all" | Pauses all running processes |
| Status | "Status" | Speaks brief summary of active processes (≤15 words) |
| Stop (targeted) | "Stop" / "Halt" | Halts the currently selected process |
| Panic (global) | "Abort" | Halts all processes, closes steering windows |
| Mute | "mute" | Stops feeding audio into the suggestion/routing pipeline (§12) |
| Unmute | "unmute" | Resumes the pipeline (Cue hears "unmute" even while muted) (§12) |

### 5.3 Callsign pool & collision guard

A proposed callsign is **rejected** if its Metaphone code matches, **or** its phoneme-Levenshtein
distance is ≤2 to, any active callsign / wake / panic word. V0 ships a pre-validated
NATO subset:

```
Atlas    Bravo    Delta    Foxtrot    Golf
Hotel    India    Juliet   Kilo       Lima
```

No two concurrent processes share a callsign. Callsigns are assigned in sequential order at spawn;
a halted process's callsign is **not** re-available for **60 s** (muscle-memory confusion guard,
**D-DD-18**). See **D-DD-05** for the holistic-set rationale (ICAO 1948–49).

### 5.4 Steering-window lifecycle

1. **Opens on:** callsign detection, including one-breath "Atlas, make it faster".
2. **Routes** subsequent speech to the selected UPID **only**.
3. **Closes on:** "Done"/"Back", **OR** `STEER_IDLE_SECONDS` (default 20) of mic-level idle, **OR** "Abort".
4. **While open:** the Layer-B addressed-command ack (§3.2) marks each routed utterance.

### 5.5 Verify (vocabulary & routing)

- **Integration (against Cue doubles):**
  - *Dispatch-invariant test* — a steering verb with no in-utterance callsign and no open window is
    **rejected in deterministic dispatch, not by the LLM** (REQ-6 AC6.1). *Red-before-green:* remove
    the guard → un-addressed talk steers a process → fails; restore → passes.
  - *Routing-exclusivity test* — each utterance resolves to exactly one of {suggestion, steer:X, pass}.
  - *Per-state command test* — "Yes" with no suggestion pending is inert (does not accept anything).
    *Red-before-green:* make "Yes" accept unconditionally → a casual "yes" spawns a process → fails.
  - *Collision-guard test* — reject a callsign within distance ≤2 of an active one / wake / panic.
    *Red-before-green:* add "Delta" while a "Della"-like callsign is active → must reject.
  - *Determinism test* — replay the same transcript N× → identical decisions every time.
  - *Window-lifecycle test* — open on callsign; close on "Done" / idle / "Abort".
  - *Re-use cooldown test* — a halted callsign is unavailable for the cooldown window.
- **E2e:** live multi-utterance script — un-addressed talk only ever feeds suggestions (never
  steers); one-breath select-and-steer routes correctly; each documented command yields its
  documented effect; an undocumented phrase yields no command.
- **Third-party:** P-CUE (`TextCue`, `SpeakerWordCue`, two-`Program` routing).
- **Observability:** `command.recognize{phrase, matchedCommand|null, distanceScore}`,
  `route{utteranceId, route, targetUPID|null, ackKind}`.

---

## 6. Voice interaction loop design — the spine (REQ-5)

### 6.1 State machine

```
IDLE ──[wake word]──► ACTIVE_LISTEN
  │                        │
  │            [suggestion pending] ──► SUGGESTION_DELIVERY
  │                        │                    │
  │                        │            [accept]──► SPAWN ──► PLANNING
  │                        │            [decline]──► IDLE
  │                        │
  │            [callsign]──► STEERING_WINDOW(UPID)         ← callsign select: no wake needed
  │                              │
  │                    [instruction]──► STEER(UPID) ──► ACK ──► STEERING_WINDOW
  │                    [done/idle20s]──► IDLE
  │                    [abort]──► GLOBAL_HALT
  │
  └──[mute]──► MUTED (always wins from any state; exits on "unmute" — heard by Cue, §12 —
              or the on-screen unmute button)
```

### 6.2 Stage-transition audibility (AC5.3)

Every transition emits an identifiable signal: IDLE→ACTIVE_LISTEN = E1; →SUGGESTION_DELIVERY = soft
spoken pitch begins; ACCEPT→SPAWN = E3 + spoken callsign; STEERING_WINDOW open = Layer-B tick-tick
per routed utterance; STEER→ACK = spoken confirmation ≤7 words ("Got it: [summary]"); HALT = E5 +
spoken callsign + "halted"; MUTED = E2 silent, persistent low tone starts. **Ignored ambient speech
emits no signal** (silence).

### 6.3 Sub-second acknowledgement (REQ-10) & correlation threading

E1 fires **≤300 ms** after ASR finalizes the wake transcript, **before** any downstream decision,
Smithers call, or TTS render. Each loop iteration gets **one `correlationId`** minted at
wake-detection that propagates `transcript → decision → action → spoken ack`; one query on it
reconstructs the full loop.

### 6.4 Verify (the spine)

- **Integration (against doubles):** *stage-sequencer test* drives all four stages through the happy
  path **and** each single-stage failure (mis-heard wake, empty intent, action error, TTS failure),
  asserting the correct recovery/ack at each boundary. *Red-before-green:* drop the ack on the
  action-error branch → fails.
- **E2e:** the **canonical scenario test** — scripted audio drives wake→intent→action→ack
  against the live stack; run **≥10×**, assert **≥9 pass** (AC5.2) with each failure attributable to
  a logged cause; a **no-screen harness** asserts **zero** GUI/keyboard events were consumed on the
  critical path (AC5.1). *Red-before-green:* feed a build with a broken dispatcher → ≥2 runs fail →
  suite reports red, proving it can detect spine breakage.
- **Third-party:** P-CUE + P-ASR + P-TTS + P-SMITHERS + P-SEAM (all of §11).
- **Observability:** one `correlationId` threads `wake.detected → decision → action → ack.emit`; a
  single trace query rebuilds the loop (causal-chain test, §13).

---

## 7. Audio output policy — hybrid earcon + TTS (REQ-9)

### 7.1 Output triage (default = silent)

| Trigger | Channel | Max length |
|---------|---------|-----------|
| Completion / success | TTS | ≤15 words |
| Blocker / question needed | TTS | ≤15 words |
| Explicit "status" ask | TTS | ≤15 words |
| State transition | Earcon | ≤500 ms |
| Routine progress / tick | Silent | — |
| Ignored ambient (`observe.pass` / `route.pass`) | Silent | — |

**Never emit to TTS:** file names, diff contents, URLs, stack traces, raw output — summarize instead
("The diff is ready. Say 'continue' to apply."). The **15-word guard** is a hard truncator in the
TTS pipeline stage: count words → ≤15 submit as-is → >15 summarize via the **cheap/fast hot-loop**
LLM (never the planning model, NG-9) and resubmit. **90%-silence target:** default class is `silent`;
a per-session TTS-bearing-tick counter tightens the gate (explicit-ask-only) if >10% in a rolling
5-min window. **Ignored ambient speech is silent by definition.** **TTS voice:** one consistent,
calm, neutral, non-persona voice across all events — selected once per session, not per-utterance.

### 7.2 Verify (output policy)

- **Integration (against doubles):** *class→channel map test* (each trigger → {silent|earcon|tts},
  ignored ambient → silent); *15-word guard test* (16-word candidate → summarized; 15 → as-is) —
  *red-before-green:* feed 16 words and remove the guard → recited verbatim → fails; *never-recite
  test* (file/diff/URL payload is never sent to TTS); *silence-budget test* (>10% TTS-bearing ticks
  in the window → gate tightens).
- **E2e:** representative session — count TTS-bearing ticks / total, assert **≤10%** (AC9.1); assert
  every TTS utterance is in an allowed class and ≤15 words. *Red-before-green:* inject a chatty build
  → ratio exceeds 10% → test fails.
- **Third-party:** P-TTS (streaming start latency), P-LLM (summarizer ≤2 s).
- **Observability:** `output.decision{tickId, class, channel, wordCount, summarized:bool}`.

---

## 8. Execution posture design (REQ-11)

### 8.1 V0 runs dangerously — run-to-completion, no per-action gate

V0 has **one execution mode: dangerous / run-to-completion.** Processes run autonomously to
completion; there is **no per-action approval, no spoken read-back/confirm gate, and no dead-man
timer.** You shouldn't need to approve often. Where a confirmation is genuinely needed, the voice
library (Cue) already handles it — we minimize approvals rather than build a bespoke gate.

We **do not** build:

- a `PreToolUse` read-back/confirm hook or a safe-executor that holds destructive tool calls;
- a 25 s dead-man timer;
- Safe / Explicit / Dangerous mode switching (there is only the one dangerous mode);
- a parse-based shell-command classifier that sub-classifies shell calls into read-safe vs.
  mutating/unknown and gates them. There is **no** `safety/shell-classifier.ts`; nothing is gated.

This is an explicit scope cut. **Routing authority still lives in deterministic code** (§5, E4) — the
LLM scores quality/intent, code decides where an utterance goes — but execution is ungated.

**Safety, when we want it later, comes from sandboxing the whole process, not from permission
classification.** That is a future addition (sandbox the run), not a V0 permission/mode system.

### 8.2 Verify (execution posture)

- **Integration (against doubles):** *run-to-completion test* — a destructive-verb action is
  dispatched to Smithers **without** any read-back, confirm wait, or timer (assert no gate is
  interposed). *Red-before-green:* re-introduce a blocking confirm gate → the action no longer
  dispatches in one pass → fails.
- **E2e:** live — instruct a process toward a destructive act and assert it runs to completion with
  no spoken approval prompt and no timeout abort.
- **Third-party:** P-SMITHERS (spawn/steer/cancel a durable run).
- **Observability:** `process.action{verb, object, gated:false}` — the `gated:false` field is a
  positive assertion that nothing held the action.

---

## 9. Observability board design (REQ-16) — read-only mission-control console

The board is a **debugging tool with zero operational controls** — every pixel is a display. It is
served as an **optional** HTTP page; the system never waits for board connections and never alters
behavior based on board presence (board serving is **off the critical path of every voice flow**).

**Layout (NASA MOCR / ATC STARS):** listening indicator top-left (highest criticality), global state
top-center, emergency-stop status top-right (Z-pattern scan); per-process panels (V0 max 2;
empty-state "No second process running" when <2) showing callsign / state / last output / last
action / UPID + a 5-event action log; a scrollable, **non-auto-scrolling** trace log at the bottom.

**Color semantics (STARS/APCA on dark):** bg `#0a0a0a`; nominal/active `#00ff88`; paused/pending
`#f5a623`; halted/error `#ff3b30`; selected/in-focus `#00bcd4` (cyan, the Echo active-listening
color, **D-DD-20**); text `#e0e0e0`. **Violet/purple is prohibited** as a status color (STARS
human-factors audit). **Blink** is reserved for exactly one state: emergency-stop triggered
(**D-DD-09**). **Auto-scroll disabled**; a "NEW" indicator appears when
events arrive while scrolled up — clicking it scrolls to bottom, the **only** click target and it is
navigational, never operational (**D-DD-07/08**). Reference mockup:
`artifacts/smithering/mockups/observability-board.html`.

### 9.1 Verify (board)

- **Unit/integration:** *read-only test* — assert the board exposes **no** mutating endpoint/handler
  (*red-before-green:* add a POST route → test fails); *trace-schema test* — every record carries the
  required ids/fields (§13.3); *causal-chain reconstruction test* — rebuild an utterance's full chain
  from recorded traces alone.
- **E2e:** *board-non-authoritative test* — run the full REQ-5 canonical scenario with the board
  server **down** and assert it still passes (AC16.2); then run with the board up and reconstruct the
  loop from persisted traces only, asserting it matches the live run. *Red-before-green:* make a voice
  flow await a board connection → the board-down scenario hangs/fails → proves the off-path guarantee
  is actually tested.
- **Third-party:** P-CUE HTTP/SSE routes (consumed read-only).
- **Observability:** the board renders the §13.3 stream; it adds none of its own authority.

---

## 10. Audio onboarding design (REQ-1)

The **consent announcement is the entire onboarding** — three sentences, ≤8 s (no feature wall):

```
"Panopticon is listening. Say 'Panop, status' to hear a rundown.
Say 'mute' to pause. [earcon E2 begins]"
```

(Updated from the draft's `[mute word]` to the chosen plain word "mute".) **Printed A6 magic-word
card** (a build artifact, posted near the primary mic) is the persistent reference for a zero-screen
room — **not optional**; it lists the wake word, all magic commands, active callsigns, mute/unmute,
and the panic word. **Progressive disclosure:** capabilities are not announced, only responded to.
**Near-miss soft landing:** an utterance within Levenshtein ≤2 of a documented command (and no other
route) → "Did you mean '[closest]'? Say it again to confirm." — disabled after the first 20 min.
**First-run VAD:** end-of-utterance silence threshold extended **+50%** for the first 5 min
(**D-DD-10**).

### 10.1 Verify (onboarding)

- **Unit/integration:** *consent-scheduler test* — fires **once** per session, idempotent, within
  3 s of start (AC1.1); *near-miss test* — distance-≤2 non-match → soft landing; exact match → no
  prompt; *first-run VAD test* — threshold is +50% for 5 min then reverts (mocked clock).
  *Red-before-green:* make the scheduler fire twice → idempotency test fails.
- **E2e:** live — assert the consent line is spoken **first**, names the actual mute word "mute",
  the listening indicator is active for the whole session, and a post-run disk/log scan finds **zero**
  audio artifacts (REQ-1 AC1.3; *red-before-green:* introduce a `.wav` write path → scan fails).
- **Third-party:** P-ASR, P-TTS.
- **Observability:** `session.start{provider, consentSpoken:true}`, `onboarding.nearMiss{phrase, closest, distance}`.

---

## 11. API & integration design + real-API probe gates

Every probe below calls the **real** library and asserts the methods/arguments/return shapes **our
adapter** depends on, **before** product code is built on it. We confirm the *shape of the seam we
own*, not the library's internal correctness (Cue is battle-tested by Etheria). A probe that *could*
fail and *passed* is the evidence; docs and memory are not. Probe artifacts live under
`artifacts/smithering/probes/`; results under `artifacts/smithering/reports/`. All are currently
**unrun** — nothing below is confirmed yet.

### 11.1 P-CUE (P0, blocking) — Cue (`github.com/jameslbarnes/cue`)

Cue is the canonical substrate; our integration is a **thin adapter we own** (D2) that translates
Cue's observation/action schema ↔ Panopticon's internal events. **We re-implement nothing Cue
provides.**

**Exact surface the probe must exercise against the real library, with assertions:**

| Primitive | Used for | Probe assertion |
|-----------|---------|-----------------|
| `TextCue` | Magic-word detection in transcript | matches a literal/regex token in a transcript observation; returns a decision object of the documented shape |
| `SpeakerWordCue` | Per-speaker routing | exposes a stable per-speaker label on the observation |
| `IdleCue` | Idle-preferring delivery | fires after a configurable idle gap; gap is settable |
| `WordCountCue` | Suggestion gate (≥60) | threshold is settable; fires at/above it, not below |
| `IntervalCue` + `cooldownSeconds` | Cadence throttle (≤1/3 min) | cooldown is honored; assert granularity (integer-second vs sub-second) |
| `observe.pass` | Explicit non-action | is a **named, loggable** first-class outcome (not a silent gap) |
| `CueHarness` | Continuous observation loop | starts/stops; accepts our provider slots |
| `Program` | One per routing channel (C2/C3) | two independent Programs route independently |
| `MappedActionTool` | Cue decision → Smithers action | the emitted **action schema** matches what our adapter dispatches |
| transcription/LLM/output/frame **provider** slots | our ASR/TTS/LLM adapters | the provider interfaces accept our implementations |
| JSONL trace files | Observability | every decision (incl. `observe.pass`) is written with a stable id |
| HTTP/SSE routes | Board consumption | routes stream live state read-only |

**Our adapter adds (recorded as owned extensions, per D2):** transcript-observation normalization
`{text, isFinal, speaker, sessionId}`; routing-decision logging with `correlationId`; earcon
emission (Cue decides, adapter plays); Smithers lifecycle calls on `MappedActionTool` actions.
**Known risks the probe must resolve:** speaker-label stability across utterances (adapter must
survive re-labeling without breaking the routing invariant); whether `observe.pass` is truly
first-class (else the adapter intercepts and logs it); `cooldownSeconds` granularity (if integer-only,
sub-second ≤300 ms acks are handled **outside** Cue).

> **⚠ P0 BLOCKER.** Upstream artifacts **disagree on whether the Cue repo is publicly accessible**
> (`domain.md` §7 could not confirm it on 2026-06-13; `prior-art.md` §1 documents its API as found).
> **Confirming repo access and running P-CUE is the first build task.** All Cue claims above are
> README-derived and **unconfirmed**. If the repo is unavailable or the API differs, REQ-1/3/5/6/7
> design here must be revised. *(Surfaced to the orchestrator's gate — see §15 and structured output.)*

**Verify (P-CUE):** the probe **is** the test — each row above is an assertion that must be able to
fail (feed a below-threshold word count and assert `WordCountCue` does **not** fire; feed a passing
count and assert it does). Record red-before-green for every assertion.

### 11.2 P-SMITHERS (P0) + P-SEAM (P0) — durable runs and the Cue↔Smithers seam

**Credentials:** there are **no raw API keys** and no elaborate credential-provider abstraction. We
**assume the host machine is already logged in to its OpenAI Codex and Anthropic Claude
subscriptions** (the local CLIs/subscriptions are available); model calls use those. Model choice
follows the model-assignment matrix in O4 (see `docs/planning/` orchestration notes). Probe asserts,
against the real harness: durable-run spawn with seed payload; `streamRunEvents` (SSE) shape;
pause/resume; steer/signal (mid-run injection); pre-kill context archive; restart recovery to last
checkpoint; concurrent durable runs (fleet, REQ-13). **Fork may require a fresh seeded run +
`parentId` lineage rather than a native fork — the probe must determine which.**

**P-SEAM** (the novel integration, no prior art — `prior-art.md` §8): probe asserts a `MappedActionTool`
action out of Cue invokes the Smithers spawn API, and Smithers SSE run-events flow back into Cue as
observations for voice-out coherence. Adapter must handle: spawn ≤3 s without blocking the Cue loop
(AC4.3); SSE reconnect; UPID↔steering-window correlation; run-events summarized to ≤15 words before TTS.

**Verify:** probe assertions (red-before-green each); plus the e2e *durability-recovery test* (kill
backend mid-run, restart, assert resume from last checkpoint — work not lost, REQ-15) and the e2e
*fleet-isolation test* (steer A, assert B byte-identical, REQ-8/13).

### 11.3 P-ASR (P0) — streaming ASR (candidate: Deepgram Nova-3)

Behind a swappable interface:

```typescript
interface ASRProvider { stream(audio: NodeJS.ReadableStream): AsyncIterable<TranscriptObservation> }
interface TranscriptObservation { text: string; isFinal: boolean; speaker: string | null; latencyMs: number; sessionId: string }
```

Probe asserts: `isFinal` flag shape & timing; diarization label format; **measured** word-final
latency **<200 ms** (to leave headroom for ≤300 ms earcon, REQ-10 AC10.1); **no** observation on
silence (not empty observations); behavior on overlapping speech (2 simultaneous speakers). "Top
streaming ASR in 2026" per `domain.md` is confirmed **only if** these assertions pass.

### 11.4 P-TTS (P0) — low-latency streaming TTS (provider unverified; probe is also a benchmark)

```typescript
interface TTSProvider { speak(text: string, options?: {voice?: string}): Promise<NodeJS.ReadableStream> }
```

`design-art`/`domain` benchmarked ASR, **not** TTS — so the provider is **unverified** (D-DD-14).
Candidates: ElevenLabs Flash v3, Cartesia Sonic, PlayHT 3.0 Turbo. Probe asserts **first audio byte
≤200 ms** of text submission (to keep round-trip ≤1 s, REQ-10 AC10.2) and selects the winner. Voice
is selected once per session, not per-utterance. The 15-word guard runs **before** submission.

### 11.5 P-LLM (P0) — cheap/fast decision LLM (hot loop only)

The hot loop (Cue decision layer, suggestion scoring, 15-word summarizer) uses a **cheap/fast model
only** — **no heavy planning model in the hot loop** (NG-9). The specific model follows the O4
model-assignment matrix and runs against the host's logged-in subscriptions (no raw keys). The
per-process planning agent (via Smithers) uses a richer model per the same matrix. Probe asserts:
temperature-0 determinism (record-replay compatibility); p50 latency within the hot-loop budget
(env-tunable `HOTLOOP_BUDGET_MS`); the emitted action/tool-selection schema matches
`MappedActionTool`.

---

## 12. Mute / unmute architecture (final-pass decision)

**What "muted" means.** Saying "mute" **stops feeding audio into the suggestion/routing pipeline**:
within 500 ms (AC2.1) the system produces **zero transcript observations, suggestions, or actions**
(AC2.3), and the transcribing-ambient earcon E2 is replaced by the persistent mute tone (§3.1). The
voice library (Cue, by Etheria) **still listens for the "unmute" keyword** the whole time — Cue
already handles always-on keyword listening even while cloud transcription/suggestions are paused, so
we do **not** build a custom on-device keyword spotter. (See **D-DD-22**.)

**Two ways to unmute:**

1. **Say "unmute."** Cue hears it even while muted and re-opens the pipeline.
2. **Press the on-screen "unmute" button.** The screen always offers an unmute button — a minimal
   non-voice control (the bounded off-path hatch of REQ-14) so the room is never trapped muted.

On unmute (either path): the suggestion/routing pipeline resumes, E2 is restored, and the system logs
`mute.released{trigger: voice|button, latencyMs}`.

This keeps voice the operational modality and satisfies "no observations while muted" without a
bespoke spotter, a P-SPOTTER blocking probe, or any teardown/clean-restart recovery — all removed.

### 12.1 Verify (mute/unmute)

- **Integration (against Cue/ASR doubles):**
  - *Mute-latency test* — "mute" stops feeding the pipeline ≤500 ms (mocked clock, AC2.1).
  - *No-observation-while-muted test* — in MUTED state, feed arbitrary speech and assert **zero**
    observations/suggestions/actions reach the pipeline (AC2.3). *Red-before-green:* leave the
    pipeline fed on mute → observations appear → fails.
  - *Unmute-paths test* — both "unmute" (via Cue) and the on-screen button re-open the pipeline.
    *Red-before-green:* disconnect the button handler → button no longer unmutes → fails.
- **E2e:** live — speak "mute"; assert the pipeline stops ≤500 ms (measured), E2 flips to the mute
  tone, and subsequent speech yields zero observations; then speak "unmute" (and separately, press
  the button); assert the pipeline resumes and E2 returns. Post-run disk/log scan finds **zero**
  audio artifacts across the muted interval. *Red-before-green:* route the muted-interval mic to a
  recorder → scan finds a blob → fails.
- **Third-party:** P-CUE (asserts Cue still surfaces the "unmute" keyword while the pipeline is
  paused); P-ASR (stream stop/restart semantics).
- **Observability:** `mute.engaged{latencyMs}`, `mute.released{trigger: voice|button, latencyMs}`,
  and a periodic `mute.heartbeat{feedingPipeline:false}` while muted so a debugging agent can prove
  the pipeline was closed for the whole interval.

---

## 13. Validation & observability — consolidated

This section consolidates how we test **the seams we own**. §13.1 is the testable seam over the AI
surface; §13.2 is the component→test matrix; §13.3 is the log contract; §13.4 the red-before-green
protocol; §13.5 the boundary/error catalog. We do **not** re-verify the third-party libraries
themselves, and there is **no formal labeled corpus or restraint metric** for V0 — tunable behavior
is governed by documented env vars, tuned by feel.

### 13.1 Record-replay harness (the testable seam)

ASR + LLM are non-deterministic, so all decision tests run the decision LLM at **temperature-0** and
replay **pre-recorded ASR output** as JSONL:

```
[real session audio] → [ASR (real, recorded once)] → [transcript-observation JSONL]
                                                              ↓
[replay reads JSONL] → [decision loop, temperature-0] → [actions / routing decisions]
```

Same input → same output on every run — the audio-domain analog of snapshot testing. On AI-output
surfaces we assert **shape/invariants** ("≤3 MCQs", "≤15 words", "fires within budget"), never exact
text. The harness records every decision's `input→output` hashed for replay.

### 13.2 Per-component verification matrix

Each component is tested over the seam we own; "RBG" names the failure injection that proves the
test can go red where we use one.

| Component (§) | Integration (with RBG) | End-to-end | Probe | Key observability |
|---|---|---|---|---|
| Priority ladder (§2.4) | mute>panic>stop>steer>suggest>pass; RBG: demote mute | co-occurring triggers in one utterance resolve correctly | P-CUE | `*.detected`, ordered `decisionId` |
| Mute/unmute (§12.1) | stop feeding ≤500 ms; zero obs while muted (RBG: leave pipeline fed); both unmute paths (RBG: disconnect button) | speak "mute"→silent→"unmute"/button→resumes; disk scan = 0 audio | P-CUE + P-ASR | `mute.engaged/released/heartbeat` |
| Earcons & acks (§3.3) | E1 within budget (RBG: 100 ms budget); Layer A/B disjoint (RBG: pitched ack) | each transition emits mapped earcon; ignored ambient = silence | P-LLM | `earcon.emit`, `route.*` |
| Suggestion engine (§4.3) | gate boundary (RBG: lower env threshold); MCQ≤3 (RBG: force 4); interrupt-cost queue (RBG: zero cost); expiry | scripted replay: idle-preference; ignored ambient = `observe.pass`/silence (restraint tuned by feel via env, no metric gate) | P-CUE, P-LLM | per-decision incl. every `observe.pass` |
| Vocabulary & routing (§5.5) | dispatch-invariant (RBG: remove guard); per-state command (RBG: "Yes" unconditional); collision; determinism | un-addressed never steers; one-breath steer | P-CUE | `command.recognize`, `route` |
| The spine (§6.4) | stage-sequencer happy + 4 failure branches (RBG: drop ack) | canonical scenario ≥9/10; no-screen harness = 0 GUI events on critical path | all probes | one `correlationId` across loop |
| Output policy (§7.2) | class→channel (ignored ambient=silent); 15-word guard (RBG: 16 words, remove guard); never-recite; silence budget | session TTS-tick ratio ≤10% (RBG: chatty build) | P-TTS, P-LLM | `output.decision` |
| Execution posture (§8.2) | run-to-completion, no gate interposed (RBG: re-introduce blocking confirm) | destructive act runs to completion, no approval prompt | P-SMITHERS | `process.action{gated:false}` |
| Board (§9.1) | read-only (RBG: add POST); trace-schema; causal-chain rebuild | board-down → REQ-5 still passes (RBG: await board → hangs) | P-CUE SSE | renders §13.3 stream |
| Onboarding (§10.1) | consent once+idempotent (RBG: fire twice); near-miss; first-run VAD | consent first, names "mute"; disk scan = 0 audio | P-ASR, P-TTS | `session.start`, `onboarding.nearMiss` |
| Latency (REQ-10) | ack scheduler within env budget; timeout→"working" earcon | ≥100 round-trips: p50<1 s, p95<1.5 s, earcon<300 ms; recorded baseline | P-ASR, P-TTS | latency spans `asr.final/decision/ack.emit` |
| Durability/fleet (§11.2) | lifecycle edges; pre-kill archive; recovery equality | kill backend mid-run→resume; steer A, B byte-identical | P-SMITHERS | durable checkpoint log |
| Cue↔Smithers seam (§11.2) | action schema match; SSE reconnect; UPID↔window | full spine drives a real durable run | P-SEAM | action-dispatch + run-event trace |

### 13.3 Structured observability contract

Every event emits one structured line:

- `level`: debug | info | warn | error
- `event`: **verb-noun** (`process.spawn`, `route.pass`, `mute.engaged`) — reads in event order,
  fast to scan, self-documenting (**D-DD-12**)
- `sessionId` — across the whole session · `correlationId` — one loop iteration (wake→ack) ·
  `upid` — a specific process · `latencyMs` — **measured, not estimated** · `meta` — word count,
  confidence, matched command, etc.

**The trace log is the single source of truth** for causal-chain reconstruction (REQ-16 AC16.3): no
human memory, no agent assertion — only a structured line proves something happened. A debugging
agent arriving with **no context** must be able to query one `correlationId` and replay the full
chain.

### 13.4 Red-before-green protocol

A test is trusted only after it has been shown to fail — applied where it adds confidence on the
seams we own, not as a per-line mandate. The standard moves: **remove the guard** and assert failure,
then restore and assert pass (dispatch invariant, 15-word guard, mute pipeline-close); **breach the
budget** and assert failure, then relax to spec (earcon ≤300 ms, round-trip <1 s); **cross the
boundary** and assert the boundary holds (word/second gate thresholds, distance-≤2 collision). "The
agent said it's done" is never accepted; the red run is the evidence.

### 13.5 Boundary / error / benchmark catalog

The Verify blocks are the floor; each component covers the boundary/error cases that protect a real
invariant — we don't gold-plate. Representative cases: **empty/longest inputs** (empty transcript,
single word, very long monologue → all resolve to `observe.pass`); **silence** (produces no
observations, not empty ones); **simultaneous speakers** (2 talking at once — routing and diarization
stay sane); **mis-transcription** (garbled callsign → re-prompt or drop); and **benchmarks** for the
performance-critical paths (earcon <300 ms, round-trip p50<1 s / p95<1.5 s) recorded as regression
baselines that **fail on regression**.

---

## 14. Design decisions log

| ID | Topic | Decision | Rationale |
|----|-------|----------|-----------|
| D-DD-01 | Wake word | "Panop" (not "Panopticon") | 5-syllable full name has a soft /p/ onset and poor keyword anchor. "Panop" is 2 syllables, rare, plosive-leading, preserves name recognition. Re-confirm vs. team vocabulary in P-CUE. |
| D-DD-02 | Earcon set | Exactly 5 tonal state earcons (wake, transcribing-ambient, spawn, resolve, stop) | Distinct non-verbal signatures per state beat spoken announcements (`design-art.md` §2). 5 is the minimum distinguishable set; additions require an acoustic-distinctness check. |
| D-DD-03 | Suggestion threshold | Gate on **room-interrupt cost**, not just quality | A spoken suggestion is a no-opt-out broadcast interrupt; annoyance ∝ frequency (CHI 2025). FP cost in a room ≫ FP on a screen. Idle-preferring delivery is non-negotiable. |
| D-DD-04 | Panic word | "Abort" (not "Stop") | "Stop" is constant in speech; "Abort" is rare, 2 syllables, distinct, reserved exclusively for global panic. |
| D-DD-05 | Callsign collision guard | Metaphone + phoneme-Levenshtein ≤2 | ICAO 1948–49: design the active set holistically. At 7.4% WER, similar callsigns misroute. Algorithm must be reproducible and tested. |
| D-DD-06 | Execution posture | V0 runs dangerously / run-to-completion; no read-back/confirm gate or dead-man timer | Cut for speed. You shouldn't need to approve often; Cue handles genuine confirmations. Safety later = sandbox the process, not permission gating. (Supersedes the former 25 s dead-man timer.) |
| D-DD-07 | Board layout | Z-pattern, listening top-left, per-process panels, trace bottom, no controls | NASA MOCR / STARS: role-based segregation, tiered authority, "read-only displays have no buttons." |
| D-DD-08 | Trace auto-scroll | Disabled; "NEW" indicator, click to scroll | Auto-scroll past readable speed makes the log worthless; the only click target is navigational. |
| D-DD-09 | Blink policy | Only emergency-stop triggered blinks | Peripheral blink is the fastest visual signal; blink fatigue (STARS audit) means it must not be wasted. (The destructive-read-back-pending state was removed with the safety gate, D-DD-06.) |
| D-DD-10 | First-run VAD | +50% silence threshold for first 5 min | Mid-sentence pauses cut users off during first-run; one cut-off command kills onboarding confidence. |
| D-DD-11 | TTS word guard | Hard 15-word cap before submission | Spoken word count is the sole length measure in audio; the guard is a pipeline function, not a guideline. |
| D-DD-12 | Log naming | Verb-noun (`process.spawn`, `route.pass`) | Reads in event order, fast to scan, self-documenting (ATC naming, `design-art.md` §7). |
| D-DD-13 | Cue posture | Thin adapter we own; build only on confirmed primitives; record extensions as risks | PRD D2. Extensions live in our layer so Cue gaps never block us. P-CUE is a P0 blocker. |
| D-DD-14 | TTS provider | Unverified; selected by P-TTS probe (ElevenLabs Flash v3 / Cartesia Sonic / PlayHT 3.0 Turbo) | Research covered ASR, not TTS. The probe is also a benchmark; target first byte ≤200 ms. |
| D-DD-15 | Suggestion expiry | Queued suggestions expire after 90 s with no idle gap; logged, not spoken | A 90-s-old idea about a since-abandoned topic is stale; expiry avoids surfacing it on a later idle gap. |
| D-DD-16 | Onboarding | Consent announcement = full onboarding (≤3 sentences, ≤8 s); printed card is the reference | "Feature wall" is the top VUI onboarding failure; humans retain <5–7 audio items. The card is the persistent zero-screen reference. |
| D-DD-17 | Roger vs. Wilco | E1 = "I heard the wake word"; E3 = "I'm acting on it" | Receipt ≠ compliance (ATC). The room must hear *received* vs. *acted*; these are never the same sound. |
| D-DD-18 | Callsign re-use cooldown | 60 s before a halted callsign is re-available | Avoids muscle-memory confusion when a just-halted callsign is reassigned moments later. |
| D-DD-19 | Execution mode | One mode for V0: dangerous / run-to-completion (no Safe/Explicit/Dangerous switching) | Cut mode-switching for speed. Run-to-completion by default; safety later = sandbox the whole process, not voice-toggled permission modes. (Supersedes the former session-only "dangerous mode" toggle.) |
| D-DD-20 | "Selected" color | Cyan `#00bcd4` | Distinct from green/amber/red; cyan is the Echo active-listening color — reuses an existing mental model. |
| **D-DD-21** | **Mute/unmute words** | **"mute" (mute) / "unmute" (unmute) — plain English** | Closes the `[mute word]` gap. Cue handles wake/keyword robustness, so no exotic collision-resistant words are needed; plain words remove onboarding friction. |
| **D-DD-22** | **Unmuting while muted** | **No custom spotter. Cue hears "unmute" even while muted; an on-screen unmute button is also always available** | "Muted" = stop feeding audio into the suggestion/routing pipeline; Cue keeps listening for "unmute". Two unmute paths (voice + button) mean the room is never trapped. The bespoke on-device spotter, P-SPOTTER probe, and teardown/restart recovery are removed. |
| **D-DD-23** | **Earcons & acks** | **Ignored ambient speech is silent; tonal state earcons + addressed-command acks remain** | `observe.pass` / `route.pass` make no sound by definition — un-addressed speech should make no noise. The 5 tonal state earcons (Layer A) and non-tonal addressed-command acks (Layer B) stay, disjoint by construction. |
| **D-DD-24** | **Vocabulary tiering** | **Deferred — no always-hot vs. state-gated tiering in V0** | Cue handles wake/keyword activation, so the tiered vocabulary and its scaling collision bar are not a V0 requirement. Revisit later only if it becomes a problem. |
| **D-DD-25** | **Verification stance** | **Integration-only: verify our seams with the libraries (typed providers + mocks), not the libraries themselves; no formal restraint corpus** | Cue is battle-tested by Etheria; we verify our adapter/dispatch/policy code via typed, mockable provider interfaces plus real-API probes for the shapes we depend on. Tunable behavior is env-driven and tuned by feel — the formal labeled restraint corpus is dropped. |

---

## 15. Open blockers & risks surfaced to the orchestrator's gate

Surfaced here (and in the structured output) for the gate — **not** raised as a human request from
within this pass.

- **P-CUE repo availability (P0 BLOCKER).** Upstream artifacts disagree on whether
  `github.com/jameslbarnes/cue` is publicly accessible (`domain.md` §7 unconfirmed 2026-06-13;
  `prior-art.md` §1 documents the API as found). **Confirming access and running P-CUE is the first
  build task.** Every Cue claim in §11.1 is README-derived and unconfirmed; if the repo is
  unavailable or the API differs, REQ-1/3/5/6/7 design must be revised.
- **TTS provider unverified (P-TTS).** No prior benchmark covered TTS; the probe both validates and
  selects. Latency target (first byte ≤200 ms) is unproven until the probe runs.
- **Cue↔Smithers seam (P-SEAM).** Novel integration with no prior art; top integration risk.
- **Unmute-while-muted depends on Cue.** We assume Cue keeps surfacing the "unmute" keyword while the
  pipeline is paused (P-CUE must confirm). The on-screen unmute button is the guaranteed fallback so
  the room is never trapped muted.
- **Mistranscription blast radius.** ~7.4% WER on technical speech. V0 runs dangerously by design;
  the mitigations are the panic word + emergency stop, and (later) sandboxing the process — not a
  per-action read-back gate.

---

## 16. Decision observability index (HTML decision docs)

Significant final-pass judgment calls have self-contained HTML decision docs under
`artifacts/smithering/decisions/` — what was decided, alternatives considered, example
inputs/outputs, and diagrams/diffs where they help a human review fast:

- `validation-as-centerpiece.html` — integration-only verification stance (**D-DD-25**)
- `mute-unmute-words.html` — choosing the plain words "mute"/"unmute" (**D-DD-21**)
- `mute-local-spotter.html` — superseded: no custom spotter; unmute = "unmute" (Cue) + on-screen button (**D-DD-22**)
- `earcon-vs-routing-ack-layering.html` — ignored ambient is silent; two disjoint non-verbal layers (**D-DD-23**)
- `always-hot-callsigns.html` — superseded: tiered vocabulary deferred for V0 (**D-DD-24**)
