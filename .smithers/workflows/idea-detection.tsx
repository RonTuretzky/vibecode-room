// smithers-source: ambient idea detection (control plane for the projector's
// idea bubbles). ONE durable run = ONE detection pass over a rolling transcript
// window: the agent JUDGES every idea-shaped span on the anchored rubric
// (category + concreteness/buildableAsSoftware/intent/novelty, defined in
// src/detect/rubric.ts) and the system derives confidence/surfacing from the
// rubric in code. The prompt is the SAME buildJudgePrompt the local detector
// uses, so gateway and local detection judge identically.
//
// The projector server launches this per detection round (HostClaudeIdeaJudge is
// the gateway-less fallback that runs the same inference inline; SmithersIdea
// Detector launches this workflow on the gateway). Durable, replayable (re-run
// the same window deterministically for evals), and observable per step.
/** @jsxImportSource smithers-orchestrator */
import { createScorer, createSmithers, llmJudge, schemaAdherenceScorer } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
// Shared judgment logic — the SAME prompt + scoring the local detector and CI use.
import { buildJudgePrompt } from "../../src/detect/prompt";
import { deriveAssessment, normalizeRubric } from "../../src/detect/rubric";
import { scoreGrounding, scorePitchQuality, type ScorableIdea } from "../../src/detect/scorers";

const turnSchema = z.object({
  id: z.string(),
  speaker: z.string().nullable().default(null),
  text: z.string(),
  atMs: z.number().default(0),
});

const knownSchema = z.object({
  id: z.string(),
  pitch: z.string(),
  startTurnId: z.string(),
  endTurnId: z.string(),
});

const inputSchema = z.object({
  sessionId: z.string().default("projector-live"),
  correlationId: z.string().default("corr-detect"),
  // The rolling window of committed turns inference runs over (chronological).
  turns: z.array(turnSchema).default([]),
  // Ideas already tracked, so the agent UPDATEs (echoes matchId) instead of
  // re-proposing a duplicate.
  known: z.array(knownSchema).default([]),
});

// One rubric assessment per idea-shaped span (matches the judge prompt's reply
// schema; confidence is intentionally ABSENT — code derives it from the rubric).
const assessmentSchema = z.object({
  matchId: z.string().nullable().default(null),
  category: z.enum(["proposal", "existing-product", "hypothetical", "logistics", "recap", "chatter"]),
  concreteness: z.number().min(0).max(3),
  buildableAsSoftware: z.number().min(0).max(3),
  intent: z.number().min(0).max(3),
  novelty: z.number().min(0).max(3),
  pitch: z.string().describe("<=14 word imperative pitch"),
  startTurn: z.string().describe("first turn-id of the grounding span"),
  endTurn: z.string().describe("last turn-id of the grounding span"),
  quote: z.string().default("").describe("verbatim evidence from the cited turns"),
  questions: z.array(z.string()).default([]).describe("<=3 short aloud-answerable questions"),
  answers: z.array(z.string()).default([]).describe("<=3 short option labels"),
  rationale: z.string().default("").describe("one line explaining the category+intent call"),
});

const ideasSchema = z.object({
  assessments: z.array(assessmentSchema).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  ideas: ideasSchema,
});

// ── evals / scorers ─────────────────────────────────────────────────────────
// Grade the detect task's structured output on every run. Confidence for scoring
// is DERIVED from each assessment's rubric — same rules as the live path.
function scorableAssessments(output: unknown): ScorableIdea[] {
  const raw = (output as { assessments?: unknown[] } | null)?.assessments ?? [];
  const out: ScorableIdea[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const r = entry as Record<string, unknown>;
    const pitch = typeof r.pitch === "string" ? r.pitch.trim() : "";
    if (pitch.length === 0) {
      continue;
    }
    const rubric = normalizeRubric({
      category: typeof r.category === "string" ? r.category : undefined,
      concreteness: r.concreteness,
      buildableAsSoftware: r.buildableAsSoftware,
      intent: r.intent,
      novelty: r.novelty,
    });
    out.push({
      pitch,
      confidence: deriveAssessment(rubric).confidence,
      startTurnId: typeof r.startTurn === "string" ? r.startTurn : "",
      endTurnId: typeof r.endTurn === "string" ? r.endTurn : "",
      quote: typeof r.quote === "string" ? r.quote : "",
    });
  }
  return out;
}

