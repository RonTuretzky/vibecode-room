# Panopticon — Design Document (V0, final)

> **Audio-only. Voice is the sole operational modality.** Design, build, and verify as if no
> screen and no keyboard exist on any critical path.
>
> Upstream (read from disk, not assumed): `docs/planning/01-prd.md` (requirements & binding
> decisions D1–D6), `artifacts/smithering/research/design-art.md` (design research),
> `artifacts/smithering/research/domain.md`, `artifacts/smithering/research/prior-art.md`.
> Predecessor: `docs/planning/02-design-draft.md` (reviewed → approved).
>
> This doc translates PRD requirements into concrete design decisions and — first and foremost —
> the **verification plan that proves each decision works**. Per the operating bar, the
> verification plan is the centerpiece, not an afterthought: every design component below carries
> an inline **Verify** block (the specific unit/integration tests AND end-to-end tests that prove
> it), and §13 consolidates them into a single component→test→observability matrix. Decisions are
> recorded in §14 with rationale; significant final-pass judgment calls also have standalone HTML
> decision docs (§16).
>
> **Reading order for a verifier:** §1 (how verification is treated) → §13 (the consolidated
> matrix and harness) → §11 (the real-API probe gates). The design sections (§2–§10, §12) exist to
> be tested; each ends with its own Verify block so no behavior is described without the test that
> proves it.

---

## 0. What changed in the final orchestrator pass

This document supersedes `02-design-draft.md`. The draft was approved; this pass tightens it and
closes four concrete gaps the draft left open. Nothing from the approved draft was removed; the
changes are additive or corrective.

1. **Validation & observability promoted to the structural centerpiece.** Every design section now
   carries an inline **Verify** block (unit AND e2e, with the red-before-green failure injection
   named). §13 adds a full per-component verification matrix, a boundary/fuzz/benchmark catalog
   sized to the 10×–100× bar, and the structured-log schema. §11 now names the **exact** third-party
   API surface each probe must exercise against the real library, with the assertions that gate
   build. (Decision **D-DD-25**, HTML: `validation-as-centerpiece.html`.)
2. **Concrete mute/unmute words chosen.** The draft (and PRD) carried a `[mute word]` placeholder
   and used the conversational words "Mute"/"Listen" — which `design-art.md` §4 explicitly warns
   against. Final pass selects **"Curtain"** (mute) and **"Daybreak"** (unmute): rare,
   plosive-leading, 2 syllables, a paired metaphor, provisional pending P-CUE acoustic validation.
   (Decision **D-DD-21**, HTML: `mute-unmute-words.html`.)
3. **The "no observations while muted" vs. voice-unmute contradiction resolved.** REQ-2 AC2.3 says
   *no observations are produced while muted*, but D1 makes voice the sole operational modality —
   so something must still hear "Daybreak." Final pass specifies an **on-device unmute keyword
   spotter** that runs while muted: it streams nothing to the cloud ASR, persists nothing, and
   emits exactly one event class (`mute.released`) — preserving AC2.3 while keeping unmute
   hands-free. (Decision **D-DD-22**, HTML: `mute-local-spotter.html`, new §12.)
4. **"Exactly 5 earcons" reconciled with routing-acks.** The draft said "exactly 5 earcons, no
   more" then added routing acks ("tick-tick", "whoosh"). Final pass makes the layering explicit
   and intentional: the 5 are the **tonal state earcons**; routing acks are a separate,
   deliberately **non-tonal** ack layer, categorically distinguishable so the two never collide.
   (Decision **D-DD-23**, HTML: `earcon-vs-routing-ack-layering.html`.)
5. **Command vocabulary tiered into always-hot vs. state-gated.** This explains why "Yes"/"Accept"
   may be acceptance words despite the no-conversational-words rule (they are only matched inside
   the narrow pending-suggestion window), and why callsigns/wake/mute/panic must pass the strict
   rarity+collision bar (they are always live). The collision-resistance bar **scales with the cost
   of a false trigger**. (Decision **D-DD-24**, HTML: `always-hot-callsigns.html`.)

---

## 1. How verification is treated in this document (the bar)

We hold an **extremely high validation bar**: assume **no behavior works until a test that was
capable of failing proves it works**. "The agent said it's done" is never evidence. This is not a
closing checklist — it shaped every decision below.

- **Unit/integration AND end-to-end — it is an AND.** Every behavior gets both. The bar: if we
  deleted either layer, the surviving layer alone should still leave us *fairly confident* the
  behavior holds. Each Verify block names both.
- **Red-before-green is mandatory.** Each test must be demonstrated capable of failing before it is
  trusted. Every Verify block names the **failure injection** that proves the test can go red
  (remove the guard / breach the budget / cross the boundary), then is restored to green.
- **10×–100× more verification than a human would write.** The criteria here are the *floor*. §13.5
  catalogs the corner cases, error paths, boundary conditions (empty / largest / silence /
  simultaneous-speaker / mis-transcription), fuzz inputs, and benchmarks that each component must
  additionally carry. Performance-critical paths (the ≤300 ms earcon, the <1 s round-trip) get
  recorded benchmark baselines that fail on regression.
- **Validate third-party APIs against the real thing first.** Cue, Smithers, the ASR provider, the
  TTS provider, and the cheap/fast decision LLM are all **non-framework third-party dependencies**.
  Per §11, each is exercised by a probe that calls the **real** API and asserts the exact methods,
  arguments, and return shapes we rely on — **before** any product code is built on it. React and
  standard libraries are exempt. **P-CUE is a P0 blocker** (see §11.1, §15).
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

