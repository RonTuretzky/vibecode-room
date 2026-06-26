import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildIdeaPreview, IdeaBuildRegistry, type IdeaPreview } from "./idea-builder";

// Real accept->build->preview unit coverage (no stubs): buildIdeaPreview writes
// real files into a fresh builds/<upid>/ and starts a real loopback static
// server. We assert the scaffolded files exist AND that an actual GET on the
// returned URL responds 200 with the page that reflects the pitch.

describe("idea-builder — real scaffold + live preview server", () => {
  const previews: IdeaPreview[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(previews.map((preview) => preview.stop().catch(() => undefined)));
    previews.length = 0;
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
    roots.length = 0;
  });

  async function tempRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "idea-builder-"));
    roots.push(root);
    return root;
  }

  test("writes index.html + assets and serves a URL that responds 200 with the pitch", async () => {
    const buildsRoot = await tempRoot();
    const pitch = "Build a replay dashboard that shows the last run";
    const preview = await buildIdeaPreview(pitch, "upid-unit-1", { buildsRoot });
    previews.push(preview);

    // Real files on disk under builds/<upid>/.
    const html = await readFile(join(preview.dir, "index.html"), "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Build a replay dashboard"); // the pitch drives the page
    await expect(readFile(join(preview.dir, "styles.css"), "utf8")).resolves.toContain("body");
    await expect(readFile(join(preview.dir, "app.js"), "utf8")).resolves.toContain("DOMContentLoaded");

    // The returned URL is a real loopback URL on an ephemeral port.
    expect(preview.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    // A genuine GET reaches the live server and returns the scaffolded page.
    const response = await fetch(preview.previewUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Build a replay dashboard");
    expect(body).toContain('data-testid="prototype-pitch"');
  });

  test("stop() shuts the server down so the URL stops responding", async () => {
    const buildsRoot = await tempRoot();
    const preview = await buildIdeaPreview("A quick prototype", "upid-unit-stop", { buildsRoot });
    const url = preview.previewUrl;

    expect((await fetch(url)).status).toBe(200);

    await preview.stop();

    // After stop() the loopback socket is closed; the fetch must fail to connect.
    await expect(fetch(url)).rejects.toBeDefined();
  });

  test("IdeaBuildRegistry tracks building -> ready with the live preview URL", async () => {
    const buildsRoot = await tempRoot();
    const registry = new IdeaBuildRegistry({ buildsRoot });

    const task = registry.start("Ship a status board", "upid-reg-1");
    // Immediately marked building so the snapshot reflects in-flight work.
    expect(registry.state("upid-reg-1")?.status).toBe("building");

    await task;

    const ready = registry.state("upid-reg-1");
    expect(ready?.status).toBe("ready");
    expect(ready?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    const response = await fetch(ready!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Ship a status board");

    // stopAll tears every live server down (emergency-stop lifecycle).
    const url = ready!.previewUrl!;
    await registry.stopAll();
    expect(registry.state("upid-reg-1")).toBeUndefined();
    await expect(fetch(url)).rejects.toBeDefined();
  });
});
