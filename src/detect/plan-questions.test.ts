import { describe, expect, test } from "bun:test";
import { MAX_PLAN_ANSWERS, MAX_PLAN_QUESTIONS, questionsFromAssessment } from "./plan-questions";

describe("questionsFromAssessment", () => {
  test("the deck contract: each question is {id, prompt, answers[]}", () => {
    const out = questionsFromAssessment({
      questions: ["Where does the usage data come from?"],
      answers: ["Stripe / Product analytics / CSV upload"],
    });
    expect(out).toHaveLength(1);
    const q = out[0];
    expect(Object.keys(q).sort()).toEqual(["answers", "id", "prompt"]);
    expect(q.prompt).toBe("Where does the usage data come from?");
    expect(q.answers).toEqual(["Stripe", "Product analytics", "CSV upload"]);
    expect(typeof q.id).toBe("string");
    expect(q.id.length).toBeGreaterThan(0);
  });

  test("current convention: parallel questions[i] ↔ '/'-joined answers[i]", () => {
    const out = questionsFromAssessment({
      questions: ["Stake with real money or points first?", "When does ownership vest?"],
      answers: ["Real money / Points", "Immediately / Over worked shifts"],
    });
    expect(out.map((q) => q.prompt)).toEqual(["Stake with real money or points first?", "When does ownership vest?"]);
    expect(out[0].answers).toEqual(["Real money", "Points"]);
    expect(out[1].answers).toEqual(["Immediately", "Over worked shifts"]);
  });

  test("legacy shape: one question whose options are separate answer entries", () => {
    const out = questionsFromAssessment({ questions: ["On-chain or points?"], answers: ["On-chain", "Points"] });
    expect(out).toHaveLength(1);
    expect(out[0].answers).toEqual(["On-chain", "Points"]);
  });

  test("heuristic-detector shape (2 questions, 2 single-option answers) survives", () => {
    const out = questionsFromAssessment({
      questions: ["Scope it as one task?", "Spawn an agent now?"],
      answers: ["Yes, scope it", "Yes, spawn it"],
    });
    expect(out).toHaveLength(2);
    expect(out[0].answers).toEqual(["Yes, scope it"]);
    expect(out[1].answers).toEqual(["Yes, spawn it"]);
  });

  test("tolerates mixed delimiters | ; and newlines", () => {
    const out = questionsFromAssessment({ questions: ["Pick one"], answers: ["Slack | Jira ; Notes\nEmail"] });
    expect(out[0].answers).toEqual(["Slack", "Jira", "Notes", "Email"]);
  });

  test("does NOT split option labels on commas", () => {
    const out = questionsFromAssessment({ questions: ["Which region?"], answers: ["US, then EU / Global day one"] });
    expect(out[0].answers).toEqual(["US, then EU", "Global day one"]);
  });

  test("empty / missing / non-array inputs yield []", () => {
    expect(questionsFromAssessment({ questions: [], answers: [] })).toEqual([]);
    expect(questionsFromAssessment({})).toEqual([]);
    expect(questionsFromAssessment(null)).toEqual([]);
    expect(questionsFromAssessment(undefined)).toEqual([]);
    // A gated span (questions: []) never fabricates questions even if answers leak.
    expect(questionsFromAssessment({ questions: [], answers: ["stray"] })).toEqual([]);
  });

  test("drops blank/whitespace questions and non-string junk", () => {
    const out = questionsFromAssessment({
      questions: ["  ", "Real fork?", 42 as unknown as string, ""],
      answers: ["A / B"],
    });
    expect(out).toHaveLength(1);
    expect(out[0].prompt).toBe("Real fork?");
    expect(out[0].answers).toEqual(["A", "B"]);
  });

  test("dedups repeated questions (case/punctuation-insensitive)", () => {
    const out = questionsFromAssessment({
      questions: ["Which data source?", "which data source??", "Which style?"],
      answers: ["Slack / Jira", "Slack / Jira", "Dark / Light"],
    });
    expect(out.map((q) => q.prompt)).toEqual(["Which data source?", "Which style?"]);
  });

  test("dedups repeated option labels within a question", () => {
    const out = questionsFromAssessment({ questions: ["Source?"], answers: ["Slack / slack / SLACK / Jira"] });
    expect(out[0].answers).toEqual(["Slack", "Jira"]);
  });

  test(`clamps to ${MAX_PLAN_QUESTIONS} questions and ${MAX_PLAN_ANSWERS} options`, () => {
    const out = questionsFromAssessment({
      questions: ["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"],
      answers: ["a / b / c / d / e", "a", "b", "c", "d"],
    });
    expect(out).toHaveLength(MAX_PLAN_QUESTIONS);
    expect(out[0].answers).toEqual(["a", "b", "c", "d"]);
    expect(out[0].answers.length).toBe(MAX_PLAN_ANSWERS);
  });

  test("clamps over-long prompts and option labels", () => {
    const longPrompt = "x".repeat(400);
    const longOption = "y".repeat(400);
    const out = questionsFromAssessment({ questions: [longPrompt], answers: [longOption] });
    expect(out[0].prompt.length).toBeLessThanOrEqual(120);
    expect(out[0].answers[0].length).toBeLessThanOrEqual(48);
  });

  test("ids are stable across calls and unique across distinct prompts", () => {
    const a = questionsFromAssessment({ questions: ["Where does data come from?"], answers: ["Slack / Jira"] });
    const b = questionsFromAssessment({ questions: ["Where does data come from?"], answers: ["Totally / Different"] });
    // Same prompt → same id regardless of the answer set (deck keys on the id).
    expect(a[0].id).toBe(b[0].id);
    const two = questionsFromAssessment({ questions: ["Data source?", "Visual style?"], answers: ["Slack / Jira", "Dark / Light"] });
    expect(two[0].id).not.toBe(two[1].id);
  });

  test("ids are slug-legible and collision-resistant for same-slug prompts", () => {
    const key = "which data source should the churn dashboard pull its recent usage signals from originally";
    const out = questionsFromAssessment({
      questions: [`${key} alpha`, `${key} beta`],
      answers: ["Stripe / Product", "CSV / API"],
    });
    expect(out[0].id).toStartWith("q-");
    // Slug prefixes collide (>32 chars shared) but the content hash disambiguates.
    expect(out[0].id).not.toBe(out[1].id);
  });

  test("question with no options is kept as an empty-answer entry (deck guards)", () => {
    const out = questionsFromAssessment({ questions: ["Open question?"], answers: [] });
    expect(out).toEqual([{ id: out[0].id, prompt: "Open question?", answers: [] }]);
  });
});
