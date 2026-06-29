# Vibersyn — Verification Backpressure Matrix (V0)

> **Purpose.** One gate row per **acceptance criterion** of every requirement in
> `docs/planning/01-prd.md`, cross-referenced to the verification plan in `docs/planning/03-eng.md`.
> The implementation workflow wires **every blocking gate** into its merge checks: a blocking gate
> that has not produced a *red-before-green* pass against a test capable of failing **blocks merge**.
>
> **Non-negotiable rules (from the operating bar):**
> 1. Every **blocking** criterion maps to a real verification method that **can FAIL**. "The agent
>    said it's done" is never evidence — only a test that was demonstrated capable of failing is.
> 2. Each gate names the **cheapest method that actually proves the criterion**. Where the criterion
>    is a deterministic invariant/logic/contract, a headless `bun test` unit/integration test is the
>    gate (fast, runs every PR). Where the criterion is fundamentally a real-world property
>    (measured latency, recall on a corpus, durability across a real restart, hands-free/no-screen,
>    real third-party behavior), the e2e/eval/probe is the gate — a mocked unit cannot honestly prove
>    it. The verification bar's **AND** (unit *and* e2e) is preserved in `Evidence required`.
> 3. `Evidence required` lists concrete artifacts: the **red-before-green (RBG)** failure injection,
>    a passing-test artifact, and the e2e/probe corroboration. No artifact is ever "agent confirmation."
>
> **Method legend:** `unit_test` / `integration_test` / `e2e_test` (live stack) / `eval` (corpus
> metric) / `schema` / `agent_review` / `approval` / `manual_check`.
> **Gate types:** `blocking` (merge-blocking) · `warning` · `informational`.
>
> **Totals (after the V0 scope cut):** 57 active acceptance-criterion gates (REQ-1..16; AC11.2/11.3/11.4
> removed as N-A, AC3.4 downgraded to informational) + 9 active validate-before-build probe gates (P-HOOK,
> P-SPOTTER, P-SHELL-PARSE, P-BUN-NATIVE removed as N-A) + 1 secret-hygiene gate = **67 active gate rows**
> (64 blocking, 1 warning, 2 informational), plus 7 rows explicitly marked **REMOVED / N-A**.

---

## REQ-1 — Always-on, legible, consentful ambient listening

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC1.1 | Spoken consent announcement within 3 s of start, stating "Only transcripts are saved" and naming the mute word | integration_test | blocking | `bun test src/onboarding/consent.test.ts` | Block merge until consent-content + scheduler tests pass | RBG: drop "Only transcripts are saved" sentence → consent-content assertion fails; passing scheduler test (once/session, idempotent, ≤3 s mocked clock); e2e transcript showing consent spoken first, measured <3 s |
| AC1.2 | Persistent always-on listening indicator active whenever the mic is streaming (audible E2 earcon is authoritative) | integration_test | blocking | `bun test src/onboarding/listening-indicator.test.ts` | Block merge; indicator must track mic-stream state | RBG: force indicator off while streaming → test fails; passing indicator-state test (E2 active iff streaming, inactive when muted); whole-session e2e indicator trace |
| AC1.3 | Transcript-only persistence: zero raw-audio artifacts written to disk/logs at any point | e2e_test | blocking | `bun test test/e2e/onboarding.e2e.ts` (whole-session disk/log scan) | Block merge; any `.wav`/`.pcm`/raw blob is a hard fail | RBG: introduce a raw-audio write path → mock-writer guard fails AND whole-session scan finds a blob; passing unit persistence-guard (writer never called); whole-session scan = 0 audio files incl. muted intervals |
| AC1.4 | Each finalized utterance → transcript observation carrying ≥ `{text,isFinal,speaker}` + traceable session id | unit_test | blocking | `bun test src/cue/adapter.test.ts` | Block merge; observation shape must conform | RBG: drop `speaker` from mapper → schema-presence assertion fails; passing adapter-normalization test (frames → exact `TranscriptObservation` shape, sessionId non-empty) |

