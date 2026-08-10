import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TreeGitSubstrate,
  treeGitEnabled,
  type GitCommandResult,
  type GitCommandRunner,
  type TreeSeed,
} from "./tree-git";
import type { ForestCommandRunner } from "./github-org";
import type { LogEvent } from "../types";

// Unit coverage for the git substrate ("tree = repo"). The GitCommandRunner is
// a SCRIPTED FAKE with just enough git semantics (staged tree per index file,
// commit graph, refs) that parent chaining / the identical-tree skip are
// honest — NO test here ever spawns a real git or gh subprocess. The fs is
// real (temp buildsRoot) so seed files and trace.log are genuinely written.

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "tree-git-"));
  roots.push(root);
  return root;
}

function ok(stdout = ""): GitCommandResult {
  return { ok: true, stdout, stderr: "" };
}

function fail(stderr: string): GitCommandResult {
  return { ok: false, stdout: "", stderr };
}

interface RecordedCall {
  argv: string[];
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

// The git subcommand of a recorded argv (skipping --git-dir/--work-tree/-c).
function subcommandOf(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-c") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      continue;
    }
    return arg;
  }
  return "";
}

// Scripted git with a real-enough model: per-index staged trees are content
// hashes of the --work-tree directory (so an unchanged lane produces the SAME
// tree sha), commit-tree grows a parent-linked graph, update-ref moves refs.
class FakeGit {
  readonly calls: RecordedCall[] = [];
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, { tree: string; parent: string | null; message: string }>();
  readonly staged = new Map<string, string>();
  remoteUrl: string | null = null;
  pushes: RecordedCall[] = [];
  failInit = false;
  readonly failSubcommands = new Set<string>();
  #seq = 0;

  readonly run: GitCommandRunner = async (argv, opts) => {
    this.calls.push({ argv, env: opts?.env, timeoutMs: opts?.timeoutMs });
    const positional: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index]!;
      if (arg === "-c") {
        index += 1;
        continue;
      }
      if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
        continue;
      }
      positional.push(arg);
    }
    const cmd = positional[0] ?? "";
    if (this.failSubcommands.has(cmd)) {
      return fail(`${cmd}: scripted failure`);
    }
    switch (cmd) {
      case "init": {
        if (this.failInit) {
          return fail("git: command not found");
        }
        // Real git creates the gitdir — the substrate's trace.log lands there.
        mkdirSync(join(positional[positional.length - 1]!, ".git"), { recursive: true });
        return ok("");
      }
      case "symbolic-ref":
        return ok("");
      case "add": {
        const workTree = argv.find((arg) => arg.startsWith("--work-tree="))?.slice("--work-tree=".length);
        const index = opts?.env?.GIT_INDEX_FILE;
        if (workTree === undefined || index === undefined) {
          return fail("add without work-tree/index");
        }
        this.staged.set(index, await digestDir(workTree));
        return ok("");
      }
      case "write-tree": {
        const index = opts?.env?.GIT_INDEX_FILE;
        const tree = index === undefined ? undefined : this.staged.get(index);
        return tree === undefined ? fail("nothing staged") : ok(tree);
      }
      case "rev-parse": {
        const target = positional[positional.length - 1]!;
        if (target.endsWith("^{tree}")) {
          const commit = this.commits.get(target.slice(0, -"^{tree}".length));
          return commit === undefined ? fail("unknown commit") : ok(commit.tree);
        }
        const sha = this.refs.get(target);
        return sha === undefined ? fail("") : ok(sha);
      }
      case "commit-tree": {
        const tree = positional[1]!;
        const parentIndex = positional.indexOf("-p");
        const messageIndex = positional.indexOf("-m");
        this.#seq += 1;
        const sha = `commit-${this.#seq}`;
        this.commits.set(sha, {
          tree,
          parent: parentIndex >= 0 ? positional[parentIndex + 1]! : null,
          message: positional[messageIndex + 1] ?? "",
        });
        return ok(sha);
      }
      case "update-ref": {
        this.refs.set(positional[1]!, positional[2]!);
        return ok("");
      }
      case "for-each-ref":
        return ok(
          [...this.refs.keys()].map((ref) => ref.replace("refs/heads/", "")).join("\n"),
        );
      case "rev-list": {
        const branch = positional[positional.length - 1]!;
        let sha: string | undefined = this.refs.get(`refs/heads/${branch}`) ?? this.refs.get(branch);
        let count = 0;
        while (sha !== undefined) {
          count += 1;
          sha = this.commits.get(sha)?.parent ?? undefined;
        }
        return ok(String(count));
      }
      case "remote": {
        this.remoteUrl = positional[positional.length - 1]!;
        return ok("");
      }
      case "push": {
        this.pushes.push({ argv, env: opts?.env, timeoutMs: opts?.timeoutMs });
        return ok("");
      }
      default:
        return fail(`unscripted git subcommand: ${cmd}`);
    }
  };

  messageOf(ref: string): string | undefined {
    const sha = this.refs.get(ref);
    return sha === undefined ? undefined : this.commits.get(sha)?.message;
  }
}

