import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ProjectorProcess, TranscriptLine } from "./types";
import type { SceneDwellRect } from "./gesture/scene-source";
import { RecordSteerToggle } from "./RecordSteerToggle";
import { loadSelfVersion, useSelfBranches, type SelfBranchesPayload, type SelfTreeSpec } from "./self-repo";
import { stageOf } from "./stage";
import { treeMenuPlacement } from "./TreeMenu";
import "./TreePopups.css";

/**
 * Branch popup — the contextual glass that opens when a LIMB is picked (the
 * tip bud or anywhere along the wood; RoomScene routes the pick through
 * onPickBranch with the limb TIP's own projected rect, so the card opens
 * beside the limb, not the whole tree).
 *
 * Same glass family + clamped placement as TreeMenu (treeMenuPlacement), a
 * dwell shield over the whole rect, plain enabled buttons only. TWO SOURCES
 * of truth feed it, because two kinds of tree grow limbs:
 *   • ADOPTED imports resolve out of the snapshot's treeRepo, and the branch
 *     is a live work rail:
 *       - 🎙 Steer this branch → POST /api/process/:upid/select {branch},
 *         close — the record path, scoped to this branch.
 *       - ⬆ Open PR ▸ → POST /api/process/:upid/branch/<branch>/pr; the
 *         returned URL (or the honest error) shows INLINE — in-room text,
 *         never a new tab.
 *   • The SELF tree (the room's own repo, treeRepo null) resolves out of the
 *     forest spec + the room's local rails, and the branch is a VERSION of
 *     the room. Only what the server actually honors renders: ⏱ load this
 *     version (POST /api/self/checkout), the record toggle on the branch the
 *     room is running (the only branch #cutSelfBranch can cut off), and the
 *     PR's URL inline. No steer (the server ignores a branch scope on the
 *     self path), no Open PR (it 400s — the PR already exists), no merge
 *     (no route).
 *   - ✕ close.
 */

export const BRANCH_POPUP_WIDTH = 380;
export const BRANCH_POPUP_EST_HEIGHT = 300;

// The self tree's data, threaded down from App (the forest-derived spec) and
// the local rails (fetched here, seeded in tests).
export interface SelfBranchContext {
  tree: SelfTreeSpec;
  versions: SelfBranchesPayload | null;
}

export interface BranchPopupModel {
  // Full branch ref ("room/spoken-changes" / a PR's head ref) — the POST path
  // segment.
  branch: string;
  // Display name without the room/ rail prefix.
  short: string;
  commits: number;
  prUrl: string | null;
  // Which resolver answered: the adopted snapshot's git substrate, or the
  // room's own repo. Decides the whole action row.
  source: "tree" | "self";
  // Self only: the PR title (minus its "#n " prefix) or the local tip subject.
  subject: string | null;
  prNumber: number | null;
  // Self only: this IS the branch the room is running right now.
  isCurrent: boolean;
  // Self only: a local branch of this name exists, so a checkout can succeed
  // (a PR head ref that was never fetched here cannot).
  loadable: boolean;
}

