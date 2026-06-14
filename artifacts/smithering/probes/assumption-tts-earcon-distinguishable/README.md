# Probe: assumption-tts-earcon-distinguishable

**One question:** Can users reliably distinguish TTS speech responses from the earcon/ack vocabulary?

## What was tested

| Check | Method | Threshold |
|-------|--------|-----------|
| TTS synthesis latency | macOS `say` (3 runs, mean) | < 500 ms |
| Layer A earcon generation | Synthesized as pure-tone WAV files | All 5 present & non-empty |
| Layer B ack generation | Synthesized as noise-burst WAV files | Both present & non-empty |
| Acoustic distinctness | ZCR coefficient of variation (ZCR-CV) | LayerA CV < 0.15; TTS CV > 0.40; ratio > 4× |

## Vocabulary (D-DD-23)

### Layer A — tonal state earcons (≤500 ms, pitched, melodic)

| ID | Name | Pattern | Meaning |
|----|------|---------|---------|
| E1 | Wake | C5 → E5 | System received input |
| E2 | Hum  | A2 (drone) | Transcribing / listening |
| E3 | Spawn | G5 | New process started |
| E4 | Resolve | C4 → E4 → G4 | Process completed |
| E5 | Halt | E5 → C4 | Process halted |

### Layer B — non-tonal routing acks (clicks/noise, no pitch)

| ID | Name | Pattern | Meaning |
|----|------|---------|---------|
| B1 | tick-tick | double noise burst | Utterance routed to steered process |
| B2 | whoosh | bell-envelope noise | Utterance routed to suggestion engine |
| — | silence | (nothing) | `observe.pass` — not a command |

**Why non-tonal:** Layer B acks are synthesized as broadband noise (not pitched tones) so they
are *disjoint by construction* from Layer A. A click can never be confused for a melodic earcon
even under cognitive load or room noise.

## Run

```bash
bun probe.ts
```

Evidence files are written to `evidence/`.

## In-room human listening test (not automated)

This probe validates the acoustic structure programmatically. Before shipping, conduct the
following in the target room with the target microphone/speaker setup:

1. **Playback test**: Play each Layer A earcon and each Layer B ack through the room speaker at
   the intended volume. Verify each is clearly audible and distinct from the others.

2. **TTS contrast test**: Play a TTS response immediately followed by an earcon. Ask a listener
   (eyes closed) to identify which was speech and which was a cue. Target: ≥ 4/5 correct.

3. **Ambient noise test**: Repeat step 2 with typical room noise (conversation, keyboard typing)
   at ~60 dB SPL. Earcons should remain identifiable.

4. **Cognitive load test**: During a focused work task, trigger each earcon. Verify the earcon
   registers without requiring the user to stop working.

**Record results** in `evidence/human-test.json` with the schema:
```json
{
  "date": "YYYY-MM-DD",
  "room": "description",
  "speaker": "device",
  "results": [
    { "test": "tts-contrast", "trials": 5, "correct": 5 },
    { "test": "ambient-noise", "trials": 5, "correct": 4 }
  ],
  "passed": true,
  "notes": ""
}
```

## Evidence files

```
evidence/
  latency.json        TTS synthesis latency (3 runs)
  earcons.json        Earcon generation results
  zcr_analysis.json   ZCR-CV distinctness analysis
  result.json         Final verdict
  audio/
    E1-wake.wav       Layer A earcons
    E2-hum.wav
    E3-spawn.wav
    E4-resolve.wav
    E5-halt.wav
    B1-tick-tick.wav  Layer B acks
    B2-whoosh.wav
    tts_sample.wav    TTS synthesis output
```

## Interpretation

- **ZCR-CV low (< 0.15)**: signal is regular/tonal → earcon-like
- **ZCR-CV high (> 0.40)**: signal is aperiodic → speech-like  
- **Ratio > 4×**: TTS and earcons occupy clearly different acoustic spaces

Structural distinguishability (by design): Layer A = pure tones (narrow spectrum),
Layer B = noise bursts (broadband, no pitch), TTS = natural speech (broadband with
formant structure). Three acoustically disjoint categories.
