// The labeled conversation corpus for idea detection. Each case is a small
// conversation plus the EXPECTED surface decision (should an idea bubble pop?),
// with hard negatives the old detector had no defense against: existing
// products, jokes, logistics, hardware-only ideas, recaps, and retractions.
//
// Used two ways:
//  • corpus.test.ts (CI) — validates shape and the deterministic scaffolding.
//  • run-live.ts (`bun run eval:detect`) — runs every case through the REAL
//    rubric judge and reports precision/recall/F1 on the surface decision.

export interface CorpusTurn {
  speaker: string;
  text: string;
}

export interface CorpusCase {
  id: string;
  kind: "positive" | "negative";
  description: string;
  turns: CorpusTurn[];
  // For positives: fragments the detected pitch/quote should relate to (any match
  // counts — model phrasing varies).
  pitchHints?: string[];
}

export const CORPUS: CorpusCase[] = [
  // ── positives ────────────────────────────────────────────────────────────────
  {
    id: "laundromat-coop",
    kind: "positive",
    description: "the canonical multi-turn buildable idea",
    turns: [
      { speaker: "ron", text: "so i have this idea for a crypto laundromat cooperative" },
      { speaker: "ron", text: "where all the consumers get revenue share and it can actually work" },
      { speaker: "ron", text: "you stake collateral at the laundromat and then do a shift doing the work" },
      { speaker: "ron", text: "and you can buy liquid ownership in the laundromat network, wouldn't that be lovely" },
    ],
    pitchHints: ["laundromat", "co-op", "cooperative", "staking", "ownership"],
  },
  {
    id: "implicit-blocker-tool",
    kind: "positive",
    description: "implicit idea — never says app/build",
    turns: [
      { speaker: "amy", text: "the standup notes keep losing people's blockers, it happened again today" },
      { speaker: "bo", text: "we could honestly wrap those into one thing that pings whoever is blocking" },
      { speaker: "amy", text: "yes! and it should escalate if nobody responds by lunch" },
    ],
    pitchHints: ["blocker", "standup", "nag", "ping", "escalate"],
  },
  {
    id: "committed-forming-idea",
    kind: "positive",
    description: "idea forms across speakers and the room commits",
    turns: [
      { speaker: "amy", text: "what if the projector showed every agent as a little creature" },
      { speaker: "bo", text: "and their mood is the build status, red when tests fail" },
      { speaker: "amy", text: "ok let's actually make that this afternoon, it's perfect for the demo" },
    ],
    pitchHints: ["creature", "agent", "mood", "build status", "projector"],
  },
  {
    id: "voice-recipe-scaler",
    kind: "positive",
    description: "clear single-speaker tool proposal with behavior described",
    turns: [
      { speaker: "kai", text: "i keep messing up doubling recipes while my hands are covered in flour" },
      { speaker: "kai", text: "i want a voice thing where i say scale this to six people and it just reads the steps back adjusted" },
    ],
    pitchHints: ["recipe", "voice", "scale", "cooking"],
  },
  {
    id: "genuine-interest-not-committed",
    kind: "positive",
    description: "genuine interest without explicit commitment still surfaces",
    turns: [
      { speaker: "amy", text: "a dashboard that shows which of our preview servers are actually getting clicked would be so useful" },
      { speaker: "bo", text: "oh that would settle the which-demo-do-people-like argument for good" },
    ],
    pitchHints: ["dashboard", "preview", "click", "usage"],
  },

  // ── negatives ────────────────────────────────────────────────────────────────
  {
    id: "existing-product-review",
    kind: "negative",
    description: "reviewing a product that already exists",
    turns: [
      { speaker: "amy", text: "have you tried the new Linear asks feature" },
      { speaker: "bo", text: "yeah we use it for the support rotation, it's honestly great" },
      { speaker: "amy", text: "way better than the spreadsheet we had" },
    ],
  },
  {
    id: "joke-startup",
    kind: "negative",
    description: "a joke with startup framing — laughter, not intent",
    turns: [
      { speaker: "amy", text: "we should build an app that texts your ex at 2am hahaha" },
      { speaker: "bo", text: "lmaooo yes, series A by friday" },
      { speaker: "amy", text: "unicorn by monday" },
    ],
  },
  {
    id: "logistics-planning",
    kind: "negative",
    description: "pure coordination talk",
    turns: [
      { speaker: "amy", text: "ok so thursday we set up the projectors and cameras in the big room" },
      { speaker: "bo", text: "i'll bring the hdmi cables and book catering for twelve" },
      { speaker: "amy", text: "and let's do a dry run at four" },
    ],
  },
  {
    id: "hardware-treehouse",
    kind: "negative",
    description: "a genuine committed idea — but not software",
    turns: [
      { speaker: "kai", text: "i want to build a treehouse with my kid this summer" },
      { speaker: "kai", text: "cedar planks, rope bridge, the whole thing. we're starting saturday" },
    ],
  },
  {
    id: "recap-of-built-work",
    kind: "negative",
    description: "describing something already built (a recap, not a proposal)",
    turns: [
      { speaker: "amy", text: "so yesterday i shipped the gesture overlay, dwell to click works on both walls now" },
      { speaker: "bo", text: "nice, the demo yesterday looked smooth" },
    ],
  },
  {
    id: "retracted-idea",
    kind: "negative",
    description: "idea floated then explicitly withdrawn — final stance wins",
    turns: [
      { speaker: "amy", text: "what about an app that rates your sandwich by vibes" },
      { speaker: "bo", text: "hmm" },
      { speaker: "amy", text: "nah forget it, that's dumb, ignore me" },
    ],
  },
  {
    id: "weather-chatter",
    kind: "negative",
    description: "pure ambient chatter",
    turns: [
      { speaker: "amy", text: "the weather has been unreal this week" },
      { speaker: "bo", text: "i know, i finally took the bike out yesterday" },
      { speaker: "amy", text: "we should get lunch outside later" },
    ],
  },
  {
    id: "vague-wish",
    kind: "negative",
    description: "a vague wish with no concept — too formless to surface",
    turns: [
      { speaker: "amy", text: "ugh, someone should really do something with all this AI stuff" },
      { speaker: "bo", text: "yeah, for sure, something" },
    ],
  },
];

export function corpusCase(id: string): CorpusCase {
  const found = CORPUS.find((c) => c.id === id);
  if (found === undefined) {
    throw new Error(`No corpus case: ${id}`);
  }
  return found;
}
