// ADOPTED-TREE RAILS, client side — the fetch seams behind the fleet
// constellation's open-PR / merge / graft-onto-branch verbs (TreeMenu's
// non-self body). Same honesty contract as self-repo.ts: every helper parses
// the server's typed refusal and returns it VERBATIM instead of swallowing it.
//
// GROW IS NOT HERE ANY MORE. It was a name this file INVENTED (freshBranchName
// → POST /api/process/:upid/branch), which cut an empty rail the moment the
// verb was pressed. Growing a branch is now a recording window — the room
// names the branch from what was actually said, at the end of it — so the
// client has no branch name to predict and no cut to fire. A helper describing
// a flow the surface no longer performs is a lie in the source, so it is gone
// rather than kept "just in case"; POST :upid/branch itself stays, because
// take-an-issue (IssuePopup) really does cut a branch named by the issue.

// POST /api/process/:upid/branch/:branch/pr — commit the clone's spoken
// changes, push ONLY the room branch, open (or return the existing) PR.
export async function openTreeBranchPr(
  upid: string,
  branch: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string; status?: number }> {
  try {
    const response = await fetch(
      `/api/process/${encodeURIComponent(upid)}/branch/${encodeURIComponent(branch)}/pr`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    const body = (await response.json().catch(() => null)) as { ok?: unknown; url?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok === true && typeof body.url === "string") {
      return { ok: true, url: body.url };
    }
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `open PR failed (HTTP ${response.status})`,
      status: response.status,
    };
  } catch {
    return { ok: false, error: "PR request failed — is the room server up?" };
  }
}

// POST /api/process/:upid/branch/:branch/merge — squash-merge the branch's
// open PR into the origin's main (idempotent upstream).
export async function mergeTreeBranch(
  upid: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  try {
    const response = await fetch(
      `/api/process/${encodeURIComponent(upid)}/branch/${encodeURIComponent(branch)}/merge`,
      { method: "POST" },
    );
    const body = (await response.json().catch(() => null)) as { ok?: unknown; merged?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok === true && body.merged === true) {
      return { ok: true };
    }
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `merge failed (HTTP ${response.status})`,
      status: response.status,
    };
  } catch {
    return { ok: false, error: "merge request failed — is the room server up?" };
  }
}

// POST /api/process/:upid/select {branch} — stand the room's steer on THIS
// branch so the next spoken change grafts onto it (BranchPopup's rail, shared
// here by the focus view's graft verb). ACKNOWLEDGE-ONLY: the route always
// answers 200 with the snapshot (it never validates the branch, and a dead
// upid silently clears the steer), so the error path below only catches
// transport failures — the record chip's lit state is the real receipt.
export async function steerOntoTreeBranch(
  upid: string,
  branch: string,
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  try {
    const response = await fetch(`/api/process/${encodeURIComponent(upid)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch }),
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `graft arm failed (HTTP ${response.status})`,
      status: response.status,
    };
  } catch {
    return { ok: false, error: "graft request failed — is the room server up?" };
  }
}
