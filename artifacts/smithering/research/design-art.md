# Design Art — Vibersyn

> Researched 2026-06-13. Covers VUI (voice user interface) best practices, ambient listening
> design, command vocabulary conventions, earcon design, mission-control observability boards,
> and voice onboarding patterns — all filtered for Vibersyn's specific constraints:
> audio-only, always-on, team-room, ambient-suggestion-then-agent-spawn.
>
> Organized as: what to **copy**, what to **avoid**, and the concrete Vibersyn implication.

---

## 1. Wake Word / Magic Word Design

### Best-in-class examples

**Amazon "Alexa"** was engineered, not just named. Its 6 phonemes (ə/l/ɛ/k/s/ə) span multiple
consonant classes and vowel positions. It became the canonical example of acoustic design for
wake words. Key principles (from Sensory 2026 guide + Amazon Science research):

- **3–4 syllables is the sweet spot.** "Hey Siri," "Alexa," "OK Google" all land there.
  Short enough for natural repetition; long enough for the model to lock onto.
- **Lead with plosives or affricates** (/k/, /g/, /tʃ/). Sharp acoustic onsets — this is what
  the detection model anchors to first.
- **Include distinct diphthongs or formant shifts.** "ey" in "Hey," "lex" in "Alexa." These
  survive room acoustics and accent variation better than pure vowels.
- **Never use domain-common words.** If your product discusses AI agents, avoid anything that
  sounds like "agent," "task," or "process" — every natural use becomes a false trigger.
- **No common English prepositions, articles, or filler words.** "Okay" alone barely works —
  Google had to compound it to "OK Google" because standalone "okay" appears too often in
  ambient speech.

### What to avoid

- The full product name "Vibersyn" (5 syllables, starts with bilabial /p/, not ideal — the /p/
  onset is soft; better to compound or shorten).
- Any word easily confused with a teammate's name or a common technical term spoken in the room.
- Homophonic pairs within the active callsign set (see NATO rationale below).

### Vibersyn implication

The global wake word should be 3–4 syllables, plosive-leading, coined or rare. "Viber" or a
distinct coined word beats the full "Vibersyn." Per-process callsigns (REQ-7) must be drawn
from a phonetically verified set — the NATO alphabet is the gold standard for exactly this.
The callsign collision guard (AC7.2) should compute edit distance AND phonetic similarity
(Soundex/Metaphone) across the active set.

---

## 2. Earcon Design

### Best-in-class examples

**Amazon Echo LED ring + earcon system** is the most thoroughly validated consumer earcon design.
Every state gets a non-verbal signature:

| State | Audio + Visual |
|---|---|
| Passive (keyword detection only) | No ring, no sound |
| Wake / actively listening | Brief ascending chime + cyan spotlight on blue ring |
| Processing | No audio (silence signals "I heard you, thinking") + spinning blue ring |
| Notification waiting | No audio + pulsing yellow ring |
| Mic muted (hardware) | No audio + solid red ring |

The **no audio during processing** is a deliberate choice — silence after the wake chime signals
receipt. Speaking "I heard you, processing…" is slower than a 150ms earcon and trains the wrong
expectation.

**Intel bong, NBC chimes, McDonald's jingle** are the model for earcon branding: 3 notes max,
distinctive interval, consistent across every surface. Emotional associations are trainable —
you choose the earcon, the user learns it — but only if you use it consistently and sparingly.

### What to avoid

- Earcons that sound similar to each other — listeners need to distinguish them under noise
  and cognitive load. Space them acoustically (different pitches, different rhythm patterns).
- Spoken state announcements substituting for earcons. "Processing your request" wastes ~1.5s
  and interrupts the room. An earcon does the same in 200ms.
- Reusing earcons for different states. If "spawn succeeded" and "mute enabled" use the same
  tone, users will not distinguish them.
- Long earcons (> 500ms for transient states). The earcon signals; it does not perform.

### Vibersyn implication

Design exactly **5 earcons** for V0 — no more:

1. **Wake/active** — ascending two-tone (≈300ms), fires on wake-word detection
2. **Transcribing-active** — nearly subliminal ambient tone/hum, continuous while mic is live
   (should be close to perception threshold — present, not attended)
