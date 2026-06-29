# Build PROMPT — Vibersyn (voice-only, Cue-powered)

> **What this is.** The product brief to **build Vibersyn from scratch**. It is the single
> source of truth, synthesized from the Session-1 design — the whiteboard photos
> (`IMG_8774–8781`), the Mobile + Aftermath recordings, the cleaned transcript, and the
> interactive spec — **then re-pointed to a voice-only interaction model built on Cue.**
>
> This is a **product specification first.** It describes _what we're building and why_, in the
> product framework the team used in the room
> (**Goals → Reasons → Constraints → Performance criteria → Functionality map → Scope**).
> Engineering is kept to high-level decisions (§9); we are building fresh and are **not** bound to
> the previous implementation's choices except where the design itself dictates an architecture.
>
> **The two big changes since Session 1.**
> 1. **Voice-only interaction.** Session 1 selected processes by **click** (Pro mode) or
>    **pinch/point** (Easy mode, V1) and named `click → type → Enter` the highest-value flow. We
>    are now **audio-only**: no mouse, keyboard, touch, click, drag, pointing, or gesture. You
>    talk to it and it talks back; the screen is a surface you _watch_, never one you _touch_.
> 2. **You select things by speaking a "magic word."** Every selectable element on the display
>    wears a short spoken call-sign (e.g. _Atlas_, _Bravo_, _Cobalt_). Saying it selects it. This
>    is the **Cue** mechanic — magic words are **cue policies** (see below). _("Etherea," from the
>    design chat, is Cue's flagship demo, not the tech; the technology we build on is **Cue**.)_
>
> Everything in §5–§8 has been re-derived from those two facts.

---

## 0. One-paragraph summary

**Vibersyn is an operating system for AI-agent work that you run entirely with your voice.**
A small group talks in a room. The system **passively listens** and floats **idea bubbles**
proposing things to build — each bubble shipping a tiny live demo + a few multiple-choice
questions you can answer out loud. Accept one **by saying its magic word**, and a durable agent
**"process"** is born. Every process and every bubble on the shared display wears a short,
phonetically-distinct **magic word** (a call-sign like _Atlas_, _Bravo_, _Cobalt_). **Speaking a
magic word is the select gesture** — it's what makes the system start caring about what you say
next — and from there you **steer by talking**: _"Atlas — make the header bigger,"_ _"Fork
Bravo,"_ _"Pause Cobalt."_ It **talks back** when (and only when) something warrants it. You
operate **many concurrent processes at once**, each rendering its own **live visualization** of
what it's building, and you never touch the screen. Underneath, **Cue** is the realtime harness
that turns the room's speech into observations, decides via **cue policies** whether to wake an
agent or `observe.pass`, and routes the right context to the right process; **plugin-local-
inference** supplies the streaming STT→LLM→TTS kernels; **Smithers** runs each process as a
durable, forkable loop. The unifying metaphor is an OS **Process Manager**: a long-running
**meta-session** owns N concurrent **processes**, each running `input → pre-hooks → action →
post-hooks → output`. The headline magic is **ambient suggestion**; the headline mechanic is
**magic-word voice control**.

---

## 1. Goals (what this is for)

- **G1 — Build by talking, and _only_ by talking.** Turn ordinary room conversation into running
  work with **zero** "operate the computer" effort — no hands, no pointer. _"We're just chilling
  in the room talking, and it's passively listening — then 'oh, should I build this?'"_
- **G2 — Operate many agents at once.** Manage the full lifecycle of _multiple concurrent_
  processes from one surface — born, live, die — including spawning new ones from existing ones
  (propagation), all by voice.
- **G3 — Steer, don't micromanage.** Give intent and high-level steering aloud; let a strong
  planning/orchestration model handle _how_. Hard-steer (pause, fork, escape) by voice when
  needed.
- **G4 — Resolve "which one" without a pointer.** With N processes on screen and one shared mic,
  the system must always know **which process** a spoken instruction is for — solved by
  **magic-word selection / cue policies** (§5.4), not by pointing or clicking.
- **G5 — Render the right thing.** For any artifact a process produces, auto-pick a fitting
  **live visualization** on the shared display that the room can also re-prompt by voice.
- **G6 — Restraint by default.** The system should _mostly stay silent and not act_ — most of
  what's said is just conversation. It wakes only when a cue warrants it (`observe.pass` is the
  common case). A system that interrupts the room constantly fails G1.

## 2. Reasons (why now, and why voice-only)