## REQ-2 — Hard spoken mute that always wins

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC2.1 | Mute word stops audio streaming to ASR within 500 ms | e2e_test | blocking | `bun test test/e2e/onboarding.e2e.ts` (mute-latency, measured) | Block merge if measured stop time > 500 ms | RBG: relax stop path so close is deferred → measured >500 ms → fails; passing unit mute-latency (mocked clock ≤500 ms); live measured stop ≤500 ms |
| AC2.2 | Mute pre-empts every other cue on a co-occurring utterance | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (priority-ladder) | Block merge; mute must out-rank all cues | RBG: demote mute below another cue → priority test fails; passing cue-priority test (mute > suggestion/select/global on co-occurrence) |
| AC2.3 | While muted, zero observations produced and no suggestions/actions fire | integration_test | blocking | `bun test src/audio/mute-controller.test.ts` | Block merge; muted state must emit nothing | RBG: leave ASR stream open on mute → observations appear → fails; passing state-machine test (no observation in muted state); e2e: post-mute speech → 0 observations/actions |
| AC2.4 | Mute announced via earcon + one-word TTS and reflected in the indicator | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (mute-announce) | Block merge; mute must emit earcon + "Muted" | RBG: drop the one-word TTS → earcon-only → mute-announce test fails; passing test (mute tone + 1-word "Muted"); indicator flips to muted |

## REQ-3 — Conservative ambient suggestion engine (`observe.pass`-first)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC3.1 | Suggestion gated behind ≥60 words OR ≥90 s + buildable-intent/confidence; below floor → `observe.pass` | unit_test | blocking | `bun test src/suggest/engine.test.ts` (gate-boundary) | Block merge; sub-floor input must pass | RBG: lower threshold → 59-word case fires → fails; passing boundary tests (59→pass, 61→eligible; 89 s→pass, 91 s→eligible); empty/single-word/10k-word → all `observe.pass` |
| AC3.2 | Default cadence ≤1 spoken suggestion / 3 min; prefers to surface a queued idea on idle, not mid-talk | integration_test | blocking | `bun test src/suggest/engine.test.ts` (cadence + idle-preference) | Block merge; cadence cap + idle-hold must hold | RBG: zero out interrupt cost → fires mid-speech → fails; passing cooldown/cadence test (≤1/3 min) and idle-preference test (queued held to idle gap); replay corroboration |
| AC3.3 | Delivered as a spoken one-line pitch + 1–3 spoken MCQs (never >3), answerable aloud | unit_test | blocking | `bun test src/suggest/engine.test.ts` (MCQ-count invariant) | Block merge; >3 MCQs or non-spoken format fails | RBG: force 4 MCQs → invariant fails; passing tests (1–3 MCQs, pitch ≤12 words, answerable aloud) |
| AC3.4 | **DEFERRED (informational, not a V0 hard gate).** Suggestion recall/false-positive restraint is **env-tunable** (cadence/threshold/TTL params with documented defaults), tuned by feel later — not enforced against a fixed labeled corpus | eval | informational | (deferred) | Non-blocking: the annotated replay corpus + restraint metric (former ENG-T-07) are dropped for V0 (E9); restraint lives in `AC3.2`/`AC3.5` env knobs | If/when a corpus is built later, an `eval` recall/FP run can graduate this to a gate; for V0 the knobs and their defaults are the contract |
| AC3.5 | Cadence and TTL are live-tunable knobs without restart | integration_test | blocking | `bun test src/suggest/engine.test.ts` (live-knob) | Block merge; knobs must patch at runtime | RBG: hard-code cadence → knob-patch test fails; passing test (cadence/TTL changed at runtime, no restart) |

## REQ-4 — Hands-free spawn from a spoken acceptance → durable process

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC4.1 | Spoken "yes/accept" spawns a process, auto-selects it, enters planning, seeded with pitch + MCQ answers | integration_test | blocking | `bun test src/acceptance/spawn.test.ts` | Block merge; spawn must auto-select+plan+seed | RBG: drop `answers` from seed → seed-contents test fails; passing exactly-one-spawn + auto-select + planning-transition + seed-contents (pitch + every MCQ answer); e2e real durable process corroboration |
| AC4.2 | Spoken confirmation (earcon + ≤15-word TTS) acknowledges spawn, naming the callsign | unit_test | blocking | `bun test src/acceptance/spawn.test.ts` (confirmation format) | Block merge; confirmation must name callsign, ≤15 words | RBG: allow a 20-word confirmation → length guard fails; passing test (E3 + ≤15-word TTS naming the callsign) |
| AC4.3 | Spawn-to-spoken-confirmation completes within 3 s under nominal conditions | e2e_test | blocking | `bun test test/e2e/spine.e2e.ts` (measured spawn round-trip) | Block merge if measured spawn→confirm > 3 s | RBG: inject slow seam → measured >3 s → fails; passing P-SEAM async spawn ≤3 s without blocking the Cue loop; measured live spawn→confirm ≤3 s |
| AC4.4 | A declined/ignored suggestion spawns nothing and leaves the registry unchanged | unit_test | blocking | `bun test src/acceptance/classifier.test.ts` | Block merge; decline/ignore must be a no-op | RBG: make decline fall through to spawn → registry grows → fails; passing exactly-one-spawn test (decline/ignore add zero); ignore-timeout test (no-op) |

