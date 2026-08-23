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

// ── the room's own VERSION RAILS (/api/self/branches + /api/self/checkout) ──
// Every record window cuts a room/* branch off the running checkout, so the
// room's local rails are the versions it can actually be loaded to. This is
// the data side of that: the tree menu's version rows AND the self tree's
// branch popup read the SAME payload through the hook below.

// GET /api/self/branches — the running branch plus every local rail with its
// tip subject.
export interface SelfBranchesPayload {
  current: string;
  branches: Array<{ name: string; subject: string; date?: string }>;
}

// The rails handle a tending surface holds: the payload plus the two refresh
// seams the tend verbs need — `adopt` swallows the fresh rails a tend route
// returned in its own response (the Rails 2/3 refresh contract: no second
// GET), `refresh` re-fetches on demand (a tend whose response carried no
// rails). The bare payload alone was enough while the list was read-only;
// prune/merge/archive change it mid-mount.
export interface SelfBranchesHandle {
  payload: SelfBranchesPayload | null;
  adopt: (next: SelfBranchesPayload) => void;
  refresh: () => void;
}

// The data hook: fetch the rails while `armed` (the surface that needs them
// is open on the self tree), null until they land. Unarmed → null, so a
// fleet tree's popup never asks the server about the room's own checkout.
// `seed` is the SSR/test seam (the effect-free static renderer cannot fetch).
export function useSelfBranches(armed: boolean, seed?: SelfBranchesPayload | null): SelfBranchesHandle {
  const [payload, setPayload] = useState<SelfBranchesPayload | null>(seed ?? null);
  const [fetchTick, setFetchTick] = useState(0);
  useEffect(() => {
    if (!armed || typeof window === "undefined") {
      return;
    }
    let closed = false;
    void fetch("/api/self/branches")
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!closed && body !== null) {
          setPayload(body as SelfBranchesPayload);
        }
      })
      .catch(() => undefined);
    return () => {
      closed = true;
    };
  }, [armed, fetchTick]);
  return useMemo(
    () => ({
      payload,
      adopt: (next: SelfBranchesPayload) => setPayload(next),
      refresh: () => setFetchTick((tick) => tick + 1),
    }),
    [payload],
  );
}

// POST /api/self/checkout — load the room to a version (checkout, then the
// supervisor rebuilds and relaunches ON it). The RESULT is parsed rather than
// swallowed: checkoutSelfBranch's honest refusals ("no supervisor is wrapping
// this process", a dirty src/, an unknown branch) are exactly what the
// operator needs to read on the wall.
export async function loadSelfVersion(branch: string): Promise<{ ok: boolean; error: string | null }> {
  try {
    const response = await fetch("/api/self/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok !== false) {
      return { ok: true, error: null };
    }
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `load failed (HTTP ${response.status})`,
    };
  } catch {
    return { ok: false, error: "load request failed — is the room server up?" };
  }
}

// A tend verb's parsed outcome. `branches` is the fresh rails payload the
// route returned alongside ok (the refresh contract) — null when the response
// carried none (older server, refusal), in which case the caller refresh()es.
// `conflicts`/`reloading` are the prune-excise honesty fields riding an ok
// delete (scope "everywhere"): branches the graft-revert could NOT land on
// (named for the wall's honest note) and whether the room is about to
// rebuild (the current branch was excised). Absent → [] / false.
export interface TendResult {
  ok: boolean;
  error: string | null;
  branches: SelfBranchesPayload | null;
  conflicts: string[];
  reloading: boolean;
  grafts: number | null;
}

// Pure: the excise outcome riding an ok tend response — STRICT (non-string
// conflict entries are dropped, anything but `true` reads false): the wall's
// honest note must never render garbage, and an old server's body simply
// reads as "no conflicts, no reload".
export function parseTendOutcome(body: unknown): { conflicts: string[]; reloading: boolean; grafts: number | null } {
  if (typeof body !== "object" || body === null) {
    return { conflicts: [], reloading: false, grafts: null };
  }
  const { conflicts, reloading, grafts } = body as { conflicts?: unknown; reloading?: unknown; grafts?: unknown };
  return {
    conflicts: Array.isArray(conflicts)
      ? conflicts.filter((entry): entry is string => typeof entry === "string")
      : [],
    reloading: reloading === true,
    // How many own graft commits the pruned branch carried (everywhere scope);
    // null on old servers / non-excise responses. 0 is the honest "there was
    // nothing to remove elsewhere" the wall must SAY (live-room report: an
    // empty record-window branch pruned everywhere, and no reload followed).
    grafts: typeof grafts === "number" ? grafts : null,
  };
}

// Pure: pull the refreshed rails out of a tend response body ({current,
// branches} ride beside ok). Null unless BOTH halves parse — a half-payload
// must never repaint the list as empty.
export function parseTendBranches(body: unknown): SelfBranchesPayload | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const { current, branches } = body as { current?: unknown; branches?: unknown };
  if (typeof current !== "string" || !Array.isArray(branches)) {
    return null;
  }
  const entries: SelfBranchesPayload["branches"] = [];
  for (const entry of branches) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const { name, subject, date } = entry as { name?: unknown; subject?: unknown; date?: unknown };
    if (typeof name !== "string") {
      return null;
    }
    entries.push({
      name,
      subject: typeof subject === "string" ? subject : "",
      ...(typeof date === "string" ? { date } : {}),
    });
  }
  return { current, branches: entries };
}

// POST /api/self/branch — tend a limb: archive (room/x -> archive/x), delete
// (prune — local branch -D + best-effort remote prune), or merge (finalize —
// into the trunk via the PR or a fast-forward). Delete takes an optional
// `scope`: "branch" (default — the label alone falls) or "everywhere" (the
// graft is also reverted on every branch carrying it; the room rebuilds if
// the current branch loses it). The server's honest refusals (running branch,
// unknown name, "no PR and not fast-forward…") surface to the wall VERBATIM;
// ok responses carry the refreshed rails plus the excise outcome
// (conflicts[] / reloading).
export async function manageSelfVersion(
  branch: string,
  action: "archive" | "delete" | "merge",
  scope?: "branch" | "everywhere",
): Promise<TendResult> {
  try {
    const response = await fetch("/api/self/branch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch, action, ...(scope !== undefined ? { scope } : {}) }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok !== false) {
      return { ok: true, error: null, branches: parseTendBranches(body), ...parseTendOutcome(body) };
    }
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `${action} failed (HTTP ${response.status})`,
      branches: null,
      conflicts: [],
      reloading: false,
    };
  } catch {
    return {
      ok: false,
      error: `${action} request failed — is the room server up?`,
      branches: null,
      conflicts: [],
      reloading: false,
    };
  }
}

// POST /api/self/run/halt — stop the growing self-run (✂ stop growing).
// Idempotent server-side: `halted:false` means nothing was executing (it
// already finished) — a truth the wall must say, not an error. `status`
// (present on an HTTP answer) feeds the reportControlFailure toast.
export async function haltSelfRun(): Promise<{ ok: boolean; halted: boolean; error: string | null; status?: number }> {
  try {
    const response = await fetch("/api/self/run/halt", { method: "POST" });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; halted?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok !== false) {
      return { ok: true, halted: body?.halted === true, error: null, status: response.status };
    }
    return {
      ok: false,
      halted: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `stop failed (HTTP ${response.status})`,
      status: response.status,
    };
  } catch {
    return { ok: false, halted: false, error: "stop request failed — is the room server up?" };
  }
}
