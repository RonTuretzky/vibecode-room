# Local AI verification — 2026-09-05

Branch: `feature/fully-local-room`, based on main `b13a605`.
These results distinguish actual inference on the development Mac from deterministic
fixtures. This is an experimental local provider, not a guarantee that arbitrary
generated applications will be correct.

## Machine and model routing

The 128 GB Mac ran LM Studio at `127.0.0.1:1234`. Its installed GPT-OSS 20B and
120B models were loaded with 32k contexts as `room-local` and `room-local-code`.
20B handled conversation, research, naming and copy; 120B handled the later coding
and review runs. Whisper `base.en` transcribed on CPU. macOS `say` produced speech
and `afplay` supplied host speaker output. No cloud AI fallback was enabled.

The review instance runs with:

```sh
VIBERSYN_PORT=18994 VIBERSYN_PHONE_LISTENER=0 \
VIBERSYN_LOCAL_MODEL=room-local VIBERSYN_LOCAL_CODE_MODEL=room-local-code \
VIBERSYN_AUTO_PUBLISH=0 HOST=127.0.0.1 bun run local
```

Aliases are machine-local: select the IDs your LM Studio server exposes when
running elsewhere. Source changes and saved projects are separate; generated apps,
transcripts, model reports and run journals are ignored by Git.

## Real flows exercised

| Flow | Evidence and outcome |
| --- | --- |
| Speech input/output | Real system speech converted to browser-format PCM and sent through `/api/mic`. Whisper recognized the reading-timer request exactly; the isolated transcription took 1.6 seconds. This tests PCM ingestion, not physical microphone acoustics. |
| Plant an idea | The actual Whisper transcript reached the local idea judge; an actionable idea appeared. Clicking Plant and placing it in the garden created a concept and deck with local inference. |
| Shape and plan | Typed changes regenerated the concept. Answering a deck question recorded the platform choice and rebuilt it. Commissioning now carries approved answers and previous corrections into the real app. |
| Commission | The local coding loop produced a runnable reading timer and served its preview. Later edits ran against saved app files. |
| Recover and control | Real running jobs were canceled and retried through Projects. Pause/resume reached the local transport. Restart preserved projects, positions, imports and preview state. Late events and completion polls from canceled runs no longer fail their replacements. |
| Test generated behavior | In the actual preview: Start advanced time, Pause held it, Reset returned to zero, and Dark Mode survived reload with computed background `rgb(18, 18, 18)` and text `rgb(224, 224, 224)`. |
| Import and grow | Imported `mdn/beginner-html-site-styled`, grew `room/accessible-dark-mode-toggle`, then applied another local branch edit. Changes were committed locally and previewed; no upstream push or PR was made. |
| Research | Real web retrieval plus local synthesis and verification produced sourced reports. A separate spoken question about Rayleigh scattering passed through Whisper into the room's research flow. |
| Language-model seams | All 11 `local:smoke` checks passed: ambient decisions, idea judging/verification, naming, summarization, research suggestions, topic refinement, cloud relationships, import planning, planning questions, slide copy and sourced research/verification. The final report was inspected for substantive content, not just valid JSON. |
| Self-edit | Isolated-worktree, checks, commit and clean-checkout fast-forward lifecycle covered with a fixture. A real model was not asked to rewrite the room during this implementation. |

## Defects found and corrected during testing

- LM Studio's constrained JSON decoding garbled GPT-OSS output, including plausible
  JSON filled with meaningless content. Prompted schemas plus application validation
  produced normal answers; constrained decoding is now opt-in.
- A dense research prompt caused 20B to return empty rounds for an explicit question.
  The local adapter now uses a shorter task-specific prompt and validates its result.
- Commissioning omitted previous planning answers and corrections. Those requirements
  now travel into the execution prompt, and completed local apps accept further edits.
- Cancel/retry reused event sequence state and allowed an old completion poll to fail
  a replacement run. Subscriptions and completion checks now track the current run ID.
- The coding reviewer could receive multiple stale versions of a file under different
  paths. It now sees canonical paths and current bytes, along with live steering.
- Model-generated code included a script that accessed `document.body` too early and
  a theme selector that did not match the element being toggled. The coding loop now
  exposes real browser interactions and computed-style assertions, plus an automatic
  load check before completion. These checks provide evidence; model judgment alone
  was insufficient.

## Practical limits and UX findings

- Local coding can take minutes. Progress reflects model/tool steps, and pause takes
  effect between steps. Keep cancellation and retry visible during long inference.
- Code review can miss real defects or request unnecessary changes. Generated apps
  still need task-specific browser assertions and human review. Small corrections
  can cause more UI changes than requested; inspect the resulting diff.
- Research suggestions may overproduce bias checks or miss a question. Explicit
  research remains available; reports and citations still need ordinary fact checking.
- Research decks can be text-heavy at projector distance; concise findings with
  expandable source detail would improve readability.
- Local Whisper currently has one speaker label and final utterances only. It does
  not provide live interim text or speaker diarization. Speech plays on the host Mac.
- Full-app previews support static HTML and `dist/index.html`. Automatic startup and
  lifecycle management for arbitrary backend servers remains outside this provider.
- GitHub and ordinary web access remain available; “local” describes inference.
  Automatic publication is off by default in this profile.

See [setup and configuration](local-ai.md).

## Automated checks

- `bun run typecheck` and `bun run build`: passed. The build retains the existing
  warning about a large frontend bundle.
- Focused provider, lifecycle, retry, registry and research regressions: **92 passed**.
- Standard browser suite with one worker: **60 passed**.
- Live journey suite: **31 passed, 1 skipped, 1 failed** on the full run. The failure
  was a sampling race when an automatic retry replaced a waiting message. After
  correcting the observation window, both tests in that file passed.
- Full unit/integration run under simultaneous local-model load: **2,588 passed,
  20 skipped, 7 failed**, with one related socket error. The failures hit timing
  budgets. Rerunning the affected six files gave **71 passed, 1 timeout**; the remaining
  gateway fleet file then passed all **4 tests** in isolation. This does not claim
  that the original full run was clean.
- Real inference smoke: **11 passed**. Saved report:
  `.context/local-smoke-reports/2026-09-05T19-41-01-118Z.json` on the test machine.

The browser suites use controlled provider fixtures. The real model, speech,
branch and generated-app outcomes above are separate evidence.
