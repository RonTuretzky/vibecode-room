import { localAiEnabled } from "../config/local";
import { LocalResearchAgent } from "./local-agent";
// The research agent: turns an accepted quest into a sourced, fact-checked,
// bias-scanned report. The host-`claude` implementation runs THREE staged CLI
// calls (the CLI has live web search, so sources are real URLs):
//   1. RESEARCH    — search the web, gather findings + sources;
//   2. FACT-CHECK  — an adversarial second pass that tries to REFUTE each
//                    finding and downgrades verdicts it cannot defend;
//   3. BIAS SCAN   — reviews the sources/framing for lean and blind spots.
// Stages 2 and 3 degrade gracefully: a failed pass keeps the prior stage's
// report (a research room would rather have unverified findings labeled
// honestly than nothing). The stub agent is the deterministic offline/test
// implementation of the same contract.

import { defaultClaudeCliRunner, type ClaudeCliRunner } from "../detect/claude-cli";
import {
  researchReportSchema,
  type ResearchAgent,
  type ResearchAgentOptions,
  type ResearchQuest,
  type ResearchReport,
} from "./types";

export const DEFAULT_RESEARCH_AGENT_MODEL = "sonnet";
// Per-call budget: source lanes do real web searching and need headroom.
export const DEFAULT_RESEARCH_STAGE_TIMEOUT_MS = 150_000;
// Overall wall-clock cap for one quest (lanes + synthesis + verification);
// past it, whatever landed ships with honest degraded notes.
export const DEFAULT_RESEARCH_TOTAL_BUDGET_MS = 300_000;

const REPORT_SHAPE =
  '{"summary": string (3-5 sentences), "confidence": "low"|"medium"|"high", ' +
  '"findings": [{"claim": string, "verdict": "supported"|"refuted"|"mixed"|"unverified", "explanation": string, "sourceIndexes": number[]}], ' +
  '"biasNotes": [{"note": string, "severity": "low"|"medium"|"high"}], ' +
  '"sources": [{"title": string, "url": string, "publisher": string, "note": string}], ' +
  '"followUps": string[]}';

export interface HostClaudeResearchAgentOptions {
  model?: string;
  stageTimeoutMs?: number;
  // Overall wall-clock cap across every phase; whatever landed by the
  // deadline is what the room gets (with honest degraded notes).
  totalBudgetMs?: number;
  runner?: ClaudeCliRunner;
  clock?: () => number;
}

// The parallel source hunt: three angle-diverse lanes so the draft is built
// from adversarially different searches, not one pass's blind spot. Capped at
// three concurrent host-claude calls to stay kind to the subscription.
export const RESEARCH_LANES = [
  {
    key: "supporting",
    instruction:
      "Hunt for the strongest EVIDENCE FOR the claim/question: primary sources, official data, first-hand reporting that supports or directly answers it.",
  },
  {
    key: "refuting",
    instruction:
      "Hunt for evidence AGAINST: counterexamples, failed attempts, critiques, and sources that contradict or complicate the claim/question.",
  },
  {
    key: "background",
    instruction:
      "Hunt for QUANTITATIVE and historical background: hard numbers, market/industry data, studies, and how this has played out before.",
  },
] as const;

export class HostClaudeResearchAgent implements ResearchAgent {
  readonly #model: string;
  readonly #stageTimeoutMs: number;
  readonly #totalBudgetMs: number;
  readonly #runner: ClaudeCliRunner;
  readonly #clock: () => number;

  constructor(options: HostClaudeResearchAgentOptions = {}) {
    this.#model = options.model ?? DEFAULT_RESEARCH_AGENT_MODEL;
    this.#stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_RESEARCH_STAGE_TIMEOUT_MS;
    this.#totalBudgetMs = options.totalBudgetMs ?? DEFAULT_RESEARCH_TOTAL_BUDGET_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
    this.#clock = options.clock ?? (() => Date.now());
  }

