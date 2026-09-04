import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ExecutionRegistry } from "./execution";

test("a restarted commission preserves each previous version without serving it as a new result", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-history-"));
  try {
    for (const content of ["first session", "second session"]) {
      const registry = new ExecutionRegistry({ artifactsRoot: root, footprintPollMs: 0 });
      const dir = registry.artifactsDir("legacy-upid-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "index.html"), content);
      await registry.prepare("legacy-upid-1");
      expect(await Bun.file(join(dir, "index.html")).exists()).toBe(false);
    }
    const history = join(root, ".history", "legacy-upid-1");
    const versions = await readdir(history);
    expect(versions).toHaveLength(2);
    const saved = await Promise.all(versions.map((v) => readFile(join(history, v, "index.html"), "utf8")));
    expect(saved.sort()).toEqual(["first session", "second session"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