- **R1 — Models crossed a capability line.** A new model (**Fable**) is _"a god at planning and
  orchestration"_ — it can write the orchestration script (route Kimi/Codex/Opus, set up review
  loops) better than a human PM. So you hand it **intent**, not implementation.
- **R2 — The mapping problem is solved.** Fable maps a _defined_ concept onto whatever stack
  already exists, so we can design freely without worrying about overlap.
- **R3 — Compute is the new constraint, and it's about to feel cheap.** _"Bitcoin Pizza Day, but
  for Compute."_
- **R4 — Voice is the lowest-friction interface, and it's finally fast enough.** Typing and
  pointing are the friction that kills "build while you talk." The full voice loop —
  **transcription → LLM → speech**, each side **streamed** (input _and_ output streams) on
  local-inference kernels — is now low-latency enough to carry the whole interface.
- **R5 — A shared room has no single pointer anyway.** Four people around a wall display can't
  all hold a mouse. Voice + on-screen magic words is the natural multi-operator interface: anyone
  can name any process and act on it.
- **R6 — The realtime "should I wake?" problem is already solved by Cue.** Deciding when ambient
  talk rises to an action — and otherwise passing — is exactly what Cue does. We build on it
  rather than reinventing wake policy, turn-taking, and context-packaging.

## 3. Constraints & requirements (hard yes/no)

- **C0 — AUDIO-ONLY INTERACTION (the defining constraint).** The _only_ interaction modalities
  are **speech in and speech out**. No mouse, keyboard, touch, click, drag, scroll, pinch, point,
  or gesture is part of the product. The display is **output-only** — a surface the room watches
  for legibility (magic words + live builds), never touches. (A hidden operator/debug keyboard
  escape may exist for the human running a demo, but it is **not** part of the product.)
- **C1 — MUST support multiple concurrent processes.**
- **C2 — Every spoken input MUST resolve to a specific target** (a process, a bubble, a global
  command) **or to `observe.pass`.** With N processes running, the system decides which one an
  utterance is for — via magic-word cue policies — and otherwise passes. _Except:_ all speech
  always also feeds the suggestion engine.
- **C3 — Two listening channels (resolved — not either/or).** The transcript is **always
  listening, for exactly one purpose: spawning new-process _suggestions_.** To steer an _existing_
  process you **MUST select it first by speaking its magic word**; transcription is then scoped to
  that process until the steering window closes. → _Always-on for suggesting new; magic-word-first
  for steering existing._ Speculative _selection_ of a process (acting without naming it) is
  wishlist; speculative _suggestion_ is core.
- **C4 — Each process MUST be independently controllable:** pause, resume, fork, kill, steer — by
  voice, without affecting siblings.
- **C5 — There MUST be a spoken escape/stop affordance** (the Esc-in-Claude-Code equivalent) — a
  **panic word** that immediately halts the current prompt/steering, for the common case of a
  mis-transcription or a runaway instruction. It must be phonetically unmistakable and always win.
- **C6 — Magic words MUST be unambiguous and accident-resistant.** Call-signs must be phonetically
  distinct from each other and unlikely to occur in normal conversation, so the system rarely
  mis-selects and almost never selects by accident. Each is shown **prominently** on its element.
- **C7 — Context MUST be preserved across lifecycle events** (pre-kill archives a process's
  context; pre-spawn checks resources).
- **C8 — The agent/model for a process MUST be swappable** (plug-and-play; model is a field).
- **C9 — Low latency.** Short utterance→action lag and high enough refresh to feel live — doubly
  important when voice is the _only_ channel and there's no pointer to paper over lag. Streaming
  STT/LLM/TTS is how we hit it.
- **C10 — Listening must be legible and consentful.** A visible always-on listening indicator and
  a spoken global mute; persist only the transcript (no raw audio) in V0.

## 4. Performance criteria & preferences (good / better / best)

- **P-Latency:** minimize utterance→action lag; stream all three legs of the voice loop; keep the
  visualization live while building.
- **P-Effort:** the lowest-friction interaction that works — _speaking_. Prefer a silence boundary
  / dead-man timer over a mandatory "go" word; prefer one high-value voice flow over many.
- **P-Recognition:** be forgiving of mis-hearing — confirm consequential actions, make magic words
  robust, make the stop word effortless. A wrong action from a mis-transcription should be one
  word away from undone.
- **P-Restraint:** lean on `observe.pass`. Catch the important moments; avoid dumb wakeups and
  chatter. Speaking back is rationed, not constant.