  async research(quest: ResearchQuest, options: ResearchAgentOptions): Promise<ResearchReport> {
    const { signal, onProgress, onDraft } = options;
    const deadlineAt = this.#clock() + this.#totalBudgetMs;
    // Every call's timeout is clamped to the remaining overall budget, so a
    // slow phase eats its own slack — never the room's patience.
    const run = (prompt: string) => {
      const remaining = deadlineAt - this.#clock();
      if (remaining <= 0) {
        return Promise.reject(new Error("research budget exhausted"));
      }
      return this.#runner(prompt, { model: this.#model, timeoutMs: Math.min(this.#stageTimeoutMs, remaining) });
    };
    const degraded: string[] = [];

    // Phase 1 — PARALLEL source hunt (angle-diverse lanes).
    signal?.throwIfAborted();
    onProgress?.({ percent: 8, label: `hunting sources (${RESEARCH_LANES.length} lanes)` });
    let lanesLanded = 0;
    const laneResults = await Promise.allSettled(
      RESEARCH_LANES.map(async (lane) => {
        const parsed = parseReport(await run(lanePrompt(quest, lane.instruction)));
        if (parsed === null) {
          throw new Error(`${lane.key} lane returned no parseable report`);
        }
        lanesLanded += 1;
        onProgress?.({ percent: 8 + lanesLanded * 10, label: `${lanesLanded}/${RESEARCH_LANES.length} source lanes landed` });
        return parsed;
      }),
    );
    const landed: ResearchReport[] = [];
    laneResults.forEach((result, index) => {
      if (result.status === "fulfilled") {
        landed.push(result.value);
      } else {
        degraded.push(`${RESEARCH_LANES[index]!.key} lane failed or timed out`);
      }
    });
    if (landed.length === 0) {
      throw new Error("no research lane returned a parseable report");
    }

    // Phase 2 — synthesis into one draft. With a lone landed lane a dead
    // synthesis degrades to that lane instead of failing the quest.
    signal?.throwIfAborted();
    onProgress?.({ percent: 42, label: "synthesizing findings" });
    let draft = landed.length === 1 ? landed[0]! : null;
    const synthesized = parseReport(await run(synthesisPrompt(quest, landed)).catch(() => ""));
    if (synthesized !== null) {
      draft = synthesized;
    } else if (draft !== null) {
      degraded.push("synthesis pass failed — single-lane draft stands");
    }
    if (draft === null) {
      throw new Error("synthesis returned no parseable report");
    }

    // Progressive disclosure: the wall shows draft findings while the
    // verification passes still run.
    signal?.throwIfAborted();
    draft = { ...draft, degraded: degraded.length > 0 ? [...degraded] : undefined };
    onDraft?.(sanitizeReport(draft));
    onProgress?.({ percent: 55, label: "verifying findings (fact-check + bias)" });

    // Phase 3 — fact-check and bias scan IN PARALLEL against the draft; each
    // degrades honestly instead of silently.
    const [checked, scanned] = await Promise.all([
      run(factCheckPrompt(quest, draft)).then(parseReport).catch(() => null),
      run(biasPrompt(quest, draft)).then(parseReport).catch(() => null),
    ]);
    signal?.throwIfAborted();
    let report = draft;
    if (checked !== null) {
      report = checked;
    } else {
      degraded.push("fact-check pass failed — findings unverified");
    }
    if (scanned !== null) {
      // Bias pass owns biasNotes and contributes follow-ups; the fact-checked
      // findings/sources stay authoritative.
      const followUps = [...new Set([...report.followUps, ...scanned.followUps])];
      report = { ...report, biasNotes: scanned.biasNotes, followUps };
    } else {
      degraded.push("bias scan failed");
    }

    onProgress?.({ percent: 100, label: "report ready" });
    return sanitizeReport({ ...report, degraded: degraded.length > 0 ? degraded : undefined });
  }
}