// Pure: resolve the picked branch, adopted substrate FIRST. Null when neither
// resolver knows it (force-deleted upstream, or a ref that left the forest) —
// the caller closes rather than rendering a dead card.
export function branchPopupModel(
  process: ProjectorProcess,
  branch: string,
  self?: SelfBranchContext | null,
): BranchPopupModel | null {
  const entry = process.treeRepo?.branches.find((candidate) => candidate.name === branch);
  if (entry !== undefined) {
    return {
      branch: entry.name,
      short: entry.name.startsWith("room/") ? entry.name.slice("room/".length) : entry.name,
      commits: Math.max(0, Math.round(entry.commits)),
      prUrl: typeof entry.prUrl === "string" && entry.prUrl.length > 0 ? entry.prUrl : null,
      source: "tree",
      subject: null,
      prNumber: null,
      isCurrent: false,
      loadable: false,
    };
  }
  // The SELF tree carries no treeRepo (the mirror's is null): its branches are
  // the open PRs of the forest spec, plus whatever rails exist locally.
  if (self === undefined || self === null || stageOf(process) !== "self") {
    return null;
  }
  const specBranch = self.tree.spec.branches.find((candidate) => candidate.ref === branch);
  const local = self.versions?.branches.find((candidate) => candidate.name === branch) ?? null;
  if (specBranch === undefined && local === null) {
    return null; // neither a PR nor a local rail — no dead glass
  }
  // Branch ids follow forestTreeSpec's stable `pr-<number>` convention.
  const parsed = specBranch?.id.startsWith("pr-") === true ? Number(specBranch.id.slice(3)) : NaN;
  const prNumber = Number.isFinite(parsed) ? parsed : null;
  const label = specBranch?.tip?.label ?? null;
  const subject =
    label !== null ? label.replace(/^#\d+\s+/u, "") : local !== null && local.subject.length > 0 ? local.subject : null;
  return {
    branch,
    short: branch.startsWith("room/") ? branch.slice("room/".length) : branch,
    commits: 0,
    prUrl: prNumber !== null ? `https://github.com/${self.tree.repo}/pull/${prNumber}` : null,
    source: "self",
    subject,
    prNumber,
    isCurrent: self.versions?.current === branch,
    loadable: local !== null,
  };
}

// SSR-safe measure (TreeMenu's pattern): layout effect in the browser, plain
// effect on the server so renderToStaticMarkup stays quiet.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface BranchPopupProps {
  process: ProjectorProcess;
  branch: string;
  // The LIMB TIP's projected screen rect at pick time (the sub-object rect,
  // not the whole-tree bbox); null → edge resting, same contract as TreeMenu.
  anchor: SceneDwellRect | null;
  // The SELF tree's forest spec (App holds it), with the local rails optional
  // — live they are fetched here; the static renderer seeds them.
  self?: { tree: SelfTreeSpec; versions?: SelfBranchesPayload | null } | null;
  // The server's receipt for the last spoken change (snapshot.selfLanding) —
  // which branch grew it, or why the room refused to grow anything.
  landing?: { branch: string | null; onto: string | null; error: string | null; atMs: number } | null;
  // The live transcript (snapshot.transcript), threaded from App exactly as
  // TreeMenu gets it. NOT optional: it was, and this card — on the very branch
  // the room was running — silently omitted it, so the graft toggle echoed
  // nothing while the operator spoke and then announced "heard nothing — no
  // graft was made" over a graft the room had really cut. `null` says "no
  // transcript here" out loud; a missing prop is now a compile error.
  transcript: readonly TranscriptLine[] | null;
  onClose: () => void;
}

