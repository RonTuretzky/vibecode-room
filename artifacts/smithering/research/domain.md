# Domain Research — Panopticon Problem Space
*Written: 2026-06-13. Grounded in upstream brainstorm.md, PROMPT.md, and external research.*

---

## 1. Who has this problem today

**Primary users:** Software engineers and technical creative teams who build iteratively in
collaborative, conversational sessions — pair programmers, small product + engineering teams
co-located or on shared calls, indie developers who "think out loud" while coding. The friction
they share: the moment they shift from _talking about_ an idea to _commanding a computer_ to
build it, flow breaks.

**The interrupt cost is measurable:** Studies document a 23-minute recovery time after a
programming interruption; interrupted tasks take 2× longer and contain 2× as many errors; 82% of
productive work time can be erased by interruptions (GitHub internal study). Context-switching
costs developers 6+ hours per week. This is the direct tax that "dropping into a command loop"
imposes.

**Secondary users:** The same demographic who adopted Cursor ($2B ARR 2026, 1M+ paying users),
GitHub Copilot (4.7M paid users, 75% YoY), and Claude Code (18% workplace adoption). 85% of
developers now use AI coding tools; 70% use 2–4 simultaneously. They are already multi-agent
operators — the bottleneck is not willingness but interface friction: all current tools still
require a keyboard, a screen, and an explicit command turn.

---

## 2. How they solve it now

**Current workarounds (and their failure modes):**

| Tool | Approach | Core friction |
|---|---|---|
| Cursor + Copilot | Editor-embedded LLM with keyboard/click UX | Still requires looking at a screen and typing; token costs penalize long sessions ($0.25–$6/M tokens depending on mode) |
| Aider `/voice` | Whisper-powered voice-to-text into a terminal agent | Turn-based (push-to-talk); no ambient listening; single process; no fleet management |
| GitHub Copilot CLI voice | Hold spacebar/Ctrl+X+V to record voice commands | Push-to-talk, not ambient; requires keyboard access |
| Devin / OpenHands | Fully autonomous agent given a written spec | Requires well-scoped written requirements; fails on vague/evolving intent; high cost; no voice |
| SWE-agent | Benchmark-grade autonomous coder | 53–72% on SWE-bench; breaks on ambiguity and tacit knowledge; zero voice |
| Web Speech API (DIY) | Browser STT piped to a custom agent | High WER on technical vocabulary; no speaker diarization; no cue policy logic; brittle |

**The pattern:** every existing solution is *reactive and keyboard-mediated*. None are
*ambient*. None watch a continuous stream and decide on their own whether something is
actionable. None support multi-process voice fleet management.

---

## 3. Competing products

**No direct competitor exists at the "ambient, audio-only, multi-agent fleet" level.** The
closest partial overlaps:

- **Observe.AI Agent Blueprint** — production voice agent orchestration for regulated industries
  (50K+ daily calls). Breaks work into controllable tasks with deterministic routing. Targets
  contact centers, not software development. Closest architectural analog (observe → policy →
  act), but not a dev tool and not ambient.
- **Cursor** — highest-revenue AI IDE ($2B ARR); deeply keyboard/screen-first. Complaints:
  token burn, context-window exhaustion mid-project, no voice, no ambient operation.
- **Devin 2.x / OpenHands** — autonomous coding agents. Complaints: need precise specs, high
  cost, poor on ambiguous creative tasks, no voice interface, no concurrent fleet management.
- **Retell AI / Pipecat** — ultra-low-latency voice agent infra (<150ms). Customer service
  focus, not coding. Relevant as infrastructure analogs.
- **Aider with /voice** — closest voice-adjacent coding tool. Confirmed useful by real users
  ("not a gimmick"), but turn-based, single-process, terminal-native, no ambient cue detection.
- **GitHub Copilot Voice** (launched 2026) — push-to-talk only; still a command interface.

**Gap confirmed:** No product combines (a) ambient, always-on listening, (b) cue-policy-based
selective wake, (c) multi-process durable agent fleet, (d) voice-only operation end to end.

---

## 4. What users complain about in current solutions

From public forums (HN, Reddit, dev.to), GitHub issues, and product review sites:

1. **Token burn and context exhaustion** (Cursor): "I ran out of tokens mid-project and had to
   switch to Copilot." Long conversations consume 30%+ of context window in 6–8 exchanges.
