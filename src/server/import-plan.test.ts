import { describe, expect, test } from "bun:test";
import {
  buildImportPlanPrompt,
  buildImportPlanQuestions,
  cerebrasAdditionPlanner,
  cerebrasQuestionPlanner,
  deterministicImportQuestions,
  inferAdditionMode,
  renderImportPlanPrompt,
  type AdditionPlanner,
  type ImportQuestionPlanner,
} from "./import-plan";

// A digest that looks like a real, substantial repo (the enriched repoDigest
// shape from repo-clone.ts).
const SUBSTANTIAL_DIGEST = [
  "This project appears to be: a React web front-end (Vite).",
  "Stack: React, Vite, TypeScript\nLanguages: TypeScript (12), CSS (3)\nEntrypoint: src/index.tsx",
  "Top-level files: README.md, index.html, package.json, src/, vite.config.ts",
  "package.json: my-app — a demo app",
  "Dependencies: react, react-dom, vite",
  "README excerpt:\nMy App\n…",
].join("\n\n");

describe("inferAdditionMode", () => {
  test("null / empty digest → scaffold", () => {
    expect(inferAdditionMode(null, null)).toBe("scaffold");
    expect(inferAdditionMode("", "add a leaderboard")).toBe("scaffold");
    expect(inferAdditionMode("   \n  ", null)).toBe("scaffold");
  });

  test("a substantial repo (real stack + deps) → additions", () => {
    expect(inferAdditionMode(SUBSTANTIAL_DIGEST, null)).toBe("additions");
    expect(inferAdditionMode(SUBSTANTIAL_DIGEST, "add dark mode")).toBe("additions");
  });

  test("a stack line alone is enough for additions", () => {
    const digest = "This project appears to be: a Go project.\n\nStack: Go\n\nTop-level files: go.mod, main.go";
    expect(inferAdditionMode(digest, null)).toBe("additions");
  });

  test("dependencies alone are enough for additions", () => {
    const digest = "Dependencies: express, pino";
    expect(inferAdditionMode(digest, null)).toBe("additions");
  });

  test("a docs-only repo (README + LICENSE, no code signals) → scaffold", () => {
    const digest = "This project appears to be: a software project.\n\nTop-level files: LICENSE, README.md\n\nREADME excerpt:\nIdeas go here.";
    expect(inferAdditionMode(digest, null)).toBe("scaffold");
    expect(inferAdditionMode(digest, "build the thing described")).toBe("scaffold");
  });

  test("a borderline repo (one weak signal) tips to additions only with a room steer", () => {
    // package.json line is a single weak signal (score 1).
    const digest = "This project appears to be: a Node.js/JavaScript project.\n\npackage.json: seed — placeholder";
    expect(inferAdditionMode(digest, null)).toBe("scaffold");
    expect(inferAdditionMode(digest, "wire up a REST endpoint")).toBe("additions");
  });

  test("a large top-level listing counts as a substance signal", () => {
    const digest =
      "Top-level files: a.txt, b.txt, c.txt, d.txt, e.txt, f.txt, g.txt, h.txt, i.txt\n\npackage.json: big — many files";
    expect(inferAdditionMode(digest, null)).toBe("additions");
  });
});

