// STEERING AN EXISTING BRANCH: every way the graft can be refused, and the one
// way it succeeds. The refusals are the point — a graft that cannot reach the
// branch it was asked for must land NOWHERE, because the alternative (growing
// the change on whatever branch happens to be checked out) is invisible until
// someone reads the log.
import { describe, expect, test } from "bun:test";

import { dirtySourcePaths, graftOntoBranch, porcelainPath, type GraftGitRunner } from "./self-graft";

function scriptedGit(setup: { current: string; branches: string[]; dirty?: string[]; checkoutFails?: string }): {
  calls: string[][];
  state: { current: string };
  run: GraftGitRunner;
} {
  const calls: string[][] = [];
  const state = { current: setup.current };
  const branches = new Set(setup.branches);
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr: string) => ({ ok: false, stdout: "", stderr });
  const run: GraftGitRunner = async (argv) => {
    calls.push(argv);
    if (argv[0] === "branch" && argv[1] === "--show-current") {
      return ok(state.current);
    }
    if (argv[0] === "rev-parse") {
      const name = (argv[argv.length - 1] ?? "").replace(/^refs\/heads\//u, "");
      return branches.has(name) ? ok("deadbeef") : fail("");
    }
    if (argv[0] === "status") {
      return ok((setup.dirty ?? []).map((path) => ` M ${path}`).join("\n"));
    }
    if (argv[0] === "checkout") {
      if (setup.checkoutFails !== undefined) {
        return fail(setup.checkoutFails);
      }
      state.current = argv[1] ?? state.current;
      return ok();
    }
    return ok();
  };
  return { calls, state, run };
}

describe("graftOntoBranch", () => {
  test("climbs onto an existing branch so the change grows THERE", async () => {
    const git = scriptedGit({ current: "room/here", branches: ["room/here", "room/older"] });
    expect(await graftOntoBranch(git.run, "room/older")).toEqual({ ok: true, branch: "room/older" });
    expect(git.state.current).toBe("room/older");
    // Never a sibling: the old behavior cut a fresh rail off the current branch.
    expect(git.calls.some((argv) => argv[0] === "checkout" && argv[1] === "-b")).toBe(false);
  });

  test("already standing there is a no-op success — no checkout at all", async () => {
    const git = scriptedGit({ current: "room/here", branches: ["room/here"] });
    expect(await graftOntoBranch(git.run, "room/here")).toEqual({ ok: true, branch: "room/here" });
    expect(git.calls.some((argv) => argv[0] === "checkout")).toBe(false);
  });

  test("a branch pruned between arming and speaking refuses, and says so", async () => {
    const git = scriptedGit({ current: "room/here", branches: ["room/here"] });
    const result = await graftOntoBranch(git.run, "room/gone");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("room/gone");
    expect(result.ok === false && result.error).toContain("pruned");
    expect(git.state.current).toBe("room/here"); // nowhere else
  });

  test("uncommitted src/ work refuses rather than dragging it onto another branch", async () => {
    const git = scriptedGit({
      current: "room/here",
      branches: ["room/here", "room/older"],
      dirty: ["src/ui/App.tsx", "src/ui/mic.ts"],
    });
    const result = await graftOntoBranch(git.run, "room/older");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("src/ui/App.tsx");
    expect(result.ok === false && result.error).toContain("+1");
    expect(git.state.current).toBe("room/here");
  });

  test("dirt OUTSIDE src/ is not the room's business", async () => {
    const git = scriptedGit({
      current: "room/here",
      branches: ["room/here", "room/older"],
      dirty: ["artifacts/smithering/x.json"],
    });
    expect(await graftOntoBranch(git.run, "room/older")).toEqual({ ok: true, branch: "room/older" });
  });

  test("unsafe names never reach git", async () => {
    for (const name of ["../../etc/passwd", "room/../main", "-rf", ""]) {
      const git = scriptedGit({ current: "room/here", branches: ["room/here"] });
      const result = await graftOntoBranch(git.run, name);
      expect(result).toEqual({ ok: false, error: "unsafe branch name" });
      expect(git.calls).toEqual([]);
    }
  });

  test("git's own refusal surfaces verbatim (sliced), never as success", async () => {
    const git = scriptedGit({
      current: "room/here",
      branches: ["room/here", "room/older"],
      checkoutFails: "error: Your local changes would be overwritten",
    });
    const result = await graftOntoBranch(git.run, "room/older");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("would be overwritten");
  });
});

describe("porcelainPath — the status parse the dirty guards depend on", () => {
  test("THE BUG: a trimmed blob loses the first line's status column", () => {
    // git prints " M src/ui/App.tsx"; callers trim the whole blob, so the
    // first line arrives as "M src/ui/App.tsx". slice(3) returned
    // "rc/ui/App.tsx" — which fails a src/ test, so the first modified file
    // was invisible and a single unstaged edit passed every dirty check.
    expect(porcelainPath("M src/ui/App.tsx")).toBe("src/ui/App.tsx");
    expect(porcelainPath(" M src/ui/App.tsx")).toBe("src/ui/App.tsx");
  });

  test("every status pair parses", () => {
    expect(porcelainPath("?? src/new.ts")).toBe("src/new.ts");
    expect(porcelainPath("MM src/both.ts")).toBe("src/both.ts");
    expect(porcelainPath("A  src/added.ts")).toBe("src/added.ts");
    expect(porcelainPath("")).toBe("");
  });

  test("dirtySourcePaths finds the first file, not just the rest", () => {
    const blob = "M src/ui/App.tsx\n M src/ui/mic.ts\n?? artifacts/x.json";
    expect(dirtySourcePaths(blob)).toEqual(["src/ui/App.tsx", "src/ui/mic.ts"]);
  });

  test("a clean tree is empty", () => {
    expect(dirtySourcePaths("")).toEqual([]);
  });
});