- **P-Legibility:** when it builds, **show what it builds**; always show **where the room's voice
  is going** (ambient vs. which selected process) and **what every magic word is**. Keep running
  ideas visible so humans cross-reference ("idea #8 ties back to #2").
- **P-Tunability:** key behaviors are config knobs (suggestion TTL, bubbles/min, safe/dangerous,
  optimistic/explicit, steering-window length, magic-word scheme, how talkative the TTS is).
- **P-Delight:** reserve room for purely aesthetic "blooming fruit" (e.g. a smart-light tool call
  that matches the room vibe) that adds no functionality.
- **P-Cost-fit:** match model tier to job — cheap/local tier for the always-on listen/decide/route
  loop; **Fable** for per-process orchestration; **no Opus in the hot loop** (too expensive).

---

## 5. Functionality map (the system)

The architecture below is **part of the product spec** — the room designed it explicitly; only the
**input surface** changed (voice-only, Cue-driven).

```
META-SESSION  (long-running, always-on outer loop · Smithers-backed)
   │  owns the live event stream + an autonomy tick
   ├── CUE LAYER          continuous speech → observations → CUE POLICIES → action | observe.pass
   │      ├── suggestion cue   buildable talk → idea bubble                  (the ambient magic, C3)
   │      ├── magic-word cue   "<call-sign> …" → select + scope steering     (the select gesture, C2)
   │      └── command cues     "fork/kill/pause/accept …" → Process-Manager verb
   └── PROCESS MANAGER     create / modify / kill / fork / merge / …
          ├── PROCESS #1   an agent (Smithers run) working on one thing; session loop:
          │                  input → pre-hooks → action → post-hooks → output
          ├── PROCESS #2
          └── PROCESS #n   may PROPAGATE (fork/spawn) → new process
                           ("genetic loop": trim / propagate / plant / prune)
```

### 5.1 Process Manager — functions

`suggest` · `create` · `modify` · `kill` · `fork`/`spawn` · `import` · `export` · `merge` ·
`pause` · `resume` · `switch mode` · `switch node`. (`suggest` is the always-on suggestion cue;
the rest act on a named/selected process via command cues.) **Every verb is reachable by a spoken
command** (§5.5); none require a pointer.

### 5.2 Process — metadata (the whiteboard column, IMG_8774/8775)

Each process carries:

| Field                   | Notes                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| **UPID**                | unique process id — **canonical**                                      |
| **magic word**          | spoken call-sign used to select/target it by voice (§5.4) — **unique** |
| **parent ID**           | propagation lineage (fork/spawn)                                       |
| **owner / creator**     | provenance                                                             |
| **title**               | short human label shown under the magic word                           |
| **creation / end date** | lifecycle bounds                                                       |
| **mode**                | Optimistic / Explicit · Safe / Dangerous (input mode is always voice)  |
| **Git ID → URL**        | **ID is canonical; URL is derived** (URLs can change)                  |
| **state**               | `planning → active ⇄ paused → dead`                                    |
| **agent**               | swappable framework (plug-and-play)                                    |
| **model**               | e.g. Fable to orchestrate; cheap/local tier for I/O                    |
| **container**           | the runtime the agent runs in                                          |
| **input queue**         | where routed (voice) inputs for this process land                      |
| **QR code**             | scan → pair a phone as a roaming mic for this process (§5.9)            |
| **dependency rules**    | inter-process deps                                                     |

### 5.3 The session loop (per process, §5.3 / IMG_8778)

**`Input → Pre-hooks → Action(s) → Post-hooks → Output`** — input first, then pre-processing.

- **Pre-hooks:** test, auth, memory-optimize; **pre-spawn resource check**; **pre-kill context
  archive** (C7).
- **Action:** any Process-Manager function; usually "advance this process."
- **Post-hooks:** cleanup, logging.
- **Output:** **_often none_** — ~90% of ticks are invisible. Otherwise a visualizer artifact on
  the shared display (and, when a cue warrants, a short spoken confirmation; see §5.7).
- Two hook layers: **per-loop** (every tick) and **per-action** (around a specific function, e.g.
  pre-kill).

### 5.4 Magic-word selection — the heart of the interaction model (NEW; Cue)

This replaces click (Pro) and pinch/point (Easy) from Session 1, and it is implemented as **Cue
cue policies** — the single most important mechanic in the voice-only product.

- **Every selectable thing wears a magic word.** Each **process card** and each **idea bubble** on
  the display shows a short, phonetically-distinct **call-sign** (e.g. _Atlas_, _Bravo_, _Cobalt_)
  rendered **prominently** so the room always knows what to say (C6).
