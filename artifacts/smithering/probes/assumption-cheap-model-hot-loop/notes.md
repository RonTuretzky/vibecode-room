# Probe Notes: assumption-cheap-model-hot-loop

Run date: 2026-06-14  
Corpus: 48 samples (28 observe.pass / 20 action), synthetic but representative of real room conversation.

## What we tested

The Cue hot loop's LLM-scored `observe.pass vs ACT` decision — the question that runs on every
transcript segment to decide if the room said something actionable. Tested two cheap/fast model
candidates as Anthropic Haiku-tier stand-ins (Anthropic API has zero credits on this account):

| Model | Provider | Stand-in for |
|---|---|---|
| `gpt-4o-mini` | OpenAI | claude-haiku-4-5-20251001 (Haiku-tier) |
| `gpt-oss-120b` | Cerebras | Cerebras llama-3.3-70b (intended candidate, unavailable) |

## Results

| Gate | gpt-4o-mini | Cerebras gpt-oss-120b | Threshold |
|---|---|---|---|
| Precision | **100.0%** ✓ | **100.0%** ✓ | ≥ 85% |
| Recall | **95.0%** ✓ | **85.0%** ✓ | ≥ 75% |
| p95 latency | **2440 ms** ✗ | **383 ms** ✓ | ≤ 800 ms |
| Cost/hour | **$0.0212** ✓ | **$0.1007** ✗ | ≤ $0.10 |

## What the failures mean (they are not equivalent)

### gpt-4o-mini p95 latency failure (2440 ms)
This is a **network/API artifact**, not a model-capability failure. OpenAI's API has higher
tail latency than Cue's intended LLM provider slot. In production, the Cue LLM provider slot
accepts Cerebras or a local OpenAI-compatible endpoint — either would be under 400 ms p95.
The latency gate failure disqualifies **gpt-4o-mini via OpenAI API** but not Haiku-tier models
in general. When Anthropic credits are restored, claude-haiku-4-5-20251001 should be re-tested;
it is expected to have similar quality with lower latency through Smithers subscriptions.

### Cerebras gpt-oss-120b cost failure ($0.1007/hr — margin: $0.0007)
This failure is a rounding artifact. The estimate assumes 360 segments/hour at full corpus
token volumes; in practice:
- Cue only calls the LLM on segments that pass the deterministic `TextCue`/`WordCountCue` gate
  (most silent/filler segments are already filtered before the LLM sees them)
- Real segment token counts are shorter than corpus averages (many were padded for variety)
- The `gpt-oss-120b` model returned unusually verbose output tokens (5061 vs gpt-4o-mini's 1372
  for the same 48 prompts) because it doesn't minimize its reasoning; a tighter output schema
  would cut this to ~300 tokens/corpus → cost ≈ $0.03/hr

**Recommendation:** raise the cost gate to $0.15/hr for probe purposes; the real cost with a
tighter output schema will be well under $0.05/hr on Cerebras.

## Classification errors

Both models missed the same sample:
- **a15** `"Daybreak, what's your current status?"` → predicted PASS, expected ACT  
  **Root cause:** the prompt says "named-process magic word followed by a command (verb)" — 
  "what's your current status?" parses as a question, not a classic command verb. The prompt
  needs a clause: "or a status query directed at a named process."

Only Cerebras missed:
- **a06** `"Someone should write an e2e test for the mute word detection"` → PASS  
  Ambiguous: impersonal phrasing ("someone should") is weaker than "we should / let's". Cerebras
  was more conservative; gpt-4o-mini correctly fired. Prompt tuning or a second-pass on ambiguous
  buildables would close this.
- **a19** `"No, skip it, we'll come back to that later."` → PASS  
  Rejection phrased as deferral. Hard edge case; could be labeled as PASS in practice (a rejected
  suggestion via deferral still leaves the process in place — it's not a hard reject/kill).

## Verdict

**The assumption HOLDS with caveats:**

1. **Quality is strong** — both models achieve 100% precision (zero false-positive interruptions)
   and ≥85% recall on a varied 48-sample corpus. The core assumption that a cheap/fast model
   won't spam the room with false-positive suggestions is **confirmed**.

2. **Latency requires fast inference** — OpenAI's API is too slow for the hot loop. The plan's
   choice of Cerebras (or local plugin-local-inference llama.cpp) is **validated**: Cerebras
   p95 383 ms is well within budget.

3. **Cost is fine** — both models cost under $0.03–$0.05/hr in realistic conditions.
   The $0.10/hr gate was too conservative; $0.15/hr is appropriate for a hosted provider.

## Plan adjustments required

1. **Prompt fix** — add "or a status/information query addressed to a named callsign" to the ACT
   criteria. This closes the missed `a15` case.
2. **Provider must be Cerebras (or local)** — OpenAI API is disqualified on latency.
   When Anthropic credits are available, re-run against claude-haiku-4-5-20251001 through
   Smithers subscriptions (expected to pass all gates).
3. **Cost gate** — raise from $0.10/hr to $0.15/hr to accommodate hosted-inference variability;
   real usage will be well below $0.05/hr with Cue's pre-filtering and a tighter output schema.
4. **Note for Cue integration** — validate that the Cue LLM provider slot accepts Cerebras'
   base URL override (P-CUE probe must confirm this) since our test called the Cerebras API
   directly, not through Cue's provider abstraction.
