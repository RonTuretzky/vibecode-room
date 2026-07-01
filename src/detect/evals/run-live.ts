// Live idea-detection eval: run the labeled corpus through the REAL rubric judge
// (host `claude` CLI) and measure the surface decision.
//
//   bun run eval:detect                     # full corpus, default model
//   bun src/detect/evals/run-live.ts --model haiku --cases laundromat-coop,joke-startup
//   bun src/detect/evals/run-live.ts --verify   # also run the adversarial pass
//
// Reports per-case rubric judgments and corpus precision/recall/F1 for
// "an idea bubble should surface". This is the tuning loop: change the prompt or
// rubric weights, re-run, watch the numbers.
import { HostClaudeIdeaJudge } from "../detector";
import type { DetectionInput, JudgedIdea } from "../types";
import { CORPUS, type CorpusCase } from "./corpus";

interface CaseResult {
  id: string;
  kind: CorpusCase["kind"];
  expected: boolean;
  surfaced: boolean;
  vetoed: boolean;
  correct: boolean;
  pitch: string;
  rubric: string;
  blockedBy: string;
  ms: number;
}

function args(): { model: string; cases: string[] | null; verify: boolean; concurrency: number } {
  const argv = process.argv.slice(2);
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
  };
  return {
    model: get("--model") ?? process.env.VIBERSYN_IDEA_DETECTOR_MODEL ?? "haiku",
    cases: get("--cases")?.split(",").map((s) => s.trim()) ?? null,
    verify: argv.includes("--verify"),
    concurrency: Number(get("--concurrency") ?? "4"),
  };
}

function toInput(c: CorpusCase): DetectionInput {
  return {
    sessionId: `eval-${c.id}`,
    correlationId: `eval-${c.id}`,
    turns: c.turns.map((t, i) => ({ id: `turn-${String(i + 1).padStart(4, "0")}`, speaker: t.speaker, text: t.text, atMs: i * 1000 })),
    known: [],
  };
}

async function runCase(judge: HostClaudeIdeaJudge, c: CorpusCase, verify: boolean): Promise<CaseResult> {
  const started = performance.now();
  const input = toInput(c);
  const result = await judge.detect(input);
  const surfaceableIdeas = result.candidates.filter(
    (idea): idea is JudgedIdea => idea.judgment !== undefined && idea.judgment.assessment.surfaceable,
  );
  let best: JudgedIdea | null = surfaceableIdeas.sort((a, b) => b.confidence - a.confidence)[0] ?? null;
  let vetoed = false;
  if (best !== null && verify) {
    const verdict = await judge.verify(best, input);
    if (!verdict.uphold) {
      vetoed = true;
      best = null;
    }
  }
  const surfaced = best !== null;
  const expected = c.kind === "positive";
  const top = best ?? result.candidates[0] ?? null;
  return {
    id: c.id,
    kind: c.kind,
    expected,
    surfaced,
    vetoed,
    correct: surfaced === expected,
    pitch: top?.pitch ?? "",
    rubric:
      top?.judgment === undefined
        ? ""
        : `${top.judgment.rubric.category} c${top.judgment.rubric.concreteness} s${top.judgment.rubric.buildableAsSoftware} i${top.judgment.rubric.intent} n${top.judgment.rubric.novelty} → ${top.judgment.assessment.confidence}`,
    blockedBy: top?.judgment?.assessment.blockedBy.join(",") ?? "",
    ms: Math.round(performance.now() - started),
  };
}

async function main(): Promise<void> {
  const { model, cases, verify, concurrency } = args();
  const selected = cases === null ? CORPUS : CORPUS.filter((c) => cases.includes(c.id));
  if (selected.length === 0) {
    console.error("No matching corpus cases.");
    process.exit(2);
  }
  const judge = new HostClaudeIdeaJudge({ model });
  console.log(`idea-detection live eval — model=${model} verify=${verify} cases=${selected.length}\n`);

  const results: CaseResult[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (next < selected.length) {
        const c = selected[next];
        next += 1;
        const r = await runCase(judge, c, verify);
        results.push(r);
        const mark = r.correct ? "✓" : "✗";
        console.log(
          `${mark} ${r.id.padEnd(28)} expected=${String(r.expected).padEnd(5)} surfaced=${String(r.surfaced).padEnd(5)}${r.vetoed ? " (vetoed)" : ""}  ${r.rubric}${r.blockedBy ? `  held:${r.blockedBy}` : ""}  ${r.ms}ms`,
        );
      }
    }),
  );

  const tp = results.filter((r) => r.expected && r.surfaced).length;
  const fp = results.filter((r) => !r.expected && r.surfaced).length;
  const fn = results.filter((r) => r.expected && !r.surfaced).length;
  const tn = results.filter((r) => !r.expected && !r.surfaced).length;
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  console.log(`\ntp=${tp} fp=${fp} fn=${fn} tn=${tn}`);
  console.log(`precision=${precision.toFixed(2)} recall=${recall.toFixed(2)} F1=${f1.toFixed(2)} accuracy=${((tp + tn) / results.length).toFixed(2)}`);
  const wrong = results.filter((r) => !r.correct);
  if (wrong.length > 0) {
    console.log(`\nmisses: ${wrong.map((r) => r.id).join(", ")}`);
  }
  process.exit(wrong.length === 0 ? 0 : 1);
}

await main();
