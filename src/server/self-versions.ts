import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selfModeEnabled } from "../self/commission";
import { dirtySourcePaths } from "./self-graft";

import type { LogEvent } from "../types";

type Command = (argv: string[]) => Promise<{ code: number; out: string }>;
export interface SelfVersionOptions {
  env: Record<string, string | undefined>;
  sessionId: string;
  git: Command;
  gh: Command;
  trace: (event: LogEvent) => void;
  exit: (code: number) => void;
}

/** Owns listing, checking out, merging, archiving and excising room versions.
 * Commands and process exit are injected; the live room owns the lifecycle. */
export class SelfVersionManager {
  readonly #env: SelfVersionOptions["env"];
  readonly sessionId: string;
  readonly #selfGit: Command;
  readonly #selfGh: Command;
  readonly recordExternalTrace: SelfVersionOptions["trace"];
  readonly #exit: SelfVersionOptions["exit"];
  constructor(options: SelfVersionOptions) {
    this.#env = options.env;
    this.sessionId = options.sessionId;
    this.#selfGit = options.git;
    this.#selfGh = options.gh;
    this.recordExternalTrace = options.trace;
    this.#exit = options.exit;
  }


  // The room's own branches (the wall's "load this version" rows): every
  // room/* head plus the current branch, newest first, with subjects.
  async selfBranches(): Promise<{ current: string; branches: Array<{ name: string; subject: string; date: string }> }> {
    const current = (await this.#selfGit(["branch", "--show-current"])).out.trim();
    const listed = await this.#selfGit([
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)\u0001%(subject)\u0001%(committerdate:relative)",
      "refs/heads/room/",
      `refs/heads/${current}`,
    ]);
    const seen = new Set<string>();
    const branches: Array<{ name: string; subject: string; date: string }> = [];
    for (const line of listed.out.split("\n")) {
      const [name, subject, date] = line.split("\u0001");
      if (name !== undefined && name.length > 0 && !seen.has(name)) {
        seen.add(name);
        branches.push({ name, subject: subject ?? "", date: date ?? "" });
      }
    }
    // LABEL A BRANCH BY WHAT IT GREW, NOT BY WHAT LANDED ON TOP. The tip
    // subject was the label — so a prune-everywhere, which lands the SAME
    // revert commit on every branch that carried the graft, renamed the whole
    // rail to 'Revert "self: …"' and the operator could no longer tell the
    // branches apart (live report, twice: "the whole tree history is now
    // reverts", "I still see a bunch of the revert titles on the list").
    //
    // A room branch's identity is the SPOKEN graft it carries: the newest
    // `self:` commit on it. Reverts, merges and hand commits are skipped; a
    // branch with no self: commit at all keeps its tip subject, which is
    // honest because there is nothing better to call it.
    //
    // (This fix was written once already and stranded: it landed on a SIBLING
    // branch cut from the same parent as the one the room was running, so the
    // room never saw it. That is the hazard grafting onto an existing branch
    // now exists to avoid.)
    await Promise.all(
      branches.map(async (branch) => {
        const own = await this.#selfGit([
          "log",
          "--no-merges",
          "--format=%s",
          "-n",
          "40",
          `refs/heads/${branch.name}`,
        ]);
        if (own.code !== 0) {
          return;
        }
        const graft = own.out
          .split("\n")
          .map((line) => line.trim())
          .find((line) => line.startsWith("self: "));
        if (graft !== undefined) {
          branch.subject = graft.slice("self: ".length);
        }
      }),
    );
    return { current, branches };
  }


  // LOAD A VERSION: check out an existing local branch and hand the process to
  // the supervisor (exit 87 -> rebuild -> relaunch ON that branch). Refuses
  // honestly: unknown/unsafe names, src/ uncommitted work, or no supervisor.
  async checkoutSelfBranch(branch: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes("..")) {
      return { ok: false, error: "unsafe branch name" };
    }
    if (!selfModeEnabled(this.#env)) {
      return { ok: false, error: "no supervisor is wrapping this process (--self launch required)" };
    }
    const exists = await this.#selfGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.code !== 0) {
      return { ok: false, error: `no local branch named ${branch}` };
    }
    const dirty = dirtySourcePaths((await this.#selfGit(["status", "--porcelain"])).out);
    if (dirty.length > 0) {
      return { ok: false, error: `uncommitted work in the tree (${dirty[0]}${dirty.length > 1 ? ` +${dirty.length - 1}` : ""}) — commit or stash first` };
    }
    const checkout = await this.#selfGit(["checkout", branch]);
    if (checkout.code !== 0) {
      return { ok: false, error: checkout.out.slice(0, 160) };
    }
    this.recordExternalTrace({
      event: "self.version.load",
      level: "info",
      sessionId: this.sessionId,
      correlationId: `corr-self-load-${crypto.randomUUID()}`,
      meta: { branch },
    });
    // Respond first, exit after: the supervisor rebuilds the tree (now on the
    // requested branch) and relaunches the room on it. Through the #exit seam
    // so tests observe the 87 instead of dying with it.
    setTimeout(() => this.#exit(87), 400);
    return { ok: true };
  }


  // INTO THE TRUNK (finalize): merge a room/* branch into main. The gh path
  // drives the branch's PR — ready it if draft, retarget its base to main
  // (vibersyn-self drafts PRs against the branch it started FROM, often
  // another room/*), then a plain merge commit (--merge, never --squash: self
  // commits are the room's history). No PR at all falls back to a fast-
  // forward push when main is an ancestor. Merging the CURRENT branch is
  // ALLOWED — the room keeps standing on it; main simply gains its commits
  // (the operator loads main later via /api/self/checkout). Every gh/git
  // refusal surfaces verbatim (sliced) — the wall renders it inline.
  async mergeSelfBranch(
    branch: string,
  ): Promise<{ ok: true; merged: true; via: "pr" | "fast-forward" } | { ok: false; error: string }> {
    const correlationId = `corr-self-finalize-${crypto.randomUUID()}`;
    const refuse = (error: string): { ok: false; error: string } => {
      this.recordExternalTrace({
        event: "self.version.finalize",
        level: "warn",
        sessionId: this.sessionId,
        correlationId,
        meta: { branch, error },
      });
      return { ok: false, error };
    };
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes("..")) {
      return refuse("unsafe branch name");
    }
    if (!branch.startsWith("room/")) {
      return refuse("only room/* limbs can be finalized");
    }
    const exists = await this.#selfGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.code !== 0) {
      return refuse(`no local branch named ${branch}`);
    }
    const slug = this.#env.VIBERSYN_SELF_REPO ?? "RonTuretzky/vibecode-room";
    const listed = await this.#selfGh([
      "gh", "pr", "list", "-R", slug, "--head", branch,
      "--state", "all", "--json", "number,state,isDraft,baseRefName", "--limit", "1",
    ]);
    if (listed.code !== 0) {
      return refuse(listed.out.slice(0, 160));
    }
    let prs: Array<{ number?: unknown; state?: unknown; isDraft?: unknown; baseRefName?: unknown }> = [];
    try {
      const parsed = JSON.parse(listed.out) as unknown;
      prs = Array.isArray(parsed) ? parsed : [];
    } catch {
      prs = [];
    }
    const pr = prs[0];
    let via: "pr" | "fast-forward";
    if (pr === undefined || typeof pr.number !== "number") {
      // No PR: a plain fast-forward push is the only honest merge left.
      via = "fast-forward";
      const ancestor = await this.#selfGit(["merge-base", "--is-ancestor", "refs/heads/main", `refs/heads/${branch}`]);
      if (ancestor.code !== 0) {
        return refuse("no PR and not fast-forward from main — needs a PR");
      }
      const pushed = await this.#selfGit(["push", "origin", `refs/heads/${branch}:refs/heads/main`]);
      if (pushed.code !== 0) {
        return refuse(pushed.out.slice(0, 160));
      }
    } else {
      via = "pr";
      if (pr.state !== "MERGED") {
        if (pr.isDraft === true) {
          const readied = await this.#selfGh(["gh", "pr", "ready", String(pr.number), "-R", slug]);
          if (readied.code !== 0) {
            return refuse(readied.out.slice(0, 160));
          }
        }
        if (typeof pr.baseRefName === "string" && pr.baseRefName !== "main") {
          const retargeted = await this.#selfGh(["gh", "pr", "edit", String(pr.number), "-R", slug, "--base", "main"]);
          if (retargeted.code !== 0) {
            return refuse(retargeted.out.slice(0, 160));
          }
        }
        const merged = await this.#selfGh(["gh", "pr", "merge", String(pr.number), "-R", slug, "--merge"]);
        if (merged.code !== 0) {
          return refuse(merged.out.slice(0, 160));
        }
      }
      // Best-effort: freshen the local main ref so a later fast-forward /
      // checkout sees the merge; a failure here changes nothing upstream.
      await this.#selfGit(["fetch", "origin", "main:main"]).catch(() => undefined);
    }
    this.recordExternalTrace({
      event: "self.version.finalize",
      level: "info",
      sessionId: this.sessionId,
      correlationId,
      meta: { branch, via },
    });
    return { ok: true, merged: true, via };
  }


  // A pruned branch's OWN GRAFT COMMITS: commits reachable from X but not
  // from X's NEAREST ancestor among {origin/main (fallback local main), every
  // other room/* tip that is an ancestor of X, the current branch}. "Nearest"
  // = the candidate with the FEWEST commits between it and X's tip (min
  // `rev-list --count C..X` — the ancestor holding the most of X's history);
  // in the room's stacked topology that is exactly the run's own commit(s) at
  // X's tip. Returned newest-first — already the revert order. `others` is
  // every OTHER tendable branch (room/* tips + current, minus X) the caller
  // probes for containment.
  async #selfOwnCommits(branch: string, current: string): Promise<{ own: string[]; others: string[] }> {
    const listed = await this.#selfGit(["for-each-ref", "--format=%(refname:short)", "refs/heads/room/"]);
    const names = new Set(
      listed.out
        .split("\n")
        .map((line) => line.trim())
        .filter((name) => name.length > 0),
    );
    if (current.length > 0) {
      names.add(current);
    }
    names.delete(branch);
    const others = [...names];
    const candidates = others.map((name) => `refs/heads/${name}`);
    const originMain = await this.#selfGit(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"]);
    candidates.push(originMain.code === 0 ? "refs/remotes/origin/main" : "refs/heads/main");
    let nearest: { ref: string; count: number } | null = null;
    for (const ref of candidates) {
      const ancestor = await this.#selfGit(["merge-base", "--is-ancestor", ref, `refs/heads/${branch}`]);
      if (ancestor.code !== 0) {
        continue;
      }
      const counted = await this.#selfGit(["rev-list", "--count", `${ref}..refs/heads/${branch}`]);
      const count = Number.parseInt(counted.out, 10);
      if (!Number.isFinite(count)) {
        continue;
      }
      if (nearest === null || count < nearest.count) {
        nearest = { ref, count };
      }
    }
    if (nearest === null || nearest.count === 0) {
      return { own: [], others };
    }
    const ownListed = await this.#selfGit(["rev-list", `${nearest.ref}..refs/heads/${branch}`]);
    const own = ownListed.out
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return { own, others };
  }


  // EXCISE a pruned branch's graft from another (NON-current) branch: revert
  // its commits (newest-first) in a TEMPORARY detached worktree — the live
  // checkout can never switch branches (the room projects from it) — then
  // move the branch ref with an old-value CAS (`update-ref <ref> <new> <old>`
  // refuses if the tip moved under us) and push the single explicit refspec
  // best-effort (the reverts sit ON TOP of the old tip, a plain fast-forward,
  // keychain-plain). A conflicted revert aborts and leaves the branch exactly
  // as it was: {ok:false} is the honest answer the caller reports by name —
  // never a throw, never a half-revert. One temp worktree at a time, ALWAYS
  // cleaned up (finally: remove --force + rmSync + worktree prune).
  async #exciseFromBranch(branch: string, commits: string[]): Promise<{ ok: boolean }> {
    const oldTip = (await this.#selfGit(["rev-parse", `refs/heads/${branch}`])).out.trim();
    if (oldTip.length === 0) {
      return { ok: false };
    }
    const tmp = mkdtempSync(join(tmpdir(), "vibersyn-excise-"));
    try {
      const added = await this.#selfGit(["worktree", "add", "--detach", tmp, oldTip]);
      if (added.code !== 0) {
        return { ok: false };
      }
      const reverted = await this.#selfGit(["-C", tmp, "revert", "--no-edit", ...commits]);
      if (reverted.code !== 0) {
        // Conflict (or any refusal): abort best-effort, the branch untouched.
        await this.#selfGit(["-C", tmp, "revert", "--abort"]);
        return { ok: false };
      }
      const newTip = (await this.#selfGit(["-C", tmp, "rev-parse", "HEAD"])).out.trim();
      if (newTip.length === 0) {
        return { ok: false };
      }
      const updated = await this.#selfGit(["update-ref", `refs/heads/${branch}`, newTip, oldTip]);
      if (updated.code !== 0) {
        return { ok: false };
      }
      // Best-effort: freshen origin so the branch's PR shows the excise; a
      // push failure changes nothing locally and is not a conflict.
      await this.#selfGit(["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`]);
      return { ok: true };
    } finally {
      await this.#selfGit(["worktree", "remove", "--force", tmp]);
      rmSync(tmp, { recursive: true, force: true });
      await this.#selfGit(["worktree", "prune"]);
    }
  }


  // TEND A LIMB: archive or delete one of the room's local branches — the
  // tree-menu's per-branch lifecycle actions. Neither ever touches the running
  // branch (the room must not saw off the limb it stands on), and both refuse
  // unsafe names. Archiving RENAMES room/<x> -> archive/<x> (the limb leaves
  // the load list but the work survives); deleting is a local `branch -D`
  // followed by a BEST-EFFORT remote prune (push origin --delete + closing
  // any open PR) — a remote failure is reported in the trace, never rolled
  // back (the local prune already happened; honesty = report, not rollback).
  // Delete with scope "everywhere" FIRST excises the branch's own graft from
  // every other branch carrying it (see #selfOwnCommits / #exciseFromBranch);
  // the CURRENT branch reverts in place (the server owns that worktree) and
  // schedules the exit-87 rebuild so the walls actually lose the feature.
  async manageSelfBranch(
    branch: string,
    action: "archive" | "delete",
    scope: "branch" | "everywhere" = "branch",
  ): Promise<
    | { ok: true; excised?: Array<{ branch: string; reverted: number }>; conflicts?: string[]; reloading?: boolean; grafts?: number }
    | { ok: false; error: string }
  > {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) || branch.includes("..")) {
      return { ok: false, error: "unsafe branch name" };
    }
    // Belt-and-braces: the room/* gate below already excludes the trunk, but
    // the trunk must never be tendable even if that gate ever loosens.
    if (branch === "main") {
      return { ok: false, error: "the trunk (main) is never tended" };
    }
    if (!branch.startsWith("room/")) {
      return { ok: false, error: "only room/* branches can be tended" };
    }
    const current = (await this.#selfGit(["branch", "--show-current"])).out.trim();
    const archivingLive = branch === current;
    if (branch === current && action === "delete") {
      return { ok: false, error: "cannot tend the running branch — load another version first" };
    }
    const exists = await this.#selfGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (exists.code !== 0) {
      return { ok: false, error: `no local branch named ${branch}` };
    }
    // Remote-prune bookkeeping for the delete path's trace (report, never
    // rollback): what happened to origin's copy + whether an open PR closed.
    let remote = "skipped";
    let prClosed = false;
    // Excise bookkeeping (delete scope "everywhere" only): which branches
    // lost the graft, which the revert could not land on, and whether the
    // current branch was excised (=> the exit-87 rebuild is scheduled).
    let excised: Array<{ branch: string; reverted: number }> | undefined;
    let grafts: number | undefined;
    let conflicts: string[] | undefined;
    let reloading = false;
    if (action === "archive") {
      // Archiving the LIVE branch: step off it onto main first so the running
      // room no longer stands on the limb being archived, then rename and hand
      // the process to the supervisor (exit 87 -> rebuild -> relaunch on main)
      // so whatever is archived is no longer live on the room.
      if (archivingLive) {
        if (!selfModeEnabled(this.#env)) {
          return { ok: false, error: "no supervisor is wrapping this process (--self launch required)" };
        }
        const stepOff = await this.#selfGit(["checkout", "main"]);
        if (stepOff.code !== 0) {
          return { ok: false, error: stepOff.out.slice(0, 160) };
        }
      }
      const archived = `archive/${branch.slice("room/".length)}`;
      const renamed = await this.#selfGit(["branch", "-m", branch, archived]);
      if (renamed.code !== 0) {
        return { ok: false, error: renamed.out.slice(0, 160) };
      }
      if (archivingLive) {
        this.recordExternalTrace({
          event: "self.version.tend",
          level: "info",
          sessionId: this.sessionId,
          correlationId: `corr-self-tend-${crypto.randomUUID()}`,
          meta: { branch, action, reload: true },
        });
        // Respond first, exit after: the supervisor rebuilds on main and
        // relaunches — the archived change is gone from the live room.
        setTimeout(() => this.#exit(87), 400);
        return { ok: true };
      }
    } else {
      // THE EXCISE (scope "everywhere"): before the label falls, revert X's
      // own graft commits on every OTHER branch that carries any of them —
      // per-commit containment, because a descendant may hold only part of
      // the graft. Non-current branches go through the temp-worktree excise;
      // the CURRENT branch (the live checkout) reverts in place — guarded by
      // the supervisor gate and the dirty-src refusal (the leftover-hygiene
      // contract) — and the room rebuilds. Every branch the revert could NOT
      // land on is reported by name in `conflicts`, untouched: partial
      // success is per-branch and spoken, never silent.
      if (scope === "everywhere") {
        excised = [];
        grafts = 0;
        conflicts = [];
        const { own, others } = await this.#selfOwnCommits(branch, current);
        grafts = own.length;
        const containedIn = async (name: string): Promise<string[]> => {
          const contained: string[] = [];
          for (const commit of own) {
            const check = await this.#selfGit(["merge-base", "--is-ancestor", commit, `refs/heads/${name}`]);
            if (check.code === 0) {
              contained.push(commit);
            }
          }
          return contained;
        };
        for (const other of others) {
          if (other === current) {
            continue;
          }
          const contained = await containedIn(other);
          if (contained.length === 0) {
            continue;
          }
          const result = await this.#exciseFromBranch(other, contained);
          if (result.ok) {
            excised.push({ branch: other, reverted: contained.length });
          } else {
            conflicts.push(other);
          }
        }
        if (others.includes(current)) {
          const contained = await containedIn(current);
          if (contained.length > 0) {
            if (!selfModeEnabled(this.#env)) {
              // No supervisor to rebuild the room off the excised tip: refuse
              // THIS branch only (reported, the rest of the excise stands).
              conflicts.push(`${current} (no supervisor — --self launch required)`);
            } else {
              const dirty = dirtySourcePaths((await this.#selfGit(["status", "--porcelain"])).out);
              if (dirty.length > 0) {
                conflicts.push(`${current} (uncommitted work)`);
              } else {
                const reverted = await this.#selfGit(["revert", "--no-edit", ...contained]);
                if (reverted.code !== 0) {
                  await this.#selfGit(["revert", "--abort"]);
                  conflicts.push(current);
                } else {
                  await this.#selfGit(["push", "origin", `refs/heads/${current}:refs/heads/${current}`]);
                  excised.push({ branch: current, reverted: contained.length });
                  reloading = true;
                }
              }
            }
          }
        }
      }
      const removed = await this.#selfGit(["branch", "-D", branch]);
      if (removed.code !== 0) {
        return { ok: false, error: removed.out.slice(0, 160) };
      }
      // BEST-EFFORT remote prune: the local branch is already gone, so a
      // remote failure is reported (trace meta), never rolled back — the
      // pruned limb must not resurrect as an error.
      const pushed = await this.#selfGit(["push", "origin", "--delete", branch]);
      remote = pushed.code === 0 ? "deleted" : `failed: ${pushed.out.slice(0, 120)}`;
      const slug = this.#env.VIBERSYN_SELF_REPO ?? "RonTuretzky/vibecode-room";
      const listed = await this.#selfGh([
        "gh", "pr", "list", "-R", slug, "--head", branch, "--state", "open", "--json", "number", "--limit", "1",
      ]);
      try {
        const openPrs = listed.code === 0 ? (JSON.parse(listed.out) as Array<{ number?: unknown }>) : [];
        const openPr = Array.isArray(openPrs) ? openPrs[0] : undefined;
        if (openPr !== undefined && typeof openPr.number === "number") {
          const closed = await this.#selfGh(["gh", "pr", "close", String(openPr.number), "-R", slug]);
          prClosed = closed.code === 0;
        }
      } catch {
        // Unparseable gh output = no PR found; the prune already succeeded.
      }
    }
    this.recordExternalTrace({
      event: "self.version.tend",
      level: "info",
      sessionId: this.sessionId,
      correlationId: `corr-self-tend-${crypto.randomUUID()}`,
      meta: {
        branch,
        action,
        ...(action === "delete" ? { remote, prClosed, scope } : {}),
        ...(grafts !== undefined ? { grafts } : {}),
      ...(excised !== undefined ? { excised, conflicts, reload: reloading } : {}),
      },
    });
    if (reloading) {
      // Respond first, exit after (the checkoutSelfBranch idiom): the current
      // branch lost the graft, so the supervisor rebuilds the tree from the
      // excised tip and relaunches — the walls actually lose the feature.
      // Through the #exit seam so tests observe the 87 instead of dying.
      setTimeout(() => this.#exit(87), 400);
    }
    return excised !== undefined ? { ok: true, excised, conflicts, reloading } : { ok: true };
  }
}
