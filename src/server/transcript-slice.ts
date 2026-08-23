// ── STEER TRANSCRIPT SLICE (pure logic) ─────────────────────────────────────
// The record toggle's spoken-change window: while the operator steers an
// ADOPTED tree, every FINAL transcript line lands here; on steering CLEAR the
// joined slice becomes the steer applier's input (steer-applier.ts). The
// window is the toggle-on→toggle-off span EXACTLY — the slice is reset when
// the steering target is set, so stage narration before the toggle never
// leaks in — AND bounded to the trailing STEER_SLICE_WINDOW_MS, so a toggle
// left on through a long demo segment only commits what was just spoken.
// Pure functions over plain data: no clock, no fs, no runtime — the
// composition owns the state and stamps atMs from its injected clock.

export interface SteerSliceLine {
  text: string;
  atMs: number;
}

// "…or the last 60s, whichever is smaller": on clear, only lines whose FINAL
// arrived within this trailing window make the commit.
export const STEER_SLICE_WINDOW_MS = 60_000;

// Memory bound: a runaway mic session can never grow the slice unbounded.
// 200 finals is far beyond anything a 60s window can hold.
export const STEER_SLICE_MAX_LINES = 200;

// Append one FINAL line, dropping the oldest beyond the cap. Returns a new
// array (the composition swaps its field; no shared mutation).
export function appendSliceLine(
  lines: readonly SteerSliceLine[],
  line: SteerSliceLine,
  maxLines: number = STEER_SLICE_MAX_LINES,
): SteerSliceLine[] {
  const appended = [...lines, line];
  return appended.length <= maxLines ? appended : appended.slice(appended.length - maxLines);
}

// The joined slice text for the applier: lines within the trailing window,
// whitespace-normalized, joined into one spoken instruction. "" when nothing
// usable remains — the caller treats that as "no slice, nothing to apply".
export function joinedSliceText(
  lines: readonly SteerSliceLine[],
  nowMs: number,
  windowMs: number = STEER_SLICE_WINDOW_MS,
): string {
  const cutoffMs = nowMs - windowMs;
  return lines
    .filter((line) => line.atMs >= cutoffMs)
    .map((line) => line.text.replace(/\s+/gu, " ").trim())
    .filter((text) => text.length > 0)
    .join(" ");
}
