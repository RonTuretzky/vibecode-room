import { describe, expect, test } from "bun:test";
import {
  FOREST_CI_COLORS,
  FOREST_ISSUE_FALLBACK_COLOR,
  FOREST_LEAF_LUSH,
  FOREST_LEAF_PARCHED,
  forestPlacements,
  forestTreeSpec,
  hasForest,
  issueMarkerColor,
  repoFreshness01,
  type ForestPayload,
  type ForestPr,
  type ForestRepo,
} from "./forest-spec";
import { treeSpecSignature } from "./tree/spec";

// The pure payload → grove mapping: deterministic placement, PRs as branches
// (stacks off parent tips), CI tip colors, freshness-driven stature, and the
// issues toggle gating the trunk-base markers.

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-08-09T12:00:00Z");

function pr(overrides: Partial<ForestPr> & { number: number }): ForestPr {
  return {
    title: `PR ${overrides.number}`,
    draft: false,
    ci: "pass",
    baseRef: "main",
    headRef: `feat/${overrides.number}`,
    ...overrides,
  };
}

function repo(overrides: Partial<ForestRepo> & { name: string }): ForestRepo {
  return { pushedAtMs: NOW - DAY_MS, prs: [], issues: [], ...overrides };
}

function payload(repos: ForestRepo[]): ForestPayload {
  return { org: "acme", fetchedAtMs: NOW, repos };
}

describe("forestPlacements — determinism + spiral grove", () => {
  test("the same payload maps to byte-identical placements and signatures", () => {
    const input = payload([
      repo({ name: "alpha", prs: [pr({ number: 1 }), pr({ number: 2, baseRef: "feat/1" })] }),
      repo({ name: "beta", issues: [{ number: 9, title: "Crash", labels: ["bug"] }] }),
    ]);
    const first = forestPlacements(input, { issuesVisible: true });
    const second = forestPlacements(input, { issuesVisible: true });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.map((p) => treeSpecSignature(p.spec))).toEqual(first.map((p) => treeSpecSignature(p.spec)));
  });

  test("placement is keyed by repo name, not payload order: a re-sorted payload never moves a tree", () => {
    const repos = [repo({ name: "alpha" }), repo({ name: "beta" }), repo({ name: "gamma" })];
    const forward = forestPlacements(payload(repos), { issuesVisible: false });
    const reversed = forestPlacements(payload([...repos].reverse()), { issuesVisible: false });
    const positionOf = (placements: typeof forward, name: string) =>
      placements.find((p) => p.repo === name)?.position;
    for (const name of ["alpha", "beta", "gamma"]) {
      expect(positionOf(reversed, name)).toEqual(positionOf(forward, name));
    }
    // The grove spreads: no two trees share a spot.
    const keys = new Set(forward.map((p) => p.position.map((v) => v.toFixed(2)).join(",")));
    expect(keys.size).toBe(3);
  });
});

describe("forestTreeSpec — PR branches", () => {
  test("one branch per PR with the tip contract: label '#n title', pickId 'repo#n', repo sub", () => {
    const spec = forestTreeSpec(
      "acme",
      repo({
        name: "widget",
        prs: [pr({ number: 12, title: "Add the grove renderer" }), pr({ number: 14, title: "Fix flaky test" })],
      }),
      NOW,
      false,
    );
    expect(spec.branches).toHaveLength(2);
    const tips = spec.branches.map((branch) => branch.tip);
    expect(tips.map((tip) => tip?.label)).toEqual(["#12 Add the grove renderer", "#14 Fix flaky test"]);
    expect(tips.map((tip) => tip?.pickId)).toEqual(["widget#12", "widget#14"]);
    expect(tips.every((tip) => tip?.sub === "widget")).toBe(true);
    // The branch's real GIT identity rides the spec: picking the limb has to
    // name a ref, not a PR number (the pr() helper heads at feat/<number>).
    expect(spec.branches.map((branch) => branch.ref)).toEqual(["feat/12", "feat/14"]);
    // Trunk attachment: the first spine point sits ON the trunk axis (buried).
    for (const branch of spec.branches) {
      expect(branch.points[0].x).toBe(0);
      expect(branch.points[0].z).toBe(0);
      expect(branch.points[0].y).toBeGreaterThan(0);
      expect(branch.points[0].y).toBeLessThan(spec.trunk.height);
    }
  });

  test("long titles are capped at 40 chars with an ellipsis", () => {
    const title = "A very long pull request title that keeps going well past the budget";
    const spec = forestTreeSpec("acme", repo({ name: "widget", prs: [pr({ number: 7, title })] }), NOW, false);
    const label = spec.branches[0].tip?.label ?? "";
    expect(label.startsWith("#7 ")).toBe(true);
    const shown = label.slice(3);
    expect(shown.length).toBeLessThanOrEqual(40);
    expect(shown.endsWith("…")).toBe(true);
  });

  test("CI states color the branch tips (pass/fail/pending green/red/amber, none bark)", () => {
    const spec = forestTreeSpec(
      "acme",
      repo({
        name: "widget",
        prs: [
          pr({ number: 1, ci: "pass" }),
          pr({ number: 2, ci: "fail" }),
          pr({ number: 3, ci: "pending" }),
          pr({ number: 4, ci: "none" }),
        ],
      }),
      NOW,
      false,
    );
    expect(spec.branches.map((branch) => branch.tip?.color)).toEqual([
      FOREST_CI_COLORS.pass,
      FOREST_CI_COLORS.fail,
      FOREST_CI_COLORS.pending,
      FOREST_CI_COLORS.none,
    ]);
    expect(FOREST_CI_COLORS.pass).toBe(0x46c66e);
    expect(FOREST_CI_COLORS.fail).toBe(0xe05555);
    expect(FOREST_CI_COLORS.pending).toBe(0xf0c674);
  });

  test("draft PRs grow thinner wood", () => {
    const spec = forestTreeSpec(
      "acme",
      repo({ name: "widget", prs: [pr({ number: 1 }), pr({ number: 2, draft: true })] }),
      NOW,
      false,
    );
    const [ready, draft] = spec.branches;
    expect(draft.thickness).toBeLessThan(ready.thickness);
  });

  test("a stacked chain grows each child branch from its parent's exact tip point", () => {
    const spec = forestTreeSpec(
      "acme",
      repo({
        name: "widget",
        prs: [
          pr({ number: 10, headRef: "feat/base" }),
          pr({ number: 11, baseRef: "feat/base", headRef: "feat/mid", stackedOn: 10 }),
          pr({ number: 12, baseRef: "feat/mid", headRef: "feat/top", stackedOn: 11 }),
        ],
      }),
      NOW,
      false,
    );
    const byId = new Map(spec.branches.map((branch) => [branch.id, branch]));
    const tipOf = (id: string) => {
      const points = byId.get(id)!.points;
      return points[points.length - 1];
    };
    expect(byId.get("pr-11")!.points[0]).toEqual(tipOf("pr-10"));
    expect(byId.get("pr-12")!.points[0]).toEqual(tipOf("pr-11"));
    // A stacked child keeps its OWN head ref — the limb picks the child's
    // branch, never its parent's.
    expect(["pr-10", "pr-11", "pr-12"].map((id) => byId.get(id)!.ref)).toEqual([
      "feat/base",
      "feat/mid",
      "feat/top",
    ]);
    // Only the stack root attaches to the trunk axis.
    expect(byId.get("pr-10")!.points[0].x).toBe(0);
    expect(byId.get("pr-11")!.points[0].x).not.toBe(0);
  });

  test("a stack CYCLE degrades to trunk-attached branches instead of dropping PRs", () => {
    const spec = forestTreeSpec(
      "acme",
      repo({
        name: "widget",
        prs: [
          pr({ number: 1, baseRef: "b", headRef: "a", stackedOn: 2 }),
          pr({ number: 2, baseRef: "a", headRef: "b", stackedOn: 1 }),
        ],
      }),
      NOW,
      false,
    );
    expect(spec.branches).toHaveLength(2);
    for (const branch of spec.branches) {
      expect(branch.points[0].x).toBe(0);
      expect(branch.points[0].z).toBe(0);
    }
  });
});

