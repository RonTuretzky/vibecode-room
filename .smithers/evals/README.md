# Idea-detection evals

Idea detection is judged on an ANCHORED RUBRIC (src/detect/rubric.ts): the model
scores category + concreteness/buildableAsSoftware/intent/novelty and CODE
derives confidence, maturity, and the surface decision. Three complementary
eval layers grade it:

## 1. Labeled corpus + live precision/recall (the tuning loop)

`src/detect/evals/corpus.ts` — 13 labeled conversations covering the hard
negatives (existing products, jokes, logistics, hardware-only, recaps,
retractions, vague wishes) and hard positives (implicit ideas, multi-turn
forming ideas, commitment).

    bun run eval:detect                    # full corpus through the REAL judge
    bun run eval:detect -- --verify        # plus the adversarial verification pass
    bun run eval:detect -- --model sonnet --cases laundromat-coop,joke-startup

Reports per-case rubric judgments and precision/recall/F1 on "should a bubble
surface". Change the prompt or RUBRIC_WEIGHTS, re-run, watch the numbers.
Baseline (2026-07, haiku): 13/13 — precision 1.00, recall 1.00, F1 1.00, with
and without --verify.

## 2. Inline scorers (quality grading, every live run)

`.smithers/workflows/idea-detection.tsx` attaches `scorers` to the `detect` task:
- `schema` — output validates against the assessments Zod schema (no LLM)
- `grounding` — every judged idea cites a real turn id + carries a quote (code)
- `pitch` — pitches are crisp <=14-word imperatives (code)
- `rubricFidelity` — LLM judge (sampled 25%) auditing category/intent calls
  against the quoted evidence

Scores land in the `_smithers_scorers` table:

    node_modules/.bin/smithers scores <runId> --node detect

## 3. File-based regression suite (pass/fail over fixtures)

`idea-detection.jsonl` — one case per line for `smithers eval`. The harness loads
a run's output as `{ ideas: [ { assessments: [...], runId, nodeId, iteration } ] }`
(output keyed by name, each a row array):
- `laundromat-buildable` — `outputContains` a `proposal`-category assessment.
- `joke-not-proposal` / `empty-window` — assert `status: finished` only
  (`outputContains` uses array-SUBSET semantics and cannot assert emptiness;
  gating is verified by the corpus eval + unit tests, which can).

Run it (spawns the real judge agent — needs the Claude subscription):

    node_modules/.bin/smithers eval .smithers/workflows/idea-detection.tsx \
      --cases .smithers/evals/idea-detection.jsonl --suite idea-detection

The report is written to `.smithers/evals/idea-detection.json`; non-zero exit on
any failure.
