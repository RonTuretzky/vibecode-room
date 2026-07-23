import { deriveAssessment, normalizeRubric, type IdeaAssessment, type IdeaRubric } from "./rubric";
import type { ContextSpan, DetectionInput, JudgedIdea, TranscriptTurn, VerifiableIdea } from "./types";

// The judge prompt + reply parser for idea detection. Design rules:
//  • The model fills the ANCHORED RUBRIC (category + four 0-3 dimensions whose
//    anchors are stated verbatim below, mirroring rubric.ts). It never invents a
//    confidence — code derives that.
//  • Few-shot exemplars cover the hard cases the old one-paragraph prompt got
//    wrong: discussing an existing product, jokes, logistics, implicit ideas,
//    ideas that form across turns, and ideas floated then retracted.
//  • Judge the room's FINAL stance in the window: a retracted idea is scored by
//    the retraction.
//  • Every idea is grounded: turn-id span + verbatim quote (repaired against the
//    actual turns after parsing, so a drifted quote never ships).

const MAX_PITCH_WORDS = 14;
const MAX_QUESTIONS = 3;
// Answer options are packed one "/"-joined string per question (questions[i] ↔
// answers[i]); the swipe deck fans them back out (see plan-questions.ts). 2-4 is
// the range the deck renders well — enough to fork, few enough to swipe.
const MAX_ANSWERS = 4;

// ── few-shot exemplars (compact on purpose; each teaches one failure mode) ────
const EXEMPLARS = `Example 1 — discussing an EXISTING product (not an idea):
[turn-0001] amy: have you tried that new Linear calendar view
[turn-0002] bo: yeah it's pretty good actually
→ {"assessments":[{"matchId":null,"category":"existing-product","concreteness":2,"buildableAsSoftware":3,"intent":1,"novelty":0,"pitch":"Linear calendar view","startTurn":"turn-0001","endTurn":"turn-0002","quote":"have you tried that new Linear calendar view","questions":[],"answers":[],"rationale":"they are reviewing an existing product, not proposing one"}]}

Example 2 — a JOKE (not meant):
[turn-0001] amy: we should build an app that texts your ex at 2am hahaha
[turn-0002] bo: lmao yes, series A immediately
→ {"assessments":[{"matchId":null,"category":"hypothetical","concreteness":1,"buildableAsSoftware":3,"intent":0,"novelty":2,"pitch":"App that texts your ex at 2am","startTurn":"turn-0001","endTurn":"turn-0002","quote":"we should build an app that texts your ex at 2am hahaha","questions":[],"answers":[],"rationale":"laughter framing; nobody means it"}]}

Example 3 — LOGISTICS (no idea at all):
[turn-0001] amy: let's book the demo room for thursday and order food
[turn-0002] bo: i'll send the invite
→ {"assessments":[]}

Example 4 — an IMPLICIT idea (never says "app"); ONE sharp data-source fork:
[turn-0001] amy: the standup notes keep losing people's blockers
[turn-0002] bo: honestly we could wrap those into one thing that nags whoever's blocking
→ {"assessments":[{"matchId":null,"category":"proposal","concreteness":2,"buildableAsSoftware":3,"intent":2,"novelty":2,"pitch":"Build a blocker tracker that nags owners from standup notes","startTurn":"turn-0001","endTurn":"turn-0002","quote":"the standup notes keep losing people's blockers honestly we could wrap those into one thing that nags whoever's blocking","questions":["Where do the blockers come from?"],"answers":["Slack / Standup doc / Jira"],"rationale":"a genuine tool proposal phrased implicitly"}]}

Example 5 — idea FORMS across turns and the room COMMITS; TWO forks (scope + style):
[turn-0001] amy: what if members could stake collateral and work shifts
[turn-0002] bo: yes and buy ownership shares as they work
[turn-0003] amy: let's actually build that this week
→ {"assessments":[{"matchId":null,"category":"proposal","concreteness":2,"buildableAsSoftware":2,"intent":3,"novelty":2,"pitch":"Build member staking with shifts earning ownership shares","startTurn":"turn-0001","endTurn":"turn-0003","quote":"what if members could stake collateral and work shifts yes and buy ownership shares as they work let's actually build that this week","questions":["Stake with real money or points first?","When does ownership vest?"],"answers":["Real money / Points","Immediately / Over worked shifts"],"rationale":"proposal elaborated by both speakers, explicit commitment"}]}

Example 6 — idea floated then RETRACTED (score the final stance):
[turn-0001] amy: an app that rates sandwiches by vibe
[turn-0002] bo: hmm
[turn-0003] amy: nah forget it, that's dumb
→ {"assessments":[{"matchId":null,"category":"proposal","concreteness":1,"buildableAsSoftware":3,"intent":1,"novelty":2,"pitch":"Sandwich vibe-rating app","startTurn":"turn-0001","endTurn":"turn-0003","quote":"an app that rates sandwiches by vibe nah forget it, that's dumb","questions":[],"answers":[],"rationale":"floated then withdrawn — final stance is disinterest"}]}

Example 7 — a KNOWN idea gets retracted later (known: id=idea-42 pitch="Inventory nag bot"):
[turn-0007] amy: actually scrap the inventory bot thing, we don't have time
[turn-0008] bo: yeah agreed, drop it
→ {"assessments":[{"matchId":"idea-42","category":"proposal","concreteness":2,"buildableAsSoftware":3,"intent":1,"novelty":2,"pitch":"Inventory nag bot","startTurn":"turn-0007","endTurn":"turn-0008","quote":"actually scrap the inventory bot thing, we don't have time yeah agreed, drop it","questions":[],"answers":[],"rationale":"the room explicitly abandoned the tracked idea — intent drops"}]}

Example 8 — a SURFACED proposal with the RIGHT questions: three forks (data source, scope, style), each 2-3 concrete options that MEANINGFULLY change the build:
[turn-0001] amy: we should build a dashboard that shows which customers are about to churn
[turn-0002] bo: yeah, pull their recent usage and flag the risky ones
[turn-0003] amy: let's ship a first cut this week
→ {"assessments":[{"matchId":null,"category":"proposal","concreteness":3,"buildableAsSoftware":3,"intent":3,"novelty":2,"pitch":"Build a churn-risk dashboard flagging at-risk customers","startTurn":"turn-0001","endTurn":"turn-0003","quote":"we should build a dashboard that shows which customers are about to churn yeah, pull their recent usage and flag the risky ones let's ship a first cut this week","questions":["Where does the usage data come from?","How is churn risk scored?","Who is the first version for?"],"answers":["Stripe / Product analytics / CSV upload","Simple rules / ML model","Exec overview / CS worklist"],"rationale":"explicit commitment to a concrete internal tool"}]}`;