describe("forestTreeSpec — freshness", () => {
  test("a freshly pushed repo stands taller with denser, lusher foliage than a stale one", () => {
    const fresh = forestTreeSpec("acme", repo({ name: "fresh", pushedAtMs: NOW }), NOW, false);
    const stale = forestTreeSpec("acme", repo({ name: "stale", pushedAtMs: NOW - 120 * DAY_MS }), NOW, false);
    expect(fresh.trunk.height).toBeGreaterThan(stale.trunk.height);
    expect(fresh.foliage!.density).toBeGreaterThan(stale.foliage!.density);
    expect(fresh.foliage!.palette).toEqual(FOREST_LEAF_LUSH);
    expect(stale.foliage!.palette).toEqual(FOREST_LEAF_PARCHED);
  });

  test("repoFreshness01 clamps to [0,1] across the 90-day window", () => {
    expect(repoFreshness01(NOW, NOW)).toBe(1);
    expect(repoFreshness01(NOW + DAY_MS, NOW)).toBe(1); // clock skew never overshoots
    expect(repoFreshness01(NOW - 45 * DAY_MS, NOW)).toBeCloseTo(0.5, 5);
    expect(repoFreshness01(NOW - 400 * DAY_MS, NOW)).toBe(0);
  });
});

describe("forestTreeSpec — issues toggle", () => {
  const withIssues = repo({
    name: "widget",
    issues: [
      { number: 3, title: "Crash on load", labels: ["bug"] },
      { number: 4, title: "Needs docs", labels: [] },
    ],
  });

  test("issuesVisible=false grows ZERO issue adornments", () => {
    const spec = forestTreeSpec("acme", withIssues, NOW, false);
    expect(spec.adornments ?? []).toHaveLength(0);
  });

  test("issuesVisible=true grows label-hued markers clustered near the trunk base", () => {
    const spec = forestTreeSpec("acme", withIssues, NOW, true);
    const markers = (spec.adornments ?? []).filter((adornment) => adornment.kind === "marker");
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(Math.hypot(marker.position.x, marker.position.z)).toBeLessThan(1.5);
      expect(marker.position.y).toBeGreaterThan(0);
      expect(marker.position.y).toBeLessThan(1.5);
    }
    expect(markers[0].color).toBe(issueMarkerColor(["bug"]));
    expect(markers[1].color).toBe(FOREST_ISSUE_FALLBACK_COLOR);
  });

  test("issue marker hues are deterministic per label and distinct across labels", () => {
    expect(issueMarkerColor(["bug"])).toBe(issueMarkerColor(["Bug"])); // case-insensitive
    expect(issueMarkerColor(["bug"])).not.toBe(issueMarkerColor(["enhancement"]));
    expect(issueMarkerColor([])).toBe(FOREST_ISSUE_FALLBACK_COLOR);
  });
});

describe("hasForest", () => {
  test("guards the /api/forest union", () => {
    expect(hasForest(null)).toBe(false);
    expect(hasForest({ org: null })).toBe(false);
    expect(hasForest({ org: null, loading: "acme" })).toBe(false);
    expect(hasForest(payload([]))).toBe(true);
  });
});