2. **Forced/intrusive AI suggestions** (Copilot): "Let us git rid of it" — HN thread on forced
   Copilot features. Copilot generating unwanted issues/reviews breaks flow rather than helping.
3. **Vague intent fails** (Devin/OpenHands): Agents require well-scoped, written specs. "Make it
   faster" or "make it look better" return poor results. Tacit knowledge and stakeholder nuance
   are not handled.
4. **No concurrent fleet** (all products): Every current tool operates one agent at a time with
   full human attention. Operating multiple AI agents simultaneously is unsupported.
5. **Screen and keyboard still required** (all products): Even the most autonomous agents
   (Devin, OpenHands) require a screen to monitor, a keyboard to redirect, and explicit written
   commands.
6. **Voice is still bolt-on** (Aider, Copilot CLI): Push-to-talk with no ambient detection.
   Requires dedicated gesture (holding a key) rather than natural speech. No cue policies.
7. **Intrusiveness vs. silence trade-off is untuned** (Copilot, Cursor): Either the assistant
   is too chatty (breaks flow) or too quiet (adds no ambient value). No tunable cadence control.

---

## 5. Answers to the 11 open questions (evidence-grounded)

### Q1: Who is the V0 user, and is a screen ever allowed?

**Answer (recorded decision): V0 user = a small technical team (2–5 people) in a shared physical
room. A screen is allowed as output-only observability but is NEVER required for operation.**

Evidence:
- The product's core premise (R5) is "a shared room has no single pointer anyway" — the user is
  inherently a *group*, not a solo developer. V0 targets co-located technical teams who already
  build collaboratively: pair programmers, small product+eng squads, maker/hacker rooms.
- The intake artifact confirms: "Audio-only remains the sole *operational* modality. The visual
  surface is consulted by engineers debugging, never by product users operating the system."
- The validation bar requires observability "that a later agent arriving with NO context can debug
  it" — this demands a visible surface for debugging engineers, not product users.
- User research confirms voice-only users perform worse on complex tasks vs. users with even a
  minimal visual fallback — a blank room wall is worse than a status display.
- **Decision:** V0 user is a trusted co-located technical team; a read-only visual board (process
  list, magic words, listening indicator, trace log) is a required engineering surface but NOT a
  required operational surface. A user who is blind or in a room with no wall display can operate
  Panopticon end-to-end by voice alone.

### Q2: What is the single success criterion for V0?

**Answer (recorded decision): ONE end-to-end voice flow working hands-free and live in ≤12
minutes: ambient talk → spoken suggestion → voice-accept → durable process spawned → voice-steered
→ spoken result; with ≥2 concurrent processes independently controllable by voice.**

Evidence from PROMPT.md §6: "The win condition is a single high-value flow working end-to-end,
hands-free, live, in ~12 minutes." The 12-minute bound is a demo-fitness threshold.

**Operationally, V0 passes if:**
1. A speaker says something buildable without addressing the system → suggestion fires within 90s.
2. Room says "accept [magic word]" → durable Smithers process spawns, confirmed by spoken ack.
3. Room steers that process by voice ("Atlas, make it faster") → output reflects the instruction.
4. A second independent process runs concurrently without voice collision (distinct magic words).
5. The stop word halts the current process immediately.
All five happen without anyone touching a keyboard, mouse, or screen.

### Q3: How conservative should the suggestion cadence be, given spoken suggestions interrupt?

**Answer (recorded decision): Very conservative. Default = 1 suggestion per 90 seconds of
substantive conversation, gated on ≥60 words of buildable talk. Start there and tune upward only
if the room feels under-served. `observe.pass` is the common case.**

Evidence and reasoning:
- User research (§4 above) shows "intrusive AI suggestions" is the #1 complaint about Copilot.
  In a voice-first system, a false-positive suggestion is *audibly* disruptive — it interrupts
  the room's conversation, which is meaningfully worse than a visual pop-up the user can ignore.
- PROMPT G6 / P-Restraint: "~90% of ticks are silent; no constant narration."
- A spoken suggestion consumes 5–15 seconds of room audio — it pre-empts the conversation, not
  just occupies a peripheral display. A false-negative (missed suggestion) is recoverable; a
  false-positive (unsolicited interruption) breaks flow irreversibly.
