import { useEffect, useState } from "react";
import { ForestScene, forestCiWord } from "./ForestScene";
import type { ForestPayload, ForestState } from "./forest-spec";

/**
 * SELF-REBUILD REPO TREE — "watch the room grow itself".
 *
 * While the 🔁 Self-Rebuild toggle is ON, wall windows carry this corner
 * panel: THIS repository rendered as one HD tree (src/ui/tree engine via
 * ForestScene), open PRs as branches with CI-colored tips. Pointability for
 * every cursor comes from the PR LIST beside the canvas — plain <button>s,
 * so the dwell layer targets them natively (the 3D tips also hover-pick for
 * mouse users through ForestScene's own raycast).
 *
 * Data: /api/self-repo names the repo; /api/forest carries the loader's
 * payload (the self-rebuild toggle kicks the load server-side; this panel
 * just polls and filters to the one repo).
 */

// Poll cadence for the forest payload while the panel is mounted. The server
// loader refreshes from GitHub every ~5 minutes; polling faster only re-reads
// its cache.
export const SELF_REPO_POLL_MS = 30_000;

// Pure: reduce a full forest payload to the single self repo (name matched on
// the "owner/name" tail), preserving the payload shape ForestScene consumes.
export function selfRepoState(payload: ForestState | null, selfRepo: string): ForestState | null {
  if (payload === null || payload.org === null) {
    return null;
  }
  const tail = selfRepo.split("/").pop() ?? selfRepo;
  const repo = (payload as ForestPayload).repos.find((entry) => entry.name === tail || entry.name === selfRepo);
  if (repo === undefined) {
    return null;
  }
  return { ...(payload as ForestPayload), repos: [repo] };
}

export function SelfRepoTree() {
  const [selfRepo, setSelfRepo] = useState<string | null>(null);
  const [forest, setForest] = useState<ForestState | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
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
        // Loader not warm yet / offline — the panel simply stays in its
        // "growing" state and retries on the next poll.
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
  }, [selfRepo]);

  const state = selfRepo === null ? null : selfRepoState(forest, selfRepo);
  const repo = state !== null && state.org !== null ? state.repos[0] : null;

  return (
    <aside className="self-repo-tree" data-testid="self-repo-tree">
      <header className="self-repo-head">
        <span className="self-repo-title">🌱 the room's own repo</span>
        <span className="self-repo-name">{selfRepo ?? "…"}</span>
      </header>
      <div className="self-repo-body">
        <div className="self-repo-canvas">
          <ForestScene forest={state} issuesVisible={false} onPick={(pickId) => setPicked(pickId)} />
        </div>
        <div className="self-repo-prs" data-testid="self-repo-prs">
          {repo === null ? (
            <p className="self-repo-empty">growing the tree… (fetching the repo's open PRs)</p>
          ) : repo.prs.length === 0 ? (
            <p className="self-repo-empty">no open PRs — a bare healthy trunk</p>
          ) : (
            repo.prs.map((pr) => (
              <button
                key={pr.number}
                type="button"
                className={`self-repo-pr ci-${pr.ci}${picked === `${repo.name}#${pr.number}` ? " picked" : ""}`}
                data-testid="self-repo-pr"
                title={`#${pr.number} ${pr.title} — CI ${forestCiWord(pr.ci)}`}
                onClick={() => setPicked(`${repo.name}#${pr.number}`)}
              >
                <span className="self-repo-pr-num">#{pr.number}</span>
                <span className="self-repo-pr-title">{pr.title}</span>
                <span className="self-repo-pr-ci">{forestCiWord(pr.ci)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </aside>
  );
}
