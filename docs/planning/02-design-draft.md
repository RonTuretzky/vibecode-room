# Panopticon — Design Document (Draft V0)

> **Superseded assumption corrected:** Panopticon is audio-first with voice as the primary routine
> control modality, and V0 includes a required shared projector UI for visual context.
>
> Upstream: `docs/planning/01-prd.md` (requirements), `artifacts/smithering/research/design-art.md`
> (design research). This doc translates PRD requirements into concrete design decisions: layout
> patterns for the observability board, API contracts for Cue/Smithers/ASR/TTS, earcon
> specifications, command vocabulary, and interaction ergonomics. Each decision is recorded with
> rationale in §12 and inline.
>
> **Posture (V0):** cut scope and ship fast — run dangerously / run-to-completion, trust the voice
> library (Cue, by Etheria), and make tunable parameters env-driven (tuned by feel later). We verify
> **our integration** with the libraries via typed, mockable provider interfaces — not the libraries'
> own correctness. See the final design (`02-design.md`) for the authoritative detail.
>
> This doc does **not** reproduce requirements — it answers "how" and "with what specifics."

---

## 1. Wake Word Design

### Decision: Coined short-form, not "Panopticon"

**Wake word: "Panop"** (2 syllables: /ˈpæn.ɒp/).

"Panopticon" is 5 syllables starting with a soft bilabial /p/ — poor acoustic onset for keyword
detection. "Panop" is rare (not a natural English word), leads with the same distinguishing
consonant cluster /pæn/, and lands at 2 syllables rather than the ideal 3–4 (acceptable tradeoff
given the team-room context where false-positive cost matters more than recall).

**Why not a fully coined word:** the team should recognize the wake word as related to the
product; a fully coined word increases onboarding friction for zero acoustic gain in a controlled
team-room environment.

**Global callsign alternatives if "Panop" causes problems in acoustic testing:**
- "Panwatch" (2 syllables, plosive-leading /p/, rare)
- "Opticon" (3 syllables, affricate-ish onset, also rare)

The chosen wake word must be re-confirmed against the team's existing technical vocabulary during
P-CUE validation. If the team regularly says words acoustically close to the wake word, substitute.

**See decision D-DD-01.**

---

## 2. Earcon Design

### V0 earcon set (exactly 5, no more)

Each earcon must be acoustically distinct from all others: different pitch register, different
rhythmic pattern, and tested for discriminability under conversational noise. All earcons are
≤500ms — earcons signal, they do not perform.

| # | Name | Pattern | Duration | Trigger |
|---|------|---------|----------|---------|
| E1 | **Wake/Active** | Ascending two-tone (C5→E5) | ≈300ms | Wake word detected; system now in active-listen mode |
| E2 | **Transcribing-Ambient** | Near-subliminal continuous hum (A2, ~-20dBFS) | Continuous | Mic streaming; should be felt-not-heard — presence, not intrusion |
| E3 | **Spawn Confirmed** | Single high note (G5, sharp attack) | ≈200ms | New durable process spawned |
| E4 | **Resolved/Completed** | Resolution chord interval (C4→E4→G4 arpeggiated) | ≈400ms | Process completed or significant positive outcome |
| E5 | **Stop/Halt** | Descending two-tone (E5→C4) | ≈300ms | Stop/panic word received; process halted |

**Mute state:** E2 (transcribing-ambient) goes silent AND a **distinct persistent low tone**
(D2, ~-15dBFS) plays continuously while muted. The contrast is: nothing = listening, persistent low
tone = muted. This is the inverse of E2 and unmistakable.

**Addressed-command ack earcons:** beyond the 5 earcon set, **addressed** routing decisions get
brief non-tonal ack signals (not earcons but functional equivalents). **Ignored ambient speech is
silent** — there is no ack for un-addressed speech:
- `route.steer:X` → brief double-click or "tick-tick" sound after the wake chime (signals
  "I routed to a process")
- `route.suggestion` → single soft "whoosh" (signals "feeding the suggestion engine")
- `route.pass` / `observe.pass` (ignored ambient) → **no sound**, by definition — un-addressed
  speech makes no noise. This is not a tunable knob.

The "Roger vs. Wilco" distinction (from ATC design research): the system needs two distinct
receipts for (a) "heard" vs. (b) "heard and acting on it." E1 (wake chime) = "I heard the wake
word." The spawn earcon E3 = "I'm acting on the acceptance." These must never be the same sound.

**See decision D-DD-02.**

---

## 3. Ambient Suggestion Engine Design

### Gate threshold design

