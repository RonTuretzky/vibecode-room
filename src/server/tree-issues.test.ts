import { describe, expect, test } from "bun:test";
import type { ForestCommandRunner } from "./github-org";
import { ownerRepoFromOrigin, TreeIssuesCache, TREE_ISSUES_CACHE_MS } from "./tree-issues";

// The issues cache over a scripted gh runner — no test ever spawns real gh.

function scriptedGh(stdout: string, ok = true): { calls: string[][]; run: ForestCommandRunner } {
  const calls: string[][] = [];
  const run: ForestCommandRunner = async (argv) => {
    calls.push(argv);
    return { ok, stdout, stderr: ok ? "" : "gh exploded" };
  };
  return { calls, run };
}

const ISSUES_JSON = JSON.stringify([
  { number: 7, title: "Fix the welcome banner", labels: [{ name: "bug" }, { name: "good first issue" }] },
  { number: 12, title: "Dark mode", labels: [] },
  // A PR rides the issues endpoint too — it must be dropped.
  { number: 13, title: "PR: dark mode", labels: [], pull_request: { url: "x" } },
  // Malformed entries never leak into the contract shape.
  { number: "not-a-number", title: "bad" },
  { title: "no number" },
]);

describe("TreeIssuesCache", () => {
  test("fetches the origin's open issues in the exact contract shape", async () => {
    const gh = scriptedGh(ISSUES_JSON);
    const cache = new TreeIssuesCache({ runGh: gh.run, now: () => 0 });
    const issues = await cache.issuesFor("upid-1", "https://github.com/acme/widget");

    expect(issues).toEqual([
      { number: 7, title: "Fix the welcome banner", labels: ["bug", "good first issue"] },
      { number: 12, title: "Dark mode", labels: [] },
    ]);
    expect(gh.calls).toEqual([["gh", "api", "repos/acme/widget/issues?state=open&per_page=10"]]);
  });

  test("caches per upid for 60s, then refetches", async () => {
    let nowMs = 0;
    const gh = scriptedGh(ISSUES_JSON);
    const cache = new TreeIssuesCache({ runGh: gh.run, now: () => nowMs });
    const origin = "https://github.com/acme/widget";

    await cache.issuesFor("upid-1", origin);
    nowMs = TREE_ISSUES_CACHE_MS - 1;
    await cache.issuesFor("upid-1", origin);
    expect(gh.calls).toHaveLength(1); // within the window — served from cache

    // A DIFFERENT upid is its own cache line.
    await cache.issuesFor("upid-2", origin);
    expect(gh.calls).toHaveLength(2);

    nowMs = TREE_ISSUES_CACHE_MS;
    await cache.issuesFor("upid-1", origin);
    expect(gh.calls).toHaveLength(3); // window elapsed — refetched
  });

  test("gh failure / non-JSON / non-array all degrade to [] (never a throw)", async () => {
    const failed = new TreeIssuesCache({ runGh: scriptedGh("", false).run, now: () => 0 });
    expect(await failed.issuesFor("upid-1", "https://github.com/acme/widget")).toEqual([]);

    const garbage = new TreeIssuesCache({ runGh: scriptedGh("gh: not logged in").run, now: () => 0 });
    expect(await garbage.issuesFor("upid-1", "https://github.com/acme/widget")).toEqual([]);

    const object = new TreeIssuesCache({ runGh: scriptedGh('{"message":"Not Found"}').run, now: () => 0 });
    expect(await object.issuesFor("upid-1", "https://github.com/acme/widget")).toEqual([]);
  });

  test("a null or unparseable origin short-circuits without calling gh", async () => {
    const gh = scriptedGh(ISSUES_JSON);
    const cache = new TreeIssuesCache({ runGh: gh.run, now: () => 0 });
    expect(await cache.issuesFor("upid-1", null)).toEqual([]);
    expect(await cache.issuesFor("upid-1", "not a url")).toEqual([]);
    expect(gh.calls).toHaveLength(0);
  });
});

describe("ownerRepoFromOrigin", () => {
  test("parses github origins, dropping any .git suffix", () => {
    expect(ownerRepoFromOrigin("https://github.com/acme/widget")).toBe("acme/widget");
    expect(ownerRepoFromOrigin("https://github.com/acme/widget.git")).toBe("acme/widget");
    expect(ownerRepoFromOrigin("https://gitlab.com/acme/widget")).toBeNull();
  });
});
