import { MockBrain } from "./mock.ts";
import { SmithersBrain } from "./smithers.ts";
import type { Brain } from "./types.ts";

export type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

/** Pick the brain: Smithers subscriptions by default, deterministic mock offline. */
export function makeBrain(): Brain {
  if (process.env.PANOPTICON_OFFLINE === "1") {
    console.log("[brain] PANOPTICON_OFFLINE=1 — using MockBrain");
    return new MockBrain();
  }
  console.log("[brain] using SmithersBrain");
  return new SmithersBrain();
}
