// ── GIT SUBSTRATE ("tree = repo") ───────────────────────────────────────────
// Every accepted idea's tree IS a real local git repo: builds/<upid>/.tree/
// holds the seed worktree (README.md + seed.json = main's checkout) and its
// .git/ is THE gitdir for the whole tree. Lane branches (concept/<backendId>)
// are written entirely via git plumbing against that detached gitdir — the
// orchestrator's per-backend lane dirs are used as --work-tree snapshots and
// NEVER gain any git file, so the mapped dir lifecycle (fresh-fan-out wipes,
// correction-mode prompt serialization, the wholesale preview server) is
// untouched. NO worktrees, ever: a per-lane GIT_INDEX_FILE plus atomic
// update-ref means concurrent lanes never contend and nothing has to exist
// before a backend writes. Contracts:
//   • fire-and-forget: a git failure must NEVER fail or block a build — every
//     op swallows errors, traces them (tree.git.*), and appends one line to
//     .tree/.git/trace.log;
//   • nothing reaches GitHub before commission: publish() (private repo +
//     draft PR per concept branch) fires only from executeProcess / the
//     explicit publish route, never at birth;
//   • never git-init inside an existing clone: GitHub imports (repo/.git on
//     disk) flip the tree to ADOPTED — their origin already is the remote;
//   • ADOPTED trees get the BRANCH RAILS instead (the PR engine): fetch the
//     real origin/main tip, cut room/<slug> branches off it, commit the
//     clone's CURRENT working tree via the same detached-index plumbing
//     (HEAD/checkout untouched — the working tree keeps serving previews),
//     push ONLY refs/heads/room/<slug>, and open a real PR against the
//     origin recorded by adopt() (never a spoken repo name). These are
//     user-initiated: HONEST {ok:false, error} results, not fire-and-forget,
//     serialized per upid;
//   • VIBERSYN_TREE_GIT=0 kill-switch; a missing git binary warns once and
//     turns the substrate into a no-op;
//   • the SELF/mirror process is excluded (belt-and-braces — SELF never fans
//     out anyway);
//   • snapshot() is pure in-memory (branch → session commit count, capped),
//     ZERO subprocesses per snapshot publish.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ghCommandRunner, type ForestCommandRunner } from "./github-org";
import { SELF_UPID } from "../self/commission";
import type { LogEvent } from "../types";

export interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// git args WITHOUT the leading "git" — the seam tests inject a scripted fake
// for, so no test ever spawns a real git subprocess.
export type GitCommandRunner = (
  argv: string[],
  opts?: { env?: Record<string, string | undefined>; timeoutMs?: number },
) => Promise<GitCommandResult>;

const GIT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 60_000;
// The deliberate credential chain for every network op (fetch/push): the
// first -c CLEARS inherited helpers (no accidental osxkeychain), the second
// routes lookups through gh — which reads GH_TOKEN from the child env (the
// runner forwards VIBERSYN_GITHUB_PAT; the PAT never rides argv).
const CREDENTIAL_ARGV = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"] as const;
// Imports clone --depth 1 --single-branch; deepen the origin/main fetch so
// the branch base is a USABLE tip (PRs need shared history, not a lone graft).
const FETCH_DEPTH = 50;
// Snapshot bloat guard: main + one concept/<backend> per lane is ≤4 today;
// 8 leaves headroom without ever letting the WS payload grow unbounded.
const SNAPSHOT_BRANCH_CAP = 8;
const SLUG_MAX_CHARS = 50;
const SLUG_COLLISION_MAX_SUFFIX = 9;
const SEED_MESSAGE_MAX_CHARS = 60;
const RESEED_MESSAGE_MAX_CHARS = 50;

// The default runner: a real `git` subprocess mirroring ghCommandRunner
// (github-org.ts) — hard SIGKILL timeout, non-interactive
// (GIT_TERMINAL_PROMPT=0), author/committer pinned via env so commits never
// depend on (or pollute) the operator's host git config, and
// VIBERSYN_GITHUB_PAT forwarded as GH_TOKEN so the push credential helper
// (`gh auth git-credential`) can authenticate without the PAT ever appearing
// in argv or .git/config. NEVER throws — {ok:false} on anything.
export const defaultGitRunner: GitCommandRunner = async (argv, opts) => {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    const env: Record<string, string | undefined> = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "vibecode-room",
      GIT_AUTHOR_EMAIL: "room@vibersyn.local",
      GIT_COMMITTER_NAME: "vibecode-room",
      GIT_COMMITTER_EMAIL: "room@vibersyn.local",
      ...opts?.env,
    };
    if (env.GH_TOKEN === undefined && env.GITHUB_TOKEN === undefined && env.VIBERSYN_GITHUB_PAT !== undefined) {
      env.GH_TOKEN = env.VIBERSYN_GITHUB_PAT;
    }
    proc = Bun.spawn(["git", ...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env });
    killTimer = setTimeout(() => proc?.kill(9), opts?.timeoutMs ?? GIT_TIMEOUT_MS);
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout instanceof ReadableStream ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr instanceof ReadableStream ? new Response(proc.stderr).text() : Promise.resolve(""),
      proc.exited,
    ]);
    return { ok: exitCode === 0, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  } finally {
    if (killTimer !== null) {
      clearTimeout(killTimer);
    }
  }
};

