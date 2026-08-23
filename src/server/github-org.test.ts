import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ForestLoader,
  ciFromStatusCheckRollup,
  linkStackedPrs,
  normalizeOrgName,
  type ForestCommandResult,
  type ForestCommandRunner,
  type ForestPayload,
  type ForestPr,
} from "./github-org";

// ForestLoader over SCRIPTED gh outputs: parse shape, stacked detection, the
// disk-cache stale fallback, and the clock-gated 5-minute refresh. No test
// ever spawns a real `gh` (constructor-injected runner) or arms a real timer
// (intervalMs: null).

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-forest-"));
  tempDirs.push(dir);
  return dir;
}

// Scripted runner: exact argv (joined) → stdout JSON; unknown listings answer
// an empty array so cap tests can fan out without scripting every repo.
function scriptedRunner(script: Record<string, string>): { run: ForestCommandRunner; calls: string[] } {
  const calls: string[] = [];
  const run: ForestCommandRunner = async (argv) => {
    const key = argv.join(" ");
    calls.push(key);
    const stdout = script[key];
    return { ok: true, stdout: stdout ?? "[]", stderr: "" };
  };
  return { run, calls };
}

const failingRunner: ForestCommandRunner = async () => ({ ok: false, stdout: "", stderr: "gh: network is down" });

const REPO_LIST_KEY = "gh repo list acme --limit 30 --json name,pushedAt";
const prListKey = (repo: string) =>
  `gh pr list -R acme/${repo} --state open --limit 40 --json number,title,isDraft,statusCheckRollup,baseRefName,headRefName`;
const issueListKey = (repo: string) => `gh issue list -R acme/${repo} --state open --limit 40 --json number,title,labels`;

const WIDGET_PRS = JSON.stringify([
  {
    number: 12,
    title: "Add the grove renderer",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/grove",
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  },
  {
    number: 13,
    title: "Polish grove lighting",
    isDraft: true,
    baseRefName: "feat/grove",
    headRefName: "feat/grove-polish",
    statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }],
  },
  {
    number: 14,
    title: "Fix flaky test",
    isDraft: false,
    baseRefName: "main",
    headRefName: "fix/flaky",
    statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }],
  },
  { number: 15, title: "No checks here", isDraft: false, baseRefName: "main", headRefName: "chore/no-ci", statusCheckRollup: null },
]);

const WIDGET_ISSUES = JSON.stringify([
  { number: 3, title: "Crash on load", labels: [{ name: "bug", color: "d73a4a" }, { name: "p1", color: "ffffff" }] },
  { number: 4, title: "Needs docs", labels: [] },
]);

function acmeScript(): Record<string, string> {
  return {
    [REPO_LIST_KEY]: JSON.stringify([
      { name: "older", pushedAt: "2026-07-01T00:00:00Z" },
      { name: "widget", pushedAt: "2026-08-08T12:00:00Z" },
    ]),
    [prListKey("widget")]: WIDGET_PRS,
    [issueListKey("widget")]: WIDGET_ISSUES,
  };
}

