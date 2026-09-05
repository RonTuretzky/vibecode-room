// Adjust resolution only after sustained load, with a cooldown to avoid
// reallocating the drawing buffer on isolated slow frames or UI transitions.
export class AdaptiveResolution {
  #samples = 0;
  #totalMs = 0;
  #lastChange = 0;
  constructor(
    public ratio: number,
    readonly maximum: number,
    readonly minimum = 0.75,
  ) {}
  sample(frameMs: number, nowMs: number): number | null {
    if (frameMs <= 0 || frameMs > 250) return null;
    this.#samples++;
    this.#totalMs += frameMs;
    if (this.#samples < 90) return null;
    const mean = this.#totalMs / this.#samples;
    this.#samples = 0;
    this.#totalMs = 0;
    if (nowMs - this.#lastChange < 6000) return null;
    const next =
      mean > 28
        ? Math.max(this.minimum, this.ratio - 0.25)
        : mean < 18
          ? Math.min(this.maximum, this.ratio + 0.25)
          : this.ratio;
    if (next === this.ratio) return null;
    this.ratio = next;
    this.#lastChange = nowMs;
    return next;
  }
}