// Kill-switch: VIBERSYN_TREE_GIT=0 disables the whole substrate (the
// composition constructs null and no hook ever fires). Default ON.
export function treeGitEnabled(env: Record<string, string | undefined>): boolean {
  return env.VIBERSYN_TREE_GIT !== "0";
}

// Everything the accept knew, serialized verbatim into seed.json so the repo's
// first commit carries the idea's full provenance.
export interface TreeSeed {
  ideaId: string;
  pitch: string;
  callsign: string | null;
  brief?: unknown;
  planQuestions?: readonly { id: string; prompt: string; answers: string[] }[];
}

// The pure in-memory snapshot fragment the wall's tree visuals consume.
// `prUrl` appears on adopted trees' room/<slug> branches once a real PR to
// the origin is open (openPrToOrigin stores it per branch).
export interface TreeRepoSnapshot {
  branches: Array<{ name: string; commits: number; prUrl?: string }>;
  remoteUrl: string | null;
}

export interface TreeGitOptions {
  buildsRoot: string;
  // Seam — tests inject a scripted fake; default is the real subprocess runner.
  runGit?: GitCommandRunner;
  runGh?: ForestCommandRunner;
  // Composition wires recordExternalTrace; sessionId is stamped there.
  onTrace?: (event: LogEvent) => void;
  // Republish after adopt/publish change the snapshot.
  onUpdate?: () => void;
  now?: () => number;
}

interface TreeState {
  upid: string;
  // "local": born (or being born) with its own .tree/.git repo. "adopted": a
  // GitHub-import clone owns builds/<upid>/repo/ — the substrate records the
  // origin and never inits/commits.
  mode: "local" | "adopted";
  seed: TreeSeed | null;
  // branch name → commit count, insertion-ordered (main first). Session-scoped
  // counters, reseeded from rev-list on a re-accept of a prior-session repo.
  branches: Map<string, number>;
  remoteUrl: string | null;
  // Per-lane commit serialization (parent chaining); cross-lane fully parallel.
  laneChains: Map<string, Promise<void>>;
  // Settles when birth finished (ok or swallowed) — lane commits chain on it.
  ready: Promise<void>;
  publishing: Promise<{ ok: true; url: string } | { ok: false; error: string }> | null;
  // ── adopted-tree branch rails (the PR engine) ──
  // Per-upid in-flight guard: every fetch/branch/commit/push/PR op chains here
  // so two spoken actions can never interleave their plumbing.
  branchOps: Promise<unknown>;
  // The origin/main tip recorded by the last successful fetchOriginMain —
  // branch bases resolve from THIS, never a stale local ref.
  originMainSha: string | null;
  // branch name (room/<slug>) → its open PR URL; makes openPrToOrigin
  // idempotent and rides into snapshot.treeRepo.branches[].prUrl.
  prUrls: Map<string, string>;
}

export class TreeGitSubstrate {
  readonly #buildsRoot: string;
  readonly #runGit: GitCommandRunner;
  readonly #runGh: ForestCommandRunner;
  readonly #onTrace: (event: LogEvent) => void;
  readonly #onUpdate: () => void;
  readonly #now: () => number;
  readonly #trees = new Map<string, TreeState>();
  // Missing git binary: the first failing init flips this — one warn, then
  // every later call no-ops (per-instance so an injected failing fake in one
  // test can never poison another test's substrate).
  #gitUnavailable = false;

  constructor(options: TreeGitOptions) {
    this.#buildsRoot = resolve(options.buildsRoot);
    this.#runGit = options.runGit ?? defaultGitRunner;
    this.#runGh = options.runGh ?? ghCommandRunner;
    this.#onTrace = options.onTrace ?? (() => undefined);
    this.#onUpdate = options.onUpdate ?? (() => undefined);
    this.#now = options.now ?? Date.now;
  }