## REQ-5 — The canonical voice loop is the spine

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC5.1 | Full loop completes hands-free with no keyboard/mouse/projector input at any step; projector may display state but is not required for the routine voice loop | e2e_test | blocking | `bun test test/e2e/spine.e2e.ts` (projector-disabled harness) | Block merge if the routine voice loop consumes a GUI/keyboard event | RBG: feed a build that waits for a projector click → harness asserts >0 GUI events / hangs → fails; passing harness asserts zero GUI/keyboard events across the routine loop |
| AC5.2 | Loop succeeds end-to-end on ≥9 of 10 scripted live runs; each failure attributable to a logged cause | e2e_test | blocking | `bun test test/e2e/spine.e2e.ts` (canonical scenario ×10) | Block merge if <9/10 pass or any failure lacks a logged cause | RBG: broken dispatcher build → ≥2 runs fail → suite red; passing ≥9/10 run with per-failure logged `correlationId` cause |
| AC5.3 | Every stage transition is audibly legible (earcon or one-word ack) | integration_test | blocking | `bun test src/routing/handlers.test.ts` (stage-sequencer) | Block merge; each stage boundary must emit an ack | RBG: drop the ack on a stage boundary → sequencer test fails; passing test (each of 4 stages emits its mapped earcon/ack), incl. each single-stage failure path |
| AC5.4 | A single automated scenario test exercises all four stages in sequence (the integration spine) | e2e_test | blocking | `bun test test/e2e/spine.e2e.ts` | Block merge if the spine scenario is absent or fails | RBG: break one stage → scenario fails at that boundary; passing single scenario driving wake→intent→action→confirm, one `correlationId` end-to-end |

## REQ-6 — Two-channel routing (C2/C3) with audible routing acks

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC6.1 | An utterance without a process magic word can never steer a process (enforced at dispatch, not the LLM) | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (dispatch-invariant) | Block merge; un-addressed steering must be rejected | RBG: remove the guard → un-addressed talk steers → fails; passing dispatch-invariant test (steering verb, no callsign, no window → rejected) |
| AC6.2 | Speaking a process's magic word opens a steering window scoped to that process | unit_test | blocking | `bun test src/routing/steering-window.test.ts` | Block merge; window must scope to the selected UPID | RBG: route post-select speech to wrong UPID → fails; passing window-lifecycle test (open on callsign; subsequent speech → that UPID only) |
| AC6.3 | Window closes on ~20 s idle, an explicit end word, or the panic word | unit_test | blocking | `bun test src/routing/steering-window.test.ts` | Block merge; window must close on all three conditions | RBG: disable idle timer → window never closes → fails; passing close tests (Done/Back, 20 s idle, Abort) |
| AC6.4 | Addressed/explicit routed utterances get a distinct audible ack (suggestion vs steer-X vs addressed-pass); **ignored ambient speech (`observe.pass`/`route.pass`) is SILENT** | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (acks-distinct) | Block merge; the addressed acks must be pairwise distinct AND ignored-ambient must emit nothing | RBG: emit any sound on an ignored ambient `observe.pass`/`route.pass` → the ambient-silence test fails; make two addressed acks identical → the acks-distinct test fails; passing test (suggestion/steer/addressed-pass acks pairwise distinct; ignored ambient → 0 audio) |
| AC6.5 | "One-breath" select-and-steer ("Atlas, make the header blue") routes correctly in a single utterance | integration_test | blocking | `bun test src/routing/dispatch.test.ts` (one-breath) | Block merge; one-breath must select + steer the right UPID | RBG: split-only parser → one-breath mis-routes → fails; passing test (callsign+instruction in one utterance → select + steer:X); e2e live one-breath |

