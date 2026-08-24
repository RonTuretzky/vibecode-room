/**
 * WHERE A SPOKEN CHANGE TO THE ROOM LANDS.
 *
 * Every record window on the room used to cut a FRESH room/<slug> branch off
 * the current one, and the branch scope the wall sent with a scoped window was
 * dropped on the floor — so "steer this branch" quietly grew a sibling of it
 * instead. This module owns the other half: standing the room ON an existing
 * branch so the agent, which only ever commits where it stands, grows THAT
 * branch.
 *
 * The rule that matters is the refusal. If the room cannot get onto the branch
 * that was asked for, the change must land NOWHERE — growing it on whatever
 * branch happens to be checked out is worse than doing nothing, because it is
 * invisible until someone reads the log. Every refusal carries a sentence the
 * wall can show verbatim.
 */

export interface GraftGitRunner {
  (argv: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>;
}

export type SelfLandingResult = { ok: true; branch: string } | { ok: false; error: string };

// Same shape git accepts, minus anything that could escape the ref namespace.
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

async function run(git: GraftGitRunner, argv: string[]): Promise<{ code: number; out: string }> {
  const result = await git(argv);
  return { code: result.ok ? 0 : 1, out: (result.stdout + result.stderr).trim() };
}

/**
 * The path out of one `git status --porcelain` line.
 *
 * Written as a regex rather than `line.slice(3)` because of a bug this
 * replaces: the caller trims the whole blob, which eats the leading space of
 * the FIRST line's two-column status ("` M src/ui/App.tsx`" → "`M src/ui/
 * App.tsx`"). A blind slice(3) then returned "rc/ui/App.tsx", which fails a
 * `src/` test — so the first modified file in the list was invisible to every
 * dirty-tree guard, and a single unstaged edit passed the check entirely.
 * Handles both trimmed and untrimmed lines, and every status pair (M, ??, MM,
 * R with its "old -> new").
 */
export function porcelainPath(line: string): string {
  const match = /^\s*\S{1,2}\s+(.+)$/u.exec(line);
  return (match?.[1] ?? "").trim();
}

/** Uncommitted paths under src/ — the ones a checkout would drag along. */
export function dirtySourcePaths(statusOut: string): string[] {
  return statusOut
    .split("\n")
    .map(porcelainPath)
    .filter((path) => path.startsWith("src/"));
}

/**
 * Stand the room on `branch` so the spoken change grows it.
 *
 * Refuses — never throws — when the name is unsafe, the branch is gone (a
 * prune between arming and speaking is entirely normal), the working tree has
 * uncommitted src/ work that a checkout would drag along, or git itself says
 * no. Already standing there is a no-op success, which is the common case.
 */
export async function graftOntoBranch(git: GraftGitRunner, branch: string): Promise<SelfLandingResult> {
  if (!SAFE_BRANCH.test(branch) || branch.includes("..")) {
    return { ok: false, error: "unsafe branch name" };
  }
  const current = (await run(git, ["branch", "--show-current"])).out.trim();
  if (current === branch) {
    return { ok: true, branch };
  }
  const exists = await run(git, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (exists.code !== 0) {
    return { ok: false, error: `no branch named ${branch} — it may have been pruned` };
  }
  // Uncommitted work in src/ would ride along to the other branch. Someone
  // else's half-finished edit silently following your words onto a different
  // rail is exactly the kind of surprise this room must not produce.
  const dirty = dirtySourcePaths((await run(git, ["status", "--porcelain"])).out);
  if (dirty.length > 0) {
    return {
      ok: false,
      error: `uncommitted work in the tree (${dirty[0]}${dirty.length > 1 ? ` +${dirty.length - 1}` : ""}) — commit or stash before grafting`,
    };
  }
  const checkout = await run(git, ["checkout", branch]);
  return checkout.code === 0 ? { ok: true, branch } : { ok: false, error: checkout.out.slice(0, 160) };
}