  // Birth the tree's repo at accept time. Idempotent, LOCAL ONLY (no network,
  // no gh), swallows all errors. A repo/.git on disk means a GitHub-import
  // clone landed first — flip to adopted and never init. A .tree/.git on disk
  // means a re-accept (this session or a previous one): skip init, reseed the
  // in-memory counters, and re-commit the seed files only when the pitch
  // changed.
  async birth(upid: string, seed: TreeSeed): Promise<void> {
    try {
      if (this.#gitUnavailable || upid === SELF_UPID) {
        return;
      }
      const existing = this.#trees.get(upid);
      if (existing?.mode === "adopted") {
        return;
      }
      if (existsSync(join(this.#buildsRoot, upid, "repo", ".git"))) {
        // Clone detected — never git-init inside a clone. adopt() records the
        // origin URL; until then remoteUrl stays whatever we knew.
        this.#trees.set(upid, this.#adoptedState(upid, existing?.remoteUrl ?? null));
        return;
      }
      if (existing !== undefined) {
        // Same-session re-accept: repo + counters live; only the seed files
        // may need a re-commit (pitch changed).
        await existing.ready.catch(() => undefined);
        await this.#reseedIfPitchChanged(existing, seed);
        return;
      }
      let settleReady!: () => void;
      const state: TreeState = {
        upid,
        mode: "local",
        // Set once the birth path knows the PREVIOUS pitch (rebirth compares
        // the incoming pitch against disk seed.json, not against itself).
        seed: null,
        branches: new Map(),
        remoteUrl: null,
        laneChains: new Map(),
        ready: new Promise<void>((resolveReady) => {
          settleReady = resolveReady;
        }),
        publishing: null,
        branchOps: Promise.resolve(),
        originMainSha: null,
        prUrls: new Map(),
      };
      this.#trees.set(upid, state);
      try {
        if (existsSync(join(this.#treeDir(upid), ".git"))) {
          await this.#rebirthFromDisk(state, seed);
        } else {
          await this.#freshBirth(state, seed);
        }
      } catch (error) {
        this.#trace("tree.git.error", "error", upid, { op: "birth", message: messageOf(error) });
      } finally {
        settleReady();
      }
    } catch {
      // Fire-and-forget by contract — birth can never fail an accept.
    }
  }

  // GitHub-import clones: record the origin as the remote and refuse all local
  // init/commit/publish work for this tree — the import's origin already IS
  // the remote.
  adopt(upid: string, remoteUrl: string): void {
    const existing = this.#trees.get(upid);
    if (existing !== undefined) {
      existing.mode = "adopted";
      existing.remoteUrl = remoteUrl;
    } else {
      this.#trees.set(upid, this.#adoptedState(upid, remoteUrl));
    }
    this.#trace("tree.git.adopt", "info", upid, { remoteUrl });
    this.#onUpdate();
  }

  // Commit one lane's current on-disk state onto its concept/<lane> branch via
  // plumbing (add -A → write-tree → commit-tree → update-ref) with a per-lane
  // index file. Serialized per lane (parent correctness), parallel across
  // lanes. Refuses in adopted/disabled/unborn state. NEVER throws or rejects.
  commitLane(upid: string, lane: string, laneDir: string, message: string): Promise<void> {
    const state = this.#trees.get(upid);
    if (this.#gitUnavailable || state === undefined || state.mode !== "local") {
      return Promise.resolve();
    }
    const chained = (state.laneChains.get(lane) ?? state.ready)
      .catch(() => undefined)
      .then(() => this.#commitLaneOnce(state, lane, laneDir, message))
      .catch(() => undefined);
    state.laneChains.set(lane, chained);
    return chained;
  }

  // COMMISSION-time publish: create the PRIVATE GitHub repo, push every
  // branch, and open one draft PR per concept branch with commits. Idempotent
  // (a stored remoteUrl short-circuits), per-upid in-flight guarded, and
  // refused for adopted trees. Never at birth.
  publish(upid: string, input: { name: string; description?: string }): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    if (state === undefined) {
      return Promise.resolve({ ok: false, error: `no tree repo for ${upid}` });
    }
    if (state.mode === "adopted") {
      this.#trace("tree.git.publish", "info", upid, { refused: "adopted", remoteUrl: state.remoteUrl });
      return Promise.resolve({ ok: false, error: "adopted from a remote — its origin already is the remote" });
    }
    if (this.#gitUnavailable) {
      return Promise.resolve({ ok: false, error: "git unavailable" });
    }
    if (state.remoteUrl !== null) {
      return Promise.resolve({ ok: true, url: state.remoteUrl });
    }
    if (state.publishing !== null) {
      return state.publishing;
    }
    const inFlight = this.#doPublish(state, input)
      .catch((error: unknown): { ok: false; error: string } => ({ ok: false, error: messageOf(error) }))
      .finally(() => {
        state.publishing = null;
      });
    state.publishing = inFlight;
    return inFlight;
  }

  // ── adopted-tree branch rails (the PR engine) ─────────────────────────────
  // User-initiated ops on an ADOPTED tree's clone (builds/<upid>/repo/):
  // fetch → branch → commit → push → PR, all under the room/* namespace, all
  // returning HONEST {ok:false, error} (never fire-and-forget), serialized
  // per upid so two spoken actions cannot interleave their plumbing.

  // Authenticated `git fetch origin main` (deepened — the clone is --depth 1
  // --single-branch) recording the fetched tip. MUST run before any branch
  // base resolution; createBranch does so itself.
  fetchOriginMain(upid: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    const refused = this.#branchOpRefusal(upid, state);
    if (refused !== null || state === undefined) {
      return Promise.resolve(refused ?? { ok: false, error: `no tree repo for ${upid}` });
    }
    return this.#chainBranchOp(state, () => this.#fetchOriginMainOnce(state));
  }

  // Cut room/<slug> at the FRESHLY FETCHED origin/main tip and register it in
  // the snapshot immediately. Idempotent: an existing room/<slug> returns
  // {ok, branch} without touching its ref (commits stay intact).
  createBranch(upid: string, name: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    const refused = this.#branchOpRefusal(upid, state);
    if (refused !== null || state === undefined) {
      return Promise.resolve(refused ?? { ok: false, error: `no tree repo for ${upid}` });
    }
    return this.#chainBranchOp(state, () => this.#createBranchOnce(state, name));
  }

  // Commit the clone's CURRENT WORKING TREE onto refs/heads/room/<branch> via
  // the detached-index plumbing — HEAD/checkout untouched, the working tree
  // keeps serving previews. No-change guard: {ok:true, changed:false}.
  commitBranch(
    upid: string,
    branch: string,
    message: string,
  ): Promise<{ ok: true; branch: string; changed: boolean } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    const refused = this.#branchOpRefusal(upid, state);
    if (refused !== null || state === undefined) {
      return Promise.resolve(refused ?? { ok: false, error: `no tree repo for ${upid}` });
    }
    return this.#chainBranchOp(state, () => this.#commitBranchOnce(state, branch, message));
  }

  // Push ONLY refs/heads/room/<slug> — never --all, never main, never force.
  pushBranch(upid: string, branch: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    const refused = this.#branchOpRefusal(upid, state);
    if (refused !== null || state === undefined) {
      return Promise.resolve(refused ?? { ok: false, error: `no tree repo for ${upid}` });
    }
    return this.#chainBranchOp(state, () => this.#pushBranchOnce(state, branch));
  }

  // Open a REAL PR against the origin adopt() recorded (NEVER a spoken repo
  // name): head room/<slug>, base main. Idempotent — the stored prUrl is
  // returned on every later call (and recovered from gh's "already exists").
  openPrToOrigin(
    upid: string,
    branch: string,
    title?: string,
    body?: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const state = this.#trees.get(upid);
    const refused = this.#branchOpRefusal(upid, state);
    if (refused !== null || state === undefined) {
      return Promise.resolve(refused ?? { ok: false, error: `no tree repo for ${upid}` });
    }
    return this.#chainBranchOp(state, () => this.#openPrOnce(state, branch, title, body));
  }

  // Pure in-memory snapshot fragment — ZERO subprocesses per publish.
  snapshot(upid: string): TreeRepoSnapshot | null {
    const state = this.#trees.get(upid);
    if (state === undefined) {
      return null;
    }
    return {
      branches: [...state.branches.entries()].slice(0, SNAPSHOT_BRANCH_CAP).map(([name, commits]) => {
        const prUrl = state.prUrls.get(name);
        return prUrl === undefined ? { name, commits } : { name, commits, prUrl };
      }),
      remoteUrl: state.remoteUrl,
    };
  }

  // True when this tree is an adopted GitHub-import clone — the branch rails
  // below apply and the commission-time publish must NOT fire.
  isAdopted(upid: string): boolean {
    return this.#trees.get(upid)?.mode === "adopted";
  }

  // The seed pitch recorded at birth (publish descriptions / PR bodies).
  seedPitch(upid: string): string | null {
    return this.#trees.get(upid)?.seed?.pitch ?? null;
  }

  // Dismiss cleanup: memory only — the disk repo stays (it is history).
  forget(upid: string): void {
    this.#trees.delete(upid);
  }

  // ── birth internals ───────────────────────────────────────────────────────

  async #freshBirth(state: TreeState, seed: TreeSeed): Promise<void> {
    state.seed = seed;
    const treeDir = this.#treeDir(state.upid);
    await mkdir(treeDir, { recursive: true });
    await this.#writeSeedFiles(state.upid, seed);
    // `git init --template=` keeps host templates/hooks out of the repo;
    // `-b main` needs a modern git — fall back to symbolic-ref for old ones.
    const init = await this.#runGit(["init", "--template=", "-b", "main", treeDir]);
    if (!init.ok) {
      const fallback = await this.#runGit(["init", "--template=", treeDir]);
      if (!fallback.ok) {
        this.#markGitUnavailable(init.stderr || fallback.stderr);
        return;
      }
      await this.#runGit([`--git-dir=${this.#gitDirFor(state)}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    const committed = await this.#commitTree(state, {
      workTree: treeDir,
      indexName: "index.seed",
      ref: "refs/heads/main",
      message: `seed: ${clampLine(seed.pitch, SEED_MESSAGE_MAX_CHARS)}`,
      allowEmptyParent: true,
    });
    if ("sha" in committed) {
      state.branches.set("main", 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch: "main", message: "seed", sha: committed.sha });
      await this.#traceLog(state.upid, "birth", true);
    } else {
      await this.#traceLog(state.upid, "birth", false);
    }
  }

