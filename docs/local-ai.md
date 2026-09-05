# Run the room with local AI

The `local` profile uses **LM Studio for every language-model feature**, local
Whisper for microphone transcription, and macOS system voices for spoken output.
GitHub imports, publishing and web research can still use the internet. Inference
does not use Claude, Cerebras, Deepgram, ElevenLabs, or a cloud execution gateway.

## Start on macOS

1. Use Bun 1.3.14 or newer and run `bun install`.
2. Open LM Studio, install a model, and start its local server on port 1234.
3. Install local transcription if needed: `brew install openai-whisper ffmpeg`.
   A Python environment containing `openai-whisper` also works; set
   `VIBERSYN_LOCAL_WHISPER_PYTHON` to its Python executable.
4. Select an identifier shown by LM Studio's `GET /v1/models`, then prepare the
   speech model and verify inference:

   ```sh
   export VIBERSYN_LOCAL_MODEL=openai/gpt-oss-20b
   bun run local:setup
   bun run build
   bun run local
   ```

5. Open `http://127.0.0.1:8787/`. The status bar shows **Local AI** and the model.
   Use Capture idea for microphone input, or Add project to type an idea or import
   a repository. For the usual multi-window launcher, use
   `bun run room --profile=local`.

`local:setup` prepares Chromium for generated-app browser checks and downloads
Whisper weights once if missing. Runtime transcription
only loads an existing local model; microphone audio never triggers a download.
LM Studio is a separate application: the room does not start it or download LLMs.
Model loading can also be managed with `lms load`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `VIBERSYN_LOCAL_MODEL` | `openai/gpt-oss-20b` | Default LM Studio model identifier |
| `VIBERSYN_LOCAL_FAST_MODEL` | default model | Conversation, research, names and copy |
| `VIBERSYN_LOCAL_CODE_MODEL` | default model | Concept builds, commissions and branch edits |
| `VIBERSYN_LOCAL_LLM_URL` | `http://127.0.0.1:1234/v1` | Loopback OpenAI-compatible server |
| `VIBERSYN_LOCAL_LLM_TOKEN` | empty | Optional local server authentication |
| `VIBERSYN_LOCAL_STRUCTURED_OUTPUT` | `0` | Opt into grammar-constrained JSON only with a compatible model |
| `VIBERSYN_LOCAL_WHISPER_MODEL` | `base.en` | Whisper model name or local weight path |
| `VIBERSYN_LOCAL_WHISPER_PYTHON` | detected Whisper Python, otherwise `python3` | Python with Whisper installed |
| `VIBERSYN_LOCAL_WHISPER_CACHE` | `~/.cache/whisper` | Local speech weight directory |
| `VIBERSYN_LOCAL_WHISPER_LANGUAGE` | `en` | Transcription language; use a multilingual model for other languages |
| `VIBERSYN_LOCAL_VAD_THRESHOLD` | `220` | PCM speech threshold; lower for quiet microphones |
| `VIBERSYN_LOCAL_VOICE` | system default | Installed macOS voice (`say -v '?'` lists voices) |
| `VIBERSYN_AUTO_PUBLISH` | off in local mode | Set `1` to automatically publish decks/repos as in the cloud profile |

The local profile overrides inherited cloud-provider choices and clears cloud AI
credentials and remote trace-export settings in the room process. Switching a
backend in Projects cannot enable an unregistered cloud builder. GitHub credentials
remain available for explicit repository actions. Requests to the local inference
endpoint cannot follow redirects or use a non-loopback host.

Local room state is separate: `builds/local`, `artifacts/local-runs`, and
`artifacts/local-transcripts`. Restarting the room preserves projects, branch jobs,
previews and transcripts. An in-flight local commission becomes interrupted on
restart and can be retried; it does not pretend to have resumed its model context.

## What runs locally

- Idea judging and verification, ambient suggestions, project naming and short
  spoken summaries.
- Concept creation, critique, revisions, slide copy and planning questions.
- Full-app commissions and branch edits using a bounded file/tool coding agent.
  Progress, steering, pause/resume, cancellation and retry use the existing room
  controls. Project checks run before a commission is declared complete. Static
  apps also get a Chromium load check; the agent can click, fill, reload and
  assert text, checkbox state and computed CSS to verify requested interactions.
  Completed apps accept further edits, retaining planning decisions and corrections.
- Research suggestions, topic refinement and cloud grouping. Accepted research
  retrieves ordinary web pages, then synthesizes and checks the report in LM
  Studio. Citations are limited to retrieved sources. Failed retrieval and
  verification are explicitly marked in the report.
- Microphone PCM → local Whisper, and system speech → the room computer's speakers.

The coding agent operates in each job's checkout, rejects file traversal and
symlink access, and restricts command tools to project checks/install commands.
Project scripts are still programs running with your user account; this is not an
OS sandbox. Like other code agents, it should operate on repositories you trust.
It does not use another AI CLI as a fallback.

## Practical limits

Start with a model that reliably follows JSON instructions and a context window
of at least 32k. GPT-OSS 20B and 120B were tested on the development Mac, using
20B for conversation/research and 120B for the larger coding tasks. More RAM
allows larger models but does not guarantee better latency or correct code.

Two inference requests run concurrently, with a bounded queue. Long coding tasks
can delay ambient responses. Failed, truncated or timed-out replies never trigger
cloud inference. Smaller models may exhaust the coding agent's step budget;
partial work stays available for inspection and the run reports failure.

GPT-OSS needs Harmony control tokens. LM Studio's grammar-constrained JSON mode
produced corrupted content during testing, matching a [reported compatibility
issue](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/1555). The default
therefore supplies schemas as instructions and validates results in the application.
Use `VIBERSYN_LOCAL_STRUCTURED_OUTPUT=1` only after testing your model/runtime.
Models can still miss requirements or make incorrect critiques: browser assertions
and human review remain necessary for generated software.

Speech output currently requires macOS `say` and `afplay`, and plays on the host
computer. Whisper uses CPU inference with silence-based utterance boundaries and
one speaker label; speaker diarization and incremental partial transcripts are
not implemented by this local provider. Use a headset to avoid speaker feedback.

Full-app previews currently support static `index.html` or a project whose build
produces `dist/index.html`, matching the existing execution preview contract.
Arbitrary long-running backend services are not automatically provisioned.
Self-editing is supported only from a clean room checkout and still uses the
existing checks/commit/reload gate; save your work before enabling self mode.

## Verify

```sh
bun run typecheck
bun test src/providers/local.test.ts src/server/local-execution.test.ts
# Opt-in real inference, using models already available in LM Studio:
bun run local:smoke
```

The unit tests cover routing, cloud credential isolation, redirect rejection,
queue cancellation, model availability, file boundaries, real artifact lifecycle,
failed commissions, pause/resume, steering, cancellation and restart recovery.
`local:smoke` checks 11 language-model features and saves results under
`.context/local-smoke-reports/`. It does not simulate microphone capture or a full
coding session. Those were tested separately; see [flow results and remaining
gaps](local-ai-testing.md). Unit fixtures alone are not evidence of local model quality.

LM Studio reference: [OpenAI-compatible endpoints](https://lmstudio.ai/docs/developer/openai-compat)
and [loading models](https://lmstudio.ai/docs/cli/local-models/load).
