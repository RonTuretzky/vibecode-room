import { describe, expect, test } from "bun:test";
import {
  buildImportPlanPrompt,
  cerebrasAdditionPlanner,
  inferAdditionMode,
  renderImportPlanPrompt,
  type AdditionPlanner,
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