## REQ-7 — Fixed, documented magic-word command vocabulary (deterministic)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC7.1 | Command set enumerated in docs and includes ≥ select/callsign, accept, stop/panic, mute, global pause-all/status | unit_test | blocking | `bun test src/routing/vocabulary.test.ts` (command-coverage) | Block merge; every documented command must map to exactly one handler | RBG: drop the `status` handler → a documented command has no handler → fails; passing command-coverage test over the §4.3 table; manual_check: doc enumeration present |
| AC7.2 | Process callsigns are phonetically distinct & accident-resistant (no two within edit/phonetic distance; not common words) | unit_test | blocking | `bun test src/routing/callsigns.test.ts` (collision-guard) | Block merge; a near-collision callsign must be rejected | RBG: add a callsign within distance ≤2 → must reject (else fails); passing collision-guard test (Metaphone + phoneme-Levenshtein ≤2 vs every active callsign/wake/mute/panic); depends P-PHONETIC |
| AC7.3 | Command recognition is deterministic: same transcript → same routing decision every time | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (determinism) | Block merge; non-deterministic routing fails | RBG: introduce nondeterminism (e.g. LLM in the match path) → replay N× diverges → fails; passing determinism test (same transcript ×N → identical decisions) |
| AC7.4 | Natural-language / agent-mediated commands are explicitly out of V0 scope | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (tier-gating) | Block merge; free-form NL must be inert as a command | RBG: route NL "pause the second one" (no callsign) to a pause action → fails; passing tier-gating + dispatch-invariant (NL without callsign/window rejected); manual_check: NG-2 documented |

## REQ-8 — Voice steering of a selected process

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC8.1 | A spoken instruction to a selected process changes its behavior/output (observable in its next spoken summary/state) | e2e_test | blocking | `bun test test/e2e/fleet.e2e.ts` | Block merge; steer must produce an observable change | RBG: drop the steer signal → no change observed → fails; passing live test (select Atlas, steer, observe change in spoken/recorded output); unit steer-dispatch (routes to selected UPID only) |
| AC8.2 | Steering one process never affects a sibling process | unit_test | blocking | `bun test src/process/registry.test.ts` (isolation) | Block merge; sibling state must be unchanged | RBG: leak steer to all UPIDs → sibling mutates → fails; passing isolation test (mutate A; B byte-for-byte unchanged); e2e fleet-isolation corroboration |
| AC8.3 | A mis-transcribed/unintelligible steering instruction is not silently applied (re-prompt or drop with ack; never destructive) | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (low-confidence) | Block merge; low-confidence instruction must not execute | RBG: execute low-confidence instruction → fails; passing low-confidence test (routes to re-prompt/drop, not execute) |

## REQ-9 — Rationed spoken output (hybrid earcons + TTS)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC9.1 | ~90% of process ticks are silent: measured TTS-bearing ticks ≤10% over a representative session | e2e_test | blocking | `bun test test/e2e/spine.e2e.ts` (silence-ratio) | Block merge if TTS-bearing ratio > 10% | RBG: chatty build emits TTS on routine ticks → ratio exceeds 10% → fails; passing representative-session run with measured ratio ≤10% |
| AC9.2 | Substantive TTS only on: completion, blocker/decision-needed, or explicit ask | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (trigger-class map) | Block merge; TTS outside allowed classes fails | RBG: map a routine tick → TTS → fails; passing output-policy test (each trigger class → {silent\|earcon\|tts}); e2e every TTS in an allowed class |
| AC9.3 | Substantive spoken utterances ≤15 words; file names/diffs/URLs never read aloud | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (15-word + never-recite) | Block merge; >15-word or recited payloads fail | RBG: remove guard → 16-word recited verbatim → fails; passing 15-word-guard (summarizes >15) + never-recite (strips file/diff/URL/stack) |
| AC9.4 | State transitions and acks use earcons, not sentences | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (class→channel) | Block merge; state transition routed to TTS fails | RBG: route a state transition → tts → fails; passing class→channel map (wake/spawn/resolve → earcon) |

