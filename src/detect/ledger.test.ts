import { describe, expect, test } from "bun:test";
import { IdeaLedger, type LedgerConfig } from "./ledger";
import type { DetectedIdea, TranscriptTurn } from "./types";
import type { IdeaRubric } from "./rubric";

const turns: TranscriptTurn[] = [
  { id: "turn-0001", speaker: "a", text: "one", atMs: 0 },
  { id: "turn-0002", speaker: "a", text: "two", atMs: 1 },
  { id: "turn-0003", speaker: "a", text: "three", atMs: 2 },
];

function config(over: Partial<LedgerConfig> = {}): LedgerConfig {
  return { readyThreshold: 0.6, readyHysteresis: 0.12, maxMissedRounds: 2, maxSpans: 3, ...over };
}

function ledger(over: Partial<LedgerConfig> = {}): IdeaLedger {
  let n = 0;
  return new IdeaLedger(config(over), () => `idea-${++n}`);
}

function rubric(over: Partial<IdeaRubric> = {}): IdeaRubric {
  return { category: "proposal", concreteness: 2, buildableAsSoftware: 2, intent: 2, novelty: 2, ...over };
}

function judged(over: Partial<DetectedIdea> = {}, r: Partial<IdeaRubric> = {}): DetectedIdea {
  const ru = rubric(r);
  return {
    matchId: null,
    pitch: "Build the thing",
    confidence: 0, // ignored: ledger re-derives from the rubric
    questions: ["Q?"],
    answers: ["A"],
    contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0002", quote: "one two" },
    rationale: "",
    judgment: { rubric: ru, assessment: { confidence: 0, surfaceable: false, maturity: "forming", blockedBy: [] } },
    ...over,
  };
}

function bare(confidence: number, over: Partial<DetectedIdea> = {}): DetectedIdea {
  return {
    matchId: null,
    pitch: "Fake idea",
    confidence,
    questions: [],
    answers: [],
    contextSpan: { startTurnId: "turn-0001", endTurnId: "turn-0001", quote: "one" },
    rationale: "",
    ...over,
  };
}

describe("lifecycle", () => {
  test("a surfaceable judged idea is created ready+proposed with derived confidence", () => {
    const l = ledger();
    const d = l.reconcile([judged()], turns, 100);
    expect(d.created).toHaveLength(1);
    const c = d.created[0];
    expect(c.status).toBe("ready");
    expect(c.maturity).toBe("proposed");
    expect(c.confidence).toBeCloseTo(0.667, 2);
    expect(c.verified).toBe(false);
    expect(c.spans).toHaveLength(1);
  });

  test("persistence promotes to elaborated; commitment to actionable; evidence spans accumulate", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created;
    // round 2: same idea re-detected on a NEW span with commitment
    const d2 = l.reconcile(
      [judged({ matchId: c.id, contextSpan: { startTurnId: "turn-0003", endTurnId: "turn-0003", quote: "three" } }, { intent: 3 })],
      turns,
      200,
    );
    const u = d2.updated[0];
    expect(u.id).toBe(c.id);
    expect(u.spans).toHaveLength(2); // evidence trail grew
    expect(u.maturity).toBe("actionable"); // intent 3 + concreteness 2 (>= elaborated via ratchet too)
    expect(u.roundsSeen).toBe(2);
  });

  test("a stance drop (retraction → intent 1) un-surfaces immediately, beating hysteresis", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created;
    expect(c.status).toBe("ready");
    const d2 = l.reconcile([judged({ matchId: c.id }, { intent: 1 })], turns, 200);
    expect(d2.updated[0].status).toBe("forming"); // not held ready by hysteresis
    expect(d2.updated[0].maturity).toBe("forming");
  });

  test("judgment-less (bare) ideas keep hysteresis semantics: ready stays ready within the band", () => {
    const l = ledger();
    const [c] = l.reconcile([bare(0.85)], turns, 100).created;
    expect(c.status).toBe("ready");
    // dips to 0.55 (>= 0.6 - 0.12) → sticky ready
    const d2 = l.reconcile([bare(0.55, { matchId: c.id })], turns, 200);
    expect(d2.updated[0].status).toBe("ready");
    // dips to 0.40 → drops
    const d3 = l.reconcile([bare(0.4, { matchId: c.id })], turns, 300);
    expect(d3.updated[0].status).toBe("forming");
  });

  test("missed rounds age and supersede", () => {
    const l = ledger({ maxMissedRounds: 2 });
    l.reconcile([judged()], turns, 100);
    l.reconcile([], turns, 200);
    l.reconcile([], turns, 300);
    const d = l.reconcile([], turns, 400); // missedRounds 3 > 2 → superseded
    expect(d.superseded).toHaveLength(1);
    expect(l.candidates()).toHaveLength(0);
  });

  test("pitch-similarity matches a disjoint-span re-judgment (the retraction case)", () => {
    const l = ledger();
    const [c] = l.reconcile([judged({ pitch: "Membership app for laundromat cooperative with staking" })], turns, 100).created;
    expect(c.status).toBe("ready");
    // Later round: SAME pitch re-judged with intent 1, grounded ONLY to the
    // retraction turns (no span overlap), and matchId forgotten.
    const d2 = l.reconcile(
      [
        judged(
          { matchId: null, pitch: "Membership app for laundromat cooperative with staking", contextSpan: { startTurnId: "turn-0003", endTurnId: "turn-0003", quote: "three" } },
          { intent: 1 },
        ),
      ],
      // note: entry's span is turn-0001..0002; new span turn-0003 → zero overlap
      turns,
      200,
    );
    expect(d2.created).toHaveLength(0); // no duplicate entry
    expect(d2.updated).toHaveLength(1); // the SAME idea updated…
    expect(d2.updated[0].id).toBe(c.id);
    expect(d2.updated[0].status).toBe("forming"); // …and un-surfaced by the stance drop
  });

  test("dissimilar pitches with disjoint spans stay separate ideas", () => {
    const l = ledger();
    l.reconcile([judged({ pitch: "Membership staking app for the laundromat" })], turns, 100);
    const d2 = l.reconcile(
      [judged({ pitch: "Voice recipe scaler for cooking", contextSpan: { startTurnId: "turn-0003", endTurnId: "turn-0003", quote: "three" } })],
      turns,
      200,
    );
    expect(d2.created).toHaveLength(1); // genuinely new idea
    expect(l.candidates()).toHaveLength(2);
  });

  test("span-overlap matches when the judge forgets matchId", () => {
    const l = ledger();
    l.reconcile([judged()], turns, 100);
    const d2 = l.reconcile(
      [judged({ matchId: null, contextSpan: { startTurnId: "turn-0002", endTurnId: "turn-0003", quote: "two three" } })],
      turns,
      200,
    );
    expect(d2.created).toHaveLength(0);
    expect(d2.updated).toHaveLength(1);
  });
});

