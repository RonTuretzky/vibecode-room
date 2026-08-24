import { describe, expect, test } from "bun:test";

import { buildProjectBrief } from "./project-brief";

const NOW = 1_700_000_000_000;

const DIGEST = [
  "Appears to be a Vite + React single-page app with a small Express API.",
  "Stack: typescript, react, vite, express",
  "Entrypoint: src/main.tsx",
  "Top level: src/, server/, package.json, README.md",
  "README",
  "Widget is a dashboard for tracking greenhouse sensors.",
  "It talks to an MQTT broker and stores readings in SQLite.",
].join("\n");

describe("buildProjectBrief", () => {
  test("keeps the digest's hedge — an inference is never upgraded to a statement", () => {
    const brief = buildProjectBrief(
      { repo: "acme/widget", url: "https://github.com/acme/widget", digest: DIGEST, cloneError: null, context: null },
      NOW,
    );
    expect(brief.summary).toContain("Appears to be");
    expect(brief.unavailable).toBeNull();
  });

  test("pulls the stack facts out, without repeating the summary", () => {
    const brief = buildProjectBrief(
      { repo: "acme/widget", url: "https://github.com/acme/widget", digest: DIGEST, cloneError: null, context: null },
      NOW,
    );
    expect(brief.facts.some((fact) => fact.startsWith("Stack:"))).toBe(true);
    expect(brief.facts).not.toContain(brief.summary);
  });

  test("the README's opening prose becomes the readable excerpt", () => {
    const brief = buildProjectBrief(
      { repo: "acme/widget", url: "https://github.com/acme/widget", digest: DIGEST, cloneError: null, context: null },
      NOW,
    );
    expect(brief.readme).toContain("greenhouse sensors");
  });

  test("the ask is kept verbatim — the room shows the instruction it is working from", () => {
    const brief = buildProjectBrief(
      {
        repo: "acme/widget",
        url: "https://github.com/acme/widget",
        digest: DIGEST,
        cloneError: null,
        context: "  just study it first  ",
      },
      NOW,
    );
    expect(brief.ask).toBe("just study it first");
  });

  test("A FAILED CLONE says so instead of rendering an empty card", () => {
    const brief = buildProjectBrief(
      {
        repo: "acme/private",
        url: "https://github.com/acme/private",
        digest: null,
        cloneError: "authentication failed",
        context: null,
      },
      NOW,
    );
    expect(brief.unavailable).toContain("authentication failed");
    expect(brief.summary).toBeNull();
    expect(brief.facts).toEqual([]);
  });

  test("no checkout and no error is still stated, never blank", () => {
    const brief = buildProjectBrief(
      { repo: "acme/widget", url: "https://github.com/acme/widget", digest: null, cloneError: null, context: null },
      NOW,
    );
    expect(brief.unavailable).toContain("no checkout");
  });

  test("a digest with nothing recognizable yields nulls, not invented content", () => {
    const brief = buildProjectBrief(
      { repo: "a/b", url: "https://github.com/a/b", digest: "hello", cloneError: null, context: null },
      NOW,
    );
    expect(brief.summary).toBeNull();
    expect(brief.facts).toEqual([]);
    expect(brief.unavailable).toBeNull();
  });
});