### 2.2 Mute / unmute words — "Curtain" / "Daybreak" (final-pass decision)

The draft left `[mute word]` unbound and used "Mute"/"Listen" — both of which appear in ordinary
team speech ("can you mute that", "listen, I think…"), which `design-art.md` §4 explicitly warns
against for always-hot words. Final pass selects:

| Function | Word | Why |
|----------|------|-----|
| Mute | **"Curtain"** | Rare in technical conversation; 2 syllables; /k/ plosive onset (design-art §1); metaphor "curtain drawn = not listening". |
| Unmute | **"Daybreak"** | Rare; 2 syllables; /d/ plosive onset; paired metaphor "day breaks = listening resumes"; drives the on-device unmute spotter (§12). |

Both are **provisional pending P-CUE acoustic validation** against the team's actual vocabulary and
against "Panop"/"Abort"/all active callsigns (collision guard §5.3). Mute is **highest priority**:
it pre-empts every other cue (REQ-2 AC2.2). See **D-DD-21**.

### 2.3 Panic word — "Abort"

**Panic/global-halt word: "Abort."** "Stop" appears constantly in natural speech ("stop the build",
"stop doing that") and is reserved for *targeted* per-process halt; "Abort" is rare in casual team
conversation, 2 syllables, phonetically distinct from all other commands, and is reserved
**exclusively** for global panic — never a synonym for per-process stop. See **D-DD-04**.

### 2.4 Verify (words & priority)

- **Unit/integration:**
  - *Priority ladder test* — on a single utterance containing co-occurring triggers, assert the
    resolved order is **mute > panic > stop > steer > suggest > pass** (REQ-2 AC2.2, REQ-12 AC12.2).
    *Red-before-green:* swap mute below panic in the comparator → test fails; restore → passes.
  - *Word-rarity/collision test* — assert "Panop", "Curtain", "Daybreak", "Abort", and every active
    callsign pairwise pass the collision guard (Metaphone + phoneme-Levenshtein ≤2, §5.3).
    *Red-before-green:* inject "Listen" as the unmute word → collision with conversational corpus
    flags it → test fails; restore "Daybreak" → passes.
- **E2e:** live session — speak each always-hot word in isolation and assert its documented effect;
  speak a near-homophone in casual speech and assert **no** misfire; speak "Curtain"+"Abort" in one
  breath and assert mute wins and nothing is halted-then-heard.
- **Third-party:** P-CUE (`TextCue` match semantics, §11.1), P-ASR (finalization timing, §11.3).
- **Observability:** `wake.detected`, `mute.engaged`, `mute.released`, `process.halt{trigger:panic}`
  — each with `correlationId`, the triggering `utteranceId`, and measured `latencyMs`.

---

## 3. Earcon & routing-ack design (REQ-9, REQ-5 AC5.3) — two intentionally separate layers

The system speaks through **two categorically different non-verbal layers** so they can never be
confused. This resolves the draft's "exactly 5 earcons, no more" vs. the routing acks (see
**D-DD-23**, `earcon-vs-routing-ack-layering.html`).

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

### 3.2 Layer B — routing acks (deliberately non-tonal, so they never collide with Layer A)

Per-utterance routing receipts use **non-tonal** signatures (clicks/whoosh), categorically distinct
from the tonal earcons:

- `route.steer:X` → brief double-click ("tick-tick") after the wake/ack — "routed to a process".
- `route.suggestion` → single soft "whoosh" — "fed the suggestion engine".
- `route.pass` → **silence** — the deliberate ack for `observe.pass`.

**Roger vs. Wilco (ATC):** receipt ≠ compliance. E1 (wake chime) = "I heard the wake word"; E3
(spawn) = "I'm acting on the acceptance." These must never be the same sound (see **D-DD-17**).

### 3.3 Verify (earcons & acks)

- **Unit/integration:**
  - *Earcon-dispatch latency test* (mocked clock) — E1 fires ≤300 ms after the wake transcript is
    `isFinal`; dispatch is **never gated** on Smithers/LLM/TTS. *Red-before-green:* set budget to
    100 ms → fails; relax to 300 ms → passes (REQ-10 AC10.1).
  - *Acoustic-distinctness fixture* — assert E1–E5 differ in both pitch register and rhythm
    descriptor, and that every Layer-B ack is non-tonal (no pitched content), so Layer A and Layer B
    are disjoint by construction. *Red-before-green:* give a routing ack a pitched tone → overlap
    detector flags it → fails.
  - *Output-class → channel map test* — each trigger class resolves to exactly one of
    {silent, earcon, tts} (§7). *Red-before-green:* route "routine tick" → tts → fails.
- **E2e:** representative recorded session — assert each state transition emits its mapped earcon
  (REQ-5 AC5.3), the mute tone replaces E2 on "Curtain", and `observe.pass` emits **silence** (a
  positive assertion that no ack was emitted, not merely "nothing logged").
- **Third-party:** P-LLM/P-CUE for the decision that *selects* the class (the class→sound map itself
  is local and framework-free).
- **Observability:** `earcon.emit{id, latencyMs}`, `route.{steer|suggestion|pass}{utteranceId, ackKind}`.

---

## 4. Ambient suggestion engine design (REQ-3)

### 4.1 Gate: room-interrupt cost, not just suggestion quality