describe("renderImportPlanPrompt", () => {
  test("additions mode frames the build as extending, with repoPath + context", () => {
    const prompt = renderImportPlanPrompt(
      { context: "add a dark mode toggle", digest: SUBSTANTIAL_DIGEST, repoPath: "/builds/upid-1/repo" },
      "additions",
    );
    expect(prompt).toContain("ADDING to an existing software project");
    expect(prompt).toContain("/builds/upid-1/repo");
    expect(prompt).toContain("add a dark mode toggle");
    expect(prompt).toContain("SMALLEST coherent addition");
    expect(prompt).toContain(SUBSTANTIAL_DIGEST);
    expect(prompt).not.toContain("empty");
  });

  test("additions mode with no context asks the agent to infer the most valuable addition", () => {
    const prompt = renderImportPlanPrompt({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, "additions");
    expect(prompt).toContain("most valuable addition");
    expect(prompt).not.toContain("What the person who imported it asked for");
  });

  test("scaffold mode frames the build as a first slice", () => {
    const prompt = renderImportPlanPrompt({ context: "a snake game", digest: null, repoPath: "/r" }, "scaffold");
    expect(prompt).toContain("near-empty");
    expect(prompt).toContain("Scaffold the smallest coherent first slice");
    expect(prompt).toContain("a snake game");
    expect(prompt).toContain("No digest of the repository was available.");
  });

  test("a model suggestion is embedded but marked as verify-first", () => {
    const prompt = renderImportPlanPrompt(
      { context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      "additions",
      "Add a keyboard-shortcut help overlay",
    );
    expect(prompt).toContain("Add a keyboard-shortcut help overlay");
    expect(prompt).toContain("verify it against the actual code");
  });
});

describe("buildImportPlanPrompt", () => {
  test("with no planner suggestion, returns the deterministic additions prompt", async () => {
    const planner: AdditionPlanner = async () => null;
    const prompt = await buildImportPlanPrompt(
      { context: "add search", digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner },
    );
    expect(prompt).toContain("ADDING to an existing software project");
    expect(prompt).toContain("add search");
  });

  test("embeds a planner suggestion when one is produced", async () => {
    const seenModes: string[] = [];
    const planner: AdditionPlanner = async (request) => {
      seenModes.push(request.mode);
      return "  Add an undo button   with a shortcut  ";
    };
    const prompt = await buildImportPlanPrompt({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
    expect(seenModes).toEqual(["additions"]);
    // Whitespace is collapsed by cleanSuggestion.
    expect(prompt).toContain("Add an undo button with a shortcut");
  });

  test("a throwing planner falls back to the deterministic prompt (never throws)", async () => {
    const planner: AdditionPlanner = async () => {
      throw new Error("cerebras exploded");
    };
    const prompt = await buildImportPlanPrompt({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
    expect(prompt).toContain("ADDING to an existing software project");
    expect(prompt).not.toContain("cerebras exploded");
  });

  test("a hanging planner loses to the timeout budget and yields the deterministic prompt", async () => {
    const planner: AdditionPlanner = () => new Promise<string | null>(() => {}); // never resolves
    const prompt = await buildImportPlanPrompt(
      { context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner, timeoutMs: 10 },
    );
    expect(prompt).toContain("ADDING to an existing software project");
  });

  test("an already-aborted signal skips the planner entirely", async () => {
    let called = false;
    const planner: AdditionPlanner = async () => {
      called = true;
      return "should not appear";
    };
    const controller = new AbortController();
    controller.abort();
    const prompt = await buildImportPlanPrompt(
      { context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner, signal: controller.signal },
    );
    expect(called).toBe(false);
    expect(prompt).not.toContain("should not appear");
    expect(prompt).toContain("ADDING to an existing software project");
  });

  test("empty repo digest yields a scaffold prompt", async () => {
    const planner: AdditionPlanner = async () => null;
    const prompt = await buildImportPlanPrompt({ context: "a todo app", digest: null, repoPath: "/r" }, { planner });
    expect(prompt).toContain("near-empty");
    expect(prompt).toContain("a todo app");
  });
});

describe("deterministicImportQuestions", () => {
  test("both modes yield 3 deck-shaped questions with 2-4 options and stable ids", () => {
    for (const mode of ["additions", "scaffold"] as const) {
      const questions = deterministicImportQuestions(mode, null);
      expect(questions).toHaveLength(3);
      for (const question of questions) {
        expect(question.id).toMatch(/^q-/u);
        expect(question.prompt.length).toBeGreaterThan(0);
        expect(question.answers.length).toBeGreaterThanOrEqual(2);
        expect(question.answers.length).toBeLessThanOrEqual(4);
      }
    }
    // The sets actually vary with mode — an import deck should not read the
    // same for "extend this real repo" and "start from nothing".
    const additions = deterministicImportQuestions("additions", null).map((question) => question.prompt);
    const scaffold = deterministicImportQuestions("scaffold", null).map((question) => question.prompt);
    expect(additions).not.toEqual(scaffold);
    expect(additions[0]).toBe("How bold should the first addition be?");
    expect(scaffold[0]).toBe("What should the first slice prove?");
  });

  test("a room steer swaps in the follow-the-request question", () => {
    const steered = deterministicImportQuestions("additions", "add a dark mode toggle");
    expect(steered.map((question) => question.prompt)).toContain("How closely should we follow the request?");
    const unsteered = deterministicImportQuestions("additions", "   ");
    expect(unsteered.map((question) => question.prompt)).not.toContain("How closely should we follow the request?");
  });
});

describe("buildImportPlanQuestions", () => {
  test("a null-returning planner falls back to the deterministic set for the inferred mode (never empty)", async () => {
    const seenModes: string[] = [];
    const planner: ImportQuestionPlanner = async (request) => {
      seenModes.push(request.mode);
      return null;
    };
    const additions = await buildImportPlanQuestions(
      { context: "add search", digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner },
    );
    expect(additions).toEqual(deterministicImportQuestions("additions", "add search"));
    const scaffold = await buildImportPlanQuestions({ context: null, digest: null, repoPath: "/r" }, { planner });
    expect(scaffold).toEqual(deterministicImportQuestions("scaffold", null));
    expect(seenModes).toEqual(["additions", "scaffold"]);
  });

  test("strict-JSON planner output becomes deck questions with the judge path's id/clamp conventions", async () => {
    const planner: ImportQuestionPlanner = async () =>
      JSON.stringify([
        { prompt: "Which chart library?", answers: ["Recharts", "D3"] },
        { prompt: "Ship dark mode first?", answers: ["Yes", "Later"] },
      ]);
    const questions = await buildImportPlanQuestions({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
    expect(questions.map((question) => question.prompt)).toEqual(["Which chart library?", "Ship dark mode first?"]);
    expect(questions[0]?.answers).toEqual(["Recharts", "D3"]);
    expect(questions[0]?.id).toMatch(/^q-which-chart-library/u);
  });

  test("tolerant parse: fenced JSON with prose, a questions wrapper, and drifting key names still land", async () => {
    const planner: ImportQuestionPlanner = async () =>
      'Here you go!\n```json\n{"questions": [{"question": "Which store?", "options": ["SQLite", "A JSON file"]}]}\n```\nEnjoy.';
    const questions = await buildImportPlanQuestions({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
    expect(questions).toHaveLength(1);
    expect(questions[0]?.prompt).toBe("Which store?");
    expect(questions[0]?.answers).toEqual(["SQLite", "A JSON file"]);
  });

  test("model drift is clamped: extra questions/options trimmed, one-option questions dropped, long text cut", async () => {
    const longPrompt = `Should we ${"really ".repeat(40)}do it?`;
    const planner: ImportQuestionPlanner = async () => [
      { prompt: "Only one option", answers: ["Take it or leave it"] }, // not a decision — dropped
      { prompt: longPrompt, answers: ["Yes", "No", "Maybe", "Later", "Never"] },
      { prompt: "Second?", answers: ["A", "B"] },
      { prompt: "Third?", answers: ["C", "D"] },
      { prompt: "Fourth never fits", answers: ["E", "F"] },
    ];
    const questions = await buildImportPlanQuestions({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
    expect(questions).toHaveLength(3); // MAX_PLAN_QUESTIONS
    expect(questions[0]?.prompt.length).toBeLessThanOrEqual(120);
    expect(questions[0]?.answers).toEqual(["Yes", "No", "Maybe", "Later"]); // MAX_PLAN_ANSWERS
    expect(questions.map((question) => question.prompt)).not.toContain("Only one option");
    expect(questions.map((question) => question.prompt)).not.toContain("Fourth never fits");
  });

  test("garbage output and a throwing planner both fall back deterministically (never throws, never empty)", async () => {
    const garbage: ImportQuestionPlanner = async () => "no json in here at all";
    const throwing: ImportQuestionPlanner = async () => {
      throw new Error("cerebras exploded");
    };
    for (const planner of [garbage, throwing]) {
      const questions = await buildImportPlanQuestions({ context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" }, { planner });
      expect(questions).toEqual(deterministicImportQuestions("additions", null));
    }
  });

  test("a hanging planner loses to the timeout budget and yields the deterministic set", async () => {
    const planner: ImportQuestionPlanner = () => new Promise<never>(() => {}); // never resolves
    const questions = await buildImportPlanQuestions(
      { context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner, timeoutMs: 10 },
    );
    expect(questions).toEqual(deterministicImportQuestions("additions", null));
  });

  test("an already-aborted signal skips the planner entirely", async () => {
    let called = false;
    const planner: ImportQuestionPlanner = async () => {
      called = true;
      return [{ prompt: "Should not appear", answers: ["A", "B"] }];
    };
    const controller = new AbortController();
    controller.abort();
    const questions = await buildImportPlanQuestions(
      { context: null, digest: SUBSTANTIAL_DIGEST, repoPath: "/r" },
      { planner, signal: controller.signal },
    );
    expect(called).toBe(false);
    expect(questions).toEqual(deterministicImportQuestions("additions", null));
  });
});

describe("cerebrasQuestionPlanner", () => {
  test("returns null with no CEREBRAS_API_KEY (deterministic, no network)", async () => {
    const previous = process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    try {
      const result = await cerebrasQuestionPlanner(
        { context: null, digest: SUBSTANTIAL_DIGEST, mode: "additions" },
        new AbortController().signal,
      );
      expect(result).toBe(null);
    } finally {
      if (previous !== undefined) {
        process.env.CEREBRAS_API_KEY = previous;
      }
    }
  });
});

describe("cerebrasAdditionPlanner", () => {
  test("returns null with no CEREBRAS_API_KEY (deterministic, no network)", async () => {
    const previous = process.env.CEREBRAS_API_KEY;
    delete process.env.CEREBRAS_API_KEY;
    try {
      const result = await cerebrasAdditionPlanner(
        { context: null, digest: SUBSTANTIAL_DIGEST, mode: "additions" },
        new AbortController().signal,
      );
      expect(result).toBe(null);
    } finally {
      if (previous !== undefined) {
        process.env.CEREBRAS_API_KEY = previous;
      }
    }
  });
});
