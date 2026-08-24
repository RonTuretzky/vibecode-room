// ADOPTED-TREE RAILS, client side — the fetch seams behind the fleet
// constellation's grow / open-PR / merge / graft-onto-branch verbs
// (TreeMenu's non-self body). Same honesty contract as self-repo.ts: every
// helper parses the server's typed refusal and returns it VERBATIM instead of
// swallowing it — the old growBranch fire-and-forget (POST, ignore the body,
// close the menu) is exactly the silent failure this module retires.

// Pure: the next branch name that won't collide with an existing room/* rail.
// The server slugs {name} into room/<slug> and createBranch is IDEMPOTENT —
// an existing room/spoken-changes answers ok without growing anything, so a
// second press used to be a silent no-op. Suffixing keeps every press a real
// new limb. `existing` are full refs from process.treeRepo.branches — a list
// the server caps at 8 (SNAPSHOT_BRANCH_CAP), so beyond eight branches the
// prediction can collide again and the idempotent path returns; the cap is a
// server-side follow-up, not something this pure helper can see past.
export function freshBranchName(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has("room/spoken-changes")) {
    return "spoken-changes";
  }
  for (let n = 2; ; n += 1) {
    if (!taken.has(`room/spoken-changes-${n}`)) {
      return `spoken-changes-${n}`;
    }
  }
}

// POST /api/process/:upid/branch — cut a real room/<slug> branch off the
// freshly fetched origin tip. The route 400s honestly (substrate disabled /
// not an adopted tree / git fetch refusal) and the error string is designed
// to be read on the wall.
export async function growTreeBranch(
  upid: string,
  name: string,
): Promise<{ ok: true; branch: string } | { ok: false; error: string; status?: number }> {
  try {
    const response = await fetch(`/api/process/${encodeURIComponent(upid)}/branch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const body = (await response.json().catch(() => null)) as { ok?: unknown; branch?: unknown; error?: unknown } | null;
    if (response.ok && body?.ok === true && typeof body.branch === "string") {
      return { ok: true, branch: body.branch };
    }
    return {
      ok: false,
      error:
        typeof body?.error === "string" && body.error.length > 0
          ? body.error
          : `grow failed (HTTP ${response.status})`,
      status: response.status,
    };
  } catch {
    return { ok: false, error: "grow request failed — is the room server up?" };
  }
}

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