The REQ-3 floor (≥60 words **OR** ≥90 s of substantive talk) is the right shape. The design adds
**room-interrupt cost** as a first-class dimension — a spoken suggestion is a broadcast interrupt
with no per-person opt-out (`design-art.md` §3):

```
fire = gate_passed AND quality >= quality_threshold AND interrupt_cost <= cost_ceiling
```

`interrupt_cost` rises with: active speech velocity (words/min over last 30 s), utterance recency
(ended <5 s ago = high), and any pending steerings (in-flight work = elevated). A suggestion fires
only when `gate_passed AND (interrupt_cost low OR room idle ≥10 s)`. Otherwise it is **queued** and
delivered on the next idle gap (Cue `IdleCue`, §11.1). A queued suggestion **expires after 90 s**
with no idle gap (logged `suggestion.expired`, **not** spoken) — a 90-s-old idea about a topic the
room has moved past is stale (see **D-DD-15**).

### 4.2 Delivery format

`[≤12-word spoken concept pitch] [pause] [1–3 MCQs answerable aloud]`. MCQs are enumerated aloud
("First question: …. Second question: …"), **never >3**. Silence for 5 s after the last MCQ = "no
answer" → re-queue once for the next idle gap, then discard on the second non-answer. **Apologetic
language is prohibited** ("I noticed you might want to…" is banned); "Here's an idea: [pitch]" is
the ceiling — brevity signals confidence (`design-art.md` §3). See **D-DD-03**.

### 4.3 Verify (suggestion engine)

- **Unit/integration:**
  - *Gate-boundary tests* — 59 words → `observe.pass`; 61 → eligible; 89 s → pass; 91 s → eligible.
    *Red-before-green:* move the threshold to 50 words → the 59-word case fires → fails.
  - *MCQ-count invariant* — never emit >3 MCQs. *Red-before-green:* force 4 → fails.
  - *Interrupt-cost test* — with speech velocity high / utterance <5 s old, a gate-passed suggestion
    is **queued, not spoken**; with room idle ≥10 s it fires. *Red-before-green:* zero out
    `interrupt_cost` → it fires mid-speech → fails.
  - *Expiry test* — a queued suggestion with no idle gap for 90 s is discarded and logged
    `suggestion.expired`, never spoken.
  - *Live-knob test* — cadence and TTL patch at runtime without restart (AC3.5).
- **E2e:** the **annotated replay suite** (record-replay harness, temperature-0 decisions, §13.1) —
  assert recall **≥80%** on ground-truth "should suggest" segments and **≤1 false-positive / 10 min**
  on "should pass" audio (AC3.4); assert idle-preference (a queued idea is held until an idle gap,
  never spoken over active talk). *Red-before-green:* shuffle the ground-truth labels → recall
  collapses → suite fails, proving it discriminates.
- **Third-party:** P-CUE (`WordCountCue`, `IdleCue`, `IntervalCue`, `cooldownSeconds`, `observe.pass`),
  P-LLM (cheap/fast scoring, temperature-0 determinism).
- **Observability:** every decision — **fire and every `observe.pass`** — logs `{policy, wordCount,
  elapsedS, quality, interruptCost, decision, decisionId, correlationId}`.

---

## 5. Command vocabulary & callsign design (REQ-6, REQ-7)

Commands are deterministic: **same transcript → same routing decision, every time** (record-replay
confirms, AC7.3).

### 5.1 Tiered vocabulary — always-hot vs. state-gated (final-pass decision)

The vocabulary splits into two tiers; the **collision-resistance bar scales with the cost of a
false trigger** (see **D-DD-24**, `always-hot-callsigns.html`):

- **Always-hot** (matched at any time, so they must be rare/non-conversational and pass the §5.3
  collision guard): wake ("Panop"), every process **callsign**, mute ("Curtain"), unmute
  ("Daybreak"), panic ("Abort"), targeted stop ("Halt"). High-misfire-cost words (mute, panic,
  callsigns) get the **strictest** bar; low-cost words ("Status", whose only effect is a ≤15-word
  read-out) tolerate more conversational overlap.
- **State-gated** (matched **only** inside a narrow context window, so they may reuse natural
  words): accept ("Yes"/"Accept"/"Do it") and decline ("No"/"Nah"/"Skip") — active **only** in
  `SUGGESTION_DELIVERY`; "Done"/"Back" — active only inside an open steering window; "Confirm" —
  active **only** while a destructive read-back is pending (§8). This is why "Yes" is a legal accept
  word despite `design-art.md` §4's no-conversational-words rule: it is never live except as a
  direct answer to a question the system just asked.

### 5.2 V0 magic-word vocabulary

| Command | Spoken form | Tier | Effect |
|---------|-------------|------|--------|
| Wake | "Panop" | always-hot | Opens active-listen window for next utterance |
| Accept | "Yes" / "Accept" / "Do it" | state-gated (suggestion) | Accepts pending suggestion → spawns |
| Decline | "No" / "Nah" / "Skip" | state-gated (suggestion) | Declines pending suggestion → no-op |
| Select-and-steer | "[callsign], [instruction]" | always-hot (callsign) | Selects process, opens steering window, routes instruction |
| Select only | "[callsign]" | always-hot | Selects process, opens steering window |
| Steer | (after select) "[instruction]" | state-gated (window) | Routes instruction to selected process |
| End steering | "Done" / "Back" | state-gated (window) | Closes the steering window |
| Pause all | "Pause all" | always-hot | Pauses all running processes |
| Status | "Status" | always-hot (low-cost) | Speaks brief summary of active processes (≤15 words) |
| Stop (targeted) | "Stop" / "Halt" | always-hot | Halts the currently selected process |
| Panic (global) | "Abort" | always-hot | Halts all processes, closes steering windows |
| Mute | "Curtain" | always-hot | Stops cloud audio streaming (§12) |
| Unmute | "Daybreak" | always-hot (local spotter) | Resumes audio streaming (§12) |
| Confirm | "Confirm" | state-gated (read-back) | Confirms a pending destructive-action read-back |

