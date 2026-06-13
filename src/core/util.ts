// Small shared helpers.

let counter = 0;
/** Short, sortable-ish unique id with a prefix. */
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

/** Stable short token for QR pairing. */
export function token(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function now(): number {
  return Date.now();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