// Stable content digest of a directory — the fake's "tree sha".
async function digestDir(dir: string): Promise<string> {
  const lines: string[] = [];
  async function walk(current: string, prefix: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path, `${prefix}${entry.name}/`);
      } else {
        lines.push(`${prefix}${entry.name}:${await Bun.file(path).text()}`);
      }
    }
  }
  await walk(dir, "").catch(() => undefined);
  return `tree-${Bun.hash(lines.join("|")).toString(16)}`;
}

// Scripted gh: repo create succeeds (after N scripted name collisions) and
// echoes the created URL like the real CLI; pr create records and succeeds.
function makeGhFake(options: { collisions?: number } = {}): { calls: string[][]; run: ForestCommandRunner } {
  const calls: string[][] = [];
  let collisions = options.collisions ?? 0;
  const run: ForestCommandRunner = async (argv) => {
    calls.push(argv);
    if (argv[1] === "repo" && argv[2] === "create") {
      if (collisions > 0) {
        collisions -= 1;
        return { ok: false, stdout: "", stderr: `GraphQL: Name already exists on this account (createRepository)` };
      }
      return { ok: true, stdout: `https://github.com/roomowner/${argv[3]}\n`, stderr: "" };
    }
    if (argv[1] === "pr" && argv[2] === "create") {
      return { ok: true, stdout: "https://github.com/roomowner/x/pull/1\n", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: "unscripted gh" };
  };
  return { calls, run };
}

const SEED: TreeSeed = {
  ideaId: "idea-1",
  pitch: "a garden kiosk that waters itself on voice command",
  callsign: "fern",
  brief: { pitch: "a garden kiosk", sourceQuote: "as heard", rationale: "", qa: [], callsign: "fern" },
  planQuestions: [{ id: "q1", prompt: "Who is v1 for?", answers: ["home", "office"] }],
};

function makeSubstrate(overrides: { gh?: ForestCommandRunner } = {}): {
  root: string;
  git: FakeGit;
  traces: LogEvent[];
  substrate: TreeGitSubstrate;
} {
  const root = tempRoot();
  const git = new FakeGit();
  const traces: LogEvent[] = [];
  const substrate = new TreeGitSubstrate({
    buildsRoot: root,
    runGit: git.run,
    runGh: overrides.gh ?? makeGhFake().run,
    onTrace: (event) => traces.push(event),
    now: () => 1_754_000_000_000,
  });
  return { root, git, traces, substrate };
}

describe("treeGitEnabled — kill-switch", () => {
  test("default ON; VIBERSYN_TREE_GIT=0 disables", () => {
    expect(treeGitEnabled({})).toBe(true);
    expect(treeGitEnabled({ VIBERSYN_TREE_GIT: "1" })).toBe(true);
    expect(treeGitEnabled({ VIBERSYN_TREE_GIT: "0" })).toBe(false);
  });
});

describe("TreeGitSubstrate — birth", () => {
  test("fresh birth writes README.md + seed.json and runs init → add → write-tree → rev-parse → commit-tree → update-ref on main", async () => {
    const { root, git, substrate } = makeSubstrate();
    await substrate.birth("upid-1", SEED);

    const treeDir = join(root, "upid-1", ".tree");
    expect(await Bun.file(join(treeDir, "README.md")).text()).toContain(SEED.pitch);
    const seedJson = JSON.parse(await readFile(join(treeDir, "seed.json"), "utf8")) as Record<string, unknown>;
    expect(seedJson.upid).toBe("upid-1");
    expect(seedJson.pitch).toBe(SEED.pitch);
    expect(seedJson.ideaId).toBe("idea-1");
    expect(seedJson.planQuestions).toEqual(SEED.planQuestions as unknown);

    expect(git.calls.map((call) => subcommandOf(call.argv))).toEqual([
      "init",
      "add",
      "write-tree",
      "rev-parse",
      "commit-tree",
      "update-ref",
    ]);
    // init lands the gitdir at builds/<upid>/.tree/.git, template-free, on main.
    expect(git.calls[0]!.argv).toEqual(["init", "--template=", "-b", "main", treeDir]);
    // The seed commit stages the SEED WORKTREE via its own index file.
    const gitDir = join(treeDir, ".git");
    expect(git.calls[1]!.argv).toContain(`--git-dir=${gitDir}`);
    expect(git.calls[1]!.argv).toContain(`--work-tree=${treeDir}`);
    expect(git.calls[1]!.env?.GIT_INDEX_FILE).toBe(join(gitDir, "index.seed"));
    // First commit on main: no parent, message = clamped pitch.
    const main = git.refs.get("refs/heads/main");
    expect(main).toBeDefined();
    expect(git.commits.get(main!)?.parent).toBeNull();
    expect(git.commits.get(main!)?.message).toBe(`seed: ${SEED.pitch.slice(0, 60)}`);
    expect(substrate.snapshot("upid-1")).toEqual({
      branches: [{ name: "main", commits: 1 }],
      remoteUrl: null,
    });
    expect(substrate.seedPitch("upid-1")).toBe(SEED.pitch);
  });

  test("birth is idempotent: a same-pitch re-accept issues no second init and no commit", async () => {
    const { git, substrate } = makeSubstrate();
    await substrate.birth("upid-2", SEED);
    const callsAfterFirst = git.calls.length;

    await substrate.birth("upid-2", SEED);
    expect(git.calls.length).toBe(callsAfterFirst);
    expect(substrate.snapshot("upid-2")?.branches).toEqual([{ name: "main", commits: 1 }]);
  });

  test("a re-accept with a CHANGED pitch re-commits the seed files on main (no history rewrite)", async () => {
    const { root, git, substrate } = makeSubstrate();
    await substrate.birth("upid-3", SEED);
    const firstMain = git.refs.get("refs/heads/main")!;

    await substrate.birth("upid-3", { ...SEED, pitch: "a kiosk that also sings" });
    expect(git.calls.filter((call) => subcommandOf(call.argv) === "init")).toHaveLength(1);
    const secondMain = git.refs.get("refs/heads/main")!;
    expect(secondMain).not.toBe(firstMain);
    expect(git.commits.get(secondMain)?.parent).toBe(firstMain);
    expect(git.commits.get(secondMain)?.message).toBe("seed: re-accept — a kiosk that also sings");
    expect(substrate.snapshot("upid-3")?.branches).toEqual([{ name: "main", commits: 2 }]);
    expect(await Bun.file(join(root, "upid-3", ".tree", "README.md")).text()).toContain("a kiosk that also sings");
  });

  test("clone detection: builds/<upid>/repo/.git on disk means ADOPTED — zero init calls, publish refuses", async () => {
    const { root, git, substrate } = makeSubstrate();
    mkdirSync(join(root, "upid-4", "repo", ".git"), { recursive: true });

    await substrate.birth("upid-4", SEED);
    expect(git.calls).toHaveLength(0);
    expect(existsSync(join(root, "upid-4", ".tree"))).toBe(false);

    substrate.adopt("upid-4", "https://github.com/acme/widget");
    expect(substrate.snapshot("upid-4")).toEqual({ branches: [], remoteUrl: "https://github.com/acme/widget" });

    const published = await substrate.publish("upid-4", { name: "widget" });
    expect(published.ok).toBe(false);
    // Commits refuse too — the adopted clone is never written by the substrate.
    await substrate.commitLane("upid-4", "native", join(root, "upid-4", "native"), "native: concept mock");
    expect(git.calls).toHaveLength(0);
  });

  test("missing git binary: exactly one warn, then every later op is a zero-call no-op", async () => {
    const { git, substrate } = makeSubstrate();
    git.failInit = true;
    const warns: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(" "));
    };
    try {
      await substrate.birth("upid-5", SEED);
      // init + the old-git fallback init, then the substrate flips unavailable.
      expect(git.calls.map((call) => subcommandOf(call.argv))).toEqual(["init", "init"]);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("[tree-git] git unavailable");

      await substrate.birth("upid-6", SEED);
      await substrate.commitLane("upid-5", "native", "/nowhere", "native: concept mock");
      const published = await substrate.publish("upid-5", { name: "kiosk" });
      expect(published).toEqual({ ok: false, error: "git unavailable" });
      expect(git.calls).toHaveLength(2);
      expect(warns).toHaveLength(1);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("TreeGitSubstrate — commitLane plumbing", () => {
  test("first lane commit branches off main; the next chains the lane head; identical trees are skipped", async () => {
    const { root, git, substrate } = makeSubstrate();
    await substrate.birth("upid-7", SEED);
    const laneDir = join(root, "upid-7", "native");
    await Bun.write(join(laneDir, "index.html"), "<h1>one</h1>");

    await substrate.commitLane("upid-7", "native", laneDir, "native: concept mock");
    const first = git.refs.get("refs/heads/concept/native")!;
    expect(git.commits.get(first)?.parent).toBe(git.refs.get("refs/heads/main")!);
    expect(git.commits.get(first)?.message).toBe("native: concept mock");

    await Bun.write(join(laneDir, "index.html"), "<h1>two — bluer</h1>");
    await substrate.commitLane("upid-7", "native", laneDir, "native: revision 1 — make it bluer");
    const second = git.refs.get("refs/heads/concept/native")!;
    expect(second).not.toBe(first);
    expect(git.commits.get(second)?.parent).toBe(first);
    expect(substrate.snapshot("upid-7")?.branches).toEqual([
      { name: "main", commits: 1 },
      { name: "concept/native", commits: 2 },
    ]);

    // No-change guard: an identical tree produces NO noise commit.
    await substrate.commitLane("upid-7", "native", laneDir, "native: revision 2 — no-op");
    expect(git.refs.get("refs/heads/concept/native")).toBe(second);
    expect(substrate.snapshot("upid-7")?.branches[1]).toEqual({ name: "concept/native", commits: 2 });
  });

  test("concurrent lanes use DISTINCT index files and land on their own branches", async () => {
    const { root, git, substrate } = makeSubstrate();
    await substrate.birth("upid-8", SEED);
    const nativeDir = join(root, "upid-8", "native");
    const smithersDir = join(root, "upid-8", "smithers");
    await Bun.write(join(nativeDir, "index.html"), "<h1>native</h1>");
    await Bun.write(join(smithersDir, "index.html"), "<h1>smithers</h1>");

    await Promise.all([
      substrate.commitLane("upid-8", "native", nativeDir, "native: concept mock"),
      substrate.commitLane("upid-8", "smithers", smithersDir, "smithers: hero mock"),
    ]);

    const gitDir = join(root, "upid-8", ".tree", ".git");
    const addIndexes = git.calls
      .filter((call) => subcommandOf(call.argv) === "add" && call.env?.GIT_INDEX_FILE !== join(gitDir, "index.seed"))
      .map((call) => call.env?.GIT_INDEX_FILE);
    expect(new Set(addIndexes)).toEqual(new Set([join(gitDir, "index.native"), join(gitDir, "index.smithers")]));
    expect(git.messageOf("refs/heads/concept/native")).toBe("native: concept mock");
    expect(git.messageOf("refs/heads/concept/smithers")).toBe("smithers: hero mock");
    // Both lanes branch off main independently.
    expect(git.commits.get(git.refs.get("refs/heads/concept/native")!)?.parent).toBe(git.refs.get("refs/heads/main")!);
    expect(git.commits.get(git.refs.get("refs/heads/concept/smithers")!)?.parent).toBe(git.refs.get("refs/heads/main")!);
  });

  test("a runner failure is swallowed (never rejects), traced, and logged to trace.log", async () => {
    const { root, git, traces, substrate } = makeSubstrate();
    await substrate.birth("upid-9", SEED);
    const laneDir = join(root, "upid-9", "native");
    await Bun.write(join(laneDir, "index.html"), "<h1>doomed</h1>");
    git.failSubcommands.add("commit-tree");

    await substrate.commitLane("upid-9", "native", laneDir, "native: concept mock");
    expect(git.refs.has("refs/heads/concept/native")).toBe(false);
    expect(traces.some((event) => event.event === "tree.git.error")).toBe(true);
    const log = await readFile(join(root, "upid-9", ".tree", ".git", "trace.log"), "utf8");
    expect(log).toContain("commit-tree error");
  });

  test("commitLane refuses before birth (unborn state): zero runner calls", async () => {
    const { git, substrate } = makeSubstrate();
    await substrate.commitLane("upid-never", "native", "/nowhere", "native: concept mock");
    expect(git.calls).toHaveLength(0);
  });
});

describe("TreeGitSubstrate — publish (commission only)", () => {
  test("collision retry, remote add, credential-helper push, one draft PR per concept branch, idempotent re-publish", async () => {
    const gh = makeGhFake({ collisions: 1 });
    const { root, git, substrate } = makeSubstrate({ gh: gh.run });
    await substrate.birth("upid-10", SEED);
    const laneDir = join(root, "upid-10", "native");
    await Bun.write(join(laneDir, "index.html"), "<h1>mock</h1>");
    await substrate.commitLane("upid-10", "native", laneDir, "native: concept mock");

    const result = await substrate.publish("upid-10", { name: "Garden Kiosk!", description: SEED.pitch });
    expect(result).toEqual({ ok: true, url: "https://github.com/roomowner/garden-kiosk-2" });

    // repo create: PRIVATE, slugified, first name collided → -2 retry.
    const creates = gh.calls.filter((call) => call[1] === "repo" && call[2] === "create");
    expect(creates.map((call) => call[3])).toEqual(["garden-kiosk", "garden-kiosk-2"]);
    for (const create of creates) {
      expect(create).toContain("--private");
    }
    // remote add + credential-helper push (long timeout, PAT never in argv).
    expect(git.remoteUrl).toBe("https://github.com/roomowner/garden-kiosk-2.git");
    expect(git.pushes).toHaveLength(1);
    expect(git.pushes[0]!.argv).toContain("credential.helper=!gh auth git-credential");
    expect(git.pushes[0]!.timeoutMs).toBe(60_000);
    const everyArg = [...git.calls.map((call) => call.argv), ...gh.calls].flat().join(" ");
    expect(everyArg).not.toContain("ghp_");

    // Exactly one draft PR — the concept/native branch with commits.
    const prs = gh.calls.filter((call) => call[1] === "pr" && call[2] === "create");
    expect(prs).toHaveLength(1);
    expect(prs[0]).toContain("--draft");
    expect(prs[0]!.join(" ")).toContain("--repo roomowner/garden-kiosk-2");
    expect(prs[0]!.join(" ")).toContain("--head concept/native");
    expect(prs[0]![prs[0]!.indexOf("--title") + 1]).toBe("concept/native: kickoff mock");
    expect(prs[0]![prs[0]!.indexOf("--body") + 1]).toContain(SEED.pitch);

    expect(substrate.snapshot("upid-10")?.remoteUrl).toBe("https://github.com/roomowner/garden-kiosk-2");

    // Idempotent: a second publish returns the stored URL with ZERO new calls.
    const ghCallsBefore = gh.calls.length;
    const again = await substrate.publish("upid-10", { name: "Garden Kiosk!" });
    expect(again).toEqual({ ok: true, url: "https://github.com/roomowner/garden-kiosk-2" });
    expect(gh.calls.length).toBe(ghCallsBefore);
  });

  test("a failed gh repo create degrades to {ok:false} with a trace — nothing else runs", async () => {
    const failingGh: ForestCommandRunner = async () => ({ ok: false, stdout: "", stderr: "gh: not logged in" });
    const { git, traces, substrate } = makeSubstrate({ gh: failingGh });
    await substrate.birth("upid-11", SEED);
    const before = git.calls.length;

    const result = await substrate.publish("upid-11", { name: "kiosk" });
    expect(result.ok).toBe(false);
    expect(git.calls.length).toBe(before); // no remote add, no push
    expect(traces.some((event) => event.event === "tree.git.error")).toBe(true);
    expect(substrate.snapshot("upid-11")?.remoteUrl).toBeNull();
  });
});

describe("TreeGitSubstrate — snapshot & forget", () => {
  test("snapshot caps branches at 8 and is pure (no runner calls)", async () => {
    const { root, git, substrate } = makeSubstrate();
    await substrate.birth("upid-12", SEED);
    for (let lane = 1; lane <= 9; lane += 1) {
      const laneDir = join(root, "upid-12", `lane-${lane}`);
      await Bun.write(join(laneDir, "index.html"), `<h1>lane ${lane}</h1>`);
      await substrate.commitLane("upid-12", `lane-${lane}`, laneDir, `lane-${lane}: concept mock`);
    }
    const before = git.calls.length;
    const snapshot = substrate.snapshot("upid-12")!;
    expect(snapshot.branches).toHaveLength(8);
    expect(snapshot.branches[0]).toEqual({ name: "main", commits: 1 });
    expect(git.calls.length).toBe(before);

    substrate.forget("upid-12");
    expect(substrate.snapshot("upid-12")).toBeNull();
    // The disk repo stays — forget is memory only.
    expect(existsSync(join(root, "upid-12", ".tree", ".git"))).toBe(true);
  });

  test("snapshot is null for a tree that never birthed", () => {
    const { substrate } = makeSubstrate();
    expect(substrate.snapshot("upid-x")).toBeNull();
  });
});