export function BranchPopup({ process, branch, anchor, self, landing = null, transcript, onClose }: BranchPopupProps) {
  // The room's own rails: fetched only on the self tree, and only once the
  // popup is up (an adopted tree's card never asks about the room's checkout).
  const fetchedVersions = useSelfBranches(stageOf(process) === "self").payload;
  const selfContext: SelfBranchContext | null =
    self === undefined || self === null ? null : { tree: self.tree, versions: self.versions ?? fetchedVersions };
  const model = branchPopupModel(process, branch, selfContext);
  const viewport =
    typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1920, height: 1080 };
  const panelRef = useRef<HTMLElement | null>(null);
  const [measured, setMeasured] = useState<{ width: number; height: number } | null>(null);
  useIsomorphicLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const rect = panel.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    setMeasured((current) =>
      current !== null && Math.abs(current.width - rect.width) < 1 && Math.abs(current.height - rect.height) < 1
        ? current
        : { width: rect.width, height: rect.height },
    );
  });
  const placement = treeMenuPlacement(
    anchor,
    viewport,
    measured ?? { width: BRANCH_POPUP_WIDTH, height: BRANCH_POPUP_EST_HEIGHT },
  );

  // ✓ Finalize (adopted trees): squash-merge this branch's open PR into the
  // origin's main via POST /api/process/:upid/branch/:branch/merge. Armed on
  // the first press — merging into an upstream main is not a one-press act —
  // and the server's refusal ("no PR is open for this branch") shows verbatim.
  const [mergeArmed, setMergeArmed] = useState(false);
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeResult, setMergeResult] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    setMergeArmed(false);
    setMergeBusy(false);
    setMergeResult(null);
  }, [process.upid, branch]);
  // The arm falls back to resting on its own — a stale "really merge?" left
  // sitting on a wall is an accident waiting for the next person's dwell.
  useEffect(() => {
    if (!mergeArmed) {
      return;
    }
    const timer = window.setTimeout(() => setMergeArmed(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [mergeArmed]);
  const mergeBranch = async (): Promise<void> => {
    setMergeBusy(true);
    setMergeArmed(false);
    try {
      const response = await fetch(
        `/api/process/${encodeURIComponent(process.upid)}/branch/${encodeURIComponent(branch)}/merge`,
        { method: "POST" },
      );
      const body = (await response.json().catch(() => null)) as { merged?: unknown; error?: unknown } | null;
      if (response.ok && body?.merged === true) {
        setMergeResult({ ok: true });
        return;
      }
      setMergeResult({
        ok: false,
        error:
          typeof body?.error === "string" && body.error.length > 0 ? body.error : `Merge failed (HTTP ${response.status})`,
      });
    } catch {
      setMergeResult({ ok: false, error: "Merge failed — is the room server up?" });
    } finally {
      setMergeBusy(false);
    }
  };

  // ⬆ Open PR state: in-flight disables the button; the result (URL or the
  // honest error) shows inline. ⏱ Load-this-version state rides alongside —
  // both reset when the popup moves to another branch.
  const [prBusy, setPrBusy] = useState(false);
  const [prResult, setPrResult] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  const [loadBusy, setLoadBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    setPrBusy(false);
    setPrResult({ url: null, error: null });
    setLoadBusy(false);
    setLoadError(null);
  }, [process.upid, branch]);

  if (model === null) {
    return null;
  }
  const isSelf = model.source === "self";
  // The rails answer "is this branch on this machine?" — until they land the
  // card must not claim it isn't.
  const railsKnown = selfContext?.versions != null;

  // The record path, scoped: this branch becomes the steering target and
  // everything spoken routes into it (the server slugs/validates the branch).
  const steerBranch = (): void => {
    void fetch(`/api/process/${encodeURIComponent(process.upid)}/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: model.branch }),
    }).catch(() => undefined);
    onClose();
  };

  const openPr = async (): Promise<void> => {
    setPrBusy(true);
    setPrResult({ url: null, error: null });
    try {
      const response = await fetch(
        `/api/process/${encodeURIComponent(process.upid)}/branch/${encodeURIComponent(model.branch)}/pr`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      );
      const payload = (await response.json().catch(() => null)) as { url?: unknown; error?: unknown } | null;
      if (response.ok && typeof payload?.url === "string") {
        setPrResult({ url: payload.url, error: null });
      } else {
        setPrResult({
          url: null,
          error: typeof payload?.error === "string" && payload.error.length > 0 ? payload.error : `PR failed (HTTP ${response.status})`,
        });
      }
    } catch {
      setPrResult({ url: null, error: "PR request failed — is the room server up?" });
    } finally {
      setPrBusy(false);
    }
  };

  // ⏱ Load this version (self tree): checkout + supervisor relaunch. The
  // server's refusals ("no supervisor is wrapping this process", a dirty
  // src/) render inline — the operator must read WHY the room stayed put.
  const loadVersion = async (): Promise<void> => {
    setLoadBusy(true);
    setLoadError(null);
    const result = await loadSelfVersion(model.branch);
    if (result.ok) {
      return; // the room is rebuilding — the window reloads under us
    }
    setLoadBusy(false);
    setLoadError(result.error);
  };

  const shownPrUrl = prResult.url ?? model.prUrl;

  return (
    <section
      ref={panelRef}
      className="tree-popup branch-popup"
      data-testid="branch-popup"
      data-upid={process.upid}
      data-branch={model.branch}
      // Dwell-miss dismissal shield: reading the card never closes it.
      data-dwell-shield="1"
      role="dialog"
      aria-label={`Branch ${model.branch} on ${process.callsign}`}
      style={{ left: `${Math.round(placement.left)}px`, top: `${Math.round(placement.top)}px` }}
      onClick={(clickEvent) => clickEvent.stopPropagation()}
    >
      <header className="tree-popup-head">
        <div>
          <span className="tree-popup-eyebrow">🌿 branch</span>
          <h2 className="tree-popup-title" data-testid="branch-popup-title">
            {model.short}
          </h2>
          {/* The self tree's branches are VERSIONS of the room, not commit
              counts: the PR subject over its number, and "you are here" for
              the branch the room is actually running. */}
          {isSelf ? (
            <span className="tree-popup-sub" data-testid="branch-popup-version">
              {model.subject !== null ? `${model.subject} · ` : ""}
              {model.prNumber !== null ? `PR #${model.prNumber}` : "local version"}
              {model.isCurrent ? " · you are here" : ""}
            </span>
          ) : (
            <span className="tree-popup-sub" data-testid="branch-popup-commits">
              {model.commits} commit{model.commits === 1 ? "" : "s"}
              {model.prUrl !== null ? " · PR ✓" : ""}
            </span>
          )}
        </div>
        <button
          type="button"
          className="ctl-button tree-popup-close"
          data-testid="branch-popup-close"
          title="Close this branch card"
          onClick={onClose}
        >
          ✕
        </button>
      </header>

      {/* The PR URL rides in-room (projector text, no target=_blank jump). */}
      {shownPrUrl !== null ? (
        <div className="tree-popup-link" data-testid="branch-popup-pr-url">
          ⬆ {shownPrUrl}
        </div>
      ) : null}
      {prResult.error !== null ? (
        <div className="tree-popup-error" data-testid="branch-popup-pr-error">
          {prResult.error}
        </div>
      ) : null}
      {loadError !== null ? (
        <div className="tree-popup-error" data-testid="branch-popup-load-error">
          {loadError}
        </div>
      ) : null}

      {/* SELF tree: only what the server honors. On the branch the room is
          running, the record toggle grows a FRESH branch per spoken change.
          On any OTHER branch that exists locally, the toggle now arms scoped
          to it — the server stands the room on that branch before the run, so
          the words GROW THAT BRANCH instead of a sibling (it used to drop the
          scope and cut a new rail regardless, which is why steering an
          existing branch was impossible). Climbing without speaking is still
          its own verb. Opening a PR against ourselves 400s, so the PR URL
          rides the inline link above instead. */}
      {isSelf ? (
        <div className="tree-popup-actions">
          {model.isCurrent ? (
            <>
              <button
                type="button"
                className="ctl-button branch-popup-here"
                data-testid="branch-popup-here"
                title="The room lives on this branch right now."
                disabled
              >
                🌳 you are here — the room lives on this branch
              </button>
              <RecordSteerToggle process={process} kind="room" transcript={transcript} landing={landing} />
            </>
          ) : model.loadable ? (
            <>
              <RecordSteerToggle process={process} kind="room" branch={model.branch} transcript={transcript} landing={landing} />
              <button
                type="button"
                className="ctl-button branch-popup-load"
                data-testid="branch-popup-load"
                title={`Climb the room onto ${model.branch} — rebuilds and relaunches on it.`}
                disabled={loadBusy}
                onClick={() => void loadVersion()}
              >
                {loadBusy ? "⤴ climbing… the room will reload" : "⤴ climb here · load"}
              </button>
            </>
          ) : railsKnown ? (
            <button
              type="button"
              className="ctl-button branch-popup-absent"
              data-testid="branch-popup-absent"
              title="This PR's branch has never been fetched onto this machine, so the room cannot climb it."
              disabled
            >
              🍂 not grown on this machine
            </button>
          ) : (
            <button
              type="button"
              className="ctl-button branch-popup-absent"
              data-testid="branch-popup-rails-pending"
              title="Reading the room's local branches…"
              disabled
            >
              🔍 reading the tree…
            </button>
          )}
        </div>
      ) : (
        <>
        <div className="tree-popup-actions">
          {/* ONE PLANT LANGUAGE ACROSS EVERY TREE. The room's own branches are
              tended with graft/finalize; an adopted project's branches are the
              same kind of thing and now say so, backed by the same real rails
              (select {branch} → the steer applier's commit; the branch merge
              route). What an adopted tree still lacks is PRUNE — there is no
              delete-branch rail on the clone substrate yet, and a verb with no
              rail behind it is the one thing this surface must never grow. */}
          <button
            type="button"
            className="ctl-button branch-popup-steer"
            data-testid="branch-popup-steer"
            title="Press, then talk — everything you say routes into THIS branch until you stop."
            onClick={steerBranch}
          >
            🌱 Graft onto this branch
          </button>
          <button
            type="button"
            className="ctl-button branch-popup-pr"
            data-testid="branch-popup-pr"
            title="Open a real PR from this branch against the import's own origin."
            disabled={prBusy}
            onClick={() => void openPr()}
          >
            {prBusy ? "⬆ Opening PR…" : "⬆ Open PR ▸"}
          </button>
          {/* ✓ INTO THE TRUNK: squash-merge this branch's open PR upstream.
              Two-stage like every destructive verb in the room — merging into
              someone else's main is not a thing to do on one press. */}
          <button
            type="button"
            className={`ctl-button branch-popup-merge${mergeArmed ? " is-armed" : ""}`}
            data-testid="branch-popup-merge"
            title="Squash-merge this branch's open PR into the origin's main."
            disabled={mergeBusy}
            onClick={() => {
              if (!mergeArmed) {
                setMergeArmed(true);
                return;
              }
              void mergeBranch();
            }}
          >
            {mergeBusy ? "✓ merging…" : mergeArmed ? "✓ really merge into main?" : "✓ Finalize · into the trunk"}
          </button>
        </div>
        {mergeResult !== null ? (
          <div
            className={mergeResult.ok ? "tree-popup-link" : "tree-popup-error"}
            data-testid="branch-popup-merge-result"
          >
            {mergeResult.ok ? "✓ merged into the trunk" : mergeResult.error}
          </div>
        ) : null}
        </>
      )}
    </section>
  );
}