### 5.3 Callsign pool & collision guard

A proposed callsign is **rejected** if its Metaphone code matches, **or** its phoneme-Levenshtein
distance is ≤2 to, any active callsign / wake / mute / unmute / panic word. V0 ships a pre-validated
NATO subset:

```
Atlas    Bravo    Delta    Foxtrot    Golf
Hotel    India    Juliet   Kilo       Lima
```

No two concurrent processes share a callsign. Callsigns are assigned in sequential order at spawn;
a halted process's callsign is **not** re-available for **60 s** (muscle-memory confusion guard,
**D-DD-18**). See **D-DD-05** for the holistic-set rationale (ICAO 1948–49).

### 5.4 Steering-window lifecycle

1. **Opens on:** callsign detection (always-hot), including one-breath "Atlas, make it faster".
2. **Routes** subsequent speech to the selected UPID **only**.
3. **Closes on:** "Done"/"Back", **OR** 20 s of mic-level idle, **OR** "Abort".
4. **While open:** the Layer-B routing ack (§3.2) marks each routed utterance.

### 5.5 Verify (vocabulary & routing)

- **Unit/integration:**
  - *Dispatch-invariant test* — a steering verb with no in-utterance callsign and no open window is
    **rejected at dispatch, not by the LLM** (REQ-6 AC6.1). *Red-before-green:* remove the guard →
    un-addressed talk steers a process → fails; restore → passes.
  - *Routing-exclusivity test* — each utterance resolves to exactly one of {suggestion, steer:X, pass}.
  - *Tier-gating test* — "Yes" outside `SUGGESTION_DELIVERY` is inert (does not accept anything);
    "Confirm" outside a pending read-back is inert. *Red-before-green:* make "Yes" always-hot → a
    casual "yes" spawns a process → fails.
  - *Collision-guard test* — reject a callsign within distance ≤2 of an active one / wake / mute /
    panic. *Red-before-green:* add "Delta" while "Della"-like is active → must reject.
  - *Determinism test* — replay the same transcript N× → identical decisions every time.
  - *Window-lifecycle test* — open on callsign; close on "Done" / 20 s idle / "Abort".
  - *Re-use cooldown test* — a halted callsign is unavailable for 60 s.
- **E2e:** live multi-utterance script — un-addressed talk only ever feeds suggestions (never
  steers); one-breath select-and-steer routes correctly; a near-homophone of a callsign in casual
  speech does **not** mis-select; each documented command yields its documented effect; an
  undocumented phrase yields no command.
- **Third-party:** P-CUE (`TextCue`, `SpeakerWordCue`, two-`Program` routing).
- **Observability:** `command.recognize{phrase, matchedCommand|null, tier, distanceScore}`,
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
  │            [callsign]──► STEERING_WINDOW(UPID)         ← always-hot: no wake needed
  │                              │
  │                    [instruction]──► STEER(UPID) ──► ACK ──► STEERING_WINDOW
  │                    [done/idle20s]──► IDLE
  │                    [abort]──► GLOBAL_HALT
  │
  └──[mute word]──► MUTED (always wins from any state; only "Daybreak" via §12 local spotter exits)