- **Tuning heuristics:** record sessions, replay with annotated ground truth, adjust
  `SuggestionWindowCue` thresholds. Start at 90s/60-word gate; tune downward only when evidence
  from replay shows systematic false-negatives.

### Q4: What is a suggestion's 'demo' when there's no screen?

**Answer (recorded decision): A spoken suggestion = one-line concept pitch (spoken) + 2–3
multiple-choice clarifying questions (spoken, optionally answered aloud). No visual demo is part
of the audio product. An optional visual HTML demo strip may appear on the observability display
as a bonus but is never the product.**

Evidence:
- PROMPT.md §5.6: each suggestion ships "a lightweight live demo" + "1–5 multiple-choice
  clarifying questions answerable by voice." The brainstorm resolves: "A suggestion is a *spoken*
  one-line concept pitch + 1–3 spoken MCQs. The live HTML demo is *deferred* (optional visual
  bonus on the observability screen only)."
- In the audio-only model, the "demo" of a suggestion is the spoken description: "I heard you
  talking about tracking running agents — should I build an agent dashboard? [A] real-time view,
  [B] daily digest, or [C] both?" The room answers by voice.
- **Decision:** The spoken pitch is the canonical demo. MCQs are always ≤3 for voice; longer
  question sets cause the room to lose track mid-listen.

### Q5: How does the room select and steer an existing process by voice (the C3 select-first rule)?

**Answer (recorded decision): Speak the process's magic word → opens a "steering window" scoped
to that process → speak the instruction → window auto-closes on ~20s silence, explicit end word,
or panic word. No utterance steers a process without the magic word being spoken first.**

This is implemented directly in Cue cue policies (brainstorm §4):
1. **`ProcessSelectCue`** (`TextCue` / `SpeakerWordCue`) — monitors the transcript stream for
   any registered callsign. When "Atlas" appears, it fires and: (a) emits a `process.select`
   action to the Process Manager, (b) starts a scoped steering window, (c) all subsequent
   transcript observations route to that process until the window closes.
2. **Steering window lifecycle:** Opens on magic word → stays open while the room addresses that
   process → closes on 20-second `IdleCue`, an explicit deselect word ("done," "deselect"), or
   the panic word.
3. **The "select first" invariant (C3):** The Process Manager refuses to apply any steering verb
   to a process unless that process is the currently-selected target or the magic word is
   explicitly in the utterance. Enforced at dispatch, not in the LLM.
4. **One-breath select-and-steer:** "Atlas make the header blue" works as a single utterance —
   the magic word is detected first, window opens, remainder is the instruction.
5. **Visual reinforcement (non-required):** Display shows "YOU ARE STEERING ATLAS" banner; the
   canonical confirmation is a spoken "now steering Atlas."

### Q6: What does a process's output sound like (G5')?

**Answer (recorded decision): A process speaks only when (a) it completed something notable,
(b) it needs clarification, or (c) the room explicitly asks. Output = a ≤3-sentence spoken
summary of what was just done or decided. No running narration.**

Evidence:
- PROMPT §5.3 + G6: "~90% of ticks are invisible. Otherwise... a short spoken confirmation."
- Brainstorm expresses G5 as G5′ "speak the right summary": "the agent *tells* you what it
  built, sparingly."
