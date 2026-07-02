import type { ContextSpan, TranscriptTurn } from "./types";

export interface TranscriptWindowOptions {
  // Hard cap on retained turns. The window is what inference sees, so this bounds
  // prompt size; old turns fall off the front. Default 60.
  maxTurns?: number;
  // Drop turns older than this (measured from the newest turn's timestamp), so a
  // long pause naturally clears stale framing. Default 6 minutes.
  maxAgeMs?: number;
  // Stable monotonic id factory. Ids are NEVER reused even after a turn is pruned,
  // so a context span recorded earlier always refers to the same utterance.
  idFactory?: (seq: number) => string;
}

const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 1_000;

export interface AppendTurnInput {
  speaker: string | null;
  text: string;
  atMs: number;
}

// A rolling, turn-structured view of room speech. Each committed (FINAL) line
// becomes a turn with a stable id; the window keeps the recent arc of the
// conversation so detection runs over CHUNKS, not isolated finals, and a detected
// idea can be grounded back to the exact turns that produced it.
export class TranscriptWindow {
  readonly #maxTurns: number;
  readonly #maxAgeMs: number;
  readonly #idFactory: (seq: number) => string;
  #seq = 0;
  #turns: TranscriptTurn[] = [];

  constructor(options: TranscriptWindowOptions = {}) {
    this.#maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#idFactory = options.idFactory ?? ((seq) => `turn-${String(seq).padStart(4, "0")}`);
  }

  // Append one committed turn and prune. Empty/whitespace text is ignored
  // (returns null) so blank finals never enter the window or move scheduling.
  append(input: AppendTurnInput): TranscriptTurn | null {
    const text = input.text.trim();
    if (text.length === 0) {
      return null;
    }
    this.#seq += 1;
    const turn: TranscriptTurn = {
      id: this.#idFactory(this.#seq),
      speaker: input.speaker,
      text,
      atMs: input.atMs,
    };
    this.#turns.push(turn);
    this.#prune();
    return turn;
  }

  turns(): TranscriptTurn[] {
    return this.#turns.map((turn) => ({ ...turn }));
  }

  size(): number {
    return this.#turns.length;
  }

  isEmpty(): boolean {
    return this.#turns.length === 0;
  }

  lastAtMs(): number | null {
    return this.#turns.at(-1)?.atMs ?? null;
  }

  findTurn(id: string): TranscriptTurn | undefined {
    const found = this.#turns.find((turn) => turn.id === id);
    return found === undefined ? undefined : { ...found };
  }

  // Resolve an inclusive turn-id range to the concatenated verbatim text. Returns
  // null if either endpoint is no longer in the window (pruned). Used to VALIDATE
  // and, when the model's quote drifts, REPAIR a context span against ground truth.
  resolveSpan(startTurnId: string, endTurnId: string): { turns: TranscriptTurn[]; quote: string } | null {
    const startIndex = this.#turns.findIndex((turn) => turn.id === startTurnId);
    const endIndex = this.#turns.findIndex((turn) => turn.id === endTurnId);
    if (startIndex === -1 || endIndex === -1) {
      return null;
    }
    const [lo, hi] = startIndex <= endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
    const turns = this.#turns.slice(lo, hi + 1).map((turn) => ({ ...turn }));
    return { turns, quote: turns.map((turn) => turn.text).join(" ") };
  }

  #prune(): void {
    if (this.#turns.length > this.#maxTurns) {
      this.#turns = this.#turns.slice(this.#turns.length - this.#maxTurns);
    }
    const newest = this.#turns.at(-1)?.atMs;
    if (newest !== undefined) {
      const cutoff = newest - this.#maxAgeMs;
      this.#turns = this.#turns.filter((turn) => turn.atMs >= cutoff);
    }
  }
}

// Render a window of turns into a numbered transcript for the model. Each turn is
// labelled with its STABLE id so the model can cite ids directly in a context
// span, e.g. "[turn-0007] speaker_0: ...". Pure — shared by detector + tests.
export function renderTurns(turns: readonly TranscriptTurn[]): string {
  return turns
    .map((turn) => `[${turn.id}] ${turn.speaker ?? "speaker"}: ${turn.text}`)
    .join("\n");
}

// Clamp/repair a model-proposed span against the live window: if the cited turns
// still exist, replace the quote with ground truth; otherwise keep the model's
// quote but leave ids as given. Never throws — grounding is best-effort.
export function groundSpan(window: TranscriptWindow, span: ContextSpan): ContextSpan {
  const resolved = window.resolveSpan(span.startTurnId, span.endTurnId);
  if (resolved === null) {
    return span;
  }
  return { startTurnId: span.startTurnId, endTurnId: span.endTurnId, quote: resolved.quote };
}
