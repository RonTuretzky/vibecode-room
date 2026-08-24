// LABELLING THE ROOM'S OWN BRANCHES.
//
// The prune-everywhere lands the SAME revert commit on every branch that
// carried the pruned graft. With the tip subject as the label, twenty-odd
// branches all became 'Revert "self: make each tree's dancing dog a purple
// chihuahua"' and the version rail became unreadable — reported live twice
// ("the whole tree history is now reverts", "I still see a bunch of the revert
// titles on the list").
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectorRuntime, type ProjectorRuntimeOptions } from "./composition";

// for-each-ref's field separator (see selfBranches' --format).
const SEP = "";

const dirs: string[] = [];

// Scripted git: for-each-ref lists the rail, and `log` replays each branch's
// own commit subjects newest-first.
function scriptedGit(setup: {
  current: string;
  rail: Array<{ name: string; tip: string }>;
  log: Record<string, string[]>;
}): NonNullable<ProjectorRuntimeOptions["selfGitRunner"]> {
  return async (argv) => {
    const ok = (stdout = "") => ({ ok: true as const, stdout, stderr: "" });
    if (argv[0] === "branch" && argv[1] === "--show-current") {
      return ok(setup.current);
    }
    if (argv[0] === "for-each-ref") {
      return ok(setup.rail.map((entry) => `${entry.name}${SEP}${entry.tip}${SEP}1 hour ago`).join("\n"));
    }
    if (argv[0] === "log") {
      const ref = (argv[argv.length - 1] ?? "").replace(/^refs\/heads\//u, "");
      return ok((setup.log[ref] ?? []).join("\n"));
    }
    return ok();
  };
}

async function railFor(setup: Parameters<typeof scriptedGit>[0]) {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-labels-"));
  dirs.push(dir);
  const replayPath = join(dir, "mic.jsonl");
  writeFileSync(replayPath, "", "utf8");
  const runtime = await createProjectorRuntime(
    { VIBERSYN_MIC_REPLAY: replayPath, VIBERSYN_RESEARCH: "0", VIBERSYN_SKY_INTERVAL_MS: "0" },
    { selfGitRunner: scriptedGit(setup), exitProcess: () => undefined },
  );
  const payload = await runtime.selfBranches();
  for (const entry of dirs.splice(0)) {
    rmSync(entry, { recursive: true, force: true });
  }
  return payload;
}

const REVERT = 'Revert "self: make each tree\'s dancing dog a purple chihuahua"';

describe("selfBranches labelling", () => {
  test("THE LIVE BUG: a prune-everywhere must not rename the whole rail to the same revert", async () => {
    const payload = await railFor({
      current: "room/here",
      rail: [
        { name: "room/here", tip: REVERT },
        { name: "room/tulips", tip: REVERT },
        { name: "room/racks", tip: REVERT },
      ],
      log: {
        "room/here": [REVERT, "self: add a live wall clock to the room"],
        "room/tulips": [REVERT, "self: plant pink tulips around the base of every tree"],
        "room/racks": [REVERT, "self: manufacture GPU server racks at the tree's foot"],
      },
    });
    expect(payload.branches.map((branch) => branch.subject)).toEqual([
      "add a live wall clock to the room",
      "plant pink tulips around the base of every tree",
      "manufacture GPU server racks at the tree's foot",
    ]);
    // The whole point: no two rows read the same, and none reads as a revert.
    expect(new Set(payload.branches.map((branch) => branch.subject)).size).toBe(3);
    expect(payload.branches.some((branch) => branch.subject.startsWith("Revert"))).toBe(false);
  });

  test("the NEWEST spoken graft wins when a branch carries several", async () => {
    const payload = await railFor({
      current: "room/here",
      rail: [{ name: "room/here", tip: "chore: tidy" }],
      log: { "room/here": ["chore: tidy", "self: the newest graft", "self: an older graft"] },
    });
    expect(payload.branches[0]!.subject).toBe("the newest graft");
  });

  test("a branch with NO spoken graft keeps its tip subject — nothing better to call it", async () => {
    const payload = await railFor({
      current: "room/here",
      rail: [{ name: "room/here", tip: "every tree in one HD language" }],
      log: { "room/here": ["every tree in one HD language", "a hand commit"] },
    });
    expect(payload.branches[0]!.subject).toBe("every tree in one HD language");
  });

  test("a git failure leaves the tip subject rather than blanking the row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vibersyn-labels-"));
    dirs.push(dir);
    const replayPath = join(dir, "mic.jsonl");
    writeFileSync(replayPath, "", "utf8");
    const runtime = await createProjectorRuntime(
      { VIBERSYN_MIC_REPLAY: replayPath, VIBERSYN_RESEARCH: "0", VIBERSYN_SKY_INTERVAL_MS: "0" },
      {
        selfGitRunner: async (argv) => {
          if (argv[0] === "branch") {
            return { ok: true, stdout: "room/here", stderr: "" };
          }
          if (argv[0] === "for-each-ref") {
            return { ok: true, stdout: `room/here${SEP}${REVERT}${SEP}1 hour ago`, stderr: "" };
          }
          return { ok: false, stdout: "", stderr: "fatal: bad object" };
        },
        exitProcess: () => undefined,
      },
    );
    const payload = await runtime.selfBranches();
    expect(payload.branches[0]!.subject).toBe(REVERT);
    rmSync(dir, { recursive: true, force: true });
  });
});