describe("ForestLoader — parse", () => {
  test("load(org) assembles the payload: repos sorted most-recently-pushed, PRs with draft/ci/refs, issue label names", async () => {
    const { run } = scriptedRunner(acmeScript());
    const loader = new ForestLoader({ run, now: () => Date.parse("2026-08-09T00:00:00Z"), cacheDir: tempCacheDir(), intervalMs: null });
    await loader.load("acme");

    const state = loader.current() as ForestPayload;
    expect(state.org).toBe("acme");
    expect(state.fetchedAtMs).toBe(Date.parse("2026-08-09T00:00:00Z"));
    expect(state.repos.map((repo) => repo.name)).toEqual(["widget", "older"]);
    expect(state.repos[0].pushedAtMs).toBe(Date.parse("2026-08-08T12:00:00Z"));

    const prs = state.repos[0].prs;
    expect(prs.map((pr) => [pr.number, pr.draft, pr.ci])).toEqual([
      [12, false, "pass"],
      [13, true, "pending"],
      [14, false, "fail"],
      [15, false, "none"],
    ]);
    expect(prs[0].baseRef).toBe("main");
    expect(prs[0].headRef).toBe("feat/grove");
    expect(state.repos[0].issues).toEqual([
      { number: 3, title: "Crash on load", labels: ["bug", "p1"] },
      { number: 4, title: "Needs docs", labels: [] },
    ]);
    // The un-scripted repo degrades to empty lists, not a failure.
    expect(state.repos[1].prs).toEqual([]);
  });

  test("stacked detection: baseRef equal to another open PR's headRef sets stackedOn", async () => {
    const { run } = scriptedRunner(acmeScript());
    const loader = new ForestLoader({ run, now: () => 1_000, cacheDir: tempCacheDir(), intervalMs: null });
    await loader.load("acme");
    const widget = (loader.current() as ForestPayload).repos[0];
    const stacked = widget.prs.find((pr) => pr.number === 13);
    expect(stacked?.stackedOn).toBe(12);
    // Trunk PRs stay unlinked.
    expect(widget.prs.find((pr) => pr.number === 12)?.stackedOn).toBeUndefined();
    expect(widget.prs.find((pr) => pr.number === 14)?.stackedOn).toBeUndefined();
  });

  test("caps at 30 repos, keeping the most recently pushed", async () => {
    const names = Array.from({ length: 35 }, (_, index) => ({
      name: `repo-${index}`,
      // repo-34 is the freshest, repo-0 the stalest.
      pushedAt: new Date(Date.parse("2026-01-01T00:00:00Z") + index * 86_400_000).toISOString(),
    }));
    const { run } = scriptedRunner({ [REPO_LIST_KEY]: JSON.stringify(names) });
    const loader = new ForestLoader({ run, now: () => 1, cacheDir: tempCacheDir(), intervalMs: null });
    await loader.load("acme");
    const state = loader.current() as ForestPayload;
    expect(state.repos).toHaveLength(30);
    expect(state.repos[0].name).toBe("repo-34");
    expect(state.repos.some((repo) => repo.name === "repo-4")).toBe(false); // the 5 stalest fell off
  });

  test("before any import, current() is {org:null}; while a first fetch runs it reports loading", async () => {
    const loader = new ForestLoader({ run: failingRunner, now: () => 1, cacheDir: tempCacheDir(), intervalMs: null });
    expect(loader.current()).toEqual({ org: null });
    await loader.load("acme");
    // Fetch failed, no cache: still no payload, but the org is honestly named.
    expect(loader.current()).toEqual({ org: null, loading: "acme" });
  });
});

describe("ForestLoader — disk cache fallback", () => {
  test("a fetch failure serves the stale cache written by a previous run", async () => {
    const cacheDir = tempCacheDir();
    const good = new ForestLoader({ run: scriptedRunner(acmeScript()).run, now: () => 5_000, cacheDir, intervalMs: null });
    await good.load("acme");
    expect((good.current() as ForestPayload).repos).toHaveLength(2);

    // Cold start (fresh process), gh now failing: the cached payload serves.
    const cold = new ForestLoader({ run: failingRunner, now: () => 9_000, cacheDir, intervalMs: null });
    await cold.load("acme");
    const state = cold.current() as ForestPayload;
    expect(state.org).toBe("acme");
    expect(state.fetchedAtMs).toBe(5_000); // honestly stale
    expect(state.repos.map((repo) => repo.name)).toEqual(["widget", "older"]);
  });

  test("an in-memory payload survives a failed refresh (no cache read needed)", async () => {
    let failing = false;
    const scripted = scriptedRunner(acmeScript());
    const run: ForestCommandRunner = async (argv): Promise<ForestCommandResult> =>
      failing ? { ok: false, stdout: "", stderr: "boom" } : scripted.run(argv);
    let nowMs = 0;
    const loader = new ForestLoader({ run, now: () => nowMs, cacheDir: tempCacheDir(), intervalMs: null });
    await loader.load("acme");
    failing = true;
    nowMs = 10 * 60_000;
    await loader.tick();
    expect((loader.current() as ForestPayload).repos).toHaveLength(2);
  });
});