## REQ-10 — Sub-second command acknowledgement (latency)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC10.1 | Earcon acknowledgement of a recognized command within 300 ms of finalization | e2e_test | blocking | `bun test test/e2e/latency-benchmark.e2e.ts` (earcon) | Block merge if measured earcon > 300 ms | RBG: set 100 ms budget → fails; relax → passes (proves the assertion bites); passing e2e earcon ≤300 ms after `isFinal` while the LLM decision is artificially delayed; unit mocked-clock support |
| AC10.2 | End-to-end command round-trip < 1 s p50 and < 1.5 s p95 under nominal load | e2e_test | blocking | `bun test test/e2e/latency-benchmark.e2e.ts` (≥100 round-trips) | Block merge if p50 ≥1 s or p95 ≥1.5 s; future regression past baseline fails | RBG: throttle provider → p95 blows budget → fails; passing benchmark over ≥100 live round-trips stored as a regression baseline (p50 <1 s, p95 <1.5 s) |
| AC10.3 | If the round-trip budget is exceeded, a "working on it" earcon is emitted rather than silence | integration_test | blocking | `bun test src/audio/output-policy.test.ts` (timeout-ack) | Block merge; over-budget must emit the working pulse | RBG: remove the `RoundTripTimer` → silence on overrun → fails; restore → pulse fires; passing timeout-ack test (working pulse fires once budget blown, stops when substantive ack arrives); e2e injected slow build |

## REQ-11 — Run-to-completion execution posture (V0 runs dangerously; sandbox later, not per-action gating)

> **V0 posture change (E6/E7/E8/O-Safety).** Vibersyn V0 **runs to completion, dangerously** — there is
> **no per-step approval, no spoken read-back/confirm gate, no dead-man timer, no Safe/Explicit/Dangerous
> mode switching, and no shell classifier.** "You shouldn't need to approve often"; where a confirmation is
> genuinely needed the voice library (Cue) handles it. If isolation is wanted later we **sandbox the whole
> process**, not gate via permission classification. The former read-back hook, mode switch, and shell
> classifier are cut; the criteria below reflect the run-to-completion posture.

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC11.1 | The process runs to completion without per-step approval gates (no read-back/confirm interrupt on routine tool calls) | integration_test | blocking | `bun test src/process/run-to-completion.test.ts` | Block merge; a per-action approval gate must NOT appear in the default run path | RBG: insert a per-action approval gate → an approval prompt appears mid-run → fails; passing run-to-completion test (a multi-tool sequence completes with 0 approval prompts) |
| AC11.2 | **REMOVED / N-A** — spoken read-back + confirm before destructive acts | — | — | — | Cut per E6: no read-back/confirm gate in V0. The former P-HOOK probe and `safety-execution-boundary-hook` ticket are removed. | n/a |
| AC11.3 | **REMOVED / N-A** — dead-man timer on dangerous acts | — | — | — | Cut per E6/E7: no dead-man timer; run-to-completion. | n/a |
| AC11.4 | **REMOVED / N-A** — Safe/Explicit/Dangerous mode switching | — | — | — | Cut per E7: one mode (run dangerously). No mode switching; sandbox the process later if needed. | n/a |

## REQ-12 — Panic / stop word that always wins

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC12.1 | Stop word halts the in-focus process within 1 s of being spoken | e2e_test | blocking | `bun test test/e2e/safety.e2e.ts` (halt-latency) | Block merge if measured halt > 1 s | RBG: defer halt dispatch → measured >1 s → fails; passing live test (start a process working, speak stop, halts ≤1 s measured); unit halt-dispatch support |
| AC12.2 | Stop out-prioritizes all cues except hard-mute, even mid-action where interruptible | unit_test | blocking | `bun test src/routing/dispatch.test.ts` (priority) | Block merge; priority ladder must hold | RBG: demote stop below steer → fails; passing priority test (stop > select/steer/suggest; mute > stop) + interruptible-action test (cancels in-flight cancellable action) |
| AC12.3 | The halt is acknowledged audibly (earcon + ≤15-word TTS) | unit_test | blocking | `bun test src/audio/output-policy.test.ts` (halt-announce) | Block merge; halt must emit E5 + ≤15-word TTS | RBG: map halt to earcon-only → fails; passing halt-announce test (E5 + ≤15-word TTS naming the target) |