The REQ-3 gate (≥60 words OR ≥90s of substantive talk) is the right shape. The design adds one
dimension: **room-interrupt cost**, not just suggestion quality.

The engine's decision function evaluates:
```
fire = gate_passed AND quality >= quality_threshold AND interrupt_cost <= cost_ceiling
```

Where `interrupt_cost` is a function of:
- Active speech velocity (words/min in the last 30s): high velocity = high cost
- Utterance recency: an utterance that ended <5s ago = high cost
- Pending steerings in any process: in-flight work happening = elevated cost

The suggestion fires only when gate_passed AND (interrupt_cost is low OR the room has been idle
≥10s). If the gate passes but interrupt_cost is high, the suggestion is queued and delivered on
the next idle gap (via Cue's `IdleCue` — see §7). The suggestion expires from queue after
`SUGGEST_TTL_SECONDS` (default 90) with no idle gap — at that point it is discarded, not spoken.

All of these — gate thresholds (`SUGGEST_MIN_WORDS`/`SUGGEST_MIN_SECONDS`), quality threshold, cost
ceiling, cadence, TTL — are **env-tunable params with documented defaults, tuned by feel later**.
There is **no formal labeled corpus or restraint metric** for V0.

**Why expire:** a queued suggestion about something the room discussed ~90 seconds ago may no
longer be relevant. Expired suggestions are logged (`suggestion.expired`) but not spoken.

### Suggestion delivery format

Delivered as: `[one-line spoken concept pitch] [pause] [1–3 MCQs answerable aloud]`.

- The pitch is ≤12 words (reads in ≈5s at natural speaking pace).
- MCQs are enumerated aloud: "First question: …. Second question: …." Never more than 3.
- Silence after the third MCQ for 5s = "no answer" → the suggestion is queued for re-delivery
  once on next idle gap, then discarded on second non-answer.

**Apologetic language is prohibited.** "I noticed you might want to…" is banned. "Here's an idea:
[pitch]" is the ceiling. Brevity signals confidence (design-art.md §3).

**See decision D-DD-03.**

---

## 4. Command Vocabulary & Callsign Design

### V0 magic-word vocabulary (fixed, enumerated)

Commands are deterministic: same transcript → same routing decision, every time.

| Command | Spoken form | Effect |
|---------|-------------|--------|
| Wake | "Panop" | Opens active-listen window for next utterance |
| Accept | "Yes" / "Accept" / "Do it" | Accepts the current pending suggestion → spawns |
| Decline | "No" / "Nah" / "Skip" | Declines current pending suggestion → no-op |
| Select-and-steer | "[callsign], [instruction]" | Selects process, opens steering window, routes instruction |
| Select only | "[callsign]" | Selects process, opens steering window |
| Steer | (after select) "[instruction]" | Routes instruction to selected process |
| End steering | "Done" / "Back" | Closes the steering window |
| Pause all | "Pause all" | Pauses all running processes |
| Status | "Status" | Speaks a brief summary of active processes (≤15 words) |
| Stop (targeted) | "Stop" / "Halt" | Halts the currently selected process |
| Panic (global) | "Abort" | Halts all processes, closes steering windows |
| Mute | "mute" | Stops feeding audio into the suggestion/routing pipeline (see §5 mute/unmute) |
| Unmute | "unmute" | Resumes the pipeline (Cue hears "unmute" even while muted; on-screen button also) |

**Why "Abort" not "Stop" for panic:** "Stop" appears in natural speech ("stop that process",
"stop working on it"). "Abort" is rare in casual team conversation, short (2 syllables), and
phonetically distinct from all other commands. It must not be used for anything other than the
global panic — "abort" cannot be a synonym for per-process stop.

**Steering window lifecycle:**
1. Opens on: callsign detection (or wake + callsign in one utterance)
2. Routes speech to: the selected process UPID only
3. Closes on: "Done"/"Back" spoken, **OR** 20s of mic-level idle silence, **OR** "Abort"
4. While open: the routing-ack earcon marks each utterance routed to the process

**Callsign collision guard algorithm:**

A proposed callsign is rejected if:
- Metaphone code matches any active callsign, the wake word, or the panic word
- OR phoneme-Levenshtein distance ≤2 to any active callsign / wake word / panic word

V0 ships with a pre-validated subset of NATO phonetic alphabet as the available callsign pool.
Suggested V0 callsign pool (validated for distinctiveness against each other and against
"Panop"/"Abort"):

```
Atlas    Bravo    Delta    Foxtrot    Golf
Hotel    India    Juliet   Kilo       Lima
```

No two concurrent processes can share a callsign. Callsigns from the pool are assigned at
process spawn in sequential order and re-used only after all 10 have been exhausted within a
session. A callsign of a halted process is not immediately re-available — wait 60s to avoid
muscle-memory confusion.

**See decisions D-DD-04, D-DD-05.**

---

## 5. Voice Interaction Loop Design (The Spine — REQ-5)

### State machine

```
IDLE ──[wake word]──► ACTIVE_LISTEN
  │                        │
  │            [suggestion pending] ──► SUGGESTION_DELIVERY
  │                        │                    │
  │                        │            [accept]──► SPAWN ──► PLANNING
  │                        │            [decline]──► IDLE
  │                        │
  │            [callsign]──► STEERING_WINDOW(UPID)
  │                              │
  │                    [instruction]──► STEER(UPID) ──► ACK ──► STEERING_WINDOW
  │                    [done/idle20s]──► IDLE
  │                    [abort]──► GLOBAL_HALT
  │
  └──[mute]──► MUTED (always wins; exits on "unmute" — heard by Cue — or the on-screen unmute button)
```

**Stage-transition audibility (REQ-5, AC5.3):** every stage transition must produce an
identifiable audio signal:
- IDLE → ACTIVE_LISTEN: E1 (wake chime)
- ACTIVE_LISTEN → SUGGESTION_DELIVERY: soft spoken pitch begins
- ACCEPT → SPAWN: E3 (spawn confirmed) + spoken callsign
- STEERING_WINDOW open: routing-ack tick-tick per routed utterance
- STEER → ACK: spoken confirmation ≤7 words ("Got it: [summarized instruction]")
- HALT: E5 (descending two-tone) + spoken callsign + "halted" (2 words max)
- MUTED: E2 goes silent, persistent low tone starts

**Ignored ambient speech emits no signal** (silence) — only addressed commands and state transitions
make sound.

**Mute / unmute.** Saying "mute" **stops feeding audio into the suggestion/routing pipeline**: within
500ms the system produces zero observations, suggestions, or actions, and E2 is replaced by the mute
tone. The voice library (Cue) keeps listening for "unmute" the whole time, so we build **no custom
on-device spotter**. Two ways to unmute: **say "unmute"** (Cue hears it even while muted) or **press
the on-screen "unmute" button** (always available, so the room is never trapped muted). On unmute,
the pipeline resumes and E2 returns.

**Sub-second acknowledgement (REQ-10):** the architecture must ensure E1 fires ≤300ms after
the wake-word transcript is finalized by ASR. The earcon fires before any downstream decision
logic runs. The earcon is never gated on Smithers response, LLM decision, or TTS render.

**Correlation ID threading:** each loop iteration gets a single correlation ID generated at
wake-word detection. This ID propagates through: transcript observation → decision → action →
spoken ack. Every log event in the chain carries it. One query on this ID reconstructs the
full loop.

---

## 6. Audio Output Policy (Hybrid Earcon + TTS — REQ-9)

### Output triage

Every process tick is classified before audio is emitted:

| Trigger | Channel | Max length |
|---------|---------|-----------|
| Completion / success | TTS | ≤15 words |
| Blocker / question needed | TTS | ≤15 words |
| Explicit "status" ask | TTS | ≤15 words |
| State transition | Earcon | ≤500ms |
| Routine progress / tick | Silent | — |
| Ignored ambient (`observe.pass` / `route.pass`) | Silent | — |

**Never emit to TTS:** file names, diff contents, URLs, stack traces, raw output. If the
process output contains these, summarize: "The diff is ready. Say 'continue' to apply."

**Ignored ambient speech is silent by definition** — un-addressed speech makes no sound.

**15-word guard:** implemented as a hard truncator in the TTS pipeline stage. Output >15 words
is summarized by the system before TTS emission. Summarization uses the same cheap/fast hot-loop
LLM as the suggestion engine — never the heavy planning model (NG-9).

**90% silence target:** the output-policy gate is the mechanism. Default classification is
`silent`. Only the listed trigger classes promote to earcon or TTS. The gate implementation
must be instrumented with a per-session TTS-bearing-tick counter; if the 10% threshold is
exceeded in a rolling 5-minute window, the gate tightens to require an explicit ask trigger
only.

**TTS voice selection:** consistent, calm, neutral voice — not enthusiastic or markedly
gendered. The room should perceive it as a neutral system voice, not an assistant persona.
A consistent voice across all TTS events prevents the "multiple assistants" confusion.

---

## 7. Execution Posture Design (REQ-11)

### V0: one mode — dangerous / run-to-completion

V0 has **one execution mode: dangerous / run-to-completion.** Processes run autonomously to
completion; there is **no per-action approval, no spoken read-back/confirm gate, and no dead-man
timer.** You shouldn't need to approve often — and where a confirmation is genuinely needed, the
voice library (Cue) already handles it. We minimize approvals rather than build a bespoke gate.

We **do not** build, in V0:
- a `PreToolUse` read-back/confirm hook or a safe-executor that holds destructive tool calls;
- a 25s dead-man timer;
- Safe / Explicit / Dangerous **mode switching** (there is only the one dangerous mode);
- a parse-based shell-command classifier that gates shell calls (read-safe vs. mutating). Nothing
  is gated — there is no `safety/shell-classifier.ts`.

**Routing authority still lives in deterministic code** (the LLM scores quality/intent; code decides
where an utterance goes), but execution is ungated. **Safety, when we want it later, comes from
sandboxing the whole process — not from permission classification.**

**See decision D-DD-06.**

---

## 8. Observability Board Design (REQ-16)

### Layout: mission-control console, strictly read-only

The board is a **debugging tool**, not a control surface. It has zero operational controls.
Every pixel is a display.

**Primary layout (inspired by NASA MOCR / ATC STARS):**

```
┌──────────────────────────────────────────────────────┐
│ [LISTENING] ●          [STATE: active]      [EMERGENCY: ready] │  ← top strip
├──────────────────────────────────────────────────────┤
│ PROCESS: Atlas              │ PROCESS: Bravo              │  ← process grid
│ State: ACTIVE (green)       │ State: PAUSED (amber)       │
│ Last output: "Diff ready"   │ Last output: "Planning..."  │
│ Last action: git diff       │ Last action: read files     │
│ Callsign: Atlas             │ Callsign: Bravo             │
│ UPID: …abc123              │ UPID: …def456              │
│ ─────────────────────────── │ ─────────────────────────── │
│ Action log (5 recent):      │ Action log (5 recent):      │
│  · tool.bash (2s ago)       │  · tool.read (18s ago)      │
│  · tool.read (8s ago)       │  · decision.plan (22s ago)  │
│  · tool.grep (14s ago)      │  · (paused 22s ago)         │
├──────────────────────────────────────────────────────┤
│ TRACE LOG (scrollable, no auto-scroll)                         │
│ 14:02:03 [session.abc] wake detected → correlation:xyz         │
│ 14:02:03 [route.steer:Atlas] utterance "make it faster"        │
│ …                                                              │
└──────────────────────────────────────────────────────┘
```

**Z-pattern scan compliance:** listening indicator top-left (highest criticality — always
glanceable). Global state center-top. Emergency indicator top-right. Process panels in the
primary visual field. Trace log at bottom (supporting detail).

**Color semantics (STARS/APCA):**
- Background: `#0a0a0a` (near-black, reduces eye fatigue)
- Nominal / active process: `#00ff88` (bright green, APCA contrast >75 on dark bg)
- Paused / pending: `#f5a623` (amber)
- Halted / error: `#ff3b30` (red)
- Selected / in-focus: `#00bcd4` (cyan — distinct from all state colors)
- Text: `#e0e0e0` (not pure white — softens harshness)

**Violet/purple is prohibited** as a status color (misidentified as blue or red under stress,
documented in STARS human-factors audit).

**Blink policy:** blink only for states requiring immediate action. In V0, only one state
blinks: emergency stop triggered. Nothing else blinks. (The destructive-read-back-pending state
was removed with the safety gate — see §7.)

**Auto-scroll:** disabled. The trace log does not auto-scroll. An "NEW" indicator appears at
the bottom when new events arrive while the user has scrolled up. Clicking "NEW" scrolls to
bottom — this is the only click target on the board, and it is navigational, not operational.

**Per-process panels:** exactly one per active process (V0 max: 2). When fewer than 2 processes
exist, the second panel shows an empty state: "No second process running."

**Board absent = no change in product behavior:** the board is served as an optional HTTP page.
The system does not wait for board connections, nor does it alter behavior based on board
presence. Board serving must not be on the critical path of any voice flow.

**See decision D-DD-07.**

---

## 9. Audio Onboarding Design

### Consent announcement = minimal onboarding

The first utterance from the system doubles as onboarding (REQ-1, AC1.1, design-art.md §6):

```
"Panopticon is listening. Say 'Panop, status' to hear a rundown.
Say 'mute' to pause. [earcon E2 begins]"
```

Three sentences, ≤8 seconds total. This is the entire spoken onboarding. No feature wall.

**Printed magic-word card:** a printable A6 card is a build artifact. Posted near the primary
mic. This is the external memory aid that replaces persistent menus. The card lists: wake word,
all magic commands, all active callsigns, and the panic word. This is not optional — a product
without the card provides no persistent command reference for a zero-screen room.

**Progressive capability disclosure by session:** the system does not announce new capabilities.
It simply responds to them. Capabilities used are learned; capabilities not used are not surfaced
unless "status" is requested or a near-miss is detected.

**Near-miss soft landing:** if a transcribed utterance is within Levenshtein distance ≤2 of a
documented command but does not match exactly, AND no other route applies, the system responds
with: "Did you mean '[closest command]'? Say it again to confirm." This prevents silent failures
during onboarding. After the first 20 minutes of session time, this behavior is disabled —
it exists only to build initial confidence.

**Silence threshold during first run:** during the first 5 minutes of a session, the
VAD (voice activity detection) end-of-utterance silence threshold is extended by 50% to
accommodate hesitation while users learn commands (design-art.md §6).

---

## 10. API & Integration Design

### 10.1 Cue integration (P-CUE)

Cue is the canonical substrate. The integration layer is a **thin adapter we own** — its job
is to translate between Cue's observation/action schema and Panopticon's internal event types.
We do not re-implement any behavior Cue provides.

**Cue primitives we depend on (must be validated by P-CUE probe):**

| Primitive | Used for |
|-----------|---------|
| `TextCue` | Magic word detection in transcript |
| `SpeakerWordCue` | Per-speaker utterance routing |
| `IdleCue` | Idle-preferring suggestion delivery |
| `WordCountCue` | Suggestion gate (≥60 word threshold) |
| `IntervalCue` | Cadence throttle (≤1/3min suggestion) |
| `observe.pass` | Explicit non-action — logged, not silent |
| `CueHarness` | The harness that runs continuous observation |
| `Program` | One program per routing channel (C2/C3 separation) |
| `MappedActionTool` | Maps cue decisions → Smithers actions |
| `cooldownSeconds` | Per-cue cooldown for cadence control |
| JSONL trace files | Observability — every decision recorded |
| HTTP/SSE routes | Consumed by the observability board |

**Our adapter adds:**
- Transcript observation normalization (`{text, isFinal, speaker, sessionId}`)
- Routing-decision logging with correlation IDs
- Earcon emission (Cue decides; our adapter plays the audio)
- Smithers lifecycle calls (spawn/steer/halt) triggered by `MappedActionTool` actions

**Known risks / extensions required:**
- Speaker diarization label stability: Cue may re-label speakers across utterances. Our adapter
  must handle label changes without breaking the routing invariant.
- If `observe.pass` is not a named/loggable first-class outcome in the real Cue API, our adapter
  must intercept and log it explicitly.
- `cooldownSeconds` granularity: if Cue's cooldown is only integer seconds, sub-second earcon
  timing (≤300ms ack) must be handled outside Cue.

**⚠ P-CUE is a P0 blocker. All of the above is derived from README-level documentation.
Nothing above is confirmed against the real library. The P-CUE probe is the first build task.**

### 10.2 Smithers integration (P-SMITHERS)

**Credentials:** no raw API keys and no elaborate credential-provider abstraction. **Assume the host
machine is already logged in to its OpenAI Codex and Anthropic Claude subscriptions** — model calls
use those. Model choice follows the O4 model-assignment matrix (see orchestration notes).

**Smithers primitives we depend on:**
- Durable run spawn with seed payload
- `streamRunEvents` (SSE) for real-time state observation
- Pause / resume semantics
- Steer / signal (for mid-run instruction injection)
- Pre-kill context archive
- Restart recovery to last durable checkpoint

**The Cue↔Smithers seam (P-SEAM):** this is the novel integration. Cue emits a `MappedActionTool`
action; our adapter calls the Smithers spawn API; Smithers emits run events via SSE; our adapter
feeds those events back into Cue as observations for voice-out coherence.

No prior art for this exact integration exists (design-art.md §8 gap confirmation). The adapter
must handle:
- Smithers latency: spawn response ≤3s (AC4.3 budget); adapter must not block the Cue loop
- SSE reconnect on disconnect
- UPID ↔ Cue steering-window correlation
- Smithers run events that need to be summarized to ≤15 words before TTS emission

### 10.3 ASR integration (P-ASR)

Candidate: **Deepgram Nova-3** (domain.md §5-Q4 top streaming option).

ASR sits behind a provider interface — swappable without Panopticon core changes:

```typescript
interface ASRProvider {
  stream(audioStream: NodeJS.ReadableStream): AsyncIterable<TranscriptObservation>
}

interface TranscriptObservation {
  text: string
  isFinal: boolean
  speaker: string | null
  latencyMs: number
  sessionId: string
}
```

The P-ASR probe must validate:
- `isFinal` flag shape and timing
- Speaker diarization label format
- Streaming latency (must demonstrate <200ms word-final latency to leave budget for
  earcon dispatch within 300ms total — REQ-10, AC10.1)
- Behavior on silence (should produce no observations, not empty observations)
- Behavior on overlapping speech (room with 2 speakers talking simultaneously)

**Why Deepgram over alternatives:** domain.md benchmarked it as top streaming ASR in 2026;
confirmed in P-ASR probe only if latency and diarization assertions pass.

### 10.4 TTS integration (P-TTS)

**TTS provider is currently unverified.** The P-TTS probe is also a selection benchmark.
Candidates from 2026 low-latency TTS class: ElevenLabs Flash v3, Cartesia Sonic, PlayHT 3.0
Turbo. The probe asserts streaming start latency — target: first audio byte within 200ms of
text submission, to keep the total ack round-trip ≤1s (REQ-10, AC10.2).

TTS sits behind the same provider interface as ASR:

```typescript
interface TTSProvider {
  speak(text: string, options?: {voice?: string}): Promise<NodeJS.ReadableStream>
}
```

Voice is selected once and configured in the session — not per-utterance.

**The 15-word guard runs before TTS submission.** The guard function is:
1. Count words in the candidate utterance
2. If ≤15 words: submit as-is
3. If >15 words: summarize via the cheap/fast LLM (single-turn, ≤2s budget) and resubmit

### 10.5 Decision LLM (P-LLM)

The hot loop (Cue decision layer, suggestion scoring, 15-word summarizer) uses a **cheap/fast
model only** — **no heavy planning model in the hot loop** (NG-9 / PRD D4). The specific model
follows the O4 model-assignment matrix and runs against the host's logged-in subscriptions (no raw
keys). The per-process planning agent (spawned through Smithers) uses a richer model per the same
matrix.