3. **Agent spawned** — distinct single high note (≈200ms), confirms a new process is running
4. **Agent completed/resolved** — resolution interval chord (≈400ms), signals work is done
5. **Stop/halt** — descending two-tone (≈300ms), confirms a panic/stop command was received

Mute state: a **persistent low ambient tone** (not intermittent) signals mic is muted. Nothing
means passively listening. A distinctive persistent signal means muted.

---

## 3. Ambient Listening Design and the False-Positive Asymmetry

### The core principle (and why most products get it wrong)

**A spoken suggestion is a broadcast interrupt.** A screen notification is ignorable — the user
glances at it, dismisses it, returns to conversation. A spoken suggestion **talks over the room**:
it interrupts every person present simultaneously, with no opt-out for individuals. This makes the
quality bar for Vibersyn's suggestion engine asymmetrically higher than any visual-interface AI:

> A false positive that appears on a screen = mild friction.
> A false positive that is spoken in a shared room = interrupts a technical conversation, breaks
> everyone's train of thought, potentially talks over a human mid-sentence.

CHI 2025 research on proactive AI assistants for programming found users in "Persistent Suggest"
conditions described the system as "distracting" and "annoying," with annoyance directly
correlated with suggestion frequency and inversely correlated with perceived usefulness.

**Clippy's documented failure** is the canonical antipattern: "It looks like you're writing a
letter" triggered too often, in contexts where it was not useful, interrupting intentional work.
The four principles of "polite computing" (Microsoft Research, 1998, cited in VUI research) it
violated: (1) respect user choice, (2) disclose yourself, (3) offer useful choices,
(4) remember past choices. Vibersyn's conservative Clippy must honor all four.

### What to copy

**Amazon Echo's passive vs. active state distinction** — users can see/hear whether the device
is passively waiting (no signal) or actively processing. The hard-mic-mute (red ring, hardware
disconnect) is the gold standard for "I guarantee nothing goes out." Vibersyn's persistent
listening indicator earcon serves this role.

**"Better to ask than to assume" framing (CHI 2024 proactive voice study):** Users strongly
preferred assistants that asked consent before acting vs. those that acted and let you undo.
Vibersyn's spoken suggestion + MCQ model maps directly to this — the system surfaces intent,
asks clarifying questions, and waits for spoken acceptance before taking any action.

