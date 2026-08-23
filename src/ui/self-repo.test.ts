import { describe, expect, test } from "bun:test";
import { FOREST_CI_COLORS, type ForestPayload } from "./forest-spec";
import { SELF_REPO_POLL_MS, parseTendBranches, parseTendOutcome, selfGardenTree, selfRepoState } from "./self-repo";

// The self-rebuild repo tree DATA path: /api/forest payload → the ONE garden
// tree input RoomScene grows among the fleet. Pure functions only — the poll
// hook is exercised live; the mapping is what must never drift.

const payload: ForestPayload = {
  org: "acme",
  fetchedAtMs: Date.parse("2026-08-09T00:00:00Z"),
  repos: [
    {
      name: "vibecode-room",
      pushedAtMs: Date.parse("2026-08-08T00:00:00Z"),
      prs: [
        { number: 7, title: "Grow the self tree", draft: false, ci: "pass", baseRef: "main", headRef: "feat/self-tree" },
        { number: 9, title: "Repair the wall seam", draft: false, ci: "fail", baseRef: "main", headRef: "fix/seam" },
      ],
      issues: [{ number: 2, title: "Flaky boot", labels: ["bug"] }],
    },
    { name: "other-repo", pushedAtMs: 0, prs: [], issues: [] },
  ],
};

describe("selfRepoState — filter the forest to the one self repo", () => {
  test("matches the owner/name tail and keeps the payload shape", () => {
    const state = selfRepoState(payload, "acme/vibecode-room");
    expect(state).not.toBeNull();
    expect(state!.org).toBe("acme");
    expect((state as ForestPayload).repos.map((repo) => repo.name)).toEqual(["vibecode-room"]);
  });

  test("null payload, org-less state and unknown repos all map to null", () => {
    expect(selfRepoState(null, "acme/vibecode-room")).toBeNull();
    expect(selfRepoState({ org: null, loading: "acme" }, "acme/vibecode-room")).toBeNull();
    expect(selfRepoState(payload, "acme/absent")).toBeNull();
  });
});