The P-LLM probe validates:
- Temperature-0 determinism for record-replay harness compatibility
- p50 latency within the hot-loop budget (env-tunable `HOTLOOP_BUDGET_MS`; total earcon round-trip
  is 300ms — ASR finalization ~100ms, decision ~100ms, earcon dispatch ~50ms)
- Tool/action selection schema (the action the LLM emits must match `MappedActionTool`)

---

## 11. Test & Validation Harness Design

### Record-replay harness

Because ASR + LLM are non-deterministic, all tests use temperature-0 for decision LLM calls
and a record-replay wrapper for ASR output:

```
[real session audio] → [ASR (real, recorded)] → [transcript observation stream (JSONL)]
                                                          ↓
[replay harness reads JSONL] → [decision loop (temperature-0)] → [actions/routing decisions]
```

In replay mode, the ASR output is pre-recorded JSONL; the LLM is temperature-0. The same input
produces the same output on every run. This is the only testable seam over the AI surface.

**Red-before-green is mandatory.** Every test must be demonstrated capable of failing before it
is trusted:
- Gate tests: deliberately set the gate below threshold, assert no fire; then at threshold
- Dispatch invariant: remove the guard, assert the test fails; restore it, assert it passes
- Latency tests: set a tighter budget than achievable, assert failure; relax to spec, assert pass