```

### 6.2 Stage-transition audibility (AC5.3)

Every transition emits an identifiable signal: IDLE→ACTIVE_LISTEN = E1; →SUGGESTION_DELIVERY = soft
spoken pitch begins; ACCEPT→SPAWN = E3 + spoken callsign; STEERING_WINDOW open = Layer-B tick-tick
per routed utterance; STEER→ACK = spoken read-back ≤7 words ("Got it: [summary]"); HALT = E5 +
spoken callsign + "halted"; MUTED = E2 silent, persistent low tone starts.

### 6.3 Sub-second acknowledgement (REQ-10) & correlation threading

E1 fires **≤300 ms** after ASR finalizes the wake transcript, **before** any downstream decision,
Smithers call, or TTS render. Each loop iteration gets **one `correlationId`** minted at
wake-detection that propagates `transcript → decision → action → spoken ack`; one query on it
reconstructs the full loop.

### 6.4 Verify (the spine)

- **Unit/integration:** *stage-sequencer test* drives all four stages through the happy path **and**
  each single-stage failure (mis-heard wake, empty intent, action error, TTS failure), asserting
  the correct recovery/ack at each boundary. *Red-before-green:* drop the ack on the action-error
  branch → fails.
- **E2e:** the **canonical scenario test** — scripted audio drives wake→intent→action→confirm
  against the live stack; run **≥10×**, assert **≥9 pass** (AC5.2) with each failure attributable to
  a logged cause; a **no-screen harness** asserts **zero** GUI/keyboard events were consumed
  (AC5.1). *Red-before-green:* feed a build with a broken dispatcher → ≥2 runs fail → suite reports
  red, proving it can detect spine breakage.
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
| Destructive read-back | TTS | ≤20 words (action + "confirm?") |
| Explicit "status" ask | TTS | ≤15 words |
| State transition | Earcon | ≤500 ms |
| Routine progress / tick | Silent | — |
| `observe.pass` | Silent | — |

**Never emit to TTS:** file names, diff contents, URLs, stack traces, raw output — summarize instead
("The diff is ready. Say 'continue' to apply."). The **15-word guard** is a hard truncator in the
TTS pipeline stage: count words → ≤15 submit as-is → >15 summarize via the **cheap/fast** LLM (never
Opus, NG-9) and resubmit. **90%-silence target:** default class is `silent`; a per-session
TTS-bearing-tick counter tightens the gate (explicit-ask-only) if >10% in a rolling 5-min window.
**TTS voice:** one consistent, calm, neutral, non-persona voice across all events — selected once
per session, not per-utterance.

### 7.2 Verify (output policy)

- **Unit/integration:** *class→channel map test* (each trigger → {silent|earcon|tts}); *15-word
  guard test* (16-word candidate → summarized; 15 → as-is) — *red-before-green:* feed 16 words and
  remove the guard → recited verbatim → fails; *never-recite test* (file/diff/URL payload is never
  sent to TTS); *silence-budget test* (>10% TTS-bearing ticks in the window → gate tightens).
- **E2e:** representative session — count TTS-bearing ticks / total, assert **≤10%** (AC9.1); assert
  every TTS utterance is in an allowed class and ≤15 words. *Red-before-green:* inject a chatty build
  → ratio exceeds 10% → test fails.
- **Third-party:** P-TTS (streaming start latency), P-LLM (summarizer ≤2 s).
- **Observability:** `output.decision{tickId, class, channel, wordCount, summarized:bool}`.

---

## 8. Safety & execution posture design (REQ-11)

### 8.1 Default: Safe + Optimistic

Processes run autonomously to completion by default. The safety gate fires **only** on
destructive/irreversible verbs (delete, overwrite, force-push, rm, drop, truncate), classified
**deterministically at the point the agent produces the action, before execution** — via a static
verb whitelist; the action payload is never trusted on its own.

**Read-back:** "I'm about to [verb] [object]. Say 'confirm' to proceed." — `[verb]` = one word,
`[object]` ≤3 words; "confirm" is reserved exclusively for this gate (state-gated, §5.1).
**Dead-man timer:** armed at read-back emission, **25 s** (mixed-criticality aviation midpoint —
20 s too tight in a busy room, 30 s too slow for urgent acts; **D-DD-06**). On timeout: action
aborts, process emits E5, logs `safety.resolution{confirmed:false, timedOut:true}`.
**Dangerous mode** (opt-in by voice, **session-only**, re-confirmed with a spoken warning each
session start, **D-DD-19**) disables the gate.

### 8.2 Verify (safety)

- **Unit/integration:** *posture state-machine test* — destructive verb in Safe mode → read-back +
  wait; no "confirm" within 25 s → **abort** (*red-before-green:* let the action fire without
  confirmation → fails); Dangerous mode bypasses only when explicitly enabled; *error-path/fuzz* —
  garbled confirm token, "confirm" addressed to the wrong process, double-confirm → all resolve
  safely, **never double-execute**; *dead-man-timer test* — 25 s elapsed → abort, process not
  executed (mocked clock).
- **E2e:** live — instruct a process toward a destructive act; assert read-back + block; withholding
  "confirm" aborts after the timer; speaking "confirm" proceeds **exactly once**.
- **Third-party:** P-SMITHERS (pause/steer/cancel mid-run so the gate can actually hold an action).
- **Observability:** `safety.readback{action}`, `safety.resolution{action, confirmed|aborted|timedout, timerMs}`.

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
human-factors audit). **Blink** is reserved for exactly two states: destructive-read-back pending,
and emergency-stop triggered (**D-DD-09**). **Auto-scroll disabled**; a "NEW" indicator appears when
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
Say 'Curtain' to pause. [earcon E2 begins]"
```

(Updated from the draft's `[mute word]` to the chosen "Curtain".) **Printed A6 magic-word card** (a
build artifact, posted near the primary mic) is the persistent reference for a zero-screen room —
**not optional**; it lists the wake word, all magic commands, active callsigns, mute/unmute, and the
panic word. **Progressive disclosure:** capabilities are not announced, only responded to.
**Near-miss soft landing:** an utterance within Levenshtein ≤2 of a documented command (and no other
route) → "Did you mean '[closest]'? Say it again to confirm." — disabled after the first 20 min.
**First-run VAD:** end-of-utterance silence threshold extended **+50%** for the first 5 min
(**D-DD-10**).

### 10.1 Verify (onboarding)

- **Unit/integration:** *consent-scheduler test* — fires **once** per session, idempotent, within
  3 s of start (AC1.1); *near-miss test* — distance-≤2 non-match → soft landing; exact match → no
  prompt; *first-run VAD test* — threshold is +50% for 5 min then reverts (mocked clock).
  *Red-before-green:* make the scheduler fire twice → idempotency test fails.
- **E2e:** live — assert the consent line is spoken **first**, names the actual mute word "Curtain",
  the listening indicator is active for the whole session, and a post-run disk/log scan finds **zero**
  audio artifacts (REQ-1 AC1.3; *red-before-green:* introduce a `.wav` write path → scan fails).
- **Third-party:** P-ASR, P-TTS.
- **Observability:** `session.start{provider, consentSpoken:true}`, `onboarding.nearMiss{phrase, closest, distance}`.

---

## 11. API & integration design + real-API probe gates

