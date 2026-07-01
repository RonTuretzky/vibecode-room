# Idea-detection evals

Two complementary Smithers eval mechanisms grade the idea-detection loop:

## 1. Inline scorers (quality grading, every run)
`.smithers/workflows/idea-detection.tsx` attaches `scorers` to the `detect` task:
- `schema` — output validates against the ideas Zod schema (no LLM)
- `grounding` — every candidate cites a real turn id + carries a quote (code scorer)
- `pitch` — pitches are crisp <=14-word imperatives (code scorer)
- `buildable` — LLM judge (sampled 25%) rating concrete buildability

The code scorers share their logic with CI (`src/detect/scorers.ts`, tested in
`src/detect/scorers.test.ts`). Scores land in the `_smithers_scorers` table:

    node_modules/.bin/smithers scores <runId> --node detect

## 2. File-based regression suite (pass/fail over fixtures)
`idea-detection.jsonl` — one case per line. The harness loads a run's output as
`{ ideas: [ { candidates: [...], runId, nodeId, iteration } ] }` (output keyed by
name, each a row array), so assertions target `ideas[].candidates`:
- `laundromat-buildable` — `outputContains` an idea grounded to `turn-0001`.
- `pure-chatter-empty` / `empty-window` — assert `status: finished` only.
  (`outputContains` uses array-SUBSET semantics and cannot assert "candidates is
  empty"; emptiness is verified by the code scorers / `src/detect/scorers.test.ts`
  + `detector.test.ts`, which can.)

Run it (spawns the real judge agent — needs the Claude subscription):

    node_modules/.bin/smithers eval .smithers/workflows/idea-detection.tsx \
      --cases .smithers/evals/idea-detection.jsonl --suite idea-detection

The report is written to `.smithers/evals/idea-detection.json`; non-zero exit on
any failure.
