// The structured judgment behind "is this conversation an idea that could be
// built?". The old detector asked the model for a bare 0..1 confidence — an
// uncalibrated guess. Here the MODEL only fills an anchored rubric (things a
// language model is actually good at judging: what kind of talk is this, how
// concrete, is it software, does the room mean it, is it new) and CODE derives
// confidence / maturity / the surface decision deterministically. That makes the
// decision inspectable ("blocked: already-exists"), tunable (weights are
// constants, not prompt vibes), and testable without a model.

// ── what kind of talk is this span? ──────────────────────────────────────────
// Only "proposal" can become an idea. The others are the hard negatives the old
// prompt silently mishandled.
export const IDEA_CATEGORIES = [
  "proposal", // the room is suggesting something be created
  "existing-product", // discussing a product/tool that already exists
  "hypothetical", // joke, whimsy, thought experiment — not meant
  "logistics", // planning, scheduling, coordination of people
  "recap", // describing work already done / a thing already built
  "chatter", // everything else (weather, gossip, filler)
] as const;
export type IdeaCategory = (typeof IDEA_CATEGORIES)[number];

// ── anchored 0-3 dimensions ──────────────────────────────────────────────────
// Every level has a concrete anchor (mirrored verbatim in the judge prompt), so
// two judges — or the same judge on two days — score the same talk the same way.
//
// concreteness      0 vague theme ("something with AI")
//                   1 named concept ("an app for laundromat co-ops")
//                   2 described behavior (what it does / who uses it)
//                   3 specified (features, flows, data — could brief a builder)
//
// buildableAsSoftware
//                   0 not software (a treehouse, a law, a vibe)
//                   1 mostly physical/organizational with a software sliver
//                   2 core is realizable as software/automation
//                   3 squarely an app/tool/automation an agent could start NOW
//
// intent — the room's FINAL stance across the span (a floated-then-rejected idea
//          scores by the rejection, not the float). Sustained elaboration across
//          turns is REVEALED intent: developing mechanisms/details = genuine
//          interest (>=2) even when phrased softly; a one-liner nobody develops = 1.
//                   0 joke / sarcasm / clearly not meant
//                   1 idle musing ("someone should…")
//                   2 genuine interest (exploring it, "wouldn't this be great")
//                   3 commitment ("let's build it", asking for it to be made)
//
// novelty           0 it already exists and they know it
//                   1 minor variation on an existing product
//                   2 new combination of known parts
//                   3 distinctly new proposal
export interface IdeaRubric {
  category: IdeaCategory;
  concreteness: number;
  buildableAsSoftware: number;
  intent: number;
  novelty: number;
}

// ── derivation (the actual "understanding" policy) ───────────────────────────
// Hard gates first — some judgments zero the idea regardless of the other
// dimensions. Then a weighted blend. Weights are exported so evals can tune them.
export const RUBRIC_WEIGHTS = Object.freeze({
  concreteness: 0.35,
  buildableAsSoftware: 0.3,
  intent: 0.25,
  novelty: 0.1,
});

// Surface = show the bubble / feed the build loop. Requires the blend to clear
// the threshold AND the room to actually mean it (intent ≥ 2) AND at least a
// named concept (concreteness ≥ 1): a concrete idea nobody wants — or an
// enthusiastic contentless wish — is held as "forming", not popped at the room.
export const DEFAULT_SURFACE_THRESHOLD = 0.6;
export const MIN_SURFACE_INTENT = 2;
export const MIN_SURFACE_CONCRETENESS = 1;

export type IdeaMaturity = "forming" | "proposed" | "elaborated" | "actionable";

export interface IdeaAssessment {
  confidence: number; // derived 0..1 (0 when gated)
  surfaceable: boolean;
  maturity: IdeaMaturity; // rubric-level baseline; the ledger may ratchet it up
  blockedBy: string[]; // why it was gated / held (empty when surfaceable)
}

export function clampLevel(value: unknown, max = 3): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(max, Math.round(n)));
}

// Normalize a raw (possibly model-produced) rubric into valid ranges.
export interface RawRubric {
  category?: string;
  concreteness?: unknown;
  buildableAsSoftware?: unknown;
  intent?: unknown;
  novelty?: unknown;
}

export function normalizeRubric(raw: RawRubric): IdeaRubric {
  const rawCategory = (raw.category ?? "").trim().toLowerCase();
  const category = (IDEA_CATEGORIES as readonly string[]).includes(rawCategory)
    ? (rawCategory as IdeaCategory)
    : "chatter";
  return {
    category,
    concreteness: clampLevel(raw.concreteness),
    buildableAsSoftware: clampLevel(raw.buildableAsSoftware),
    intent: clampLevel(raw.intent),
    novelty: clampLevel(raw.novelty),
  };
}

export function deriveAssessment(rubric: IdeaRubric, surfaceThreshold = DEFAULT_SURFACE_THRESHOLD): IdeaAssessment {
  const blockedBy: string[] = [];

  // Hard gates: these zero the idea no matter how strong the other dimensions.
  if (rubric.category !== "proposal") {
    blockedBy.push(`category:${rubric.category}`);
  }
  if (rubric.buildableAsSoftware <= 1) {
    blockedBy.push("not-software");
  }
  if (rubric.intent === 0) {
    blockedBy.push("not-meant"); // joke / sarcasm
  }
  if (rubric.novelty === 0) {
    blockedBy.push("already-exists");
  }
  if (blockedBy.length > 0) {
    return { confidence: 0, surfaceable: false, maturity: "forming", blockedBy };
  }

  const confidence = round3(
    (RUBRIC_WEIGHTS.concreteness * rubric.concreteness) / 3 +
      (RUBRIC_WEIGHTS.buildableAsSoftware * rubric.buildableAsSoftware) / 3 +
      (RUBRIC_WEIGHTS.intent * rubric.intent) / 3 +
      (RUBRIC_WEIGHTS.novelty * rubric.novelty) / 3,
  );

  const held: string[] = [];
  if (confidence < surfaceThreshold) {
    held.push("below-threshold");
  }
  if (rubric.intent < MIN_SURFACE_INTENT) {
    held.push("intent-too-low");
  }
  if (rubric.concreteness < MIN_SURFACE_CONCRETENESS) {
    held.push("too-vague");
  }
  const surfaceable = held.length === 0;

  let maturity: IdeaMaturity = "forming";
  if (surfaceable) {
    maturity = rubric.intent >= 3 && rubric.concreteness >= 2 ? "actionable" : "proposed";
  }

  return { confidence, surfaceable, maturity, blockedBy: held };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