**Idle-preferring cadence (Cue's IdleCue):** A suggestion held until the room goes quiet is
less intrusive than one that fires mid-sentence. Delivering a queued suggestion on a natural
conversation pause is the audio analog of a "browser notification that waits for an idle tab."

### What to avoid

- Calibrating the suggestion threshold on "is this suggestion good?" — the right question is
  "is this suggestion *necessary and timely enough to justify interrupting a human conversation
  in progress*?" That is a much higher bar.
- Any auditory notification pattern that fires more than once per 3 minutes. Below that cadence,
  even imperfect suggestions are tolerable; above it, even useful suggestions become noise.
- Apologetic language in suggestion delivery. "I noticed you might want to…" is longer and less
  trustworthy than a brief, confident one-liner. Brevity signals confidence.

### Vibersyn implication

The REQ-3 thresholds (≥60 words OR ≥90s, ≤1 suggestion/3 min, idle-preferring) are the right
shape. The addition: calibrate the suggestion engine's confidence threshold on "room-interrupt
cost" not just "suggestion quality" — a 70%-confidence suggestion that might interrupt a
heated technical debate is worse than a 95%-confidence suggestion offered on an idle gap.

---

## 4. Command Vocabulary Design: ATC and NATO Patterns

### ATC phraseology (FAA AIM Chapter 4) — what to copy

Air traffic control is the most rigorously tested high-stakes voice command system in existence.
Its design principles, refined over 80 years of failure analysis:

- **Hyper-specific, internationally standardized lexicon.** Every word is chosen for
  clarity over noisy radio. "Say again" (not "repeat" — in military context "repeat" means
  "fire again"). "Roger" = received only. "Wilco" = received AND will comply. These are distinct
  because confusing them is dangerous. The specificity is not pedantry; it closes ambiguity loops.
- **The readback protocol.** After a controller issues an instruction, the pilot reads it back
  verbatim. This closes the communication loop and confirms mutual understanding. For
  Vibersyn: agent-steering should close with a brief readback — "Got it: summarize competitors
  and report back" — not silent acceptance.
- **Verb-first, noun-second syntax.** "Turn left heading 270" not "heading 270, turn left."
  The action comes first. Under cognitive load, imperative-first syntax is parsed faster.
- **No ambiguous single letters.** "November" not "N", "Charlie" not "C". Single letters fail
  at 30% WER; full words fail far less often.

### NATO phonetic alphabet rationale (ICAO, 1948–49)

ICAO linguists redesigned the alphabet under one constraint: each word had to be recognizable in
English, French, and Spanish AND acoustically distinct across the full 26-word set. "Alpha" not
"Able" — "able" sounded like "apple" on degraded radio. The redesign prioritized **acoustic
distinctiveness across the entire active set**, not just individual word clarity.

The lesson for Vibersyn callsigns: the active callsign set must be designed holistically.
Adding a new callsign means checking it against every other active callsign for phonetic
similarity — the same discipline ICAO applied.

### What to avoid

- Using common conversational words as magic words. "Yes," "start," "go," "help" — these appear
  constantly in natural team conversation and will trigger false positives.
- Similar-sounding callsigns for concurrent processes ("Alpha" and "Alfa", "Delta" and
  "Della"). At 7.4% WER on technical speech (domain.md), similar-sounding callsigns will be
  misrouted under ambient noise conditions.
- Long, polysyllabic stop words. The panic word must be short (1–2 syllables) for fast
  utterance under stress. "Stop" and "cancel" are good. "Emergency abort sequence" is not.

### Vibersyn implication

V0 should ship with a pre-validated callsign set drawn from the NATO alphabet or a
phonetically-equivalent coined set. The collision guard at AC7.2 should be implemented as a
function that rejects any proposed callsign within a phonetic distance threshold of all active
callsigns AND within a distance threshold of the wake word and the mute/stop words. Document
the phonetic distance algorithm used (Metaphone or Soundex at minimum; Levenshtein on phoneme
sequences is better) so it is reproducible and testable.

---

## 5. Mission-Control Observability Board Design

### NASA Apollo MOCR / ATC STARS — what to copy

The Mission Operations Control Room (MOCR) and STARS (Standard Terminal Automation Replacement
System) are the reference designs for multi-stream, always-on observability under high stakes.

**Structural principles:**
- **Role-based display segregation.** Each operator had one domain of information. The flight
  director saw the global view; propulsion engineers saw propulsion. For Vibersyn's board:
  one panel per process, plus a global summary panel. Not a combined log feed.
- **Tiered authority layout.** Higher authority = wider scope displayed = more central position.
  The global status metric should occupy top-center of the Vibersyn board; process panels
  radiate outward.
- **Color semantics: additive urgency.** STARS: default black background (reduces eye fatigue
  in dim monitoring environments), green for nominal, yellow for attention-warranted, red for
  action required. Color progression is never reversed or repurposed.
- **Blink = the highest-urgency alert.** Blinking elements are detected faster than color
  changes in peripheral vision. Reserve blinking for states that require immediate attention.
  Non-critical states should never blink — "blink fatigue" is a real failure mode.
- **Z-pattern scan path.** In left-to-right layouts, eyes trace top-left → top-right →
  bottom-left → bottom-right. Place the most critical status metric (listening indicator) at
  top-left.

**Color guidance:**
- Avoid violet/purple for status — operators consistently misidentify it as "blue" or "red"
  under stress (documented in STARS human-factors audit).
- Use APCA contrast (not WCAG 2.1) for dark-mode displays — standard WCAG 2.1 is calibrated
  for light backgrounds and underestimates contrast needs for dark interfaces.
- Process states: black background, green text for nominal, amber for paused/pending, red for
  halted/error, cyan for active/selected.

### What to avoid

- Operational controls on the observability board (AC16.2). The NASA mission control principle:
  "read-only displays do not have buttons." Mixing read and write surfaces in a crisis causes
  operators to make inadvertent commands. The Vibersyn board must be strictly passive.
- Auto-scrolling logs with no pause. If the log scrolls past readable speed during active
  operation, it becomes worthless. Offer scroll-pause-on-hover at minimum.
- Aggregated-only views. A "total event count" metric tells you nothing about which process
  is stuck. Per-process lanes are non-negotiable.

### Vibersyn implication

The optional observability board (REQ-16) should be designed as a **read-only mission-control
console**, not a dashboard. Layout: listening indicator (top-left, always visible), global
earcon/mute state (top-center), emergency-stop status (top-right), then per-process panels
in a two-column grid (left = callsign + state + last spoken output; right = recent action log,
last 5 events). A global trace log at the bottom is scrollable but not auto-scrolled. Every
element is display-only — no clickable controls.

---

## 6. Audio Onboarding

### What to copy

**Alexa's "try this command" setup flow:** After hardware setup, Alexa immediately asks the user
to say a specific command ("Ask Alexa to tell you a joke"). This one-command first-run exercise
builds the physical habit (speak to the device) and confirms the microphone is working. It is
short, non-optional, and immediately succeeds — which is critical.

**The laminated card heuristic:** Studies on smart speaker adoption in older adults found that a
physical command card near the device significantly improved command recall and confidence.
For a team-room product, a small printed card (A6 or business card size) with the magic-word
vocabulary should be posted in the room near the primary mic. This is not a crutch — it is
a deliberate external memory aid for a product that cannot display a persistent menu.

**Progressive capability disclosure.** Introduce one capability class per session, in order of
frequency of use: (1) wake + status, (2) suggestion acceptance, (3) process selection,
(4) process steering, (5) stop/panic. Don't surface process-forking commands in the first session.

### What to avoid

**Feature walls.** Listing all capabilities at setup is the most common VUI onboarding failure.
Users cannot hold more than 5–7 items in working memory from audio; a 15-command list is
instantly forgotten. The first session should expose ≤3 commands.

**Long setup monologues.** Users tolerate one sentence of instruction per capability. "Say
'Vibersyn status' to hear a rundown" is fine. A 90-second onboarding explanation is not.

**Teaching only via negative feedback.** If the first 2–3 commands fail, users stop attempting.
Include a "soft landing" for the most common onboarding misphrasings that responds helpfully
("I didn't catch that — try saying 'Vibersyn, status' or 'Vibersyn, help'") rather than
silently passing.

**Mid-command timeouts during first-run.** Studies on smart speaker users found that natural
pauses mid-sentence (while formulating a request) caused devices to cut off the user. During
first-run specifically, extend the silence threshold by 50–100% to allow for hesitation.

### Vibersyn implication

The consent announcement (REQ-1, AC1.1) is the first spoken utterance the room hears. It should
double as the minimal onboarding: "Vibersyn is listening. Say 'Vibersyn, status' to hear a
rundown. Say '[mute word]' to pause listening." That is the entire onboarding — 3 sentences,
< 8 seconds. A printed card with the magic-word vocabulary is the follow-on reference. The
team learns the rest through use.

---

## 7. API Ergonomics and Naming Conventions

### What to copy

**Cue's `observe.pass` pattern** is the right naming philosophy for an always-on system: the
explicit non-action is a named, logged outcome — not a silent gap. Naming "pass" rather than
just "nothing happened" makes non-action first-class and testable. Apply the same pattern to
Vibersyn's internal routing: `route.suggestion`, `route.steer:UPID`, `route.pass` are three
distinct, named outcomes, each with a trace record.

**ATC's receive-only vs. comply acknowledgement distinction ("Roger" vs. "Wilco")** is the model
for Vibersyn's voice response vocabulary. The system should have distinct earcons/words for:
"I heard that" vs. "I heard that and I'm acting on it." The difference is critical — a
spawn-confirmation earcon means something happened; a receipt earcon means only that the
command was parsed.

**Verb-first action naming** (from ATC): `process.spawn`, `process.steer`, `process.halt` is
better than `spawned_process`, `steered_process`, `halted_process`. Verb-object naming reads
in the order events occur and is easier to scan in log output.

### What to avoid

- Naming commands or log events with nouns only ("process", "command", "event"). These require
  reading context to understand what happened. Verb-noun pairs are self-documenting.
- Over-parameterized voice commands. "Vibersyn, spawn a new process using the research agent
  with high priority and deadline end of week" is too much to parse from audio. Commands should
  be ≤7 words; complex setup happens through MCQs, not command strings.
- Reusing vocabulary across different abstraction layers. If "stop" means both "pause this
  process" and "emergency stop all," users will invoke the wrong one under stress. The panic word
  should be a distinct, unambiguous word not used for any other function.

---

## 8. Decisions Recorded

- **D-DA-1:** Wake word / global callsign should be 3–4 syllables, plosive-leading, coined or
  rare — not "Vibersyn" as spoken. A shorter coined form (e.g. "Viber") is preferred.
- **D-DA-2:** Earcon set for V0 is fixed at 5 (wake, transcribing-active, spawn, resolve,
  stop). No new earcons added without an acoustic distinctiveness check against all existing ones.
- **D-DA-3:** Per-process callsigns must pass a phonetic collision guard checked against: all
  active callsigns, the wake word, the mute word, and the panic word. Algorithm must be documented
  and reproducible (Metaphone/phoneme-Levenshtein recommended).
- **D-DA-4:** The suggestion engine threshold should be calibrated on "room-interrupt cost"
  (asymmetric, higher bar) rather than "suggestion quality" alone. Idle-preferring delivery is
  non-negotiable.
- **D-DA-5:** Observability board is strictly read-only by design, not by policy. No clickable
  controls on the board surface, even non-destructive ones.
- **D-DA-6:** First-run consent announcement doubles as minimal onboarding (≤3 sentences,
  ≤8 seconds). Printed magic-word card is the follow-on reference; no feature-wall onboarding.
- **D-DA-7:** Log event naming convention: verb-noun (e.g. `process.spawn`, `route.pass`,
  `mute.engaged`). Consistent with PRD observability requirements and traceable id convention.

---

## Sources

1. Sensory (2026). *Custom Wake Words Branded Voice UX Guide 2026*.
   `sensory.com/custom-wake-words-branded-voice-ux-guide-2026/`
2. Amazon Science (2024). *Amazon Alexa's new wake word research at Interspeech*.
   `www.amazon.science/blog/amazon-alexas-new-wake-word-research-at-interspeech`
3. Devin B. Hedge (2025). *Human Factors in Wake Word Design*.
   `devinhedge.com/2025/05/02/human-factors-in-wake-word-design-optimizing-voice-assistant-interaction-for-all-users/`
4. VUI Magazine. *Earcons: The Audio Version of an Icon*.
   `medium.com/vui-magazine/earcons-the-audio-version-of-an-icon-59b7f0921235`
5. Google Design. *Speaking the Same Language: VUI Principles*.
   `design.google/library/speaking-the-same-language-vui`
6. CHI 2025. *Need Help? Designing Proactive AI Assistants for Programming*.
   `dl.acm.org/doi/10.1145/3706598.3714002`
7. CHI 2024. *Better to Ask Than Assume: Proactive Voice Assistants*.
   `dl.acm.org/doi/10.1145/3613904.3642193`
8. Georgia Tech / Stasko (2003). *Be Quiet? Evaluating Proactive vs Reactive UI Assistants*.
   `faculty.cc.gatech.edu/~stasko/papers/interact03.pdf`
9. FAA AIM Chapter 4. *ATC Radio Communication Phraseology and Techniques*.
   `www.faa.gov/air_traffic/publications/atpubs/aim_html/chap4_section_2.html`
10. NATO. *NATO Phonetic Alphabet*.
    `www.nato.int/en/about-us/nato-history/history-by-theme/symbols-of-nato/nato-phonetic-alphabet`
11. MakeUseOf. *Alexa Echo Light Ring Colors Explained*.
    `www.makeuseof.com/amazon-echo-light-ring-colors/`
12. Sustema. *From NASA to NORAD: What We Can Learn from Iconic Control Rooms*.
    `www.sustema.com/post/from-nasa-to-norad-what-we-can-learn-from-the-world-s-most-iconic-control-rooms`
13. PMC/JMIR (2021). *Smart Speaker First Interactions Research*.
    `pmc.ncbi.nlm.nih.gov/articles/PMC7840274/`
14. Cathy Pearl (2016). *Designing Voice User Interfaces*. O'Reilly Media.
15. ICAO (1949). *Phonetic Alphabet Design Rationale*. Referenced in NATO history.
