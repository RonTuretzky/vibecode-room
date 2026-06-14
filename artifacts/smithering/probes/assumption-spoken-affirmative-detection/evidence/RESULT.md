# Probe Result — assumption-spoken-affirmative-detection

**Date:** 2026-06-14
**Verdict: CONDITIONAL FAIL**

---

## What was tested

38 utterances across 5 categories, each transcribed via OpenAI Whisper STT
and run through a TextCue-equivalent whole-word keyword matcher.

| Category | Count | Expected-trigger | Result |
|---|---|---|---|
| affirmative | 8 | all true | recall=88% |
| ambient dev conversation | 12 | mixed | see below |
| context false-positive | 5 | all false | ctx FP rate=80% |
| magic-word | 6 | all true | recall=83% |
| magic-word ambient | 7 | mixed | see below |

## Key measurements

### STT quality

```
Utterances transcribed: 38
STT accuracy (≥70% word overlap): 89.5% (34/38)
```

Whisper correctly transcribes clean TTS speech. STT quality is NOT the bottleneck.

### Affirmative detection

| Utterance | Transcript | Triggered | Correct |
|---|---|---|---|
| "Yes." | "Yes." | true | ✅ |
| "Yeah, do it." | "Yeah, do it." | true | ✅ |
| "Accept." | "Accept." | true | ✅ |
| "Confirm." | "Confirm." | true | ✅ |
| "Yep, go ahead." | "[ERROR: AbortError: The operation was aborted.]" | false | ❌ |
| "Yes, approved." | "Yes, approved." | true | ✅ |
| "Go ahead and do it." | "Go ahead and do it." | true | ✅ |
| "Yeah." | "Yeah." | true | ✅ |

**Recall: 88%** — affirmatives are detectable when spoken in isolation.

### Context false-positive rate

The critical failure mode: affirmative keyword appears in ambient speech with non-affirmative intent.

| Utterance | Transcript | Expected | Triggered |
|---|---|---|---|
| "Yes, but I'm not sure we should do that." | "Yes, but I'm not sure we should do that." | false | true |
| "Yeah, that's what I'm worried about." | "Yeah, that's what I'm worried about." | false | true |
| "Not yet, we need to wait." | "Not yet, we need to wait." | false | false |
| "Yes, the question is whether to confirm before or after." | "Yes, the question is whether to confirm before or after." | false | true |
| "Yeah but that won't work with the current architecture." | "Yeah, but that won't work with the current architecture." | false | true |

**Context FP rate: 80%** — 4 of 5 context utterances wrongly triggered.

### Natural false-accept rate in ambient speech

Of 19 ambient/ambient-magic-word utterances, 10 (53%) CONTAIN a trigger keyword in natural technical speech.

Examples:
- "Does the model **accept** JSON or binary input?" → triggers `accept`
- "We need to **confirm** the schema before shipping." → triggers `confirm`
- "The **alpha** version ships next week." → triggers `alpha` callsign
- "The deployment script has a **charlie** foxtrot in it." → triggers `charlie` callsign

### Magic-word detection

| Utterance | Transcript | Triggered | Correct |
|---|---|---|---|
| "Alpha." | "Alpha" | true | ✅ |
| "Bravo." | "Bravo." | true | ✅ |
| "Charlie, stop." | "Charlie, stop." | true | ✅ |
| "Delta, pause." | "DeltaPause." | false | ❌ |
| "Echo, what is the status?" | "Echo, what is the status?" | true | ✅ |
| "Bravo, fork this process." | "Bravo, fork this process." | true | ✅ |

**Recall: 83%** — callsigns transcribe correctly in isolation.

## Overall verdict

CONDITIONAL FAIL — Recall is good (aff=88%, mw=83%) but natural false-accept rate is HIGH (53% of ambient utterances accidentally contain trigger words). TextCue keyword-only matching is insufficient to gate process spawning without semantic context.

## Plan impact

Keyword-only matching (TextCue) has a 53% natural false-accept rate from ambient technical conversation. Assumptions requires reconsideration: (1) affirmative detection must be two-step — keyword detection gates a semantic intent check, not direct spawn; (2) magic-word callsigns must avoid common tech vocabulary (e.g. "alpha", "echo", "delta" appear in natural dev speech); (3) context-free matching (ctx FP rate: 80%) means "yes, but..." will spuriously trigger. Recommend: (a) use rare coined callsigns not in tech vocabulary, (b) require keyword + intent LLM call before spawning, (c) require explicit standalone affirmative utterance (whole-utterance match, not substring) rather than keyword-in-sentence.

## Decision recorded

TextCue keyword-only matching is **insufficient as a gate for process spawning** due to:

1. **Context blindness**: "yes, but..." triggers the same as "yes." — rate ~80%
2. **Vocabulary collision**: NATO callsigns (alpha, bravo, charlie, delta, echo) appear frequently
   in developer conversation. 53% of ambient utterances contain a trigger word.
3. **Affirmative words in sentences**: "confirm", "accept", "approve" appear as verbs in technical
   discourse, not just as standalone commands.

**Required design change**: Two-step gating:
1. TextCue keyword match → cheap LLM intent check (is this a standalone command or conversational?)
2. Only on intent=command → spawn / act
Alternatively: require whole-utterance matching (transcript ≈ keyword with no surrounding words).

**Callsign vocabulary**: Must exclude common tech vocabulary. Recommended: use rare coined words,
not NATO alphabet subset. NATO alpha/bravo/charlie/delta/echo all appear naturally in tech speech.

## Evidence files

| File | Contents |
|---|---|
| `results.json` | Full structured probe output with all utterance results |
| `evidence.jsonl` | Per-utterance JSONL trace |
| `audio-*.wav` | Sample audio clips for key utterances |