Every probe below calls the **real** library and asserts the **exact** methods/arguments/return
shapes we depend on, **before** product code is built on it. A probe that *could* fail and *passed*
is the evidence; docs and memory are not. Probe artifacts live under `artifacts/smithering/probes/`;
results under `artifacts/smithering/reports/`. All are currently **unrun** — nothing below is
confirmed yet.

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

All model calls route through **Smithers subscriptions — never a raw API key.** Probe asserts, against
the real harness: durable-run spawn with seed payload; `streamRunEvents` (SSE) shape; pause/resume;
steer/signal (mid-run injection); pre-kill context archive; restart recovery to last checkpoint;
concurrent durable runs (fleet, REQ-13). **Fork may require a fresh seeded run + `parentId` lineage
rather than a native fork — the probe must determine which.**

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
only** — target Cerebras-served Llama or Haiku-4.5. **No Opus/Sonnet in the hot loop** (NG-9). The
per-process planning agent (via Smithers) uses a richer model per subscription config. Probe asserts:
temperature-0 determinism (record-replay compatibility); p50 latency within the ~100 ms hot-loop
budget; the emitted action/tool-selection schema matches `MappedActionTool`.

---

## 12. Mute-while-listening architecture — the on-device unmute spotter (final-pass decision)

**The gap caught in this pass:** REQ-2 AC2.3 requires that **while muted, no observations are
produced and no audio streams to the ASR provider**. But D1 makes voice the sole *operational*
modality — so *something* must still hear "Daybreak" to unmute hands-free. The draft did not say
what. (See **D-DD-22**, `mute-local-spotter.html`.)

**Resolution.** "Curtain" engages a **hard mute of the cloud path** — the audio stream to the ASR
provider stops within 500 ms (AC2.1), the transcribing-ambient earcon E2 is replaced by the
persistent mute tone (§3.1), and **zero transcript observations** are produced or persisted (AC2.3).
While muted, a **minimal on-device keyword spotter** stays active. It:

- runs **fully local** (no network), so nothing leaves the room and **no raw audio or transcript is
  written** (preserves NG-6 / AC1.3 / AC2.3 — it is not "the ASR" and produces no observations);
- matches **exactly one** keyword, "Daybreak", and **emits exactly one event class** on a match —
  `mute.released` — and nothing else (it cannot transcribe, route, suggest, or steer);
- on match: re-opens the cloud ASR stream, restores E2, and logs `mute.released{trigger: voice, latencyMs}`.

If the local spotter is unavailable on a given host, unmute degrades to the **non-voice emergency
control** (REQ-14) — which already exists as the bounded off-path safety hatch — so the room is never
trapped muted. This keeps voice the operational modality without violating "no observations while
muted."

### 12.1 Verify (mute/unmute)

- **Unit/integration:**
  - *Mute-latency test* — "Curtain" stops the cloud stream ≤500 ms (mocked clock, AC2.1).
  - *No-observation-while-muted test* — in MUTED state, feed arbitrary speech and assert **zero**
    observations/suggestions/actions (AC2.3). *Red-before-green:* leave the cloud stream open on
    mute → observations appear → fails.
  - *Local-spotter scope test* — the spotter emits **only** `mute.released`; assert it has no code
    path that can transcribe, route, or persist. *Red-before-green:* give the spotter a second
    keyword → scope test fails.
  - *Spotter-silence test* — non-"Daybreak" speech (including near-homophones) produces **no**
    `mute.released` and no other output.
  - *Degradation test* — disable the spotter; assert the non-voice emergency control still unmutes
    and that the system never persists audio while muted.
- **E2e:** live — speak "Curtain"; assert streaming stops ≤500 ms (measured), E2 flips to the mute
  tone, and subsequent speech yields zero observations; then speak "Daybreak"; assert streaming
  resumes and E2 returns. Post-run disk/log scan finds **zero** audio artifacts across the muted
  interval. *Red-before-green:* route the muted-interval mic to a recorder → scan finds a blob → fails.
- **Third-party:** P-ASR (stream stop/restart semantics); the local spotter is validated as its own
  probe (on-device keyword model: assert it matches "Daybreak", rejects near-homophones, emits no
  transcript).
- **Observability:** `mute.engaged{latencyMs}`, `mute.released{trigger: voice|nonvoice, latencyMs}`,
  and a periodic `mute.heartbeat{streamingToCloud:false}` while muted so a debugging agent can prove
  the cloud path was closed for the whole interval.

---

## 13. Validation & observability — consolidated centerpiece

This is the heart of the document. §13.1 is the only testable seam over the AI surface; §13.2 is the
component→test matrix; §13.3 is the log contract; §13.4 the red-before-green protocol; §13.5 the
10×–100× catalog.

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

Every component has both layers; "RBG" names the failure injection that proves the test can go red.

