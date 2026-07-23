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
// Per-stage budget: stage 1 does real web searching and needs headroom.
export const DEFAULT_RESEARCH_STAGE_TIMEOUT_MS = 150_000;

const REPORT_SHAPE =
  '{"summary": string (3-5 sentences), "confidence": "low"|"medium"|"high", ' +
  '"findings": [{"claim": string, "verdict": "supported"|"refuted"|"mixed"|"unverified", "explanation": string, "sourceIndexes": number[]}], ' +
  '"biasNotes": [{"note": string, "severity": "low"|"medium"|"high"}], ' +
  '"sources": [{"title": string, "url": string, "publisher": string, "note": string}], ' +
  '"followUps": string[]}';

export interface HostClaudeResearchAgentOptions {
  model?: string;
  stageTimeoutMs?: number;
  runner?: ClaudeCliRunner;
}

export class HostClaudeResearchAgent implements ResearchAgent {
  readonly #model: string;
  readonly #stageTimeoutMs: number;
  readonly #runner: ClaudeCliRunner;

  constructor(options: HostClaudeResearchAgentOptions = {}) {
    this.#model = options.model ?? DEFAULT_RESEARCH_AGENT_MODEL;
    this.#stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_RESEARCH_STAGE_TIMEOUT_MS;
    this.#runner = options.runner ?? defaultClaudeCliRunner;
  }

  async research(quest: ResearchQuest, options: ResearchAgentOptions): Promise<ResearchReport> {
    const { signal, onProgress } = options;
    const run = (prompt: string) => this.#runner(prompt, { model: this.#model, timeoutMs: this.#stageTimeoutMs });

    // Stage 1 — research. This stage MUST land; a miss fails the quest.
    signal?.throwIfAborted();
    onProgress?.({ percent: 8, label: "researching sources" });
    const researched = parseReport(await run(researchPrompt(quest)));
    if (researched === null) {
      throw new Error("research stage returned no parseable report");
    }
    let report = researched;

    // Stage 2 — adversarial fact-check. Degrades to stage 1 on any miss.
    signal?.throwIfAborted();
    onProgress?.({ percent: 45, label: "fact-checking findings" });
    const checked = parseReport(await run(factCheckPrompt(quest, report)).catch(() => ""));
    if (checked !== null) {
      report = checked;
    }

    // Stage 3 — bias scan. Merges bias notes/follow-ups; degrades silently.
    signal?.throwIfAborted();
    onProgress?.({ percent: 80, label: "scanning for bias" });
    const scanned = parseReport(await run(biasPrompt(quest, report)).catch(() => ""));
    if (scanned !== null) {
      report = scanned;
    }

    signal?.throwIfAborted();
    onProgress?.({ percent: 100, label: "report ready" });
    return sanitizeReport(report);
  }
}

export function researchPrompt(quest: ResearchQuest): string {
  return [
    "You are a research agent for a live conversation room. Use your web search and web fetch tools to research the material below RIGHT NOW — do not answer from memory alone; every finding must cite real, reachable sources you found.",
    `Research kind: ${quest.kind}`,
    `Topic: ${quest.topic}`,
    `The claim/question to research: ${quest.claim}`,
    quest.contextSpan.quote.length > 0 ? `Heard in the room as: "${quest.contextSpan.quote}"` : "",
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
    `Report to verify: ${JSON.stringify(report)}`,
    `Respond with ONLY the corrected JSON object matching exactly: ${REPORT_SHAPE}`,
  ].join("\n");
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

export type ResearchAgentMode = "host-claude" | "stub";

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
  const explicit = env.VIBERSYN_RESEARCH_AGENT?.trim().toLowerCase();
  if (explicit === "stub") {
    return { mode: "stub", agent: new StubResearchAgent() };
  }
  return {
    mode: "host-claude",
    agent: new HostClaudeResearchAgent({
      model: env.VIBERSYN_RESEARCH_AGENT_MODEL?.trim() || undefined,
      stageTimeoutMs: readTimeout(env.VIBERSYN_RESEARCH_STAGE_TIMEOUT_MS),
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