### Test layers

**Integration tests** (over the seams we own, against mocks/doubles of the providers):
- Gate threshold boundary tests at the configured env thresholds (one-below → pass, at/above → eligible)
- Earcon-dispatch latency (mocked clock, assert within the configured earcon budget from `isFinal` receipt)
- Routing invariant (steer without target-in-utterance and no steering window → rejected in code, not by the LLM)
- Steering-window lifecycle (open / idle / end-word / abort)
- Priority order: mute > panic > stop > steer > suggest > pass
- Callsign collision guard (Metaphone + phoneme-Levenshtein, reject at ≤2 distance)
- 15-word TTS guard (truncate/summarize at boundary)
- Run-to-completion posture (destructive verb dispatches with no gate interposed; RBG: re-introduce a confirm gate → fails)
- Per-state command ("Yes" inert with no suggestion pending)
- MCQ count invariant (never >3 emitted per suggestion)
- Causal-chain trace reconstruction (given session JSONL, rebuild full utterance chain)

**E2e tests:**
- Canonical loop scenario (≥10 runs, ≥9 pass): recorded audio drives wake→intent→action→ack
- Latency benchmark (≥100 command round-trips): assert p50 <1s, p95 <1.5s, earcon <300ms
- Suggestion idle-preference (scripted replay): queued idea held until an idle gap; ignored ambient = silence.
  Restraint is tuned by feel via env defaults — no formal labeled corpus or recall/FP metric gate for V0.