| Component (§) | Unit/integration (with RBG) | End-to-end | Probe | Key observability |
|---|---|---|---|---|
| Priority ladder (§2.4) | mute>panic>stop>steer>suggest>pass; RBG: demote mute | co-occurring triggers in one utterance resolve correctly | P-CUE | `*.detected`, ordered `decisionId` |
| Mute/unmute (§12.1) | stop ≤500 ms; zero obs while muted (RBG: leave stream open); spotter scope (RBG: 2nd keyword) | speak Curtain→silent→Daybreak→resumes; disk scan = 0 audio | P-ASR + spotter probe | `mute.engaged/released/heartbeat` |
| Earcons & acks (§3.3) | E1 ≤300 ms (RBG: 100 ms budget); Layer A/B disjoint (RBG: pitched ack) | each transition emits mapped earcon; `observe.pass`=silence | P-LLM | `earcon.emit`, `route.*` |
| Suggestion engine (§4.3) | gate 59/61, 89/91 (RBG: lower threshold); MCQ≤3 (RBG: force 4); interrupt-cost queue (RBG: zero cost); expiry | annotated replay: recall ≥80%, ≤1 FP/10 min, idle-preference | P-CUE, P-LLM | per-decision incl. every `observe.pass` |
| Vocabulary & routing (§5.5) | dispatch-invariant (RBG: remove guard); tier-gating (RBG: "Yes" always-hot); collision; determinism | un-addressed never steers; one-breath steer; near-homophone safe | P-CUE | `command.recognize`, `route` |
| The spine (§6.4) | stage-sequencer happy + 4 failure branches (RBG: drop ack) | canonical scenario ≥9/10; no-screen harness = 0 GUI events | all probes | one `correlationId` across loop |
| Output policy (§7.2) | class→channel; 15-word guard (RBG: 16 words, remove guard); never-recite; silence budget | session TTS-tick ratio ≤10% (RBG: chatty build) | P-TTS, P-LLM | `output.decision` |
| Safety posture (§8.2) | read-back+wait; no-confirm→abort (RBG: fire without confirm); dead-man 25 s; fuzz tokens | destructive act blocks; withhold→abort; confirm→once | P-SMITHERS | `safety.readback/resolution` |
| Board (§9.1) | read-only (RBG: add POST); trace-schema; causal-chain rebuild | board-down → REQ-5 still passes (RBG: await board → hangs) | P-CUE SSE | renders §13.3 stream |
| Onboarding (§10.1) | consent once+idempotent (RBG: fire twice); near-miss; first-run VAD | consent first, names "Curtain"; disk scan = 0 audio | P-ASR, P-TTS | `session.start`, `onboarding.nearMiss` |
| Latency (REQ-10) | ack scheduler within budget; timeout→"working" earcon | ≥100 round-trips: p50<1 s, p95<1.5 s, earcon<300 ms; recorded baseline | P-ASR, P-TTS | latency spans `asr.final/decision/ack.emit` |
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

### 13.4 Red-before-green protocol (mandatory)

A test is trusted only after it has been shown to fail. The standard moves: **remove the guard** and
assert failure, then restore and assert pass (dispatch invariant, 15-word guard, mute stream-close);
**breach the budget** and assert failure, then relax to spec (earcon ≤300 ms, round-trip <1 s);
**cross the boundary** and assert the boundary holds (59/61 words, 89/91 s, distance-≤2 collision).
"The agent said it's done" is never accepted; the red run is the evidence.

### 13.5 Boundary / fuzz / benchmark catalog (the 10×–100×)

The Verify blocks are the floor. Each component additionally carries: **empty/longest inputs**
(empty transcript, single word, 10k-word monologue → all resolve to `observe.pass`); **silence**
(produces no observations, not empty ones); **simultaneous speakers** (2 talking at once — routing
and diarization stay sane); **mis-transcription** (garbled callsign/confirm → re-prompt or drop,
never destructive execution); **fuzz** (random confirm tokens, double-confirm, "confirm" to the
wrong process); and **benchmarks** for the performance-critical paths (earcon <300 ms, round-trip
p50<1 s / p95<1.5 s) recorded as regression baselines that **fail on regression**. Anything
unverified is treated as broken.

---

## 14. Design decisions log