## REQ-13 — Minimal concurrent fleet (degrades gracefully)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC13.1 | Two processes run concurrently; selecting/steering/pausing one does not affect the other | e2e_test | blocking | `bun test test/e2e/fleet.e2e.ts` | Block merge; cross-process effects fail | RBG: route "[callsign], pause" to all UPIDs → sibling pauses too → fails; passing live test (spawn Atlas+Bravo; "Bravo, pause" pauses B while A advances); unit concurrent-registry isolation |
| AC13.2 | Each process has a distinct, non-colliding callsign and routes correctly with no cross-talk | unit_test | blocking | `bun test src/routing/callsigns.test.ts` + `src/routing/dispatch.test.ts` | Block merge; collision or mis-route fails | RBG: assign colliding callsigns → collision-guard rejects (else fails); passing interleaved-routing test (utterances to A and B route correctly) |
| AC13.3 | An unselected process keeps running autonomously ("unselected" ≠ "paused") | e2e_test | blocking | `bun test test/e2e/fleet.e2e.ts` | Block merge; unselected process must keep progressing | RBG: pause-on-deselect bug → unselected stalls → fails; passing live test (leave both unselected a fixed interval, confirm both made progress) |
| AC13.4 | If concurrent operation fails/is disabled, the single-process spine (REQ-5) still passes | integration_test | blocking | `bun test test/e2e/spine.e2e.ts` (degradation) | Block merge; fleet must be additive, never a spine dependency | RBG: make the spine import the fleet path → disabling fleet breaks the spine → fails; passing degradation test (fleet path disabled → REQ-5 scenario still passes) |

## REQ-14 — Bounded non-voice emergency stop (emergency-only)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC14.1 | A single non-voice/one-control action stops all streaming and halts all processes within 2 s | e2e_test | blocking | `bun test test/e2e/safety.e2e.ts` (emergency-stop) | Block merge if measured kill-all > 2 s | RBG: leave a process registered after trigger → not all halted → fails; passing live test (several processes running → trigger → all halt + listening stops ≤2 s, session ends) |
| AC14.2 | Scoped emergency-only: exposes only kill-all, no steer/select/spawn, no unmute/resume verb | unit_test | blocking | `bun test src/emergency/stop.test.ts` (scope + no-unmute) | Block merge; any operational verb on this control fails | RBG: add a steer or unmute route → scope/no-unmute test fails; passing scope test (only kill-all) + no-unmute-verb test (no resume/unmute path) |
| AC14.3 | Triggering it is loud and unambiguous (audible +, if a display exists, visible) | unit_test | blocking | `bun test src/emergency/stop.test.ts` (signal) | Block merge; trigger must emit the unambiguous signal | RBG: suppress the signal on trigger → fails; passing test (handler emits the loud unambiguous audible signal) |

## REQ-15 — Durable processes (persist, keep running, survive restart)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC15.1 | A spawned process continues advancing while the room is silent / it is unselected | e2e_test | blocking | `bun test test/e2e/fleet.e2e.ts` (progress-while-silent) | Block merge; a silent room must not stall the process | RBG: gate progress on selection → no advance while unselected → fails; passing live test (process advances during a fixed silent interval); depends P-SMITHERS |
| AC15.2 | Context preserved across lifecycle: pre-kill archive + pre-spawn resource check occur | integration_test | blocking | `bun test src/process/lifecycle.test.ts` + `src/process/resource-check.test.ts` | Block merge; missing archive or resource check fails | RBG: remove the pre-spawn check → a 3rd process spawns past the cap → fails; passing pre-kill-archive test (context persisted before teardown) + resource-check test (at cap → refused, registry unchanged, audible refusal ack) |
| AC15.3 | After a backend restart, an in-flight process is recoverable to its last durable state (no silent loss) | e2e_test | blocking | `bun test test/e2e/fleet.e2e.ts` (durability-recovery) | Block merge; lost work on restart fails | RBG: disable checkpointing → restart loses state → recovery-equality fails; passing test (kill backend mid-run, restart, resume from last checkpoint; reloaded state == pre-restart snapshot); depends P-SMITHERS |