- Mute isolation (speak "mute", assert no downstream observations or actions; "unmute"/button resumes)
- Fleet isolation (steer A, assert B byte-identical state)
- Durability recovery (kill backend mid-run, restart, assert resume from last checkpoint)
- Projector UI is non-authoritative for routine control (run canonical loop with projector server
  down, assert it still passes)

### Observability requirements

Every event in the system emits a structured log line with:
- `level`: debug | info | warn | error
- `event`: verb-noun format (e.g., `process.spawn`, `route.pass`, `mute.engaged`)
- `sessionId`: traces across the full session
- `correlationId`: traces a single loop iteration (wake to ack)
- `upid` (where applicable): traces a specific process
- `latencyMs` (where applicable): measured, not estimated
- `meta`: any additional context (e.g., word count, confidence, matched command)

**The trace log is the single source of truth** for causal-chain reconstruction. No human
memory, no agent assertion — only the structured log proves something happened.

---

## 12. Design Decisions Log

| ID | Topic | Decision | Rationale |
|----|-------|----------|-----------|
| D-DD-01 | Wake word | "Panop" (not "Panopticon") | 5-syllable full name has soft /p/ onset and poor keyword-detection anchor. "Panop" is 2 syllables, rare, plosive-leading, and preserves product name recognition. Re-confirm against team's ambient vocabulary during P-CUE validation. |
| D-DD-02 | Earcon set | Exactly 5 earcons for V0 (wake, transcribing-ambient, spawn, resolve, stop) + addressed-command acks; ignored ambient is silent | Design research (design-art.md §2) and Echo earcon system establish that distinct non-verbal signatures per state > spoken announcements. 5 is the minimum distinguishable set. Un-addressed / ignored ambient speech (`observe.pass` / `route.pass`) makes no sound, by definition. |
| D-DD-03 | Suggestion threshold calibration | Gate on "room-interrupt cost" not just "suggestion quality" | A spoken suggestion is a broadcast interrupt with no individual opt-out. CHI 2025 research confirms annoyance ∝ frequency. The cost function must reflect the asymmetry: false positive in a team room > false positive on a screen. Idle-preferring delivery is non-negotiable. |
| D-DD-04 | Panic word | "Abort" (not "Stop") | "Stop" appears in natural speech constantly ("stop the build", "stop doing that"). "Abort" is rare, 2 syllables, phonetically distinct from all other commands. Must be reserved exclusively for global panic — no other command uses it. |
| D-DD-05 | Callsign collision guard | Metaphone + phoneme-Levenshtein ≤2 distance threshold | Design research (design-art.md §4) traces this to ICAO's 1948–49 phonetic alphabet redesign rationale: the active set must be designed holistically, not each callsign independently. At 7.4% WER, acoustically similar callsigns will be misrouted. Algorithm must be reproducible and tested. |
| D-DD-06 | Execution posture | V0 runs dangerously / run-to-completion; no read-back/confirm gate or dead-man timer | Cut for speed. You shouldn't need to approve often; Cue handles genuine confirmations. Safety later = sandbox the process, not permission gating. (Supersedes the former 25s dead-man timer.) |
| D-DD-07 | Observability board layout | Z-pattern, listening indicator top-left, per-process panels, trace log bottom; no controls | NASA MOCR / ATC STARS design principles: role-based display segregation, tiered authority layout, additive urgency color semantics. "Read-only displays do not have buttons" — mixing read and write surfaces in a crisis causes inadvertent commands. |
| D-DD-08 | Auto-scroll on trace log | Disabled; "NEW" indicator appears, click to scroll | Auto-scrolling past readable speed during active operation makes the log worthless. The only click target on the board is the "NEW" scroll-to-bottom indicator — navigational, not operational. |
| D-DD-09 | Blink policy | Blink reserved for one state only: emergency stop triggered | Blink fatigue is documented in STARS human-factors audit. Peripheral blink detection is the fastest human visual signal — it must not be wasted on non-critical states. (The destructive-read-back-pending state was removed with the safety gate, D-DD-06.) |
| D-DD-10 | First-run silence threshold | Extended 50% during first 5 minutes | Smart speaker studies show natural mid-sentence pauses caused devices to cut off users during first-run. This is critical for onboarding confidence — one cut-off first command causes users to stop attempting. |
| D-DD-11 | TTS word guard | Hard cap at 15 words, enforced in the pipeline before TTS submission | Spoken word count remains the measure of audio output length in the audio-first system. The guard is a function in the output pipeline, not a guideline — it truncates/summarizes without exception. |
| D-DD-12 | Log event naming | Verb-noun convention: `process.spawn`, `route.pass`, `mute.engaged` | ATC naming rationale (design-art.md §7): verb-object naming reads in the order events occur, is faster to scan in log output, and is self-documenting without context. Consistent with PRD observability requirements. |
| D-DD-13 | Cue integration posture | Thin adapter we own; build only on confirmed Cue primitives; record all required extensions as risks | PRD D2 binding decision. Any extension we need lives in our adapter layer so Cue gaps never block us. P-CUE probe is a P0 blocker — nothing above the adapter is built before the probe confirms the primitives. |
| D-DD-14 | TTS provider selection | Unverified; selected by P-TTS probe (ElevenLabs Flash v3, Cartesia Sonic, PlayHT 3.0 Turbo are candidates) | Research covered ASR not TTS (PRD §6, P-TTS). The probe is also a benchmark. Target: first audio byte within 200ms of text submission. |
| D-DD-15 | Suggestion expiry | Queued suggestions expire after 90s with no idle gap; logged but not spoken | A 90-second-old suggestion about a conversation topic the room has since moved on from is no longer relevant. Expiring it avoids surfacing stale ideas on a subsequent idle gap. |
| D-DD-16 | Onboarding | Consent announcement = full onboarding (≤3 sentences, ≤8s); printed magic-word card is the follow-on reference | "Feature wall" onboarding is the most common VUI failure. Humans cannot retain >5–7 items from audio. The printed card is not optional — it is the persistent command reference for a zero-screen room. |
| D-DD-17 | Roger vs. Wilco earcon distinction | E1 (wake chime) = "I heard the wake word"; E3 (spawn earcon) = "I'm acting on it" | ATC phraseology distinction: receipt ≠ compliance. These must never be the same sound — the room must be able to hear whether the system received vs. acted. |
| D-DD-18 | Callsign re-use cooldown | 60s cooldown before a halted process's callsign is re-available | Muscle memory confusion risk: a team member who just said "Atlas, stop" and then hears "Atlas" called again 5 seconds later on a new process will be confused about what Atlas is. |
| D-DD-19 | Execution mode | One mode for V0: dangerous / run-to-completion (no Safe/Explicit/Dangerous switching) | Cut mode-switching for speed. Run-to-completion by default; safety later = sandbox the whole process, not voice-toggled permission modes. (Supersedes the former session-only "dangerous mode" toggle.) |
| D-DD-20 | Board color for "selected" state | Cyan (`#00bcd4`) | Distinct from all state colors (green=nominal, amber=paused, red=halted). Cyan is the Echo active-listening color — leverages existing mental model for "system is attending to this thing." |
| D-DD-21 | Mute/unmute words | Plain English: "mute" / "unmute" | Cue handles wake/keyword robustness, so no exotic collision-resistant words are needed; plain words remove onboarding friction. |
| D-DD-22 | Unmuting while muted | No custom spotter — Cue hears "unmute" even while muted; an on-screen unmute button is always available too | "Muted" = stop feeding audio into the suggestion/routing pipeline. Two unmute paths (voice via Cue + on-screen button) mean the room is never trapped. No bespoke on-device spotter, P-SPOTTER probe, or teardown/restart recovery. |
| D-DD-23 | Earcons & acks | Ignored ambient speech is silent; tonal state earcons + addressed-command acks remain | Un-addressed speech should make no noise. `observe.pass` / `route.pass` = silence by definition, not a tunable knob. |
| D-DD-24 | Vocabulary tiering | Deferred — no always-hot vs. state-gated tiering in V0 | Cue handles wake/keyword activation; revisit later only if it becomes a problem. |
| D-DD-25 | Verification stance | Integration-only: verify our seams with the libraries via typed, mockable providers (+ real-API probes), not the libraries themselves; tunable behavior env-driven; no formal restraint corpus | Cue is battle-tested by Etheria. We prove the adapter/dispatch/policy code we own; params are documented ENV vars tuned by feel. |
