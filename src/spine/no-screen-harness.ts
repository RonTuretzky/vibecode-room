export type NoScreenInputKind = "gui" | "keyboard";

export interface NoScreenConsumedEvent {
  kind: NoScreenInputKind;
  label: string;
  consumedAtMs: number;
}

export interface NoScreenHarnessOptions {
  clock?: () => number;
}

export class NoScreenHarness {
  readonly #clock: () => number;
  readonly #consumed: NoScreenConsumedEvent[] = [];

  constructor(options: NoScreenHarnessOptions = {}) {
    this.#clock = options.clock ?? (() => Date.now());
  }

  consume(kind: NoScreenInputKind, label: string): void {
    this.#consumed.push({ kind, label, consumedAtMs: this.#clock() });
  }

  consumedEvents(): NoScreenConsumedEvent[] {
    return this.#consumed.map((event) => ({ ...event }));
  }

  assertZeroConsumed(): void {
    if (this.#consumed.length > 0) {
      const summary = this.#consumed.map((event) => `${event.kind}:${event.label}`).join(", ");
      throw new Error(`Expected zero GUI/keyboard events consumed; saw ${summary}.`);
    }
  }
}
