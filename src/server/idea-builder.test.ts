import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIdeaPreview,
  IdeaBuildRegistry,
  servePreviewDirectory,
  type BuilderAgent,
  type IdeaPreview,
} from "./idea-builder";

// All tests inject a synthetic builderAgent so NO real `claude` CLI is spawned —
// the suite stays hermetic and fast. A no-op builder leaves the deterministic
// scaffold in place (the default-template behavior); other builders overwrite
// index.html to assert the agent's output is what gets served.
const noopBuilder: BuilderAgent = async () => undefined;

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
    const preview = await buildIdeaPreview(pitch, "upid-unit-1", { buildsRoot, builderAgent: noopBuilder });
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
    const preview = await buildIdeaPreview("A quick prototype", "upid-unit-stop", {
      buildsRoot,
      builderAgent: noopBuilder,
    });
    const url = preview.previewUrl;

    expect((await fetch(url)).status).toBe(200);

    await preview.stop();

    // After stop() the loopback socket is closed; the fetch must fail to connect.
    await expect(fetch(url)).rejects.toBeDefined();
  });

  test("servePreviewDirectory serves per-backend subdirs with no-cache headers", async () => {
    const dir = await tempRoot();
    await writeFile(join(dir, "index.html"), "<!doctype html><h1>root</h1>", "utf8");
    const sub = join(dir, "smithers");
    await Bun.write(join(sub, "index.html"), "<!doctype html><h1>smithers subapp</h1>");

    const server = await servePreviewDirectory(dir);
    try {
      const base = `http://127.0.0.1:${server.port}`;
      // Root still serves, and every response is uncacheable (steer rewrites in place).
      const root = await fetch(`${base}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get("cache-control") ?? "").toContain("no-store");

      // The per-backend subdir resolves to its own index.html — with or without
      // the trailing slash, and with a cache-bust query.
      for (const path of ["/smithers/", "/smithers", "/smithers/?v=2"]) {
        const response = await fetch(`${base}${path}`);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("smithers subapp");
        expect(response.headers.get("cache-control") ?? "").toContain("no-store");
      }
    } finally {
      await server.stop();
    }
  });

  test("IdeaBuildRegistry tracks building -> ready with the live preview URL", async () => {
    const buildsRoot = await tempRoot();
    const registry = new IdeaBuildRegistry({ buildsRoot, builderAgent: noopBuilder });

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

  test("an injected builder's output is what the preview serves (not the template)", async () => {
    const buildsRoot = await tempRoot();
    const marker = "REAL-AGENT-BUILT-THIS-APP";
    let scaffoldExistedFirst = false;
    const builder: BuilderAgent = async (_pitch, dir) => {
      // The deterministic scaffold must already be on disk before the agent runs.
      const before = await readFile(join(dir, "index.html"), "utf8");
      scaffoldExistedFirst = before.includes("Vibersyn prototype");
      await writeFile(join(dir, "index.html"), `<!doctype html><title>${marker}</title><h1>${marker}</h1>`, "utf8");
    };

    const registry = new IdeaBuildRegistry({ buildsRoot, builderAgent: builder });
    const task = registry.start("Build a kanban board", "upid-builder-1");
    expect(registry.state("upid-builder-1")?.status).toBe("building");
    await task;

    const ready = registry.state("upid-builder-1");
    expect(ready?.status).toBe("ready");

    // The template was written FIRST (the preview is never empty), and the live
    // server now serves the agent's real output rather than the scaffold.
    expect(scaffoldExistedFirst).toBe(true);
    const response = await fetch(ready!.previewUrl!);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain(marker);
    expect(body).not.toContain("Vibersyn prototype");

    await registry.stopAll();
  });

  test("stop() ABORTS an in-flight builder immediately instead of waiting out its timeout", async () => {
    const buildsRoot = await tempRoot();
    // A builder that never finishes on its own — it only settles when the
    // forwarded emergency-stop signal aborts it (the SIGKILL path). Without the
    // abort fix, stop() would await this build's 180s ceiling.
    let sawSignal = false;
    const hangingBuilder: BuilderAgent = (_pitch, _dir, _upid, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal === undefined) {
          reject(new Error("builder was not given the abort signal"));
          return;
        }
        sawSignal = true;
        signal.addEventListener("abort", () => reject(new Error("builder SIGKILLed")), { once: true });
      });

    const registry = new IdeaBuildRegistry({ buildsRoot, builderAgent: hangingBuilder });
    const task = registry.start("An app whose build hangs forever", "upid-abort-1");
    expect(registry.state("upid-abort-1")?.status).toBe("building");
    // Give the async build a beat to reach the hanging builder call.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const startedAt = Date.now();
    await registry.stop("upid-abort-1");
    const elapsedMs = Date.now() - startedAt;

    expect(sawSignal).toBe(true);
    expect(elapsedMs).toBeLessThan(1_500); // emergency-stop budget, never the 180s ceiling
    expect(registry.state("upid-abort-1")).toBeUndefined();
    await task; // the abandoned build settles without throwing
  });

  test("a builder that THROWS degrades to a reachable 'ready' preview serving the scaffold", async () => {
    const buildsRoot = await tempRoot();
    const throwingBuilder: BuilderAgent = async () => {
      throw new Error("agent blew up / timed out");
    };

    const registry = new IdeaBuildRegistry({ buildsRoot, builderAgent: throwingBuilder });
    const task = registry.start("Build something that fails to build", "upid-builder-fail");
    await task;

    // Degraded fallback: never stuck 'building', never 'failed' — it lands 'ready'.
    const ready = registry.state("upid-builder-fail");
    expect(ready?.status).toBe("ready");
    expect(ready?.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);

    // The preview is still reachable, serving the deterministic scaffold.
    const response = await fetch(ready!.previewUrl!);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Vibersyn prototype");

    await registry.stopAll();
  });
});
