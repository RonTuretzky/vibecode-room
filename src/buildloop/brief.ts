// Shared, PURE renderer of the IdeaBrief context block the backends append to
// their build prompts (string-level only — no backend restructures around the
// brief). Sections render only when they have content, and an empty/absent
// brief renders to "" so callers can compose unconditionally:
//
//   AS HEARD IN THE ROOM (verbatim): "…"
//   WHY IT IS BUILDABLE: …
//   DECISIONS ALREADY MADE:
//   - <question> → <chosen>
//   OPEN QUESTIONS:
//   - <question> (options: A / B)

import type { BuildBrief } from "./types";

export function briefContextBlock(brief: BuildBrief | null | undefined): string {
  if (brief === null || brief === undefined) {
    return "";
  }
  const lines: string[] = [];
  const quote = brief.sourceQuote.trim();
  if (quote.length > 0) {
    lines.push(`AS HEARD IN THE ROOM (verbatim): "${quote}"`);
  }
  const rationale = brief.rationale.trim();
  if (rationale.length > 0) {
    lines.push(`WHY IT IS BUILDABLE: ${rationale}`);
  }
  const decided: string[] = [];
  const open: string[] = [];
  for (const question of brief.qa) {
    const prompt = question.prompt.trim();
    if (prompt.length === 0) {
      continue;
    }
    const chosen = question.chosen?.trim() ?? "";
    if (chosen.length > 0) {
      decided.push(`- ${prompt} → ${chosen}`);
    } else {
      const options = question.answers.map((answer) => answer.trim()).filter((answer) => answer.length > 0);
      open.push(options.length > 0 ? `- ${prompt} (options: ${options.join(" / ")})` : `- ${prompt}`);
    }
  }
  if (decided.length > 0) {
    lines.push("DECISIONS ALREADY MADE:", ...decided);
  }
  if (open.length > 0) {
    lines.push("OPEN QUESTIONS:", ...open);
  }
  return lines.join("\n");
}