export function renderTurns(turns: readonly TranscriptTurn[]): string {
  if (turns.length === 0) {
    return "(no transcript)";
  }
  return turns.map((t) => `[${t.id}] ${t.speaker ?? "speaker"}: ${t.text}`).join("\n");
}

function renderKnown(known: DetectionInput["known"]): string {
  if (known.length === 0) {
    return "(none yet)";
  }
  return known
    .map((k) => `- id=${k.id} pitch=${JSON.stringify(k.pitch)} span=${k.contextSpan.startTurnId}..${k.contextSpan.endTurnId}`)
    .join("\n");
}

export function buildJudgePrompt(input: DetectionInput): string {
  return [
    "You are the idea judge for an ambient room assistant. People are talking; your job is to find spans where the room expresses an idea and JUDGE each one on a fixed rubric. Do not decide whether to act — the system derives that from your rubric. Judge meaning and intent, never keywords.",
    "",
    "For EVERY span someone might call an idea (even ones you judge to be jokes or existing products), emit one assessment with:",
    "• category — exactly one of:",
    '  "proposal" (the room suggests something be created) | "existing-product" (discussing a product that already exists) | "hypothetical" (joke/whimsy, not meant) | "logistics" (planning/scheduling people) | "recap" (describing work already done) | "chatter" (anything else)',
    "• concreteness 0-3 — 0 vague theme (\"something with AI\"); 1 named concept; 2 described behavior (what it does / who uses it); 3 specified (features, flows, data — could brief a builder)",
    "• buildableAsSoftware 0-3 — 0 not software; 1 mostly physical/organizational with a software sliver; 2 core is realizable as software/automation; 3 squarely an app/tool/automation a coding agent could start now",
    "• intent 0-3 — the room's FINAL stance across the span (a floated-then-rejected idea scores the rejection): 0 joke/sarcasm; 1 idle musing (a passing one-liner nobody develops); 2 genuine interest; 3 commitment (\"let's build it\"). SUSTAINED ELABORATION IS REVEALED INTENT: if the speaker(s) keep developing the idea across turns — adding mechanisms, details, or how it would work — that is genuine interest (>=2) even when the phrasing is soft (\"wouldn't that be lovely\").",
    "• novelty 0-3 — 0 already exists and they know it; 1 minor variation; 2 new combination of known parts; 3 distinctly new",
    `• pitch — <=${MAX_PITCH_WORDS} word imperative pitch`,
    "• startTurn/endTurn — the turn-id span expressing it; quote — verbatim evidence from those turns",
    `• questions — for a genuine PROPOSAL you would surface, give 1-${MAX_QUESTIONS} CRISP questions that FORK THE BUILD: each decides between real alternatives for SCOPE (what's in v1 / how big), DATA SOURCE (where inputs come from), or STYLE (look / tone / platform / audience). A good question changes what gets built; a bad one is filler ("what features?", "what should it be called?"). Ask fewer, sharper questions rather than padding to ${MAX_QUESTIONS}. Leave [] for jokes, existing products, logistics, retractions, and anything you would NOT surface.`,
    `• answers — PARALLEL to questions (answers[i] belongs to questions[i]): 2-${MAX_ANSWERS} short, mutually-distinct option labels for that question, packed as ONE string separated by " / " (e.g. "Slack / Notes doc / Jira"). Real choices, not "yes / no" unless the fork is truly binary. answers must be [] exactly when questions is [].`,
    "• rationale — one line explaining your category+intent call",
    "",
    "Known ideas already being tracked. If the transcript contains ANY further talk about a known idea — elaboration, endorsement, questions about it, OR rejection/retraction/abandonment — you MUST emit an assessment for it with matchId set to its id, re-judging the rubric against the room's CURRENT stance (elaboration raises concreteness, commitment raises intent, retraction/dismissal LOWERS intent to 0-1). Only omit a known idea when the transcript does not touch it at all:",
    renderKnown(input.known),
    "",
    EXEMPLARS,
    "",
    "Transcript to judge (each line is [turn-id] speaker: text):",
    renderTurns(input.turns),
    "",
    'Reply with ONLY a JSON object, no prose, no code fences: {"assessments":[...]}. If nothing is even idea-shaped, reply exactly: {"assessments":[]}',
  ].join("\n");
}

