import { AnthropicBrain } from "./anthropic.ts";
import { MockBrain } from "./mock.ts";
import type { Brain } from "./types.ts";

export type { Brain, StepRequest, StepResult, SuggestRequest, SuggestionDraft } from "./types.ts";

/** Pick the brain: real Anthropic if a key is present, else the deterministic mock. */
export function makeBrain(): Brain {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    console.log("[brain] using AnthropicBrain");
    return new AnthropicBrain(key);
  }
  console.log("[brain] no ANTHROPIC_API_KEY — using MockBrain (deterministic demo)");
  return new MockBrain();
}