## REQ-16 — Projector UI + structured tracing

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| AC16.1 | Every decision (incl. every `observe.pass`), action, routing choice, state transition recorded with a traceable id, queryable | unit_test | blocking | `bun test src/obs/trace.test.ts` (trace-schema) | Block merge; any record missing required ids fails | RBG: drop `correlationId` from an action event → trace-schema test fails; passing schema test (required ids/fields on every record) + pass-logging test (every `observe.pass` → a `route.pass` line) |
| AC16.2 | The Vite projector UI renders the required live regions: listening/mute, active cue, suggestion status, two-process fleet, recent spoken output, and trace/transcript strip | e2e_test | blocking | `bun run build` + `bun test test/e2e/board.e2e.ts` (projector-render contract) | Block merge if the browser app is absent, stale, or visually empty | RBG: remove a required region → projector-render contract fails; passing Vite build + region assertions |
| AC16.3 | The projector is non-authoritative for routine operation: with it closed, every voice requirement still passes; only bounded unmute/emergency controls may mutate state | e2e_test | blocking | `bun test test/e2e/board.e2e.ts` (projector-non-authoritative) | Block merge; any general steer/spawn/select UI endpoint or projector dependency fails | RBG: add a POST steer route → projector contract fails; RBG: make a voice flow await a projector connection → projector-down scenario hangs → fails; passing run of REQ-5 with the projector server down |
| AC16.4 | From traces alone (no live system), an engineer can reconstruct any utterance's full observation→decision→action→outcome chain | integration_test | blocking | `bun test src/obs/trace.test.ts` (causal-chain reconstruction) | Block merge; an unreconstructable chain fails | RBG: drop `correlationId` join key → chain cannot be rebuilt → fails; passing reconstruction test (rebuild full observation→decision→action→outcome chain from recorded traces); e2e: reconstruct from persisted traces, assert matches live run |

---

## Validate-before-build probe gates (§6 PRD / §17 eng)

> Per the validation bar, **every non-framework third-party dependency is exercised against the REAL
> API with a probe that asserts the exact behavior we rely on, before any product code is built on it.**
> A probe that *could* fail and *passed* is the evidence; docs/memory are not. Probe scripts live under
> `poc/`; reports under `artifacts/smithering/reports/`. **All probes are currently UNRUN.**

| Probe | Dependency / question | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| P-CUE | Cue runs; cue-policy + `observe.pass` + two-`Program` routing + `MappedActionTool` schema + provider slots match; `TextCue` resolves ≤300 ms earcon budget | integration_test | blocking | `bun test poc/p-cue.test.ts` (real Cue) | Block build (first build task); if false, redesign REQ-1/3/5/6/7 and surface to gate | RBG probe run against the real library (each design-row assertion + `TextCue`-latency capable of failing); recorded report; repo-access confirmation |
| ~~P-HOOK~~ **REMOVED / N-A** | Was: Smithers PreToolUse hook intercept-and-hold for a read-back/confirm gate | — | — | — | **Cut (E6/E7/O-Safety).** V0 runs to completion / dangerously — no read-back/confirm safety gate. Sandbox the process later if needed, not per-action gating. | n/a |
| P-ASR | Deepgram Nova-3 streaming: `isFinal`-flagged diarized observations, word-final latency <200 ms, no observation on silence; credential from subscription, never logged | integration_test | blocking | `bun test poc/p-asr.test.ts` (real Deepgram) | Block build; ≤300 ms earcon + <1 s round-trip depend on it | RBG probe (latency + isFinal shape + silence→no-observation, each failable) + secret-redaction assertion (zero key-shaped strings in probe report) |
| P-TTS | Which candidate streams first audio byte ≤200 ms (selection benchmark); no key written to any log/report | integration_test | blocking | `bun test poc/p-tts.test.ts` (real candidates) | Block build; round-trip ≤1 s unprovable until one passes | RBG probe across 2026 TTS candidates (first-byte ≤200 ms failable) + selection record + secret-redaction assertion |
| P-LLM | Cheap/fast model returns temp-0-deterministic decisions ~100 ms with `MappedActionTool`-compatible schema; probe trace has zero key-shaped strings | integration_test | blocking | `bun test poc/p-llm.test.ts` | Block build; record-replay + hot-loop budget + PRD §6 depend on it | RBG probe (temp-0 determinism, ~100 ms p50, tool-selection schema) + redaction assertion (no raw key in trace) |
| A-LLM-SUB | Can the hot-loop model be reached through the **host's logged-in Codex/Claude subscriptions** (no raw key)? | integration_test | blocking | `bun test poc/a-llm-sub.test.ts` | Block build; if no subscription-routable model meets the budget, binding PRD-§6 conflict to resolve at gate | RBG probe confirming subscription-routed access via the host's logged-in CLIs OR a recorded conflict surfaced to the gate; no raw key present |
| P-SMITHERS | Durable spawn, `streamRunEvents`, pause/resume, steer/signal, restart-recovery, concurrent runs behave as the lifecycle assumes; fork realization (native vs seeded `parentId`) | integration_test | blocking | `bun test poc/p-smithers.test.ts` | Block build; REQ-4/8/13/15 depend on it | RBG probe exercising each lifecycle op against the real harness (each failable), incl. recovery-equality after restart; recorded report |
| P-SEAM | A Cue `MappedActionTool` action round-trips through the dispatcher into a real Smithers run and SSE run-events flow back into Cue; spawn ≤3 s without blocking the Cue loop | integration_test | blocking | `bun test poc/p-seam.test.ts` | Block build; novel integration / top risk | RBG probe (action out + run-event back; spawn ≤3 s; non-blocking) against real Cue+Smithers; recorded report |
| ~~P-SPOTTER~~ **REMOVED / N-A** | Was: local on-device keyword spotter for unmute-while-muted | — | — | — | **Cut (V2).** The voice library (Cue) handles always-on keyword listening while muted; unmute = say "unmute" or press the on-screen unmute button. No bespoke spotter. | n/a |
| ~~P-SHELL-PARSE~~ **REMOVED / N-A** | Was: shell parser feeding the §8.1.1 shell classifier | — | — | — | **Cut (E8).** No shell classifier, no gating — V0 runs dangerously; sandbox the process later if needed. | n/a |
| ~~P-BUN-NATIVE~~ **REMOVED / N-A** | Was: native spotter module under Bun | — | — | — | **Cut (V2).** The spotter is removed, so there is no native spotter module to load. | n/a |
| P-PHONETIC | double-metaphone / phoneme-Levenshtein library produces stable, reproducible codes for the callsign collision guard | unit_test | warning | `bun test poc/p-phonetic.test.ts` | Non-blocking (justified): pure deterministic lib, swappable with zero architectural impact | RBG probe (stable codes across runs); covered by callsign collision-guard unit tests |
| P-OTEL | Smithers structured output exports to self-hosted Langfuse via OTLP with GenAI semantic conventions | integration_test | informational | `bun test poc/p-otel.test.ts` | Non-blocking (justified): observability off every critical path; OTLP backends swappable by config | RBG probe (OTLP export succeeds); Cue JSONL already covers causal-chain reconstruction |

