// PLANNING routine: normalize a judged idea's raw questions/answers into the
// EXACT shape the swipe deck consumes — Array<{ id, prompt, answers: string[] }>.
//
// The rubric judge (prompt.ts) emits, per assessment, two PARALLEL flat arrays:
//   questions[i]  the i-th decision-shaping question
//   answers[i]    that question's 2-4 option labels, "/"-joined ("Slack / Jira")
// keeping the ledger/snapshot contract at "two string[]" (no schema change). This
// normalizer is the single place that decodes that convention into the deck's
// structured questions, so the prompt, the ledger, and the UI never have to agree
// on more than those two arrays.
//
// It is PURE (no clock, no io, no randomness) and TOLERANT — beyond the current
// convention it also accepts:
//   • the legacy shape: one question whose options were emitted as separate
//     `answers` entries (["On-chain","Points"]);
//   • model drift: mismatched lengths, mixed delimiters, blanks, dupes, and
//     over-long prompts/labels.
// Anything it can't align degrades to a question with fewer (or no) options
// rather than throwing — the deck guards on empty option lists.

export interface PlanQuestion {
  // Stable, deterministic id derived from the prompt text (NOT its position), so
  // the deck can key a swipe answer to a question across re-detection.
  id: string;
  prompt: string;
  answers: string[];
}

// The minimal view the normalizer reads — satisfied by DetectedIdea,
// IdeaCandidate, and the raw judge assessment alike (all carry questions/answers
// as flat string arrays). Deliberately loose so callers never have to cast.
export interface AssessmentQuestions {
  questions?: readonly string[] | null;
  answers?: readonly string[] | null;
}

export const MAX_PLAN_QUESTIONS = 3;
export const MAX_PLAN_ANSWERS = 4;
const MAX_PROMPT_CHARS = 120;
const MAX_ANSWER_CHARS = 48;

// Option labels are packed one string per question, separated by "/" (the
// convention the prompt teaches). Tolerate the delimiters a drifting model
// reaches for — "|", ";", newlines — but NOT commas: option labels contain them.
const OPTION_DELIMITERS = /\s*[/|;\n]+\s*/u;

export function questionsFromAssessment(assessment: AssessmentQuestions | null | undefined): PlanQuestion[] {
  const prompts = cleanStrings(assessment?.questions);
  const answers = cleanStrings(assessment?.answers);
  if (prompts.length === 0) {
    return [];
  }
  // Parallel when the counts line up (the current convention). A lone question
  // whose options were split across the answers array is the legacy shape —
  // there, every answer entry is an option for the single question.
  const parallel = answers.length === prompts.length;
  const singleLegacy = prompts.length === 1 && !parallel && answers.length > 1;

  const out: PlanQuestion[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < prompts.length && out.length < MAX_PLAN_QUESTIONS; i += 1) {
    const prompt = clampChars(prompts[i], MAX_PROMPT_CHARS);
    const key = normalizeKey(prompt);
    if (key.length === 0 || seen.has(key)) {
      continue; // blank after clamping, or a duplicate question
    }
    seen.add(key);
    const optionSource = singleLegacy ? answers.flatMap(splitOptions) : splitOptions(answers[i] ?? "");
    out.push({ id: questionId(key), prompt, answers: dedupClamp(optionSource, MAX_PLAN_ANSWERS, MAX_ANSWER_CHARS) });
  }
  return out;
}

function splitOptions(bundle: string): string[] {
  return bundle.split(OPTION_DELIMITERS);
}

function dedupClamp(values: readonly string[], maxCount: number, maxChars: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const label = clampChars(value, maxChars);
    const key = normalizeKey(label);
    if (key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(label);
    if (out.length >= maxCount) {
      break;
    }
  }
  return out;
}

function cleanStrings(values: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

// Stable id from the prompt's normalized text: slug for legibility + a short
// content hash so two long prompts that slug to the same 32-char prefix still get
// distinct ids. Deterministic — same prompt always yields the same id.
function questionId(key: string): string {
  const slug = key.replace(/\s+/gu, "-").slice(0, 32).replace(/^-+|-+$/gu, "");
  return `q-${slug || "question"}-${hash36(key)}`;
}

// Normalize for dedup + hashing: lowercase, collapse non-alphanumerics to single
// spaces. "Slack" and " slack " collapse to the same key.
function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

// djb2, base36 — deterministic and dependency-free (mirrors the repo's other
// no-crypto id helpers). Never used for security, only for id disambiguation.
function hash36(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function clampChars(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : trimmed.slice(0, max).trimEnd();
}