describe("verification + veto", () => {
  test("needingVerification lists ready+unverified; markVerified settles it", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created;
    expect(l.needingVerification().map((x) => x.id)).toEqual([c.id]);
    l.markVerified(c.id);
    expect(l.needingVerification()).toHaveLength(0);
    expect(l.find(c.id)?.verified).toBe(true);
  });

  test("veto demotes to forming and STAYS held on unchanged re-detection", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created;
    l.veto(c.id, "already exists as FooApp");
    expect(l.find(c.id)?.status).toBe("forming");
    expect(l.find(c.id)?.vetoReason).toBe("already exists as FooApp");
    // same-strength re-detection cannot resurface it
    const d2 = l.reconcile([judged({ matchId: c.id })], turns, 200);
    expect(d2.updated[0].status).toBe("forming");
    expect(d2.updated[0].vetoReason).toBe("already exists as FooApp");
    expect(l.needingVerification()).toHaveLength(0); // vetoed ≠ awaiting verification
  });

  test("the veto lifts when the idea returns materially stronger (re-verification runs)", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created; // conf ~0.667
    l.veto(c.id, "weak");
    // returns much stronger: 3/3/3/3 → conf 1.0 ≥ 0.667 + 0.15
    const d2 = l.reconcile(
      [judged({ matchId: c.id }, { concreteness: 3, buildableAsSoftware: 3, intent: 3, novelty: 3 })],
      turns,
      200,
    );
    expect(d2.updated[0].vetoReason).toBeNull();
    expect(d2.updated[0].status).toBe("ready");
    expect(l.needingVerification().map((x) => x.id)).toEqual([c.id]); // must re-verify
  });
});

describe("accept / clear", () => {
  test("accept removes and returns the entry; clear drops everything", () => {
    const l = ledger();
    const [c] = l.reconcile([judged()], turns, 100).created;
    const accepted = l.accept(c.id);
    expect(accepted?.id).toBe(c.id);
    expect(l.candidates()).toHaveLength(0);
    expect(l.accept("nope")).toBeNull();
    l.reconcile([judged()], turns, 200);
    l.clear();
    expect(l.candidates()).toHaveLength(0);
  });
});