| ID | Topic | Decision | Rationale |
|----|-------|----------|-----------|
| D-DD-01 | Wake word | "Panop" (not "Panopticon") | 5-syllable full name has a soft /p/ onset and poor keyword anchor. "Panop" is 2 syllables, rare, plosive-leading, preserves name recognition. Re-confirm vs. team vocabulary in P-CUE. |
| D-DD-02 | Earcon set | Exactly 5 tonal state earcons (wake, transcribing-ambient, spawn, resolve, stop) | Distinct non-verbal signatures per state beat spoken announcements (`design-art.md` §2). 5 is the minimum distinguishable set; additions require an acoustic-distinctness check. |
| D-DD-03 | Suggestion threshold | Gate on **room-interrupt cost**, not just quality | A spoken suggestion is a no-opt-out broadcast interrupt; annoyance ∝ frequency (CHI 2025). FP cost in a room ≫ FP on a screen. Idle-preferring delivery is non-negotiable. |
| D-DD-04 | Panic word | "Abort" (not "Stop") | "Stop" is constant in speech; "Abort" is rare, 2 syllables, distinct, reserved exclusively for global panic. |
| D-DD-05 | Callsign collision guard | Metaphone + phoneme-Levenshtein ≤2 | ICAO 1948–49: design the active set holistically. At 7.4% WER, similar callsigns misroute. Algorithm must be reproducible and tested. |
| D-DD-06 | Dead-man timer | 25 s | 20 s too tight in a busy room; 30 s too slow for urgent acts; 25 s = aviation mixed-criticality midpoint. |
| D-DD-07 | Board layout | Z-pattern, listening top-left, per-process panels, trace bottom, no controls | NASA MOCR / STARS: role-based segregation, tiered authority, "read-only displays have no buttons." |
| D-DD-08 | Trace auto-scroll | Disabled; "NEW" indicator, click to scroll | Auto-scroll past readable speed makes the log worthless; the only click target is navigational. |
| D-DD-09 | Blink policy | Only destructive-read-back-pending and emergency-stop blink | Peripheral blink is the fastest visual signal; blink fatigue (STARS audit) means it must not be wasted. |
| D-DD-10 | First-run VAD | +50% silence threshold for first 5 min | Mid-sentence pauses cut users off during first-run; one cut-off command kills onboarding confidence. |
| D-DD-11 | TTS word guard | Hard 15-word cap before submission | Spoken word count is the sole length measure in audio; the guard is a pipeline function, not a guideline. |
| D-DD-12 | Log naming | Verb-noun (`process.spawn`, `route.pass`) | Reads in event order, fast to scan, self-documenting (ATC naming, `design-art.md` §7). |
| D-DD-13 | Cue posture | Thin adapter we own; build only on confirmed primitives; record extensions as risks | PRD D2. Extensions live in our layer so Cue gaps never block us. P-CUE is a P0 blocker. |
| D-DD-14 | TTS provider | Unverified; selected by P-TTS probe (ElevenLabs Flash v3 / Cartesia Sonic / PlayHT 3.0 Turbo) | Research covered ASR, not TTS. The probe is also a benchmark; target first byte ≤200 ms. |
| D-DD-15 | Suggestion expiry | Queued suggestions expire after 90 s with no idle gap; logged, not spoken | A 90-s-old idea about a since-abandoned topic is stale; expiry avoids surfacing it on a later idle gap. |
| D-DD-16 | Onboarding | Consent announcement = full onboarding (≤3 sentences, ≤8 s); printed card is the reference | "Feature wall" is the top VUI onboarding failure; humans retain <5–7 audio items. The card is the persistent zero-screen reference. |
| D-DD-17 | Roger vs. Wilco | E1 = "I heard the wake word"; E3 = "I'm acting on it" | Receipt ≠ compliance (ATC). The room must hear *received* vs. *acted*; these are never the same sound. |
| D-DD-18 | Callsign re-use cooldown | 60 s before a halted callsign is re-available | Avoids muscle-memory confusion when a just-halted callsign is reassigned moments later. |
| D-DD-19 | Dangerous mode | Session-only; spoken warning each session start | Forces active re-acknowledgement; a persistent dangerous mode that survives restarts is an accident waiting to happen. |
| D-DD-20 | "Selected" color | Cyan `#00bcd4` | Distinct from green/amber/red; cyan is the Echo active-listening color — reuses an existing mental model. |
| **D-DD-21** | **Mute/unmute words** | **"Curtain" (mute) / "Daybreak" (unmute), provisional pending P-CUE** | Closes the `[mute word]` gap; replaces conversational "Mute"/"Listen" (`design-art.md` §4) with rare, plosive-leading, 2-syllable paired words. |
| **D-DD-22** | **Mute-while-listening** | **On-device unmute keyword spotter ("Daybreak") runs while muted; cloud path hard-muted** | Resolves AC2.3 ("no observations while muted") vs. D1 (voice is the sole operational modality): the spotter is local, persists nothing, emits only `mute.released`. Degrades to the non-voice control if absent. |
| **D-DD-23** | **Earcon vs. routing-ack layering** | **5 tonal state earcons (Layer A) + non-tonal routing acks (Layer B), categorically disjoint** | Reconciles "exactly 5 earcons" with the routing acks: making Layer B non-tonal guarantees the two layers never collide acoustically. |
| **D-DD-24** | **Tiered vocabulary** | **Always-hot vs. state-gated; collision bar scales with false-trigger cost** | Explains why "Yes"/"Accept" are legal (only live in the pending-suggestion window) while callsigns/wake/mute/panic must pass the strict rarity bar; "Status" (low misfire cost) gets a looser bar. |
| **D-DD-25** | **Validation as centerpiece** | **Each design section carries an inline Verify block; §13 consolidates a component→test matrix, the log contract, RBG protocol, and 10×–100× catalog** | The operating bar makes the verification plan the first-class deliverable; structuring the doc around it (not bolting tests on at the end) is what makes "assume nothing works until a test proves it" enforceable. |

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
- **Mute/unmute words provisional.** "Curtain"/"Daybreak" are chosen on principle but **must** pass
  P-CUE acoustic validation against the team's actual vocabulary before they are final.
- **On-device unmute spotter availability.** Assumed present; where absent, unmute degrades to the
  non-voice emergency control (REQ-14). The spotter needs its own probe (matches "Daybreak", rejects
  near-homophones, emits no transcript).
- **Mistranscription blast radius.** ~7.4% WER on technical speech; mitigated by safe-by-default +
  read-back + dead-man timer + panic word + emergency stop.

---

## 16. Decision observability index (HTML decision docs)

Significant final-pass judgment calls have self-contained HTML decision docs under
`artifacts/smithering/decisions/` — what was decided, alternatives considered, example
inputs/outputs, and diagrams/diffs where they help a human review fast:

- `validation-as-centerpiece.html` — restructuring the doc around verification (**D-DD-25**)
- `mute-unmute-words.html` — choosing "Curtain"/"Daybreak" (**D-DD-21**)
- `mute-local-spotter.html` — the on-device unmute spotter resolving AC2.3 vs. D1 (**D-DD-22**)
- `earcon-vs-routing-ack-layering.html` — two disjoint non-verbal layers (**D-DD-23**)
- `always-hot-callsigns.html` — tiered always-hot vs. state-gated vocabulary (**D-DD-24**)