  // Re-accept of a repo from a previous session: the on-disk branches are the
  // truth — reseed the in-memory counters once (bounded), then re-commit the
  // seed files only when the pitch changed.
  async #rebirthFromDisk(state: TreeState, seed: TreeSeed): Promise<void> {
    const gitDir = this.#gitDirFor(state);
    const refs = await this.#runGit([`--git-dir=${gitDir}`, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (refs.ok) {
      const names = refs.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .slice(0, SNAPSHOT_BRANCH_CAP);
      // main first so the snapshot's branch order stays stable.
      names.sort((a, b) => (a === "main" ? -1 : b === "main" ? 1 : 0));
      for (const name of names) {
        const count = await this.#runGit([`--git-dir=${gitDir}`, "rev-list", "--count", name]);
        const parsed = Number.parseInt(count.stdout.trim(), 10);
        state.branches.set(name, count.ok && Number.isFinite(parsed) ? parsed : 0);
      }
    }
    await this.#reseedIfPitchChanged(state, seed);
  }

  async #reseedIfPitchChanged(state: TreeState, seed: TreeSeed): Promise<void> {
    const previousPitch = state.seed?.pitch ?? (await this.#pitchFromSeedJson(state.upid));
    state.seed = seed;
    if (previousPitch === seed.pitch) {
      return;
    }
    await this.#writeSeedFiles(state.upid, seed);
    const committed = await this.#commitTree(state, {
      workTree: this.#treeDir(state.upid),
      indexName: "index.seed",
      ref: "refs/heads/main",
      message: `seed: re-accept — ${clampLine(seed.pitch, RESEED_MESSAGE_MAX_CHARS)}`,
    });
    if ("sha" in committed) {
      state.branches.set("main", (state.branches.get("main") ?? 0) + 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch: "main", message: "seed: re-accept", sha: committed.sha });
      await this.#traceLog(state.upid, "reseed", true);
    }
  }

  async #pitchFromSeedJson(upid: string): Promise<string | null> {
    try {
      const raw = await readFile(join(this.#treeDir(upid), "seed.json"), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const pitch = (parsed as { pitch?: unknown } | null)?.pitch;
      return typeof pitch === "string" ? pitch : null;
    } catch {
      return null;
    }
  }

  async #writeSeedFiles(upid: string, seed: TreeSeed): Promise<void> {
    const treeDir = this.#treeDir(upid);
    const acceptedAt = new Date(this.#now()).toISOString();
    const title = seed.callsign ?? upid;
    const readme = [
      `# ${title}`,
      "",
      seed.pitch,
      "",
      `- callsign: ${seed.callsign ?? "(none)"}`,
      `- accepted: ${acceptedAt}`,
      "",
    ].join("\n");
    await Bun.write(join(treeDir, "README.md"), readme);
    await Bun.write(join(treeDir, "seed.json"), `${JSON.stringify({ upid, acceptedAt, ...seed }, null, 2)}\n`);
  }

  // ── plumbing core ─────────────────────────────────────────────────────────

  async #commitLaneOnce(state: TreeState, lane: string, laneDir: string, message: string): Promise<void> {
    if (this.#gitUnavailable || state.mode !== "local") {
      return;
    }
    try {
      const ref = `refs/heads/concept/${lane}`;
      const committed = await this.#commitTree(state, {
        workTree: laneDir,
        indexName: `index.${lane}`,
        ref,
        // First lane commit branches off main; later ones chain the lane head.
        fallbackParentRef: "refs/heads/main",
        message,
      });
      if (!("sha" in committed)) {
        return; // unchanged (no noise commit) or failed (traced in plumbing)
      }
      const branch = `concept/${lane}`;
      state.branches.set(branch, (state.branches.get(branch) ?? 0) + 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch, message, sha: committed.sha });
      await this.#traceLog(state.upid, `commit ${branch}`, true, message);
    } catch (error) {
      this.#trace("tree.git.error", "error", state.upid, { op: "commit", lane, message: messageOf(error) });
      await this.#traceLog(state.upid, `commit concept/${lane}`, false, messageOf(error));
    }
  }

  // add -A → write-tree → (skip when identical to parent's tree) →
  // commit-tree → update-ref. Discriminated result so callers can tell a
  // no-change skip ({unchanged}) from a plumbing failure ({error} — traced
  // here) — the branch rails' commit contract ({ok, changed}) needs the
  // difference, the fire-and-forget lane path folds both into "no commit".
  async #commitTree(
    state: TreeState,
    input: {
      workTree: string;
      indexName: string;
      ref: string;
      message: string;
      fallbackParentRef?: string;
      allowEmptyParent?: boolean;
    },
  ): Promise<{ sha: string } | { unchanged: true } | { error: string }> {
    const gitDir = this.#gitDirFor(state);
    const env = { GIT_INDEX_FILE: join(gitDir, input.indexName) };
    const add = await this.#runGit([`--git-dir=${gitDir}`, `--work-tree=${input.workTree}`, "add", "-A"], { env });
    if (!add.ok) {
      return this.#plumbingFailure(state.upid, "add", add);
    }
    const writeTree = await this.#runGit([`--git-dir=${gitDir}`, "write-tree"], { env });
    const treeSha = writeTree.stdout.trim();
    if (!writeTree.ok || treeSha.length === 0) {
      return this.#plumbingFailure(state.upid, "write-tree", writeTree);
    }
    let parentSha: string | null = null;
    const head = await this.#runGit([`--git-dir=${gitDir}`, "rev-parse", "-q", "--verify", input.ref]);
    if (head.ok && head.stdout.trim().length > 0) {
      parentSha = head.stdout.trim();
    } else if (input.fallbackParentRef !== undefined) {
      const fallback = await this.#runGit([`--git-dir=${gitDir}`, "rev-parse", "-q", "--verify", input.fallbackParentRef]);
      if (fallback.ok && fallback.stdout.trim().length > 0) {
        parentSha = fallback.stdout.trim();
      }
    }
    if (parentSha === null && input.allowEmptyParent !== true) {
      return this.#plumbingFailure(state.upid, "rev-parse", head);
    }
    if (parentSha !== null) {
      // No-change guard: an identical tree produces no noise commit.
      const parentTree = await this.#runGit([`--git-dir=${gitDir}`, "rev-parse", `${parentSha}^{tree}`]);
      if (parentTree.ok && parentTree.stdout.trim() === treeSha) {
        return { unchanged: true };
      }
    }
    const commit = await this.#runGit([
      `--git-dir=${gitDir}`,
      "commit-tree",
      treeSha,
      ...(parentSha === null ? [] : ["-p", parentSha]),
      "-m",
      input.message,
    ]);
    const commitSha = commit.stdout.trim();
    if (!commit.ok || commitSha.length === 0) {
      return this.#plumbingFailure(state.upid, "commit-tree", commit);
    }
    const updateRef = await this.#runGit([`--git-dir=${gitDir}`, "update-ref", input.ref, commitSha]);
    if (!updateRef.ok) {
      return this.#plumbingFailure(state.upid, "update-ref", updateRef);
    }
    return { sha: commitSha };
  }

  #plumbingFailure(upid: string, op: string, result: GitCommandResult): { error: string } {
    const error = clampLine(result.stderr || result.stdout, 200) || `git ${op} failed`;
    this.#trace("tree.git.error", "error", upid, { op, message: error });
    void this.#traceLog(upid, op, false, clampLine(result.stderr, 120));
    return { error };
  }

  // ── publish internals ─────────────────────────────────────────────────────

  async #doPublish(
    state: TreeState,
    input: { name: string; description?: string },
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const upid = state.upid;
    const baseSlug = slugify(input.name) || slugify(upid) || "tree";
    // gh repo create with a bounded collision retry (<slug>, <slug>-2 … -9).
    let url: string | null = null;
    let lastError = "gh repo create failed";
    for (let suffix = 1; suffix <= SLUG_COLLISION_MAX_SUFFIX; suffix += 1) {
      const slug = suffix === 1 ? baseSlug : `${baseSlug}-${suffix}`;
      const created = await this.#runGh([
        "gh",
        "repo",
        "create",
        slug,
        "--private",
        ...(input.description === undefined || input.description.length === 0
          ? []
          : ["--description", clampLine(input.description, 300)]),
      ]);
      if (created.ok) {
        url = parseGitHubUrl(`${created.stdout}\n${created.stderr}`);
        lastError = url === null ? "gh repo create returned no repo URL" : lastError;
        break;
      }
      if (!/already exists/iu.test(`${created.stderr}${created.stdout}`)) {
        lastError = clampLine(created.stderr || created.stdout, 200) || lastError;
        break;
      }
      lastError = `name taken through ${slug}`;
    }
    if (url === null) {
      this.#trace("tree.git.error", "error", upid, { op: "publish.create", message: lastError });
      await this.#traceLog(upid, "publish", false, lastError);
      return { ok: false, error: lastError };
    }
    const gitDir = this.#gitDirFor(state);
    const remoteAdd = await this.#runGit([`--git-dir=${gitDir}`, "remote", "add", "origin", `${url}.git`]);
    if (!remoteAdd.ok) {
      await this.#runGit([`--git-dir=${gitDir}`, "remote", "set-url", "origin", `${url}.git`]);
    }
    // Push via gh's credential helper — argv array, no shell quoting, the PAT
    // never appears in argv or .git/config (it rides env → gh).
    const push = await this.#runGit(
      [
        `--git-dir=${gitDir}`,
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "push",
        "origin",
        "--all",
      ],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!push.ok) {
      const error = clampLine(push.stderr || push.stdout, 200) || "git push failed";
      this.#trace("tree.git.error", "error", upid, { op: "publish.push", message: error });
      await this.#traceLog(upid, "publish", false, error);
      return { ok: false, error };
    }
    // One draft PR per concept branch with commits — per-PR failures are
    // swallowed with traces (a missing PR never un-publishes the repo).
    const repoRef = ownerRepoFromUrl(url);
    const pitch = state.seed?.pitch ?? input.description ?? "";
    for (const [branch, commits] of state.branches) {
      if (!branch.startsWith("concept/") || commits <= 0 || repoRef === null) {
        continue;
      }
      const pr = await this.#runGh([
        "gh",
        "pr",
        "create",
        "--repo",
        repoRef,
        "--head",
        branch,
        "--base",
        "main",
        "--draft",
        "--title",
        `${branch}: kickoff mock`,
        "--body",
        `${pitch}\n\n---\nOpened by vibecode-room: this branch is the ${branch} kickoff-mock lane, committed live from the room's build loop.`,
      ]);
      if (!pr.ok) {
        this.#trace("tree.git.error", "warn", upid, { op: "publish.pr", branch, message: clampLine(pr.stderr, 200) });
      }
    }
    state.remoteUrl = url;
    this.#trace("tree.git.publish", "info", upid, { url });
    await this.#traceLog(upid, "publish", true, url);
    this.#onUpdate();
    return { ok: true, url };
  }

  // ── branch-rail internals ─────────────────────────────────────────────────

  // Common refusal for every branch op: rails exist ONLY for adopted trees
  // (local trees publish whole via publish(); SELF never adopts).
  #branchOpRefusal(upid: string, state: TreeState | undefined): { ok: false; error: string } | null {
    if (this.#gitUnavailable) {
      return { ok: false, error: "git unavailable" };
    }
    if (state === undefined) {
      return { ok: false, error: `no tree repo for ${upid}` };
    }
    if (state.mode !== "adopted") {
      return { ok: false, error: "branch rails are for adopted GitHub imports — local trees publish via publish-repo" };
    }
    return null;
  }

  // The per-upid in-flight guard: chain the op onto whatever branch op is
  // already running for this tree; the chain never rejects (ops return
  // {ok:false} instead of throwing, and a defensive catch seals the seam).
  #chainBranchOp<T>(state: TreeState, op: () => Promise<T>): Promise<T> {
    const run = state.branchOps.then(op, op);
    state.branchOps = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #fetchOriginMainOnce(state: TreeState): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
    const gitDir = this.#gitDirFor(state);
    const fetch = await this.#runGit(
      [`--git-dir=${gitDir}`, ...CREDENTIAL_ARGV, "fetch", `--depth=${FETCH_DEPTH}`, "origin", "main"],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!fetch.ok) {
      const error = clampLine(fetch.stderr || fetch.stdout, 200) || "git fetch origin main failed";
      this.#trace("tree.git.error", "error", state.upid, { op: "fetch.origin.main", message: error });
      await this.#traceLog(state.upid, "fetch origin main", false, error);
      return { ok: false, error };
    }
    // FETCH_HEAD is written by every fetch regardless of the single-branch
    // clone's refspec config — THE honest origin/main tip for branch bases.
    const tip = await this.#runGit([`--git-dir=${gitDir}`, "rev-parse", "FETCH_HEAD"]);
    const sha = tip.stdout.trim();
    if (!tip.ok || sha.length === 0) {
      const error = clampLine(tip.stderr, 200) || "FETCH_HEAD unresolvable after fetch";
      this.#trace("tree.git.error", "error", state.upid, { op: "fetch.origin.main", message: error });
      await this.#traceLog(state.upid, "fetch origin main", false, error);
      return { ok: false, error };
    }
    state.originMainSha = sha;
    await this.#traceLog(state.upid, "fetch origin main", true, sha);
    return { ok: true, sha };
  }

  async #createBranchOnce(state: TreeState, name: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
    const slug = roomSlug(name);
    if (slug === null) {
      return { ok: false, error: `"${clampLine(name, 60)}" leaves no usable branch name` };
    }
    const branch = `room/${slug}`;
    if (state.branches.has(branch)) {
      return { ok: true, branch };
    }
    const fetched = await this.#fetchOriginMainOnce(state);
    if (!fetched.ok) {
      return fetched;
    }
    const updateRef = await this.#runGit([`--git-dir=${this.#gitDirFor(state)}`, "update-ref", `refs/heads/${branch}`, fetched.sha]);
    if (!updateRef.ok) {
      const error = clampLine(updateRef.stderr || updateRef.stdout, 200) || "git update-ref failed";
      this.#trace("tree.git.error", "error", state.upid, { op: "branch.create", branch, message: error });
      await this.#traceLog(state.upid, `branch ${branch}`, false, error);
      return { ok: false, error };
    }
    // Register IMMEDIATELY: the wall's snapshot.treeRepo must show the branch
    // the moment the action lands, before any commit exists on it.
    state.branches.set(branch, 0);
    this.#trace("tree.git.branch", "info", state.upid, { branch, base: fetched.sha });
    await this.#traceLog(state.upid, `branch ${branch}`, true, fetched.sha);
    this.#onUpdate();
    return { ok: true, branch };
  }

  async #commitBranchOnce(
    state: TreeState,
    branch: string,
    message: string,
  ): Promise<{ ok: true; branch: string; changed: boolean } | { ok: false; error: string }> {
    const slug = roomSlug(branch);
    if (slug === null) {
      return { ok: false, error: `"${clampLine(branch, 60)}" names no room/* branch` };
    }
    const branchName = `room/${slug}`;
    const ref = `refs/heads/${branchName}`;
    const gitDir = this.#gitDirFor(state);
    const head = await this.#runGit([`--git-dir=${gitDir}`, "rev-parse", "-q", "--verify", ref]);
    if (!head.ok || head.stdout.trim().length === 0) {
      return { ok: false, error: `no branch ${branchName} — create it first` };
    }
    // Parent = the current room/<slug> tip (resolved again inside #commitTree);
    // per-op detached index; --work-tree = the clone itself. HEAD untouched.
    const committed = await this.#commitTree(state, {
      workTree: this.#repoDir(state.upid),
      indexName: `index.room-${slug}`,
      ref,
      message,
    });
    if ("error" in committed) {
      return { ok: false, error: committed.error };
    }
    if ("unchanged" in committed) {
      return { ok: true, branch: branchName, changed: false };
    }
    state.branches.set(branchName, (state.branches.get(branchName) ?? 0) + 1);
    this.#trace("tree.git.commit", "info", state.upid, { branch: branchName, message, sha: committed.sha });
    await this.#traceLog(state.upid, `commit ${branchName}`, true, message);
    this.#onUpdate();
    return { ok: true, branch: branchName, changed: true };
  }

  async #pushBranchOnce(state: TreeState, branch: string): Promise<{ ok: true; branch: string } | { ok: false; error: string }> {
    const slug = roomSlug(branch);
    if (slug === null) {
      return { ok: false, error: `"${clampLine(branch, 60)}" names no room/* branch` };
    }
    const branchName = `room/${slug}`;
    const ref = `refs/heads/${branchName}`;
    const push = await this.#runGit(
      [`--git-dir=${this.#gitDirFor(state)}`, ...CREDENTIAL_ARGV, "push", "origin", `${ref}:${ref}`],
      { timeoutMs: PUSH_TIMEOUT_MS },
    );
    if (!push.ok) {
      const error = clampLine(push.stderr || push.stdout, 200) || "git push failed";
      this.#trace("tree.git.error", "error", state.upid, { op: "branch.push", branch: branchName, message: error });
      await this.#traceLog(state.upid, `push ${branchName}`, false, error);
      return { ok: false, error };
    }
    await this.#traceLog(state.upid, `push ${branchName}`, true);
    return { ok: true, branch: branchName };
  }

  async #openPrOnce(
    state: TreeState,
    branch: string,
    title?: string,
    body?: string,
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
    const slug = roomSlug(branch);
    if (slug === null) {
      return { ok: false, error: `"${clampLine(branch, 60)}" names no room/* branch` };
    }
    const branchName = `room/${slug}`;
    const stored = state.prUrls.get(branchName);
    if (stored !== undefined) {
      return { ok: true, url: stored };
    }
    const repoRef = state.remoteUrl === null ? null : ownerRepoFromUrl(state.remoteUrl);
    if (repoRef === null) {
      return { ok: false, error: "no recorded origin for this adopted tree" };
    }
    const pr = await this.#runGh([
      "gh",
      "pr",
      "create",
      "--repo",
      repoRef,
      "--head",
      branchName,
      "--base",
      "main",
      "--title",
      clampLine(title !== undefined && title.length > 0 ? title : `room: ${slug}`, 120),
      "--body",
      body !== undefined && body.length > 0
        ? body
        : `Opened by vibecode-room: spoken changes committed live on ${branchName}.`,
    ]);
    const url = parsePrUrl(`${pr.stdout}\n${pr.stderr}`);
    if (!pr.ok) {
      // gh refuses a second PR for the same head — recover its URL when it
      // echoes one, keeping the op idempotent across room restarts.
      if (url !== null && /already exists/iu.test(`${pr.stderr}${pr.stdout}`)) {
        state.prUrls.set(branchName, url);
        this.#onUpdate();
        return { ok: true, url };
      }
      const error = clampLine(pr.stderr || pr.stdout, 200) || "gh pr create failed";
      this.#trace("tree.git.error", "error", state.upid, { op: "branch.pr", branch: branchName, message: error });
      await this.#traceLog(state.upid, `pr ${branchName}`, false, error);
      return { ok: false, error };
    }
    if (url === null) {
      return { ok: false, error: "gh pr create returned no PR URL" };
    }
    state.prUrls.set(branchName, url);
    this.#trace("tree.git.pr", "info", state.upid, { branch: branchName, url });
    await this.#traceLog(state.upid, `pr ${branchName}`, true, url);
    this.#onUpdate();
    return { ok: true, url };
  }

  // ── shared helpers ────────────────────────────────────────────────────────

  #adoptedState(upid: string, remoteUrl: string | null): TreeState {
    return {
      upid,
      mode: "adopted",
      seed: null,
      branches: new Map(),
      remoteUrl,
      laneChains: new Map(),
      ready: Promise.resolve(),
      publishing: null,
      branchOps: Promise.resolve(),
      originMainSha: null,
      prUrls: new Map(),
    };
  }

  #treeDir(upid: string): string {
    return join(this.#buildsRoot, upid, ".tree");
  }

  #repoDir(upid: string): string {
    return join(this.#buildsRoot, upid, "repo");
  }

  #gitDir(upid: string): string {
    return join(this.#treeDir(upid), ".git");
  }

  // THE gitdir for a tree's state: an adopted tree's repo IS the import clone
  // at builds/<upid>/repo/ — every internal op must resolve through this, not
  // the .tree/.git a local birth would own.
  #gitDirFor(state: TreeState): string {
    return state.mode === "adopted" ? join(this.#repoDir(state.upid), ".git") : this.#gitDir(state.upid);
  }

  #markGitUnavailable(detail: string): void {
    if (this.#gitUnavailable) {
      return;
    }
    this.#gitUnavailable = true;
    console.warn(`[tree-git] git unavailable — substrate disabled: ${clampLine(detail, 200)}`);
  }

  #trace(event: string, level: "info" | "warn" | "error", upid: string, meta: Record<string, unknown>): void {
    try {
      // sessionId is a placeholder — the composition's onTrace stamps the real
      // one before the event reaches the TraceProcessor.
      this.#onTrace({ event, level, sessionId: "tree-git", upid, meta });
    } catch {
      // Tracing is garnish — never a substrate failure.
    }
  }

  async #traceLog(upid: string, op: string, ok: boolean, detail?: string): Promise<void> {
    try {
      // Adopted trees log inside their clone's gitdir (audit: #gitDir hardcoded
      // .tree/.git and silently lost every adopted-tree line to a missing dir).
      const state = this.#trees.get(upid);
      const gitDir = state === undefined ? this.#gitDir(upid) : this.#gitDirFor(state);
      const line = `${new Date(this.#now()).toISOString()} ${op} ${ok ? "ok" : "error"}${detail === undefined ? "" : ` ${detail}`}\n`;
      await appendFile(join(gitDir, "trace.log"), line, "utf8");
    } catch {
      // The trace log is best-effort — a read-only disk never breaks a commit.
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One-line clamp for commit messages / traces (whitespace collapsed).
function clampLine(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : line.slice(0, max);
}

// Published repo names: lowercase [a-z0-9-], bounded.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/gu, "");
}

// The room/* namespace rail: a spoken/typed branch name (or an echoed
// "room/<slug>") normalizes to its bare slug, or null when nothing usable
// remains. Every branch op resolves refs through THIS — nothing outside
// refs/heads/room/* is ever written or pushed.
function roomSlug(name: string): string | null {
  const slug = slugify(name.replace(/^room\//u, ""));
  return slug.length === 0 ? null : slug;
}

// First https://github.com/<owner>/<repo>/pull/<n> in gh's output — the PR
// parse must keep the /pull/<n> tail (parseGitHubUrl deliberately strips it).
function parsePrUrl(output: string): string | null {
  const match = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/u.exec(output);
  return match === null ? null : match[0];
}

// First https://github.com/<owner>/<repo> in gh's output, normalized (no
// trailing .git / slash / punctuation).
function parseGitHubUrl(output: string): string | null {
  const match = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+/u.exec(output);
  if (match === null) {
    return null;
  }
  return match[0].replace(/\.git$/u, "");
}

function ownerRepoFromUrl(url: string): string | null {
  const match = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/u.exec(url);
  return match === null ? null : `${match[1]}/${match[2]}`;
}