---

## Cross-cutting secret-hygiene gate (PRD §6 / eng §2.1, §15.6)

| Criterion ID | Criterion | Method | Gate | Checked by | Failure action | Evidence required |
|---|---|---|---|---|---|---|
| SEC-1 | No raw provider key appears anywhere in source/artifact/log/JSONL trace/probe report; model access comes from the **host's logged-in Codex/Claude subscriptions** (no raw keys in source); redaction is fail-closed | e2e_test | blocking | `bun test test/e2e/secret-scan.e2e.ts` + `src/providers/credentials.test.ts` | Block merge; any key-shaped string in the trace tree fails | RBG: plant a fake bearer/`sk-…`/Deepgram key in a `meta` field with the filter disabled → it leaks → secret-scan/redaction test fails; enable → `«redacted»`; passing no-raw-key test (a raw-key construction path is rejected) + whole-session secret-scan = 0 key-shaped strings |

---

## How the implementation workflow consumes this matrix

- **Blocking gates** (71) are wired into merge checks: a PR that touches a component must show the
  named test(s) **passing with a recorded red-before-green** for the gates it implements. A blocking
  gate with no failable test, or whose only evidence is "the agent said it's done," **blocks merge**.
- **Probe gates** run **before** the code that depends on them: **P-CUE is the first build task**;
  A-LLM-SUB and the ASR/TTS/seam probes are blocking. (P-HOOK, P-SPOTTER, P-SHELL-PARSE and P-BUN-NATIVE
  are **removed/N-A** — the safety read-back hook, on-device spotter, and shell classifier are cut for V0.)
  A failed blocking probe is **surfaced to the orchestrator's gate**, not engineered around.
- **Latency/recall gates** (AC10.2, AC3.4, AC9.1) store a **regression baseline**; a later build that
  regresses past threshold **fails the gate**.
- **Warning/informational gates** (P-PHONETIC, P-OTEL) do not block merge but must run
  before their paths ship; failure forces the recorded fallback (library swap / backend swap).