// One angle-diverse source-hunt lane (phase 1). Same report JSON as every
// other call so parseReport stays the single validator.
export function lanePrompt(quest: ResearchQuest, instruction: string): string {
  return [
    "You are one lane of a parallel research effort for a live conversation room. Use your web search and web fetch tools RIGHT NOW — do not answer from memory; every finding must cite real, reachable sources you found.",
    `Your lane: ${instruction}`,
    `Topic: ${quest.topic}`,
    `The claim/question under research: ${quest.claim}`,
    quest.contextSpan.quote.length > 0 ? `Heard in the room as: "${quest.contextSpan.quote}"` : "",
    conversationContext(quest),
    "Requirements:",
    "- 1-4 findings from YOUR angle only, each with a verdict: supported / refuted / mixed / unverified.",
    "- Cite 2-5 sources with REAL urls; name each publisher.",
    "- sourceIndexes on each finding index into the sources array.",
    "- followUps: 0-2 sharp next questions your angle surfaced.",
    "- Leave biasNotes as an empty array (a later pass owns it).",
    `Respond with ONLY a JSON object (no markdown fences, no prose) matching exactly: ${REPORT_SHAPE}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// Phase 2: merge the lanes' partial reports into ONE draft.
export function synthesisPrompt(quest: ResearchQuest, lanes: ResearchReport[]): string {
  return [
    "You are the synthesis editor of a parallel research effort. Merge the lane reports below into ONE coherent report about the claim/question.",
    "- Deduplicate sources by URL; keep every DISTINCT source and re-index sourceIndexes correctly.",
    "- Merge overlapping findings; where lanes disagree, the verdict is mixed and the explanation says why.",
    "- 2-6 findings total, ordered most important first. Write a fresh 3-5 sentence summary.",
    "- Union the lanes' followUps (drop duplicates). Leave biasNotes empty (a later pass owns it).",
    `The claim/question: ${quest.claim}`,
    `Lane reports: ${JSON.stringify(lanes)}`,
    `Respond with ONLY the merged JSON object matching exactly: ${REPORT_SHAPE}`,
  ].join("\n");
}

export function researchPrompt(quest: ResearchQuest): string {
  return [
    "You are a research agent for a live conversation room. Use your web search and web fetch tools to research the material below RIGHT NOW — do not answer from memory alone; every finding must cite real, reachable sources you found.",
    `Research kind: ${quest.kind}`,
    `Topic: ${quest.topic}`,
    `The claim/question to research: ${quest.claim}`,
    quest.contextSpan.quote.length > 0 ? `Heard in the room as: "${quest.contextSpan.quote}"` : "",
    conversationContext(quest),
    "Requirements:",
    "- Break the material into 2-6 specific findings, each with a verdict: supported / refuted / mixed / unverified.",
    "- Cite 3-8 sources with REAL urls; prefer primary sources and name each publisher.",
    "- sourceIndexes on each finding index into the sources array.",
    "- followUps: 2-4 sharp next questions the room could ask.",
    "- Leave biasNotes as an empty array (a later pass owns it).",
    `Respond with ONLY a JSON object (no markdown fences, no prose) matching exactly: ${REPORT_SHAPE}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

export function factCheckPrompt(quest: ResearchQuest, report: ResearchReport): string {
  return [
    "You are an adversarial fact-checker. A researcher produced the report below. Your job is to try to REFUTE it: use your web search tools to independently verify every finding.",
    "- Downgrade any verdict you cannot defend with sources (supported → mixed/unverified; wrong → refuted).",
    "- Correct explanations, fix or add sources (real urls only), and drop findings that are not actually about the claim.",
    "- Keep the same JSON shape; keep biasNotes as-is.",
    `The claim under research: ${quest.claim}`,
    conversationContext(quest),
    `Report to verify: ${JSON.stringify(report)}`,
    `Respond with ONLY the corrected JSON object matching exactly: ${REPORT_SHAPE}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

// The grounding turn's whole concept branch, verbatim — so the agent
// researches the thread the room actually had, not one utterance stripped of
// its qualifiers. Empty string when the quest carries no topic context.
function conversationContext(quest: ResearchQuest): string {
  const turns = quest.contextTurns ?? [];
  if (turns.length === 0) {
    return "";
  }
  const label = quest.topicLabel ? ` (topic: ${quest.topicLabel})` : "";
  const lines = turns.map((turn) => `- ${turn.speaker ?? "room"}: ${turn.text}`);
  return [`Conversation context${label} — the thread this came from, verbatim:`, ...lines].join("\n");
}

export function biasPrompt(quest: ResearchQuest, report: ResearchReport): string {
  return [
    "You are a media-bias reviewer. Review the fact-checked report below for bias and blind spots:",
    "- Do the cited sources lean one way (political, commercial, regional)? Name the lean.",
    "- What perspectives or counter-evidence are MISSING?",
    "- Was the original room framing itself loaded? Say so plainly.",
    "Write 1-4 biasNotes (each with severity low/medium/high) and add any missing-perspective questions to followUps.",
    "Keep every other field exactly as given unless a source attribution is factually wrong.",
    `The room's original framing: ${quest.contextSpan.quote.length > 0 ? quest.contextSpan.quote : quest.claim}`,
    `Report: ${JSON.stringify(report)}`,
    `Respond with ONLY the JSON object matching exactly: ${REPORT_SHAPE}`,
  ].join("\n");
}

// Extract + validate a report from model text that may be wrapped in prose or
// fences: parse the outermost { ... } span, zod-validate. Null on any miss.
export function parseReport(content: string): ResearchReport | null {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const result = researchReportSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

// Post-validate hygiene: only http(s) sources survive (QR codes must encode
// real links), and finding sourceIndexes must point inside the surviving list.
export function sanitizeReport(report: ResearchReport): ResearchReport {
  const keptIndexes: number[] = [];
  const sources = report.sources.filter((source, index) => {
    const ok = /^https?:\/\//u.test(source.url.trim());
    if (ok) {
      keptIndexes.push(index);
    }
    return ok;
  });
  const remap = new Map(keptIndexes.map((oldIndex, newIndex) => [oldIndex, newIndex]));
  const findings = report.findings.map((finding) => ({
    ...finding,
    sourceIndexes: finding.sourceIndexes
      .map((index) => remap.get(index))
      .filter((index): index is number => index !== undefined),
  }));
  return { ...report, sources, findings };
}

// ── stub agent (deterministic, offline/CI) ──────────────────────────────────
// Emits the full report contract with honest "unverified" verdicts and no
// sources, so the loop/deck/UI are exercisable with zero network or CLI.

export class StubResearchAgent implements ResearchAgent {
  async research(quest: ResearchQuest, options: ResearchAgentOptions): Promise<ResearchReport> {
    options.signal?.throwIfAborted();
    options.onProgress?.({ percent: 50, label: "compiling offline report" });
    options.onProgress?.({ percent: 100, label: "report ready" });
    return {
      summary: `Offline research stub for "${quest.topic}". No web access was available, so the claim is recorded but unverified. Enable the host-claude research agent for sourced findings.`,
      confidence: "low",
      findings: [
        {
          claim: quest.claim,
          verdict: "unverified",
          explanation: "No live sources were reachable in offline mode.",
          sourceIndexes: [],
        },
      ],
      biasNotes: [
        { note: "Single-statement claim from the room; no independent perspectives were consulted.", severity: "medium" },
      ],
      sources: [],
      followUps: [`Re-run "${quest.topic}" with the live research agent for sourced verdicts.`],
    };
  }
}

// ── selection ───────────────────────────────────────────────────────────────

export type ResearchAgentMode = "local" | "host-claude" | "stub";

export interface ResearchAgentSelection {
  mode: ResearchAgentMode;
  agent: ResearchAgent;
}

// Explicit VIBERSYN_RESEARCH_AGENT wins ("stub" for offline/CI); host-`claude`
// (real web-searching inference on the host subscription) is the default.
export function selectResearchAgent(
  env: Record<string, string | undefined> = process.env,
  options: { runner?: ClaudeCliRunner } = {},
): ResearchAgentSelection {
  if (localAiEnabled(env) || env.VIBERSYN_RESEARCH_AGENT === "local") return { mode: "local", agent: new LocalResearchAgent(env) };
  const explicit = env.VIBERSYN_RESEARCH_AGENT?.trim().toLowerCase();
  if (explicit === "stub") {
    return { mode: "stub", agent: new StubResearchAgent() };
  }
  return {
    mode: "host-claude",
    agent: new HostClaudeResearchAgent({
      model: env.VIBERSYN_RESEARCH_AGENT_MODEL?.trim() || undefined,
      stageTimeoutMs: readTimeout(env.VIBERSYN_RESEARCH_STAGE_TIMEOUT_MS),
      totalBudgetMs: readTimeout(env.VIBERSYN_RESEARCH_TOTAL_BUDGET_MS),
      runner: options.runner,
    }),
  };
}

function readTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
