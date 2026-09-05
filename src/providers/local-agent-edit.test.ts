import { expect, test } from "bun:test";
import { replaceUniqueText } from "./local-agent";

test("small local edits preserve the rest of a large module", () => {
  const prefix = "// unchanged\n".repeat(2000);
  expect(replaceUniqueText(prefix + "<h2>Projects</h2>\n", "<h2>Projects</h2>", "<h2>Room</h2>"))
    .toBe(prefix + "<h2>Room</h2>\n");
  expect(() => replaceUniqueText("two two", "two", "one")).toThrow("exactly once");
  expect(() => replaceUniqueText("before", "missing", "after")).toThrow("exactly once");
  expect(() => replaceUniqueText("before", "", "after")).toThrow("nonempty");
});

test("source search reports file/line evidence without searching secrets or symlinks", async () => {
  const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { searchLocalSource } = await import("./local-agent");
  const dir = await mkdtemp(join(tmpdir(), "local-search-"));
  try {
    await mkdir(join(dir, "src")); await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src/Panel.tsx"), "// panel\n<h2>Projects</h2>\n");
    await writeFile(join(dir, ".env"), "Projects secret");
    await writeFile(join(dir, "node_modules/noise.ts"), "Projects noise");
    await symlink(tmpdir(), join(dir, "escape"));
    const found = await searchLocalSource(dir, dir, "projects", AbortSignal.timeout(1000));
    expect(found).toBe("src/Panel.tsx:2: <h2>Projects</h2>");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
