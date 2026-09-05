// Opt-in real inference checks. No model doubles, cloud AI or publishing.
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRoomEnv } from "../src/config/profiles";
import { probeLocalAi, parseLocalJson } from "../src/providers/local";
import { selectDecisionLLM } from "../src/providers/llm/registry";
import { selectIdeaDetector } from "../src/detect/detector";
import { localProjectName } from "../src/process/project-name";
import { selectSummarizer } from "../src/audio/summarizer";
import { selectResearchSuggester } from "../src/research/suggester";
import { LocalResearchAgent } from "../src/research/local-agent";
import { localTopicModel } from "../src/research/tree";
import { localCloudRelate } from "../src/research/sky";
import {
  localAdditionPlanner,
  localQuestionPlanner,
} from "../src/server/import-plan";
import { localCopyModel } from "../src/slideshow/generator";
import type { ResearchQuest } from "../src/research/types";

const env = await resolveRoomEnv({
  ...process.env,
  VIBERSYN_ROOM_PROFILE: "local",
});
const health = await probeLocalAi(env);
assert(health.ok, health.reason);
const report: Array<{
  feature: string;
  ok: boolean;
  ms: number;
  result?: unknown;
  error?: string;
}> = [];
async function check(feature: string, run: () => Promise<unknown>) {
  const start = Date.now();
  try {
    const result = await run();
    report.push({ feature, ok: true, ms: Date.now() - start, result });
    console.log(`PASS ${feature} (${Date.now() - start} ms)`);
  } catch (error) {
    report.push({
      feature,
      ok: false,
      ms: Date.now() - start,
      error: String(error),
    });
    console.error(`FAIL ${feature}: ${String(error)}`);
  }
}
const text =
  "We should build a reading timer app with start, pause and reset buttons, and save completed reading sessions on this computer.";
const turns = [{ id: "turn-1", text, speaker: "speaker-1", atMs: Date.now() }];
const input = {
  sessionId: "local-smoke",
  correlationId: "local-smoke",
  turns,
  known: [],
};
await check("ambient decisions", async () => {
  const output = await selectDecisionLLM(env).llm.decide({
    model: env.VIBERSYN_LOCAL_MODEL!,
    correlationId: "local-smoke",
    messages: [{ role: "user", content: text }],
  });
  assert.equal(output.decision.kind, "action");
  return output.decision;
});
await check("idea judging and verification", async () => {
  const detector = selectIdeaDetector(env).detector;
  const output = await detector.detect(input);
  assert(output.candidates.length > 0, JSON.stringify(output.raw));
  const verdict = await detector.verify!(output.candidates[0]!, input);
  assert(verdict.uphold);
  return output.candidates[0];
});
await check("project naming", async () => {
  const name = await localProjectName(text, env);
  assert(name?.title);
  return name;
});
await check("spoken summarization", async () => {
  const summary = await selectSummarizer(env).summarizer.summarize({
    text,
    maxWords: 15,
    model: "local",
  });
  assert(summary.trim().split(/\s+/).length <= 15);
  return summary;
});
const question =
  "Does LM Studio support local chat completions and tool calling? Check the current documentation at https://lmstudio.ai/docs/developer/openai-compat";
await check("research suggestions", async () => {
  const result = await selectResearchSuggester(env).suggester.suggest({
    ...input,
    turns: [{ ...turns[0]!, text: question }],
  });
  assert(result.length > 0);
  assert(
    result.every(
      (item) =>
        item.claim.split(/\s+/).length >= 6 &&
        item.rationale.split(/\s+/).length >= 8,
    ),
    "Suggestions must contain meaningful claims and rationales",
  );
  return result;
});
const signal = AbortSignal.timeout(300_000);
await check("topic refinement", async () => {
  const result = (await localTopicModel(env)(
    {
      topics: [
        {
          id: "topic-1",
          label: "reading timer",
          turns: [{ id: "turn-1", text }],
        },
      ],
      recentTurns: [{ id: "turn-1", text }],
    },
    signal,
  )) as { reply: string };
  return parseLocalJson(result.reply);
});
await check("conversation cloud relationships", async () => {
  const result = (await localCloudRelate(env)(
    {
      clouds: [
        {
          id: "cloud-1",
          label: "reading timer",
          turnCount: 1,
          firstAtMs: 0,
          freshAtMs: Date.now(),
          live: true,
          sampleTurns: [{ speaker: "speaker-1", text }],
        },
      ],
      currentLinks: [],
      research: [],
      recentTurns: turns,
    },
    signal,
  )) as { reply: string };
  return parseLocalJson(result.reply);
});
const plan = {
  mode: "additions" as const,
  context: "Add a persistent dark theme toggle",
  digest:
    "Static site with index.html, styles/style.css and scripts/main.js. It currently shows a light page.",
};
await check("import planning", async () => {
  const result = await localAdditionPlanner(env)(plan, signal);
  assert(result?.length);
  return result;
});
await check("planning questions", async () => {
  const raw = await localQuestionPlanner(env)(plan, signal);
  assert.equal(typeof raw, "string");
  const result = parseLocalJson(raw as string);
  assert(Array.isArray(result) && result.length >= 2);
  return result;
});
await check("slide copy", async () => {
  const result = await localCopyModel(env)(
    {
      prompt: text,
      summary: "A calm reading timer",
      callsign: "reading",
      backend: "native",
      mocks: ["native"],
    },
    signal,
  );
  assert(result && Object.keys(result).length > 0);
  return result;
});
await check("sourced research and local verification", async () => {
  const quest: ResearchQuest = {
    id: "quest-smoke",
    kind: "fact-check",
    topic: "LM Studio API",
    claim: question,
    rationale: "Verify local support",
    confidence: 0.9,
    contextSpan: {
      startTurnId: "turn-1",
      endTurnId: "turn-1",
      quote: question,
    },
    status: "researching",
    progress: 0,
    progressLabel: "",
    report: null,
    error: null,
    roundsSeen: 1,
    missedRounds: 0,
    firstSeenAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  const result = await new LocalResearchAgent(env).research(quest, {
    correlationId: "local-smoke",
    signal,
  });
  assert(result.sources.length > 0, "No sources retrieved");
  assert(result.findings.length > 0);
  assert(
    result.summary.split(/\s+/).length >= 20,
    "Research needs a substantive summary",
  );
  assert(
    result.findings.every(
      (finding) => finding.explanation.split(/\s+/).length >= 10,
    ),
    "Each finding must explain its evidence",
  );
  return result;
});
const dir = resolve(".context/local-smoke-reports");
await mkdir(dir, { recursive: true });
const file = resolve(
  dir,
  `${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
);
await writeFile(
  file,
  JSON.stringify(
    {
      models: {
        fast: env.VIBERSYN_LOCAL_FAST_MODEL ?? env.VIBERSYN_LOCAL_MODEL,
        code: env.VIBERSYN_LOCAL_CODE_MODEL ?? env.VIBERSYN_LOCAL_MODEL,
      },
      report,
    },
    null,
    2,
  ),
);
console.log(`Report: ${file}`);
process.exitCode = report.every((result) => result.ok) ? 0 : 1;