// ── reply parsing (tolerant; grounding repaired against the real turns) ───────
export interface ParsedJudgement {
  ideas: JudgedIdea[];
  // Every assessment incl. gated negatives (existing-product/joke/etc.), for
  // trace + evals. `ideas` above is the subset that should enter the ledger.
  assessments: Array<{ rubric: IdeaRubric; assessment: IdeaAssessment; pitch: string }>;
  raw: unknown;
}

export function parseJudgeReply(reply: string, input: DetectionInput, surfaceThreshold?: number): ParsedJudgement {
  const obj = extractJsonObject(reply);
  if (obj === null) {
    return { ideas: [], assessments: [], raw: { reply } };
  }
  const rawAssessments = Array.isArray((obj as Record<string, unknown>).assessments)
    ? ((obj as Record<string, unknown>).assessments as unknown[])
    : [];
  const turnIds = new Set(input.turns.map((t) => t.id));
  const firstId = input.turns[0]?.id;
  const lastId = input.turns.at(-1)?.id;
  const ideas: JudgedIdea[] = [];
  const assessments: ParsedJudgement["assessments"] = [];

  for (const entry of rawAssessments) {
    if (!isRecord(entry) || firstId === undefined || lastId === undefined) {
      continue;
    }
    const pitch = clampWords(asString(entry.pitch), MAX_PITCH_WORDS);
    if (pitch.length === 0) {
      continue;
    }
    const rubric = normalizeRubric({
      category: asString(entry.category),
      concreteness: entry.concreteness as number,
      buildableAsSoftware: entry.buildableAsSoftware as number,
      intent: entry.intent as number,
      novelty: entry.novelty as number,
    });
    const assessment = deriveAssessment(rubric, surfaceThreshold);
    assessments.push({ rubric, assessment, pitch });

    const matchId = typeof entry.matchId === "string" && entry.matchId.trim().length > 0 ? entry.matchId.trim() : null;
    // Hard-gated spans (jokes, existing products, non-proposals, non-software)
    // never become NEW candidates — but a gated RE-assessment of a TRACKED idea
    // must reach the ledger, so the strongest stance changes ("it became a joke",
    // "wait, that already exists", category flip) demote the surfaced bubble
    // immediately instead of waiting out stale-supersede.
    if (assessment.confidence === 0 && matchId === null) {
      continue;
    }

    // Grounding. Cited ids can be stale (the prompt shows known ideas' original
    // spans, and the window prunes old turns while ids are never reused). Never
    // substitute window bounds for stale ids — that fabricates a whole-window
    // quote and a span that overlap-matches everything. Instead: clamp to the
    // valid endpoint, fall back to the tracked idea's original span, or anchor to
    // the window's latest turn.
    const rawStart = asString(entry.startTurn);
    const rawEnd = asString(entry.endTurn);
    const validStart = turnIds.has(rawStart);
    const validEnd = turnIds.has(rawEnd);
    let span: ContextSpan;
    if (validStart || validEnd) {
      const startTurnId = validStart ? rawStart : rawEnd;
      const endTurnId = validEnd ? rawEnd : rawStart;
      span = { startTurnId, endTurnId, quote: groundQuote(input.turns, startTurnId, endTurnId) ?? asString(entry.quote) };
    } else {
      const knownSpan = matchId === null ? undefined : input.known.find((k) => k.id === matchId)?.contextSpan;
      if (knownSpan !== undefined) {
        span = { startTurnId: knownSpan.startTurnId, endTurnId: knownSpan.endTurnId, quote: asString(entry.quote) || knownSpan.quote };
      } else {
        span = { startTurnId: lastId, endTurnId: lastId, quote: asString(entry.quote) || (groundQuote(input.turns, lastId, lastId) ?? "") };
      }
    }

    ideas.push({
      matchId,
      pitch,
      confidence: assessment.confidence,
      questions: stringArray(entry.questions).slice(0, MAX_QUESTIONS),
      answers: stringArray(entry.answers).slice(0, MAX_QUESTIONS),
      contextSpan: span,
      rationale: asString(entry.rationale),
      judgment: { rubric, assessment },
    });
  }
  return { ideas, assessments, raw: obj };
}