- **Triggered cases:** Completion ("Atlas: built the dashboard scaffold, 3 files, ready to
  review"), Blocker ("Atlas: I need a decision — Postgres or SQLite?"), Safety read-back ("Atlas:
  about to delete the main branch — say 'confirm' to proceed"), Explicit ask ("Atlas status").
- **Format:** ≤15 words per utterance; complex output is summarized, not recited. Code diffs,
  file names, URLs appear on the display only.
- **Talkativeness knob:** per-process config, defaulting to sparse.

### Q7: What is the default execution posture per process, in a voice world?

**Answer (recorded decision): Default = Safe + Optimistic. Processes run autonomously without
waiting for voice input at each step, but pause and ask before destructive or irreversible
actions. The room does NOT need to babysit.**

Reasoning:
- "Optimistic" (vs "Explicit"): the process advances autonomously, makes plausible decisions
  without asking for approval at each step. Explicit mode is incompatible with voice-only —
  approving 20 consecutive actions aloud would be more exhausting than typing. Only blocking
  decisions surface as voice prompts.
- "Safe" (vs "Dangerous"): the process reads back and requires spoken confirmation for destructive
  verbs (delete, overwrite, force-push). "Dangerous" mode turns off the confirmation gate — only
  available if explicitly requested ("Atlas, switch to dangerous mode").
- In the OS analogy: an unattended process running a build is not paused waiting for input; it
  runs to completion and speaks only when it has output or needs a decision.
- **When a process blocks:** it speaks a short prompt ("Atlas needs a decision") and idles,
  holding its context. It does NOT time out and self-destruct.

### Q8: Multi-speaker — per-user pairing, or is diarization enough for V0?

**Answer (recorded decision): Diarization is enough for V0. Per-user phone pairing is deferred
to V1. Speaker identity = speaker label from Deepgram Nova-3 diarization, not per-user auth.**

Evidence:
- Deepgram Nova-3 provides speaker diarization natively (speaker labels in the transcript
  observation payload). This gives C2/C3 routing the "who said what" signal.
- The brainstorm resolves: "Mobile QR pairing is *demoted to wishlist*. 'Who is talking /
  multiple operators' is handled by Cue speaker diarization, not per-phone pairing."
- Per-user pairing requires: QR display (visual), phone tap (touch), identity binding — all
  introduce visual or touch dependencies incompatible with V0's audio-only model.
- For V0's trust model (trusted co-located team), "speaker 0 said this, speaker 1 said that"
  is sufficient.
- **Blocking risk:** Test diarization accuracy on real in-room crosstalk before building on it.

### Q9: Does an unselected process keep working, or idle until steered?

**Answer (recorded decision): Unselected processes keep working autonomously. "Unselected" means
the mic is not routed to that process, NOT that the process is paused.**

- An OS process does not pause when it loses focus; Panopticon processes are the same — durable
  Smithers runs that continue their execution loop regardless of whether the room addresses them.
- Lifecycle states: `planning → active ⇄ paused → dead`. A process in `active` state with no
  current voice selection is **still running**. It speaks only at completion or blockers.
- **Implication for V0:** 3 processes can run simultaneously; the room says nothing for 5 minutes
  and all 3 continue making progress. When one finishes, it speaks; the room selects it and gives
  the next instruction.

### Q10: Consent and trust for an always-on cloud mic?

**Answer (recorded decision): V0 operates under a trusted co-located team assumption with three
explicit consent controls. Raw audio is NOT persisted. Transcript-only persistence, opt-out by
spoken mute, visible always-on indicator.**

- **C10 (PROMPT):** "Listening must be legible and consentful. A visible always-on listening
  indicator and a spoken global mute; persist only the transcript (no raw audio) in V0."
- **Three required consent controls:**
  1. **Visible indicator:** persistent visual or LED badge showing active mic streaming.
  2. **Spoken mute:** "Panopticon mute" immediately stops all streaming. Indicator confirms.
  3. **Transcript-only persistence:** Deepgram receives the audio stream but Panopticon does NOT
     log or archive raw audio. Only the final transcript is persisted (C10).
- **Cloud vs. local trade-off:** V1 fallback is `plugin-local-inference` (whisper.cpp on-device)
  for teams with strict privacy requirements. V0 documents this risk explicitly in setup UX.
- **Consent ceremony:** at session start, the system announces: "Panopticon is listening. Say
  'Panopticon mute' at any time to stop. Only transcripts are saved."

### Q11: Do we adopt Cue's bundled provider stack (Deepgram + a cheap fast LLM) for V0, and where is the seam to Smithers/Fable?

**Answer (recorded decision): Yes — Cue's bundled provider stack (Deepgram + Cerebras LLM) is
the V0 default. The seam is: Cue emits structured actions → dispatched to Smithers API →
Smithers runs each process with Fable orchestrating per-process planning via Smithers
subscriptions. No Opus in the hot loop.**

Provider stack decision:
- Deepgram Nova-3 for transcription: sub-300ms streaming, $0.26–0.46/hr, native speaker
  diarization. (Same as the prior Q4 decision; retained.)
- Cerebras LLM (or equivalent cheap/fast tier) for Cue's hot decision loop: the cue policy
  evaluation, buildable-intent LLM check, and process routing must be low-latency and cheap.
- No Opus in the hot loop (PROMPT §5.11). Fable is per-process, not in the ambient loop.

The Cue↔Smithers seam (the novel integration):

```
ROOM AUDIO
  └─► CUE (realtime harness)
        • Deepgram transcription provider → transcript.segment observations
        • Cue policies (ProcessSelectCue, SuggestionWindowCue, etc.)
        • Cerebras LLM program: picks one tool | observe.pass
        • MappedActionTool → emits structured action: {type, target, payload}
              │
              ▼
       PANOPTICON ACTION DISPATCHER (Hono API / WebSocket)
              │  receives Cue action, validates against process registry
              ▼
       SMITHERS PROCESS MANAGER
              │  spawn / steer / pause / resume / fork / kill
              ├─► PROCESS (Smithers durable run)
              │     • Fable orchestrates per-process planning
              │     • model calls via Smithers subscriptions (never raw API keys)
              │     • session loop: input→pre-hooks→action→post-hooks→output
              │     • output: text → PANOPTICON → CUE output provider → TTS → room
              └─► (other processes, running concurrently)
```

Key seam properties: Cue knows nothing about Smithers (emits JSON action); Smithers knows nothing
about Cue (receives verb + process ID + payload). Voice output flows the other direction:
Smithers output event → Panopticon dispatcher → Cue output provider → TTS → room audio.
**Validation requirement:** The Cue↔Panopticon dispatcher seam must be validated against the
real Cue `MappedActionTool` action schema before any Smithers integration is built on it.

**Prior V0 cue policy set (retained):**

| Policy | Type | Purpose | Default threshold |
|---|---|---|---|
| `SuggestionWindowCue` | `WordCountCue` or `IntervalCue` | Gates buildable-intent LLM check | 60 words OR 90 seconds |
| `ProcessSelectCue` | `TextCue` / `SpeakerWordCue` | Magic-word callsign → steer target | Exact match on live callsign registry |
| `GlobalCommandCue` | `TextCue` | Fleet-level: "pause all", "status", "mute" | Exact phrase on small vocab |
| `HardMuteCue` | `TextCue` | Global silence: "Panopticon stop" | Highest priority, always wins |
| `DeadManTimerCue` | `IdleCue` | Auto-close steering window after silence | 20-second idle |

**Determinism (record-replay):** Temperature=0 for all cue decision LLM calls; every
input→output pair hashed and logged; replay mode returns cached output deterministically.

---

## 5a. Prior decisions retained from first draft (for continuity)

### Visual surface decision (prior Q1 — now refined into Q1/Q7 above)

**Answer (recorded decision): Partial override. A minimal visual surface MUST be retained for
observability and debugging, but MUST NOT be required for operation.**

- The brainstorm: "the board, if it exists at all, is optional observability 'mission control'
  — required by the validation bar for debugging, never required to operate the product."
- **Decision:** Ship a minimal, non-interactive read-only observability surface (process list,
  active cue, last action, trace log). Developer-facing tooling, not a user-facing product surface.

### Q2: Which cue policies should V0 ship with, and how are their thresholds tuned without a visual feedback loop?

**Answer (recorded decision): Ship five cue policies for V0; tune by audio playback + trace
log, not visual UI.**

**V0 policy set:**

| Policy | Type | Purpose | Default threshold |
|---|---|---|---|
| `SuggestionWindowCue` | `WordCountCue` or `IntervalCue` | Gates the buildable-intent LLM check after N words of substantive speech or T seconds of conversation | 60 words or 90 seconds, whichever first |
| `ProcessSelectCue` | `TextCue` / `SpeakerWordCue` | Wakes on a magic-word callsign (e.g. "Atlas", "Bravo") to route subsequent speech to a specific process | Exact match on registered callsign list |
| `GlobalCommandCue` | `TextCue` | Catches fleet-level commands: "pause all", "status", "mute" | Exact phrase match on a small command vocabulary |
| `HardMuteCue` | `TextCue` | Immediately silences the system: "Panopticon stop", "mute" | Exact phrase; highest priority, pre-empts all others |
| `DeadManTimerCue` | `IdleCue` | If a spawned process has been `planning` with no voice steer for N seconds, auto-confirms or prompts | 30-second idle after suggestion acceptance |

**Threshold tuning without a visual feedback loop:**
- Every Cue policy decision (wake vs. `observe.pass`) MUST emit a structured trace log entry
  with: timestamp, policy name, observation payload, decision, confidence score if LLM-based.
- Tuning is done by: (a) replaying a recorded audio session through the system and comparing
  trace logs against a hand-annotated "should have acted" ground truth; (b) listening to recorded
  audio + hearing which suggestions fired, which passed; (c) adjusting thresholds and re-running.
- This is the "audio record-replay" analog of a visual A/B test. It is the only viable approach
  for an audio-only product without a feedback GUI.
- **`observe.pass` must be the default:** the system should under-suggest rather than
  over-suggest. In audio, an unwanted interruption is worse than a missed suggestion (confirmed
  by user complaints about intrusive Copilot). Start conservative (high word-count thresholds,
  long idle gates) and tune down.

### Q3: How is determinism preserved given the LLM decision step is inherently nondeterministic?

**Answer (recorded decision): Determinism is preserved at the TRACE level, not the MODEL level.
LLM calls are nondeterministic by nature; the system wraps them in a record-replay harness so
every run is reproducible from its trace.**

Two sources of LLM nondeterminism: stochastic decoding (temperature, sampling) and GPU
floating-point non-associativity (parallel additions sum differently). Setting temperature=0
reduces but does not eliminate variance.

**Chosen architecture (record-replay):**
1. Every input sent to an LLM (observation payload + system prompt + context) is hashed and
   recorded alongside the response. This forms the "execution signature" of each decision step.
2. In replay mode, the same input hash retrieves the recorded output deterministically — no LLM
   call needed. This gives reproducible testing, golden snapshot regression, and incident replay.
3. In live mode, the LLM call is made, its output is recorded, and the action taken is also
   recorded with a trace ID.
4. "The agent said it's done" is never evidence (per the validation bar). Only a test that
   replays a known trace and confirms the same action was taken constitutes a passing test.

**Practical controls:**
- Temperature = 0 for all decision-loop LLM calls (cue policy evaluation, buildable-intent check)
- Temperature > 0 only for generative tasks (suggestion text, spoken output wording) — these are
  not in the determinism-critical hot path
- Pin all model versions; log model version in trace
- Smithers' durable-run infrastructure already provides replay via its existing trace/journal
  system — Cue's decision log feeds into the same observability layer

### Q4: Which speech-to-text provider is the default for V0?

**Answer (recorded decision): Deepgram Nova-3 (streaming) is the V0 default.**

Evidence:
- **Latency:** Deepgram streaming delivers sub-300ms time-to-first-transcript at 200–400ms
  end-to-end. This fits the <800ms total round-trip budget (STT + LLM + TTS) for a responsive
  voice agent.
- **Cost:** $0.26–0.46/hour streaming — cheapest viable real-time option. Critical for a system
  that is always-on (unlike push-to-talk tools, Panopticon transcribes continuously).
- **Speaker diarization:** Deepgram Nova-3 provides speaker diarization natively. This is
  essential for the C2/C3 multi-operator routing (who said what); it is not available from
  Whisper or most alternatives at comparable latency.
- **WER on technical speech:** ~7.4% — acceptable for intent detection (cue policies need to
  detect keywords and rough intent, not verbatim transcription).
- **Cue compatibility:** The brainstorm confirms Cue uses Deepgram as its transcription provider.
  This is the least-integration-risk choice.
- **Alternatives considered:**
  - Groq Whisper (async, ~180ms, cheapest at $0.02/hr): buffers full segments — unsuitable for
    interactive real-time streaming. Use as offline batch transcript processor only.
  - AssemblyAI Universal-3 (335ms, 4.5% WER): lower WER but 30–60% higher latency and cost;
    consider for V1 if accuracy becomes a pain point.
  - ElevenLabs Scribe v2 RT (<150ms): best latency but premium cost and no confirmed Cue
    integration — consider if <150ms becomes a hard requirement.
  - OpenAI Whisper (750ms batch): too slow for ambient real-time use.
- **Validation requirement (per validation bar):** Exercise the Deepgram streaming API directly
  (word-level observations, speaker tag shape, isFinal flag) before building any Cue integration
  on top of it. Do not trust docs.

---

## 6. Architectural patterns adopted from the research

- **Three-layer policy enforcement (from voice agent research):** Audio streaming layer → LLM
  reasoning layer → Policy decision layer. Default-deny on actions. Authorization is binary —
  no "almost triggered." Maps directly onto Cue's observe → cue policy → program → act|pass.
- **Always-on + wake-word hybrid:** On-device or lightweight keyword spotting for callsign
  detection (ProcessSelectCue), plus continuous LLM-based intent check for suggestion window.
  This follows the pattern validated by Porcupine/OpenWakeWord architectures.
- **Trace-first observability:** Every policy decision, LLM call, action emitted, and
  observe.pass is logged with a trace ID. This is the only way to debug an audio-only system
  post-hoc and satisfy the validation bar.
- **Audio record-replay as the test harness:** Record real audio sessions; replay through the
  policy engine; compare decisions to ground-truth annotations. This is the audio-domain
  equivalent of snapshot testing.

---

## 7. Key risk: "jameslbarnes/cue" public availability

The research found **no public GitHub repository** for `jameslbarnes/cue` as of 2026-06-13.
The repository URL (`https://github.com/jameslbarnes/cue`) was specified in the standing
constraints but could not be confirmed to exist as a public repo. This is a **blocking risk**:
the entire Cue layer of the architecture (cue policies, observation schema, transcription
provider interface, observe.pass) must be validated against the real library before any
integration code is written (per validation bar). If the repo is private or the API surface
differs from what the brainstorm assumed, the integration plan must be revised.

**Resolution required before implementation:** Confirm repository access and run a live
validation probe against Cue's real API — specifically the observation schema, cue policy
constructors, program interface, and MappedActionTool pattern. Surface this as a blocker in
structured output if access is not confirmed.

---

## Sources

1. brainstorm.md (upstream artifact, /artifacts/smithering/brainstorm.md)
2. PROMPT.md (product spec, /PROMPT.md)
3. futureagi.substack.com — Speech-to-Text APIs in 2026: Benchmarks, Pricing, and a Developer's Decision Guide
4. assemblyai.com/benchmarks — AssemblyAI accuracy benchmarks 2026
5. github.blog/changelog/2026-06-02 — Copilot CLI voice input announcement
6. propelcode.ai/blog/defeating-nondeterminism-in-llm-inference-ramifications
7. sakurasky.com/blog/missing-primitives-for-trustworthy-ai-part-8 — Deterministic Replay
8. arxiv.org/pdf/2505.17716 — Get Experience from Practice: LLM Agents with Record & Replay
9. flowhunt.io/blog/defeating-non-determinism-in-llms
10. picovoice.ai/blog/complete-guide-to-wake-word — Wake Word Detection Guide 2026
11. picovoice.ai/products/voice/wake-word — Porcupine pricing
12. webrtc.ventures/2026/01/building-a-voice-ai-agent-with-policy-guardrails — Policy guardrails architecture
13. observe.ai/blog/meet-observe-ais-agent-blueprint — Task Orchestration for Voice AI
14. contextkeeper.io/blog/the-real-cost-of-an-interruption — Interruption cost research
15. axolo.co/blog/p/cost-context-switching-developer-workflow
16. shiftmag.dev/do-not-interrupt-developers-study-says-5715
17. vantage.sh/blog/cursor-pricing-explained — Cursor token cost analysis
18. dev.to/maximsaplin/ran-out-of-cursor-tokens — User complaint: Cursor token exhaustion
19. news.ycombinator.com/item?id=45148167 — "Let us git rid of it, angry GitHub users"
20. aitoolranked.com/blog/devin-ai-review — Devin limitations
21. openhands.dev/blog/openhands-index — OpenHands SWE-bench results
22. callsphere.ai/blog/real-time-asr-2026 — Real-time ASR provider comparison
23. deepgram.com/learn/best-speech-to-text-apis-2026
24. coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks
25. blog.exceeds.ai/ai-coding-us-market-share — AI coding market data 2026
26. uvik.net/blog/ai-coding-assistant-statistics — 85% developer adoption data
27. arxiv.org/pdf/2506.12347 — Why AI Agents Still Need You (developer-agent collaboration)
