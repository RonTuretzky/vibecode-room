// smithers-source: ambient idea detection (control plane for the projector's
// idea bubbles). ONE durable run = ONE detection pass over a rolling transcript
// window: the agent reads the conversation chunk + the ideas already on screen
// and returns every buildable idea it finds, each GROUNDED to the turn-id span /
// verbatim quote it came from. This replaces the old word/time gate — the model
// decides whether an idea was proposed, not a 90-second counter.
//
// The projector server launches this per detection round (LocalDetectionRunner is
// the gateway-less fallback that runs the same inference inline; SmithersDetection
// Runner launches this workflow on the gateway). Durable, replayable (re-run the
// same window deterministically for evals), and observable per step.
/** @jsxImportSource smithers-orchestrator */
import { createScorer, createSmithers, llmJudge, schemaAdherenceScorer } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
// Shared, dependency-free scoring logic — the SAME rules CI grades detection with
// (src/detect/scorers.test.ts). Wired here as Smithers scorers so every live
// detection run is graded (results land in the `_smithers_scorers` table; read
// them with `smithers scores <runId> --node detect`).
import { scoreGrounding, scorePitchQuality, toScorableIdea, type ScorableIdea } from "../../src/detect/scorers";

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
  // Ideas already surfaced, so the agent UPDATEs (echoes matchId) instead of
  // re-proposing a duplicate.
  known: z.array(knownSchema).default([]),
});

const detectedIdeaSchema = z.object({
  // id of a `known` idea this UPDATEs as the conversation elaborates it; null = new.
  matchId: z.string().nullable().default(null),
  pitch: z.string().describe("<=14 word imperative pitch"),
  confidence: z.number().min(0).max(1).describe("model's own 0..1 buildability confidence"),
  questions: z.array(z.string()).default([]).describe("<=3 short aloud-answerable questions"),
  answers: z.array(z.string()).default([]).describe("<=3 short option labels"),
  startTurnId: z.string().describe("first turn-id of the grounding span"),
  endTurnId: z.string().describe("last turn-id of the grounding span"),
  quote: z.string().default("").describe("verbatim evidence from the cited turns"),
  rationale: z.string().default("").describe("one short line of why this is buildable"),
});

const ideasSchema = z.object({
  candidates: z.array(detectedIdeaSchema).default([]),
});

const { Workflow, Task, smithers, outputs } = createSmithers({
  input: inputSchema,
  ideas: ideasSchema,
});

// ── evals / scorers ─────────────────────────────────────────────────────────
// Each grades the `detect` task's structured output (`{ candidates: [...] }`) on
// every run. The live engine passes `input` (the prompt string) and `output` (the
// parsed candidates); it does NOT pass a gold label, so these grade intrinsic
// quality, not equality. For a labelled regression suite see .smithers/evals/.
function scorableCandidates(output: unknown): ScorableIdea[] {
  const raw = (output as { candidates?: unknown[] } | null)?.candidates ?? [];
  return raw.map((c) => toScorableIdea(c)).filter((v): v is ScorableIdea => v !== null);
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
  // Output validates against the ideas Zod schema (no LLM).
  schema: { scorer: schemaAdherenceScorer() },
  // Every candidate cites a turn actually in the window + carries a quote (code).
  grounding: {
    scorer: createScorer({
      id: "grounding-accuracy",
      name: "Grounding Accuracy",
      description: "Every detected idea cites real turn ids and carries a verbatim quote.",
      score: async ({ input, output }) => scoreGrounding(scorableCandidates(output), turnIdsFromPrompt(input)),
    }),
  },
  // Pitches are crisp, imperative, and unhedged (code).
  pitch: {
    scorer: createScorer({
      id: "pitch-quality",
      name: "Pitch Quality",
      description: "Pitches are crisp <=14-word imperatives, not hedged musing.",
      score: async ({ output }) => scorePitchQuality(scorableCandidates(output)),
    }),
  },
  // Buildability — an LLM judge, sampled to bound cost. Must reply JSON {score,reason}.
  buildable: {
    scorer: llmJudge({
      id: "is-buildable",
      name: "Idea Buildability",
      description: "Are the detected pitches concrete, buildable software/automation ideas (not chatter)?",
      judge: providers.claudeApp,
      instructions:
        "You grade an idea-detector's output. A GOOD idea is a concrete, buildable software/automation product with a crisp <=14-word imperative pitch. Ambient chatter, logistics, or vague musing scores low. An empty array is acceptable and should score ~0.7 (you cannot see the transcript here).",
      promptTemplate: ({ output }) =>
        [
          "Rate the overall buildability & pitch quality of these detected ideas from 0 to 1.",
          'Respond with JSON only: {"score": <0-1>, "reason": "<one line>"}.',
          "",
          JSON.stringify(scorableCandidates(output), null, 2),
        ].join("\n"),
    }),
    sampling: { type: "ratio" as const, rate: 0.25 },
  },
};

function renderTurns(turns: z.infer<typeof inputSchema>["turns"]): string {
  if (turns.length === 0) {
    return "(no transcript)";
  }
  return turns.map((t) => `[${t.id}] ${t.speaker ?? "speaker"}: ${t.text}`).join("\n");
}

function renderKnown(known: z.infer<typeof inputSchema>["known"]): string {
  if (known.length === 0) {
    return "(none yet)";
  }
  return known.map((k) => `- id=${k.id} pitch=${JSON.stringify(k.pitch)} span=${k.startTurnId}..${k.endTurnId}`).join("\n");
}

export default smithers((ctx) => {
  const { turns, known } = ctx.input;
  const prompt = [
    "You are the idea detector for an ambient room assistant. People are talking; some of what they say is a concrete, BUILDABLE software/automation idea, most is not.",
    "Using genuine judgement about MEANING and INTENT (never keyword matching), find every distinct buildable idea in the transcript — even when phrased implicitly ('we could wrap those into one thing').",
    "For EACH buildable idea, GROUND it: cite the exact range of turn ids (startTurnId..endTurnId) that express it and quote the verbatim evidence. An idea may span several turns.",
    "Ignore ambient chatter, logistics, personal talk, status updates, and vague musing.",
    "",
    "Already-surfaced ideas (reuse a matchId to UPDATE one; otherwise matchId=null for a new idea):",
    renderKnown(known),
    "",
    "Transcript (each line is [turn-id] speaker: text):",
    renderTurns(turns),
    "",
    "Return the structured `ideas.candidates` output. If there is no buildable idea, return an empty candidates array. Do NOT modify, create, or delete any files — this is read-only inference.",
  ].join("\n");

  return (
    <Workflow name="idea-detection">
      <Task id="detect" output={outputs.ideas} agent={[providers.claudeApp]} scorers={detectScorers}>
        {prompt}
      </Task>
    </Workflow>
  );
});