describe("selfGardenTree — payload → the ONE garden tree spec", () => {
  test("one branch per open PR, CI-colored tips, CI-word subs, repo-named input", () => {
    const tree = selfGardenTree(payload, "acme/vibecode-room");
    expect(tree).not.toBeNull();
    expect(tree!.repo).toBe("acme/vibecode-room");
    expect(tree!.spec.id).toBe("forest:acme/vibecode-room");
    expect(tree!.spec.branches.map((branch) => branch.id).sort()).toEqual(["pr-7", "pr-9"]);
    const tips = new Map(tree!.spec.branches.map((branch) => [branch.id, branch.tip]));
    expect(tips.get("pr-7")?.label).toBe("#7 Grow the self tree");
    expect(tips.get("pr-7")?.color).toBe(FOREST_CI_COLORS.pass);
    // The tip card's second line carries the CI VERDICT (the deleted corner
    // panel's PR list used to spell it out; the garden tip is now the only
    // place to read it), not the repo name the org forest shows.
    expect(tips.get("pr-7")?.sub).toBe("CI passing");
    expect(tips.get("pr-9")?.color).toBe(FOREST_CI_COLORS.fail);
    expect(tips.get("pr-9")?.sub).toBe("CI failing");
  });

  test("the PR head refs survive the CI-word rewrite — every limb keeps its git identity", () => {
    const tree = selfGardenTree(payload, "acme/vibecode-room");
    expect(tree!.spec.branches.map((branch) => branch.ref).sort()).toEqual(["feat/self-tree", "fix/seam"]);
  });

  test("issue markers stay OFF in the garden (issuesVisible=false)", () => {
    const tree = selfGardenTree(payload, "acme/vibecode-room");
    expect(tree!.spec.adornments).toEqual([]);
  });

  test("no payload / warming loader / missing repo → null (the tree is absent)", () => {
    expect(selfGardenTree(null, "acme/vibecode-room")).toBeNull();
    expect(selfGardenTree({ org: null, loading: "acme" }, "acme/vibecode-room")).toBeNull();
    expect(selfGardenTree(payload, "acme/absent")).toBeNull();
  });

  test("a re-fetched but unchanged payload maps to an identical spec (reconcile no-op)", () => {
    const a = selfGardenTree(payload, "acme/vibecode-room");
    const b = selfGardenTree({ ...payload, repos: [...payload.repos] }, "acme/vibecode-room");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("poll cadence", () => {
  test("the forest poll only re-reads the server loader's ~5-minute cache", () => {
    expect(SELF_REPO_POLL_MS).toBe(30_000);
  });
});

// The TEND rails' parse seam: ok responses from POST /api/self/branch carry
// the refreshed rails ({current, branches}) beside ok — the wall re-renders
// without a second GET, and a half-payload must never repaint the list.
describe("parseTendBranches — the tend refresh contract's parser", () => {
  test("a full ok response yields the rails payload (subject/date defaults included)", () => {
    expect(
      parseTendBranches({
        ok: true,
        merged: true,
        via: "pr",
        current: "room/hp-at-hp-four",
        branches: [
          { name: "room/hp-at-hp-four", subject: "the default is never an invisible cursor", date: "2 minutes ago" },
          { name: "room/older-change" },
        ],
      }),
    ).toEqual({
      current: "room/hp-at-hp-four",
      branches: [
        { name: "room/hp-at-hp-four", subject: "the default is never an invisible cursor", date: "2 minutes ago" },
        { name: "room/older-change", subject: "" },
      ],
    });
  });

  test("refusal bodies and half-payloads parse to null — never an empty repaint", () => {
    // The server's honest refusal strings carry NO rails — the wall keeps its
    // list and shows the error verbatim instead.
    expect(parseTendBranches({ ok: false, error: "cannot tend the running branch — load another version first" })).toBeNull();
    expect(parseTendBranches({ ok: false, error: "no PR and not fast-forward from main — needs a PR" })).toBeNull();
    expect(parseTendBranches(null)).toBeNull();
    expect(parseTendBranches({ current: "room/x" })).toBeNull(); // branches missing
    expect(parseTendBranches({ branches: [] })).toBeNull(); // current missing
    expect(parseTendBranches({ current: "room/x", branches: [{ subject: "nameless" }] })).toBeNull();
  });
});

// The prune-excise outcome riding an ok delete (scope "everywhere"):
// conflicts[] names every branch the graft-revert could not land on and
// reloading says the current branch was excised (the room rebuilds). Parsed
// STRICTLY — the wall's honest note must never render garbage.
describe("parseTendOutcome — the excise outcome's strict parser", () => {
  test("conflicts + reloading ride an ok body; non-string conflict entries are dropped", () => {
    expect(
      parseTendOutcome({
        ok: true,
        excised: [{ branch: "room/descendant", reverted: 2 }],
        conflicts: ["room/b", 7, null, "room/live (uncommitted work)"],
        reloading: true,
      }),
    ).toEqual({ conflicts: ["room/b", "room/live (uncommitted work)"], reloading: true });
  });

  test("absent fields read as no conflicts, no reload — an old server's delete stays valid", () => {
    expect(parseTendOutcome({ ok: true, current: "room/x", branches: [] })).toEqual({ conflicts: [], reloading: false });
    expect(parseTendOutcome(null)).toEqual({ conflicts: [], reloading: false });
    expect(parseTendOutcome("ok")).toEqual({ conflicts: [], reloading: false });
    // Wrong shapes read as the safe default, never a crash or a truthy lie.
    expect(parseTendOutcome({ conflicts: "room/b", reloading: "yes" })).toEqual({ conflicts: [], reloading: false });
  });

  test("refusal bodies stay refusals upstream — the outcome parser never invents a conflict note", () => {
    expect(parseTendOutcome({ ok: false, error: "cannot tend the running branch — load another version first" })).toEqual(
      { conflicts: [], reloading: false },
    );
  });
});
