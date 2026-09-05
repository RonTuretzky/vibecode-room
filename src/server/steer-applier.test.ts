import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySteerEdit, steerApplierEnabled, type SteerApplierGit } from "./notes-writer";

// The steer applier over a tmpdir repoDir (the injectable fs root) and a fake
// treeGit (the commit seam) — no real clone, no git subprocess, ever.

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeRepoDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-steer-applier-"));
  tempDirs.push(dir);
  return dir;
}

function fakeGit(
  result: Awaited<ReturnType<SteerApplierGit["commitBranchWithEdit"]>> = { ok: true, branch: "room/demo", changed: true },
): { calls: Array<{ upid: string; branch: string; message: string }>; git: SteerApplierGit } {
  const calls: Array<{ upid: string; branch: string; message: string }> = [];
  return {
    calls,
    git: {
      // Mirrors the substrate contract: the edit callback runs INSIDE the
      // chained op, BEFORE the commit is recorded.
      async commitBranchWithEdit(upid, branch, message, edit) {
        await edit();
        calls.push({ upid, branch, message });
        return result;
      },
    },
  };
}

describe("applySteerEdit — ROOM-NOTES.md", () => {
  test("appends a dated entry and commits with the clamped room: message", async () => {
    const repoDir = makeRepoDir();
    const { calls, git } = fakeGit();
    const result = await applySteerEdit({
      repoDir,
      branch: "room/demo",
      text: "make the header cobalt blue",
      upid: "upid-1",
      treeGit: git,
      now: () => Date.parse("2026-08-10T20:00:00.000Z"),
      env: {},
    });

    expect(result).toEqual({ ok: true, branch: "room/demo", unchanged: false });
    const notes = readFileSync(join(repoDir, "ROOM-NOTES.md"), "utf8");
    expect(notes).toBe("## 2026-08-10T20:00:00.000Z — spoken in the room\n\nmake the header cobalt blue\n");
    expect(calls).toEqual([{ upid: "upid-1", branch: "room/demo", message: "room: make the header cobalt blue" }]);
  });

  test("a second slice appends a second entry separated by a blank line", async () => {
    const repoDir = makeRepoDir();
    const { git } = fakeGit();
    const options = { repoDir, branch: "room/demo", upid: "upid-1", treeGit: git, env: {} };
    await applySteerEdit({ ...options, text: "first change", now: () => 0 });
    await applySteerEdit({ ...options, text: "second change", now: () => 1_000 });

    const notes = readFileSync(join(repoDir, "ROOM-NOTES.md"), "utf8");
    expect(notes).toContain("first change\n\n## ");
    expect(notes).toContain("second change\n");
    expect(notes.match(/## /gu)).toHaveLength(2);
  });

  test("the commit message clamps to 60 chars after the room: prefix", async () => {
    const repoDir = makeRepoDir();
    const { calls, git } = fakeGit();
    const spoken = "please make the welcome banner say hello to absolutely everybody who ever walks in";
    await applySteerEdit({ repoDir, branch: "room/demo", text: spoken, upid: "upid-1", treeGit: git, env: {} });

    expect(calls).toHaveLength(1);
    const message = calls[0]!.message;
    expect(message.startsWith("room: ")).toBe(true);
    expect(message.length).toBe("room: ".length + 60);
    // The full text still lands in the notes, unclamped.
    expect(readFileSync(join(repoDir, "ROOM-NOTES.md"), "utf8")).toContain(spoken);
  });
});

describe("applySteerEdit — dashboard insertion", () => {
  test("text naming a target inserts one marked block after <body> in dashboard/index.html", async () => {
    const repoDir = makeRepoDir();
    mkdirSync(join(repoDir, "dashboard"), { recursive: true });
    writeFileSync(join(repoDir, "dashboard", "index.html"), "<html><body><h1>App</h1></body></html>", "utf8");
    const { git } = fakeGit();
    await applySteerEdit({
      repoDir,
      branch: "room/demo",
      text: "add a welcome message for guests",
      upid: "upid-1",
      treeGit: git,
      env: {},
    });

    const html = readFileSync(join(repoDir, "dashboard", "index.html"), "utf8");
    expect(html).toContain("<!-- room:room/demo: add a welcome message for guests -->");
    expect(html).toContain('<p class="room-note">add a welcome message for guests</p>');
    // Inserted right after the opening <body>, before the existing content.
    expect(html.indexOf("<body>")).toBeLessThan(html.indexOf("room-note"));
    expect(html.indexOf("room-note")).toBeLessThan(html.indexOf("<h1>"));
  });

  test("a second slice on the same branch never stacks a second note (marker idempotence)", async () => {
    const repoDir = makeRepoDir();
    mkdirSync(join(repoDir, "dashboard"), { recursive: true });
    writeFileSync(join(repoDir, "dashboard", "index.html"), "<html><body></body></html>", "utf8");
    const { git } = fakeGit();
    const options = { repoDir, branch: "room/demo", upid: "upid-1", treeGit: git, env: {} };
    await applySteerEdit({ ...options, text: "put a note on the board" });
    await applySteerEdit({ ...options, text: "another note please" });

    const html = readFileSync(join(repoDir, "dashboard", "index.html"), "utf8");
    expect(html.match(/room-note/gu)).toHaveLength(1);
    expect(html.match(/<!-- room:room\/demo/gu)).toHaveLength(1);
    // A DIFFERENT branch's marker is independent — one more insertion allowed.
    await applySteerEdit({ ...options, branch: "room/other", text: "note for the other branch" });
    expect(readFileSync(join(repoDir, "dashboard", "index.html"), "utf8").match(/room-note/gu)).toHaveLength(2);
  });

  test("no dashboard/index.html means notes-only — still ok, no file created", async () => {
    const repoDir = makeRepoDir();
    const { git } = fakeGit();
    const result = await applySteerEdit({
      repoDir,
      branch: "room/demo",
      text: "update the welcome copy",
      upid: "upid-1",
      treeGit: git,
      env: {},
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(repoDir, "dashboard", "index.html"))).toBe(false);
    expect(existsSync(join(repoDir, "ROOM-NOTES.md"))).toBe(true);
  });

  test("text naming no target leaves the dashboard untouched", async () => {
    const repoDir = makeRepoDir();
    mkdirSync(join(repoDir, "dashboard"), { recursive: true });
    const original = "<html><body><h1>App</h1></body></html>";
    writeFileSync(join(repoDir, "dashboard", "index.html"), original, "utf8");
    const { git } = fakeGit();
    await applySteerEdit({ repoDir, branch: "room/demo", text: "tighten the api retry loop", upid: "upid-1", treeGit: git, env: {} });
    expect(readFileSync(join(repoDir, "dashboard", "index.html"), "utf8")).toBe(original);
  });

  test("a document without <body> gets the block prepended at the top", async () => {
    const repoDir = makeRepoDir();
    mkdirSync(join(repoDir, "dashboard"), { recursive: true });
    writeFileSync(join(repoDir, "dashboard", "index.html"), "<div>fragment</div>", "utf8");
    const { git } = fakeGit();
    await applySteerEdit({ repoDir, branch: "room/demo", text: "note this down", upid: "upid-1", treeGit: git, env: {} });
    const html = readFileSync(join(repoDir, "dashboard", "index.html"), "utf8");
    expect(html.startsWith("<!-- room:room/demo")).toBe(true);
    expect(html.endsWith("<div>fragment</div>")).toBe(true);
  });
});

describe("applySteerEdit — honesty", () => {
  test("VIBERSYN_STEER_APPLIER=0 disables everything: no fs writes, no commit", async () => {
    const repoDir = makeRepoDir();
    const { calls, git } = fakeGit();
    const result = await applySteerEdit({
      repoDir,
      branch: "room/demo",
      text: "make the header blue",
      upid: "upid-1",
      treeGit: git,
      env: { VIBERSYN_STEER_APPLIER: "0" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("VIBERSYN_STEER_APPLIER");
    expect(existsSync(join(repoDir, "ROOM-NOTES.md"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("the default gate is ON; explicit 1 is ON; only 0 disables", () => {
    expect(steerApplierEnabled({})).toBe(true);
    expect(steerApplierEnabled({ VIBERSYN_STEER_APPLIER: "1" })).toBe(true);
    expect(steerApplierEnabled({ VIBERSYN_STEER_APPLIER: "0" })).toBe(false);
  });

  test("whitespace-only text refuses without touching fs or git", async () => {
    const repoDir = makeRepoDir();
    const { calls, git } = fakeGit();
    const result = await applySteerEdit({ repoDir, branch: "room/demo", text: "  \n  ", upid: "upid-1", treeGit: git, env: {} });
    expect(result.ok).toBe(false);
    expect(existsSync(join(repoDir, "ROOM-NOTES.md"))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("a failed commit surfaces the substrate's honest error", async () => {
    const repoDir = makeRepoDir();
    const { git } = fakeGit({ ok: false, error: "no branch room/demo — create it first" });
    const result = await applySteerEdit({ repoDir, branch: "room/demo", text: "make it blue", upid: "upid-1", treeGit: git, env: {} });
    expect(result).toEqual({ ok: false, error: "no branch room/demo — create it first" });
  });

  test("an unchanged working tree reports unchanged instead of inventing a sha", async () => {
    const repoDir = makeRepoDir();
    const { git } = fakeGit({ ok: true, branch: "room/demo", changed: false });
    const result = await applySteerEdit({ repoDir, branch: "room/demo", text: "make it blue", upid: "upid-1", treeGit: git, env: {} });
    expect(result).toEqual({ ok: true, branch: "room/demo", unchanged: true });
  });

  test("an unwritable repoDir returns {ok:false} instead of throwing", async () => {
    const { calls, git } = fakeGit();
    const result = await applySteerEdit({
      repoDir: join(tmpdir(), "vibersyn-steer-applier-missing", "nope"),
      branch: "room/demo",
      text: "make it blue",
      upid: "upid-1",
      treeGit: git,
      env: {},
    });
    expect(result.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
