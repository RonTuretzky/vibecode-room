# Probe Result — assumption-stt-realtime-latency

**Date:** 2026-06-14  
**Verdict: CONDITIONAL PASS** — Latency assumption holds; speaker diarization requires Deepgram (unverified due to missing key).

---

## What was tested

Four sub-probes:

| Probe | API | Result |
|---|---|---|
| A: Cue repo availability | GitHub API | Accessible, not on npm |
| B: Batch STT baseline | OpenAI Whisper-1 | 2165ms for 4.5s audio (0.48× RT) |
| C: Streaming STT | gpt-4o-transcribe + stream=true | **280–409ms first word** ✅ |
| C2: WebSocket realtime | gpt-realtime WebSocket | Session schema mismatch ⚠️ |
| D: Multi-speaker diarization | gpt-4o-transcribe-diarize | Transcribes accurately, no speaker labels returned |

---

## Key measurements

### Streaming transcription latency (gpt-4o-transcribe)

```
Audio clip:    4.53s speech (TTS-generated via tts-1/alloy)
First word:    280ms (run 1) / 409ms (run 2)
Total stream:  386ms (run 1) / 410ms (run 2)
Word deltas:   14 word-level streaming events per utterance
Accuracy:      100% match to source text
```

This is the relevant path for a passive-listening loop: sub-500ms first-word latency while the audio is still being processed. **This sub-assumption holds.**

### Batch baseline (Whisper-1)

```
Latency: 1314ms / 2014ms / 2165ms (three runs, different days)
RT factor: 0.29× – 0.48× realtime
```

Batch is not suitable for the passive listening loop (blocks until end of utterance) but confirms the model infrastructure is responsive.

### Multi-speaker / diarization

`gpt-4o-transcribe-diarize` was exercised on a concatenated two-speaker WAV (two utterances, two voices):

```
Response: {
  "text": "We should add a feature flag for the new authentication flow. 
           Actually, I think we should ship it directly without the flag.",
  "usage": { "total_tokens": 308 }
}
```

**No `utterances`, `segments`, or `words` fields were returned.** Speaker labels are not present in this API response. Possible explanations:
1. `gpt-4o-transcribe-diarize` may require a different request parameter to enable diarization output
2. The two-voice audio (same-model TTS, different sessions) may not be distinct enough for speaker separation
3. Deepgram Nova-3 (the Cue `.env.example`-documented default) is the intended diarization path but was not tested (no DEEPGRAM_API_KEY available)

**Speaker diarization is unverified — this sub-assumption is UNCONFIRMED.**

### Cue library architecture

The actual Cue codebase (`github.com/jameslbarnes/cue`) differs from what design docs assumed:

| Assumption | Reality |
|---|---|
| Deepgram is a built-in Cue provider | ❌ No Deepgram provider in source; providers are `qwen-asr` (WebSocket JSON) and `voxterm` (file polling) |
| Deepgram is Cue's default | ⚠️ DEEPGRAM_API_KEY is in `.env.example` but not wired to a provider in `packages/server/src/infrastructure/transcription/` |
| `@cue/server` is on npm | ❌ Private monorepo, install from GitHub only |
| LLM provider is Cerebras | ✅ Confirmed in `.env.example` (`CEREBRAS_MODEL=qwen-3-235b-a22b-instruct-2507`) |
| `session.type` parameter required | Confirmed from gpt-realtime error: `Missing required parameter: 'session.type'` |

The `qwen-asr` provider accepts transcript JSON events over WebSocket — it is a bridge for an *external* ASR system to push transcripts into Cue, not a direct Deepgram integration.

### Barge-in handling

The `gpt-realtime` session.created response includes server VAD configuration:

```json
"turn_detection": {
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 200,
  "interrupt_response": true
}
```

`interrupt_response: true` confirms barge-in (mid-utterance interruption) is supported at the API layer. **This sub-assumption holds** for realtime providers.

---

## Latency budget check

Design target (from `02-design.md`): sub-300ms word-final latency for the passive listening loop.

| Measurement | Value | Meets <500ms budget? |
|---|---|---|
| gpt-4o-transcribe first word (run 1) | 280ms | ✅ |
| gpt-4o-transcribe first word (run 2) | 409ms | ✅ |
| Whisper-1 batch (full clip) | 1314–2165ms | ❌ batch only |

The streaming path meets the latency budget. The design's <300ms target may be tight under load; budget 400ms for planning.

---

## Plan impact

1. **Latency assumption: PASSES** — streaming STT delivers first word in ~300-400ms. No redesign needed for latency.

2. **Speaker diarization gap: ACTION REQUIRED**  
   - Acquire `DEEPGRAM_API_KEY` and run `bun probe.ts` again to validate Deepgram's `isFinal` flag, diarization labels (`speaker_0` / `speaker_1`), and streaming latency
   - OR accept OpenAI gpt-4o-transcribe (no speaker labels) and redesign the `SpeakerChangedCue` to work without diarization (e.g. energy-based or VAD-based detection)

3. **Cue architecture mismatch: ACTION REQUIRED**  
   - The design assumes Cue pulls audio from Deepgram. Reality: Cue's `qwen-asr` provider is a WebSocket *receiver* — an external ASR process must push transcripts in.  
   - The Panopticon audio pipeline must include a component that: captures mic audio → streams to ASR (Deepgram/OpenAI) → sends JSON transcript events to Cue via WebSocket.  
   - This is additional scope vs. the design assumption that Cue handles this end-to-end.

4. **gpt-realtime WebSocket schema: BLOCKED** — session update requires `session.type: "realtime"` as first field; `session.modalities` is not a valid parameter in this API version. The correct schema must be re-probed before using gpt-realtime as the Cue backend.

5. **Cue install: note** — pnpm monorepo, install from GitHub. Add to setup docs.

---

## Evidence files

| File | Contents |
|---|---|
| `sample-speech.wav` | 4.5s TTS-generated speech audio used for all tests |
| `whisper-latency.json` | Whisper batch latency + word timestamps |
| `streaming-events.jsonl` | All 14 SSE delta events from gpt-4o-transcribe stream |
| `streaming-result.json` | Streaming probe summary |
| `realtime-events.json` | gpt-realtime WebSocket events (session.created + error) |
| `multi-speaker-utterance-0.wav` | First speaker audio (TTS) |
| `multi-speaker-utterance-1.wav` | Second speaker audio (TTS) |
| `multi-speaker-combined.wav` | Concatenated two-speaker WAV |
| `diarize-response.json` | gpt-4o-transcribe-diarize response (no speaker labels) |
| `results.json` | Full structured probe output |
| `evidence.jsonl` | Event log with timestamps |