- **A magic word is a cue.** Cue's transcription provider streams the room's speech into
  `transcript.segment` observations; a **magic-word cue policy** fires when a live call-sign
  appears, wakes the steering action **scoped to that process**, and packages recent context for
  it. Everything else is `observe.pass` — and still feeds the suggestion cue (C3).
- **Speaking a magic word is the select gesture.** Saying _"Atlas"_ selects that process and opens
  a **steering window** scoped to it. _Selecting is what makes the system care about what you say._
- **One utterance, one action.** You can select-and-act in a single breath (_"Atlas, make the
  button blue"_) or select first then speak. The cue resolves the leading magic word, scopes
  transcription to that process, and parses the rest as the instruction.
- **Steering window & boundaries (C3 / IMG_8779).** Once selected, the window stays scoped to that
  process; it closes on **sufficient silence** (a ~20s dead-man chunk, tunable), an explicit
  **end/deselect word**, or the **panic word** (C5). Don't hard-tie listening to a single
  utterance — detect the steering mode and chunk it.
- **Disambiguation must be robust (C6).** Magic words are acoustically far apart and rare in
  conversation. On a near-miss the system prefers **`observe.pass` + a visible "did you mean Atlas
  or Cobalt?"** over guessing. Selecting by accident is the failure mode we most want to avoid.
- **The currently-selected process is unmistakable on screen** ("you are steering ATLAS" banner) so
  the room always knows where its voice is going (P-Legibility, C2).
- **Magic-word scheme is a knob** (P-Tunability): NATO-style call-signs, colors, or short
  codenames — assigned automatically at spawn and never colliding among live elements.

### 5.5 Voice command grammar — spoken verbs as cue policies (NEW)

All Process-Manager verbs (§5.1) and the suggestion verbs (§5.6) are **command cues**. Indicative
grammar (exact wording is a tuning detail; the model parses intent, not a rigid syntax):

- **Select / target:** `"<magic word>"` → select that process/bubble.
- **Steer (after select, or inline):** `"<magic word>, <natural-language instruction>"` → effect
  the instruction on that process (e.g. _"Atlas, center the logo"_).
- **Lifecycle verbs:** `"fork <mw>"`, `"kill <mw>"`, `"pause <mw>"`, `"resume <mw>"`,
  `"merge <mw> into <mw>"`, `"export <mw>"`, `"import …"`, `"switch <mw> to dangerous mode"`.
  Without a magic word, the verb applies to the currently-selected process.
- **Bubble verbs:** `"accept <mw>"` / `"spawn <mw>"` (→ create process from bubble),
  `"dismiss <mw>"`, and **answering MCQs by voice** (e.g. _"question one, option B"_ or just
  speaking the choice).
- **Commit / dead-man:** a steering instruction fires on a **silence boundary** by default; an
  explicit commit word (_"go"_) is an optional knob. (Replaces "hit Enter / time-to-start.")
- **Global escape / panic (C5):** a single unmistakable **stop word** halts the current
  prompt/steering immediately. A stronger **halt-all** word is available for runaway fleets.
- **Deselect / return:** an **end word** drops back to the ambient channel (no process selected).
- **Mute / consent (C10):** a spoken **global mute** silences the ambient channel; a visible
  indicator always shows listening state.

> **Safety read-back.** In the default **Safe** posture, consequential or destructive verbs
> (`kill`, `dangerous`-mode actions) require a **spoken confirmation** and the system **reads back
> what it understood** before acting (_"Kill Bravo — say 'confirm' to proceed"_). The stop word
> always overrides. This is the voice-world answer to "are you sure?" and the antidote to
> mis-transcription (P-Recognition, C5).

### 5.6 The suggestion system — "bubbles" (§5.5 — the headline feature)

The **suggestion cue** is the **only always-on listening channel** (C3): it runs continuously
regardless of selection and produces **suggestions only** — it never steers an existing process.

- **Each suggestion ships, optimistically and right away (it's cheap):**
  - a **lightweight live demo** — a mocked HTML site, a rough art draft, or a one-pager: _"the most
    condensed real estate so you can decide if it's worth building"_; **and**
  - **1–5 multiple-choice clarifying questions** (Ask-style), **answerable by voice** (and
    optionally read aloud). Answer the ones you feel like.
- **Each bubble wears a magic word** (§5.4). **Accept it by saying _"accept <magic word>"_** →
  spawn the process, **auto-select** it, enter the `planning` phase, seeded with the demo + the
  questions answered aloud. _(Full speculative build-out before acceptance is out of scope — §8.)_
- **Lifecycle / TTL:** time-based **or** word-based, or left to the agent's judgment.
- **Update / merge in place:** as the conversation evolves, a bubble may **update, merge into, add
  to, or change** an existing one rather than always spawning a new bubble.
- **Queue model (decided):** keep suggestions in a **sidebar queue** for the whole session; expand
  only the **most recent**; the rest stay scrollable / QR-able / reviewable at session end. _"Just
  wait until volume is a problem."_
- **Model-initiated bubbles:** every so often the model volunteers its own idea or prior art
  ("someone already built that — here's how it went"). Often trash, but sometimes the trigger for a
  better human idea.
- **Bubbles-per-minute knob:** a target firing rate, tunable to the room's vibe — from one every
  half hour to rapid-fire ("**idea diarrhea**"). The suggestion cue's firing policy is what makes
  this feel magical or broken; start conservative and tune up live.

### 5.7 The voice I/O pipeline (NEW — STT → LLM → TTS, streamed)

The full loop, exactly as described and built on the canonical kernels:

1. **Listen — transcription.** Room audio streams into a **transcription model** → live transcript
   (Cue's `transcriptionProvider`). Streaming input so partials arrive immediately.
2. **Decide / respond — LLM.** Transcript observations pass through **cue policies**; when one
   fires, the **LLM** gets the cue + current state + eligible tools and returns a tool call / steer
   instruction / spoken response — or `observe.pass`.
3. **Speak — TTS.** When the action warrants a reply, the response streams into a **voice model**
   so the room **hears it** (Cue `outputProvider` → TTS).

All three legs use **input and output streams** to minimize latency (C9, P-Latency). The kernels
come from **`plugin-local-inference`** (Shaw's on-device kernels across CPUs/GPUs/TPUs): **whisper.
cpp** (ASR), **llama.cpp** (text), **Kokoro** (TTS), plus VAD / barge-in / phrase-streaming for a
natural turn feel. Cloud providers (Cue ships Deepgram ASR / Cerebras LLM) are an alternative
behind the same provider slots; tier per **P-Cost-fit** (cheap/local in the hot loop, no Opus).

**Spoken output is first-class but rationed (P-Restraint, G6):** the system talks back only when a
cue fires — confirmations, read-backs, MCQ readouts, brief status — never a running narration.
Talkativeness is a knob.

### 5.8 Output & the shared display — a living garden (what the room sees)

Voice carries interaction; the screen carries **legibility**, and it should feel **alive**. The
shared display is a **living garden on the wall**: each process renders as a **growing
plant/tree** that **live-updates and expands** as the agent works and commits land. This is the
**genetic loop** (trim / propagate / plant / prune) made literal — fork/spawn grows a new branch
off its parent, killing prunes it, and the room watches the fleet _grow_ in real time. The
display shows:

- the **garden board** of processes-as-growing-plants, each labeled with its **magic word**,
  state, and a **live, auto-picked visualization** of its artifact (§5.11 / G5) — _"when it
  builds, show what it builds,"_ live, while you keep talking; lineage (parent→fork) is visible as
  branch growth;
- the **idea-bubbles sidebar** (each bubble with its magic word, demo strip, and MCQs);
- a **"you are steering X" banner** and an always-on **listening indicator** (C10);
- a re-promptable viz: the room can re-shape any visualization by voice (_"Atlas, show the data as
  a chart"_).

_(Reference for the board's look/feel: `conductor-github-visualizer` — a 3D Three.js graph of
repos/PRs as connected nodes with live status — and the team's prior SNES-style "tree-growth"
vibersyn-world prototype. Candidate aesthetics for the growing garden / node-graph and the
pre-session layout (§5.10). Not dependencies; visual north stars.)_

### 5.8a Commit / PR explainer slideshow (Elaine's idea — reuse `../smithers`)

A first-class **output mode**: an agent **explains a single commit or a series of commits/PRs as
an HTML slideshow** — narrating _what changed and why_, deck-style, instead of making the room
read a diff. In the garden, you drill into a plant's growth **by voice** (_"Atlas, walk me through
the last three commits"_ / _"explain this PR"_); the agent renders a deck on the wall and (per
§5.7) can **narrate it aloud** slide by slide. This is the voice-only restatement of the
whiteboard's _"click the commit → go to the PR"_: there's no click — you **say the magic word and
ask**.

- **Reuse, don't rebuild.** The slideshow generator already exists in the sibling repo
  **`../smithers`** (`~/smithers`): the **`report-slideshow`** workflow renders a **single,
  self-contained, dependency-free HTML slideshow** (inline CSS, no scripts) from a run's
  state/artifacts, and `apps/smithers/scripts/capture/generateSlideshow.ts` builds the capture
  deck. We adapt that pipeline to take **a commit range (or PR)** as input and emit an explainer
  deck. (It's already an HTML artifact, so it slots straight into the §5.11 HTML-iframe
  visualizer.)
- **Scope:** the single/series-of-commits explainer is a concrete V0/early-V1 target because the
  rendering engine is already built; the work is wiring commit-range input + an explainer prompt +
  voice drill-in.

### 5.9 Mobile pathway — phone as a roaming mic (V0)

Each process exposes a **QR code** on its card. Scan it → opens a **pairing URL** → the phone
becomes a **roaming microphone** feeding _that process's_ input queue (scoped steering, not the
ambient channel), so someone can walk around the room and still steer. The phone screen mirrors the
call-signs / bubbles for reference. Consistent with C0, the phone is a **mic**, not a touch-pad —
no trackpad, no text field as a primary input. _(Whether a phone **hold-to-talk** button counts as
a "click" or is an acceptable mic affordance is an open question — §10.)_ Phone-as-wand (gyroscope
pointing / room-sync) is wishlist.

### 5.10 Pre-session phase (IMG_8775/8776)

Before a live session, you can lay out the **node graph** of processes — a root node branching to
child process nodes — and choose how each is controlled. In the voice-only world, "controlled"
means: assigned a magic word and steerable from the room mic or a paired phone mic.

### 5.11 Model / agent stack (§5.9, P-Cost-fit) — product-level decision

- **Listen + decide + route loop** (streaming STT, cue policies, intent parse, light routing): a
  **cheap/local tier** via `plugin-local-inference` (or Cue's cloud providers). This loop is the
  product's entire front door — it must be cheap **and** fast (C9).
- **Per-process orchestration:** **Fable** ("god at planning"), run inside Smithers.
- **No Opus in the hot loop** — too expensive. _"Don't get crazy, Ron."_
- **An agent = a container image + a model + an evolving directive.** Plug-and-play any framework; a
  new process spawns with git credentials and a "make a repo for this project" directive. (NanoClaw
  / Eliza are example pluggable frameworks.)

---

## 6. The experience (V0 demo flow — voice-only)

1. The room sees a shared **board** (process cards, each with a big **magic word**), an
   **idea-bubbles** sidebar, and an always-on **listening indicator**. Nobody touches anything.
2. Someone says something buildable — _"we should build a tool to track all our running agents."_
   The room mic is always listening; nobody addresses the computer. The suggestion cue fires.
3. An **idea bubble** appears wearing a magic word (say, **Delta**), with a **live demo** + a few
   **multiple-choice questions** (optionally read aloud). The room answers a couple out loud and
   says **_"accept Delta."_** A **process** is born, gets its own call-sign (say **Atlas**),
   auto-selects, and enters planning.
4. **Steer it by voice:** _"Atlas — make the dashboard dark mode."_ The magic-word cue scopes the
   instruction to Atlas; it fires on the silence boundary; Atlas's card shows the change live in its
   auto-picked visualization, and you hear a one-line confirmation. Mis-heard? Say the **stop word**.
5. **Operate the fleet by voice:** _"Fork Atlas," "Pause Cobalt," "Kill Bravo — confirm."_ Each
   process responds independently; destructive verbs read back before acting.
6. Tune the room by voice: _"bubbles per minute three," "Atlas dangerous mode."_ Show a card's **QR**
   to pair a phone as a roaming mic for that process.

Throughout: **when it builds, it shows you what it builds**, live, while you keep talking — and your
hands never leave the table.

---

## 7. Versioned scope

**V0 — base case (testable in ~12 minutes, hands-free):**

- **Audio-only interaction** end-to-end (C0): always-on ambient mic + magic-word selection + spoken
  verb grammar + rationed spoken responses; **no pointer anywhere in the product.**
- **Cue** wired as the realtime harness: streaming transcription → cue policies → action /
  `observe.pass`; suggestion cue + magic-word cue + command cues.
- **Streaming voice pipeline** (STT→LLM→TTS) on `plugin-local-inference` kernels (§5.7).
- **Magic-word selection** of processes and bubbles (§5.4), unique on-screen call-sign per live
  element, robust disambiguation (C6); **panic/stop word** (C5); deselect word; global mute (C10).
- Multiple concurrent processes with **magic-word selection** (2–4 real, independently controllable
  — C1/C4), each a **Smithers** durable run.
- Process Manager core (create/modify/kill/fork/merge/import/export/pause/resume/switch_mode),
  reachable by voice; merge/import/export may be minimal/stubbed.
- Session loop with pre/post hooks (pre-spawn check, pre-kill archive).
- Suggestion bubbles → live demo + multiple-choice questions → **say "accept"** → spawn;
  merge-in-place; model-initiated cadence; knobs (bubbles/min, TTL).
- **Mobile QR → roaming-mic** pathway (§5.9).
- **Living garden board** (§5.8): processes render as growing plants/trees, live-updating, with
  fork lineage as branch growth.
- One first-class **HTML-in-iframe visualizer** + a text/chat fallback (auto-picked per artifact),
  including the **commit/PR explainer slideshow** (§5.8a) reusing `../smithers`'s `report-slideshow`.
- Swappable agent/model per process.

**V1 — next:** richer visualizers (art-variations, book-graph, data-chart, the 3D node-graph board);
optimistic **plan / research / expand** on a suggestion before commit; fuller conversational TTS;
speaker-aware routing so the system knows _who_ said a magic word (Cue VLM / speaker imprint).

**Wishlist (explicitly deferred):** spatial diarization (voice→speaker→process); speculative process
_selection_ (acting without naming); message-based prompting from anywhere; mobile gyroscope wand /
room-sync; Cue VLM/video signals (Etherea-style live video); multiple simultaneous active
suggestions beyond the queue; HUD/AR build; aesthetic "blooming fruit" (smart-light tool call); a
keyboard/pointer "pro" fallback (explicitly **not** a V0 goal under C0).
**Full speculative build-out of a suggested process is _not even wishlist_ — "we just don't do
that."**

---

## 8. Out of scope / non-goals (explicit, because of the pivot)

- **No mouse, keyboard, touch, click, drag, pinch, point, or gesture** in the product (C0). The
  Session-1 **Pro mode** (mouse+keyboard) and the **Easy-mode pointing/pinch** selection are
  **removed**, not deferred. Spatial pointing is subsumed by magic words.
- **No `click → type → Enter` flow.** It was Session 1's highest-value flow; it is gone. The
  highest-value flow is now **`say magic word → speak intent → silence/​"go" → effect`.**
- **No on-screen text entry** as a primary path (a future accessibility text fallback is wishlist).
- **No constant narration** — spoken output is rationed by `observe.pass` (G6, P-Restraint).
- **No full auto build-out** of a suggested process before acceptance.

---

## 9. Engineering decisions (high level)

We're building from scratch and are **not** bound to the previous implementation. These are the
up-front decisions; everything else is the implementer's judgment as long as it serves §1–§8.

- **Realtime voice + interaction harness:** **Cue** — `https://github.com/jameslbarnes/cue`. The
  always-on outer loop runs as Cue: speech → observations → **cue policies** → action /
  `observe.pass`. **Magic words, the suggestion engine, and every spoken command are cue policies**
  over the transcript stream; selection/steering routing (C2/C3) lives here. Use Cue's provider
  slots (`transcriptionProvider`, `llmProvider`, `outputProviders`, and later `vlmProvider`/frame
  providers) rather than rolling our own STT/turn-taking/wake stack.
- **Voice kernels:** **`plugin-local-inference`** (elizaOS) —
  `https://github.com/elizaOS/eliza/tree/develop/plugins/plugin-local-inference`. On-device,
  streaming STT (whisper.cpp), LLM (llama.cpp), TTS (Kokoro), plus VAD / barge-in / phrase
  streaming; the hot-loop kernels behind Cue's providers (P-Cost-fit, no Opus).
- **Durable process / inner loops:** **Smithers** — `https://github.com/smithersai/smithers`. Each
  process is a durable, forkable, resumable Smithers run; pause/resume/fork/replay and "operate many
  agents at once" are real because of it. Combined with **Fable** for planning. **All model calls
  route through Smithers subscriptions — never a raw API key**, even trivial one-shots (carried
  directive from `.smithers/VIBERSYN_BUILD.md`).
- **Frontend (output-only):** a **React app built with Vite** — the **living garden board**
  (§5.8, processes as growing plants/trees), the idea-bubbles sidebar, the "steering X" banner,
  the listening indicator, the mobile paired-mic page. Rendered for _viewing_, not input (C0).
  Visual references: `conductor-github-visualizer` (RonTuretzky, 3D node-graph) and the prior
  vibersyn-world tree-growth prototype.
- **Commit/PR explainer slideshow:** **reuse `../smithers`** (`~/smithers`) — adapt the
  **`report-slideshow`** workflow (self-contained, dependency-free HTML deck) and
  `apps/smithers/scripts/capture/generateSlideshow.ts` to take a commit range / PR and emit an
  agent-narrated explainer deck (§5.8a). Don't rebuild the renderer.
- **Backend:** **Hono** — command API + a **real-time stream** (WebSocket/SSE) pushing
  process/suggestion/transcript events to every client so the shared display and every paired phone
  stay in sync.
- **App vs. dev workflows:** Vibersyn **runtime** workflows (the durable Process loop, the
  suggestion engine) live in the **app** under `src/`; **dev** workflows that _build_ the app live in
  `.smithers/`. **Never mix the two.**
- **Validate before building (carried bar):** Cue and `plugin-local-inference` are third-party — per
  the project's validation bar, exercise their **actual** APIs (provider interfaces, cue-policy +
  observation/action schemas, Smithers subscription/`streamRunEvents`/fork/resume) against the real
  libraries before code is built on them. Popular frameworks (React) are exempt.
- **Design intent to honor regardless of stack:** the meta-session / process-manager /
  session-loop-with-hooks / suggestion-engine / cue-layer decomposition (§5) and the two-channel
  routing rule (C2/C3) are **product** requirements — keep them intact. Keep the agent/model
  **swappable** (C8) behind a clean seam.

> **Build order suggestion:** get the whole voice loop running end-to-end first
> (ambient → bubble with demo+questions → "accept" → spawn → magic-word select → steer → live
> visualization → spoken confirmation), then deepen durability, the mobile mic pathway, and the
> knobs. Favor one high-value voice flow working over many half-flows.

---

## 10. Open questions (revisit; flagged for the 5-question pass)

1. **Magic-word scheme.** NATO call-signs (Alpha/Bravo/…), colors, codenames, or rare generated
   words? Phonetic distance / accident-resistance (C6) vs. memorability.
2. **Wake discipline.** Is a magic word _alone_ enough to enter steering mode, or do we want a
   global wake word in front of commands to further suppress accidental selection in a chatty room?
3. **Cue providers for V0.** Local kernels (`plugin-local-inference`: whisper / llama / Kokoro) for
   cost/offline, or Cue's hosted providers (Deepgram ASR / Cerebras LLM) for quality/latency — or a
   split (hosted ASR, local everything else)?
4. **Mobile mic affordance.** Under strict "no clicking," is a phone **hold-to-talk** button
   acceptable (a mic affordance, not UI navigation), or must the paired phone be **open-mic**?
5. **Suggestion threshold.** What makes ambient talk "rise to" a suggestion, and how aggressively to
   fire (the suggestion cue's policy + bubbles-per-minute default)? _(Channel split is resolved — C3.)_
6. **Steering-window boundary.** Silence-based ~20s chunks vs. an explicit end word; needs real
   tuning with a live mic.

---

## Glossary

**Cue** — the realtime "silent harness" we build on (`jameslbarnes/cue`): speech/world signals →
observations → cue policies → action or `observe.pass`. **Cue policy** — the rule that decides
whether/what to wake; **magic words, suggestions, and commands are all cue policies. `observe.pass`**
— Cue's first-class "do nothing" decision; most utterances resolve here. **Etherea** — Cue's
flagship demo (a live AI video agent); _the demo, not the tech_. **Magic word** — a short,
phonetically-distinct spoken **call-sign** shown on each selectable element; saying it
selects/targets it (the voice-only replacement for click/pinch). **Stop / panic word** — the spoken
Esc: halts the current prompt immediately (C5). **Steering window** — the scoped-listening state
opened by selecting a process, closed by silence / end word / panic word. **plugin-local-inference**
— elizaOS on-device STT/LLM/TTS kernels (whisper.cpp / llama.cpp / Kokoro) behind Cue's providers.
**Fable** — the orchestration model, "god at planning." **Smithers** — the durable orchestrator (the
team's implement→validate→review→fix "Ralph loop") running each process. **Ask-style questions** —
multiple-choice clarifying questions a suggestion ships. **Genetic loop** — trim / propagate / plant
/ prune. **"Idea diarrhea"** — the high end of bubbles-per-minute. **"Bitcoin Pizza Day for
Compute"** — the bet that this scale of agent compute will look absurdly cheap in hindsight.
**Blooming fruit** — purely aesthetic delight that adds no functionality.