// Turn ids present in the prompt (lines look like "[turn-0001] speaker: ..."), so
// the grounding scorer can verify a cited span was actually shown to the model.
function turnIdsFromPrompt(input: unknown): Set<string> {
  const text = String(input ?? "");
  const ids = new Set<string>();
  for (const m of text.matchAll(/\[([a-z0-9-]+)\]\s/giu)) {
    ids.add(m[1]);
  }
  return ids;
}

const detectScorers = {
  // Output validates against the assessments Zod schema (no LLM).
  schema: { scorer: schemaAdherenceScorer() },
  // Every assessment cites a turn actually in the window + carries a quote (code).
  grounding: {
    scorer: createScorer({
      id: "grounding-accuracy",
      name: "Grounding Accuracy",
      description: "Every judged idea cites real turn ids and carries a verbatim quote.",
      score: async ({ input, output }) => scoreGrounding(scorableAssessments(output), turnIdsFromPrompt(input)),
    }),
  },
  // Pitches are crisp, imperative, and unhedged (code).
  pitch: {
    scorer: createScorer({
      id: "pitch-quality",
      name: "Pitch Quality",
      description: "Pitches are crisp <=14-word imperatives, not hedged musing.",
      score: async ({ output }) => scorePitchQuality(scorableAssessments(output)),
    }),
  },
  // Rubric fidelity — an LLM judge (sampled to bound cost) checks the CATEGORY and
  // INTENT calls against the quoted evidence. Must reply JSON {score,reason}.
  rubricFidelity: {
    scorer: llmJudge({
      id: "rubric-fidelity",
      name: "Rubric Fidelity",
      description: "Do the category/intent judgments match the quoted evidence (jokes marked hypothetical, existing products marked existing-product, retractions scored low)?",
      judge: providers.claudeApp,
      instructions:
        "You audit an idea judge's rubric calls. For each assessment, the quoted evidence should support its category (a joke must be 'hypothetical', a product review 'existing-product', a genuine suggestion 'proposal') and its intent level (retractions/jokes low, commitment high). Score 1 when every call is defensible, lower proportionally to the number of misjudged assessments. An empty list scores 0.7 (you cannot see the transcript).",
      promptTemplate: ({ output }) =>
        [
          "Audit these rubric assessments (category/intent vs their quoted evidence) and rate 0 to 1.",
          'Respond with JSON only: {"score": <0-1>, "reason": "<one line>"}.',
          "",
          JSON.stringify(((output as { assessments?: unknown[] } | null)?.assessments ?? []).slice(0, 10), null, 2),
        ].join("\n"),
    }),
    sampling: { type: "ratio" as const, rate: 0.25 },
  },
};

export default smithers((ctx) => {
  const { sessionId, correlationId, turns, known } = ctx.input;
  // The exact prompt the local HostClaudeIdeaJudge uses (anchored rubric +
  // few-shot hard cases), so gateway detection judges identically.
  const prompt = buildJudgePrompt({
    sessionId,
    correlationId,
    turns: turns.map((t) => ({ id: t.id, speaker: t.speaker, text: t.text, atMs: t.atMs })),
    known: known.map((k) => ({
      id: k.id,
      pitch: k.pitch,
      contextSpan: { startTurnId: k.startTurnId, endTurnId: k.endTurnId, quote: "" },
    })),
  });

  return (
    <Workflow name="idea-detection">
      <Task id="detect" output={outputs.ideas} agent={[providers.claudeApp]} scorers={detectScorers}>
        {`${prompt}

Return the structured \`ideas.assessments\` output matching the schema. Do NOT modify, create, or delete any files — this is read-only inference.`}
      </Task>
    </Workflow>
  );
});
