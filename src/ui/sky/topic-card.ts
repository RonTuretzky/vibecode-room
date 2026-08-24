/**
 * THE TOPIC CARD's pure model — what a picked constellation says about itself.
 *
 * Picking a constellation used to fire a research quest at its freshest
 * utterance: a heavy, invisible side effect for what reads like "tell me about
 * this". Now it opens a card, and researching the thread is a verb ON the
 * card.
 *
 * The rules here are all about not lying:
 *   • The abstract is the relate agent's or it does not exist. There is no
 *     synthesized recap — with no abstract the card shows the actual lines and
 *     says why (never summarized yet vs. no model has ever spoken).
 *   • Lines are marked "said" (live text) or "recalled" (an ≤80-char gist kept
 *     after the dialogue window dropped the turn) — a gist is visibly a
 *     fragment, not a quote.
 *   • Elided history is stated, not hidden: "+N earlier turns no longer kept".
 *
 * Pagination, not scrolling: the wall's grammar has no wheel and no drag, so
 * the lines come in pages the dwell cursor can step through.
 */

export interface TopicCardLine {
  id: string;
  atMs: number;
  speaker: string | null;
  text: string;
  source: "said" | "recalled";
}

export interface TopicCardDetail {
  id: string;
  label: string;
  labelSource: "agent" | "topic";
  firstAtMs: number;
  freshAtMs: number;
  turnCount: number;
  dominantSpeaker: string | null;
  live: boolean;
  named: boolean;
  summary: string | null;
  summaryAtMs: number | null;
  agentAtMs: number | null;
  lines: TopicCardLine[];
  elidedCount: number;
  related: Array<{ id: string; label: string; strength: number; reason: string; source: "agent" | "lexical" }>;
}

// Lines per page. Four fits the card at projector type sizes without the list
// ever needing a scrollbar the room cannot drive.
export const TOPIC_CARD_PAGE_SIZE = 4;

/**
 * The abstract block: either the agent's sentence, or an honest statement of
 * which silence this is. `kind` drives the styling — a real abstract reads as
 * content, a silence reads as a quiet note.
 */
export function summaryBlock(detail: Pick<TopicCardDetail, "summary" | "agentAtMs" | "lines">): {
  kind: "agent" | "pending" | "never";
  text: string;
} {
  if (detail.summary !== null && detail.summary.trim().length > 0) {
    return { kind: "agent", text: detail.summary.trim() };
  }
  if (detail.agentAtMs === null) {
    return {
      kind: "never",
      text: "No model has summarized the ceiling yet — this is the thread as it was said.",
    };
  }
  return {
    kind: "pending",
    text: "Not summarized yet — this is the thread as it was said.",
  };
}

/** "12 turns · 3 no longer kept" — the memory line, elision stated outright. */
export function memoryLine(detail: Pick<TopicCardDetail, "turnCount" | "elidedCount">): string {
  const turns = `${detail.turnCount} turn${detail.turnCount === 1 ? "" : "s"}`;
  if (detail.elidedCount <= 0) {
    return turns;
  }
  return `${turns} · ${detail.elidedCount} earlier no longer kept`;
}

/** Clock-time span of the thread, e.g. "14:32 → 14:51" (or one stamp). */
export function spanLine(
  detail: Pick<TopicCardDetail, "firstAtMs" | "freshAtMs">,
  format: (atMs: number) => string,
): string {
  const from = format(detail.firstAtMs);
  const to = format(detail.freshAtMs);
  return from === to ? from : `${from} → ${to}`;
}

/** Page slice of the thread, clamped so a stale page index can never blank the card. */
export function linePage(
  lines: readonly TopicCardLine[],
  page: number,
  pageSize: number = TOPIC_CARD_PAGE_SIZE,
): { lines: TopicCardLine[]; page: number; pageCount: number } {
  const pageCount = Math.max(1, Math.ceil(lines.length / pageSize));
  const clamped = Math.min(Math.max(0, Math.floor(page)), pageCount - 1);
  return { lines: lines.slice(clamped * pageSize, clamped * pageSize + pageSize), page: clamped, pageCount };
}

/**
 * Which page holds a given turn — picking a single star opens the card ON that
 * star's page rather than at the beginning of a long thread.
 */
export function pageOfLine(
  lines: readonly TopicCardLine[],
  turnId: string | null,
  pageSize: number = TOPIC_CARD_PAGE_SIZE,
): number {
  if (turnId === null) {
    return 0;
  }
  const index = lines.findIndex((line) => line.id === turnId);
  // Not in the kept history (elided, or the whole-patch pick's freshest-turn
  // key): the freshest page is the useful default.
  if (index < 0) {
    return Math.max(0, Math.ceil(lines.length / pageSize) - 1);
  }
  return Math.floor(index / pageSize);
}