// ── adversarial verification (runs once, when an idea first becomes ready) ────
// The costly error is a false bubble. Before surfacing, a second pass argues the
// OTHER side: is this genuinely a new, buildable, wanted idea — or did the judge
// misread an existing product / joke / musing?
export function buildVerifyPrompt(idea: VerifiableIdea, input: DetectionInput): string {
  return [
    "You are a NARROW misread-check for an ambient room assistant. A rubric judge already assessed the span below as a buildable software idea the room wants; your only job is to catch CLEAR misreads. You are not a second judge — do not re-litigate how enthusiastic the room sounds or how good the idea is.",
    "Reject ONLY if the transcript contains explicit evidence of one of these:",
    "• the room is reviewing/using a SPECIFIC existing product (named or unmistakable) rather than proposing to build something;",
    "• unmistakable joke framing (laughter, sarcasm) with no serious take-up by anyone;",
    "• an explicit retraction/dismissal is the room's final word on it;",
    "• the proposal is plainly not realizable as software;",
    "• the claimed pitch has no support at all in the transcript.",
    "Generic resemblance to existing products is NOT grounds — most good ideas resemble something. Casual or playful tone is NOT grounds — the judge already scored intent. WHEN IN DOUBT, UPHOLD.",
    "",
    `Claimed idea: ${JSON.stringify(idea.pitch)}`,
    `Judged rubric: ${JSON.stringify(idea.judgment?.rubric ?? {})}`,
    `Evidence span ${idea.contextSpan.startTurnId}..${idea.contextSpan.endTurnId}: ${JSON.stringify(idea.contextSpan.quote)}`,
    "",
    "Full transcript window:",
    renderTurns(input.turns),
    "",
    'Reply with ONLY JSON: {"verdict":"uphold"|"reject","reason":"one line"}',
  ].join("\n");
}

export interface VerifyVerdict {
  uphold: boolean;
  reason: string;
}

// Fail-open: an unparseable/errored verification must never block a real idea,
// so anything not an explicit "reject" upholds.
export function parseVerifyReply(reply: string): VerifyVerdict {
  const obj = extractJsonObject(reply);
  if (obj === null) {
    return { uphold: true, reason: "unparseable-verifier-reply" };
  }
  const verdict = asString((obj as Record<string, unknown>).verdict).toLowerCase();
  return {
    uphold: verdict !== "reject",
    reason: asString((obj as Record<string, unknown>).reason) || verdict,
  };
}

// ── shared helpers ────────────────────────────────────────────────────────────
export function groundQuote(turns: readonly TranscriptTurn[], startId: string, endId: string): string | null {
  const startIndex = turns.findIndex((t) => t.id === startId);
  const endIndex = turns.findIndex((t) => t.id === endId);
  if (startIndex === -1 || endIndex === -1) {
    return null;
  }
  const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
  return turns
    .slice(lo, hi + 1)
    .map((t) => t.text)
    .join(" ");
}

function extractJsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim())
    : [];
}

function clampWords(text: string, max: number): string {
  return text.trim().split(/\s+/u).filter(Boolean).slice(0, max).join(" ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
