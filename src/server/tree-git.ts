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
export interface TreeRepoSnapshot {
  branches: Array<{ name: string; commits: number }>;
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

  // Pure in-memory snapshot fragment — ZERO subprocesses per publish.
  snapshot(upid: string): TreeRepoSnapshot | null {
    const state = this.#trees.get(upid);
    if (state === undefined) {
      return null;
    }
    return {
      branches: [...state.branches.entries()]
        .slice(0, SNAPSHOT_BRANCH_CAP)
        .map(([name, commits]) => ({ name, commits })),
      remoteUrl: state.remoteUrl,
    };
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
      await this.#runGit([`--git-dir=${this.#gitDir(state.upid)}`, "symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    const sha = await this.#commitTree(state, {
      workTree: treeDir,
      indexName: "index.seed",
      ref: "refs/heads/main",
      message: `seed: ${clampLine(seed.pitch, SEED_MESSAGE_MAX_CHARS)}`,
      allowEmptyParent: true,
    });
    if (sha !== null) {
      state.branches.set("main", 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch: "main", message: "seed", sha });
      await this.#traceLog(state.upid, "birth", true);
    } else {
      await this.#traceLog(state.upid, "birth", false);
    }
  }

  // Re-accept of a repo from a previous session: the on-disk branches are the
  // truth — reseed the in-memory counters once (bounded), then re-commit the
  // seed files only when the pitch changed.
  async #rebirthFromDisk(state: TreeState, seed: TreeSeed): Promise<void> {
    const gitDir = this.#gitDir(state.upid);
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
    const sha = await this.#commitTree(state, {
      workTree: this.#treeDir(state.upid),
      indexName: "index.seed",
      ref: "refs/heads/main",
      message: `seed: re-accept — ${clampLine(seed.pitch, RESEED_MESSAGE_MAX_CHARS)}`,
    });
    if (sha !== null) {
      state.branches.set("main", (state.branches.get("main") ?? 0) + 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch: "main", message: "seed: re-accept", sha });
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
      const sha = await this.#commitTree(state, {
        workTree: laneDir,
        indexName: `index.${lane}`,
        ref,
        // First lane commit branches off main; later ones chain the lane head.
        fallbackParentRef: "refs/heads/main",
        message,
      });
      if (sha === null) {
        return;
      }
      const branch = `concept/${lane}`;
      state.branches.set(branch, (state.branches.get(branch) ?? 0) + 1);
      this.#trace("tree.git.commit", "info", state.upid, { branch, message, sha });
      await this.#traceLog(state.upid, `commit ${branch}`, true, message);
    } catch (error) {
      this.#trace("tree.git.error", "error", state.upid, { op: "commit", lane, message: messageOf(error) });
      await this.#traceLog(state.upid, `commit concept/${lane}`, false, messageOf(error));
    }
  }

  // add -A → write-tree → (skip when identical to parent's tree) →
  // commit-tree → update-ref. Returns the new commit sha, or null when
  // skipped/failed (failures are traced by the caller or here).
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
  ): Promise<string | null> {
    const gitDir = this.#gitDir(state.upid);
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
        return null;
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
    return commitSha;
  }

  #plumbingFailure(upid: string, op: string, result: GitCommandResult): null {
    this.#trace("tree.git.error", "error", upid, { op, message: clampLine(result.stderr || result.stdout, 200) });
    void this.#traceLog(upid, op, false, clampLine(result.stderr, 120));
    return null;
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
    const gitDir = this.#gitDir(upid);
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
    };
  }

  #treeDir(upid: string): string {
    return join(this.#buildsRoot, upid, ".tree");
  }

  #gitDir(upid: string): string {
    return join(this.#treeDir(upid), ".git");
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
      const line = `${new Date(this.#now()).toISOString()} ${op} ${ok ? "ok" : "error"}${detail === undefined ? "" : ` ${detail}`}\n`;
      await appendFile(join(this.#gitDir(upid), "trace.log"), line, "utf8");
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