describe("ForestLoader — refresh cadence (injected clock)", () => {
  test("tick() refetches only once the clock passes the 5-minute mark", async () => {
    let nowMs = 0;
    const scripted = scriptedRunner(acmeScript());
    const loader = new ForestLoader({ run: scripted.run, now: () => nowMs, cacheDir: tempCacheDir(), intervalMs: null });
    await loader.load("acme");
    const callsAfterLoad = scripted.calls.length;
    expect(callsAfterLoad).toBeGreaterThan(0);

    // 4 minutes: not due — tick is a no-op.
    nowMs = 4 * 60_000;
    await loader.tick();
    expect(scripted.calls.length).toBe(callsAfterLoad);

    // 5 minutes: due — the whole listing refetches.
    nowMs = 5 * 60_000;
    await loader.tick();
    expect(scripted.calls.length).toBeGreaterThan(callsAfterLoad);
    expect(scripted.calls.slice(callsAfterLoad)[0]).toBe(REPO_LIST_KEY);
  });

  test("tick() before any load never runs a command", async () => {
    const scripted = scriptedRunner({});
    const loader = new ForestLoader({ run: scripted.run, now: () => 10 * 60_000, cacheDir: tempCacheDir(), intervalMs: null });
    await loader.tick();
    expect(scripted.calls).toEqual([]);
  });
});

describe("ciFromStatusCheckRollup", () => {
  test("maps gh's rollup shapes onto the four-way verdict; failure dominates pending", () => {
    expect(ciFromStatusCheckRollup(null)).toBe("none");
    expect(ciFromStatusCheckRollup([])).toBe("none");
    expect(ciFromStatusCheckRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pass");
    expect(ciFromStatusCheckRollup([{ status: "COMPLETED", conclusion: "NEUTRAL" }])).toBe("pass");
    expect(ciFromStatusCheckRollup([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("pending");
    expect(ciFromStatusCheckRollup([{ state: "PENDING" }])).toBe("pending");
    expect(ciFromStatusCheckRollup([{ state: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("fail");
    expect(ciFromStatusCheckRollup([{ status: "IN_PROGRESS", conclusion: "" }, { state: "ERROR" }])).toBe("fail");
    expect(ciFromStatusCheckRollup([{ status: "COMPLETED", conclusion: "TIMED_OUT" }])).toBe("fail");
  });
});

describe("linkStackedPrs", () => {
  test("links a chain and leaves trunk PRs untouched", () => {
    const prs: ForestPr[] = [
      { number: 1, title: "base", draft: false, ci: "pass", baseRef: "main", headRef: "a" },
      { number: 2, title: "mid", draft: false, ci: "pass", baseRef: "a", headRef: "b" },
      { number: 3, title: "top", draft: false, ci: "pass", baseRef: "b", headRef: "c" },
      { number: 4, title: "solo", draft: false, ci: "pass", baseRef: "main", headRef: "d" },
    ];
    const linked = linkStackedPrs(prs);
    expect(linked.map((pr) => pr.stackedOn)).toEqual([undefined, 1, 2, undefined]);
  });
});

describe("normalizeOrgName", () => {
  test("accepts bare names, @names and github URLs; rejects junk", () => {
    expect(normalizeOrgName("acme")).toBe("acme");
    expect(normalizeOrgName("  Acme-Org  ")).toBe("Acme-Org");
    expect(normalizeOrgName("@acme")).toBe("acme");
    expect(normalizeOrgName("https://github.com/Acme-Org/some-repo")).toBe("Acme-Org");
    expect(normalizeOrgName("")).toBeNull();
    expect(normalizeOrgName("not a name")).toBeNull();
    expect(normalizeOrgName("-leading")).toBeNull();
    expect(normalizeOrgName("../../etc/passwd")).toBeNull();
  });
});
