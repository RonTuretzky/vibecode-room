import { useEffect, useMemo, useState } from "react";
import { forestCiWord } from "./forest-spec";
import { forestTreeSpec, type ForestState } from "./forest-spec";
import type { TreeSpec3D } from "./tree/spec";

/**
 * SELF-REBUILD REPO TREE data — "watch the room grow itself".
 *
 * While the 🔁 Self-Rebuild toggle is ON, wall windows grow THIS repository
 * as ONE MORE TREE inside the RoomScene garden — not a panel, not its own
 * canvas: the same HD tree engine, standing in the fleet's slot family, open
 * PRs as branches with CI-colored tips. This module owns the DATA side only:
 * the poll loop (/api/self-repo names the repo; /api/forest carries the
 * loader's payload — arming the toggle kicks the load server-side) and the
 * pure payload → garden-tree-input mapping. RoomScene consumes the result
 * through its `selfTree` prop.
 */

// Poll cadence for the forest payload while the toggle is armed. The server
// loader refreshes from GitHub every ~5 minutes; polling faster only re-reads
// its cache.
export const SELF_REPO_POLL_MS = 30_000;

// Pure: reduce a full forest payload to the single self repo (name matched on
// the "owner/name" tail), preserving the payload shape downstream consumers
// expect.
export function selfRepoState(payload: ForestState | null, selfRepo: string): ForestState | null {
  if (payload === null || payload.org === null) {
    return null;
  }
  const tail = selfRepo.split("/").pop() ?? selfRepo;
  const repo = payload.repos.find((entry) => entry.name === tail || entry.name === selfRepo);
  if (repo === undefined) {
    return null;
  }
  return { ...payload, repos: [repo] };
}

// The garden's input: RoomScene grows `spec` with the HD tree engine and
// labels the tree with `repo`, exactly one entry among the fleet trees.
export interface SelfTreeSpec {
  // "owner/name" as /api/self-repo names it — the garden label's title.
  repo: string;
  // The prebuilt, id-stable HD tree spec: every open PR a branch, CI status
  // coloring its tip bud, tip sub carrying the CI word for the tip card.
  spec: TreeSpec3D;
}

// Pure: full forest payload → the one self-repo garden tree input, or null
// until both the repo name and a payload containing it exist (the tree is
// simply absent while the loader warms). Reuses the forest spec verbatim —
// same branches, same CI tip colors, no issue markers — but rewrites each
// tip's sub line from the repo name to the CI WORD: in the garden the tip
// card is the only place the verdict can be read (the old panel's PR list is
// gone), and the tree's own label already names the repo.
export function selfGardenTree(payload: ForestState | null, selfRepo: string): SelfTreeSpec | null {
  const state = selfRepoState(payload, selfRepo);
  if (state === null || state.org === null) {
    return null;
  }
  const repo = state.repos[0];
  const spec = forestTreeSpec(state.org, repo, state.fetchedAtMs, false);
  const ciByNumber = new Map(repo.prs.map((pr) => [pr.number, pr.ci] as const));
  return {
    repo: selfRepo,
    spec: {
      ...spec,
      branches: spec.branches.map((branch) => {
        // Branch ids follow forestTreeSpec's stable `pr-<number>` convention.
        const ci = branch.id.startsWith("pr-") ? ciByNumber.get(Number(branch.id.slice(3))) : undefined;
        return branch.tip === undefined || ci === undefined
          ? branch
          : { ...branch, tip: { ...branch.tip, sub: forestCiWord(ci) } };
      }),
    },
  };
}

// Test seam mirror of App's initialSnapshot: seeds the repo name + forest
// payload so the effect-free static renderer can render an armed wall with
// the tree data already present.
export interface SelfTreeSeed {
  repo: string;
  forest: ForestState;
}

// The data hook: while `armed`, name the repo once (/api/self-repo), then
// poll /api/forest on SELF_REPO_POLL_MS and map the payload to the garden
// tree input. Unarmed → null (the tree is absent); fetched state is kept so
// re-arming repaints without waiting for the next poll.
export function useSelfRepoTree(armed: boolean, seed?: SelfTreeSeed): SelfTreeSpec | null {
  const [selfRepo, setSelfRepo] = useState<string | null>(seed?.repo ?? null);
  const [forest, setForest] = useState<ForestState | null>(seed?.forest ?? null);

  useEffect(() => {
    if (!armed || typeof window === "undefined") {
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        if (selfRepo === null) {
          const named = await fetch("/api/self-repo");
          if (named.ok) {
            const body = (await named.json()) as { repo?: unknown };
            if (!closed && typeof body.repo === "string") {
              setSelfRepo(body.repo);
            }
          }
        }
        const response = await fetch("/api/forest");
        if (response.ok) {
          const body = (await response.json()) as ForestState;
          if (!closed) {
            setForest(body);
          }
        }
      } catch {
        // Loader not warm yet / offline — the tree simply stays absent and
        // the next poll retries.
      }
      if (!closed) {
        timer = setTimeout(() => void poll(), SELF_REPO_POLL_MS);
      }
    };
    void poll();
    return () => {
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [armed, selfRepo]);

  return useMemo(
    () => (armed && selfRepo !== null ? selfGardenTree(forest, selfRepo) : null),
    [armed, selfRepo, forest],
  );
}
