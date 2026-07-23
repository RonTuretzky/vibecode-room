import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequest } from "../types";
import {
  SmithersBuildBackend,
  SMITHERS_ENTRYPOINT,
  smithersBuildPrompt,
  smithersCorrectionPrompt,
  summaryFromClaudeOutput,
  type ClaudeRunner,
} from "./smithers";

// All tests inject a fake ClaudeRunner — no real `claude` spawn, fully hermetic.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)));
  roots.length = 0;
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "smithers-backend-"));
  roots.push(dir);
  return dir;
}

function request(outDir: string, overrides: Partial<BuildRequest> = {}): BuildRequest {
  return {
    upid: "upid-t",
    ideaId: "idea-t",
    prompt: "Build a pomodoro timer",
    callsign: "atlas",
    outDir,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

describe("smithers backend — prompts (pure)", () => {
  test("fresh prompt asks for a CONCEPT MOCK (hero, pitch line, one interaction), not the full app", () => {
    const prompt = smithersBuildPrompt("A kanban wall");
    expect(prompt).toContain("IDEA: A kanban wall");
    expect(prompt).toContain("SELF-CONTAINED");
    expect(prompt).toContain(SMITHERS_ENTRYPOINT);
    expect(prompt).toContain("CONCEPT MOCK");
    expect(prompt).toContain("HERO SCREEN");
    expect(prompt).toContain("HEADLINE PITCH LINE");
    expect(prompt).toContain("Do not build the full app");
  });

  test("correction prompt includes the existing files' content AND the spoken correction", () => {
    const files = new Map([["index.html", "<h1>old app</h1>"]]);
    const prompt = smithersCorrectionPrompt("A kanban wall", files, "make the columns draggable");
    expect(prompt).toContain("<h1>old app</h1>");
    expect(prompt).toContain("make the columns draggable");
    expect(prompt).toContain("IN PLACE");
  });

  test("summary uses the claude JSON envelope result, else a deterministic fallback", () => {
    expect(summaryFromClaudeOutput(JSON.stringify({ result: "Built a timer.\n\nDetails follow." }), "pitch", null)).toBe(
      "Built a timer.",
    );
    expect(summaryFromClaudeOutput("not json at all", "a pitch", null)).toContain("a pitch");
    expect(summaryFromClaudeOutput("", "pitch", "add dark mode")).toContain("add dark mode");
  });
});

describe("smithers backend — build via injected runner", () => {
  test("fresh build: runner writes the app, result is ok with entrypoint + summary", async () => {
    const outDir = join(await tempDir(), "smithers");
    const seenPrompts: string[] = [];
    const runner: ClaudeRunner = async ({ prompt, cwd }) => {
      seenPrompts.push(prompt);
      await writeFile(join(cwd, "index.html"), "<!doctype html><h1>timer</h1>", "utf8");
      return { exitCode: 0, stdout: JSON.stringify({ result: "Built the pomodoro timer." }) };
    };
    const backend = new SmithersBuildBackend({ runner });

    expect(await backend.available()).toEqual({ ok: true });
    const result = await backend.build(request(outDir));

    expect(result).toEqual({ ok: true, entrypoint: SMITHERS_ENTRYPOINT, summary: "Built the pomodoro timer." });
    expect(seenPrompts[0]).toContain("Build a pomodoro timer");
    await expect(readFile(join(outDir, "index.html"), "utf8")).resolves.toContain("timer");
  });

  test("a run that produces no index.html fails with a specific error", async () => {
    const outDir = join(await tempDir(), "smithers");
    const runner: ClaudeRunner = async () => ({ exitCode: 0, stdout: "" });
    const backend = new SmithersBuildBackend({ runner });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("index.html");
  });

  test("ceiling-killed run (exit 137) whose entrypoint landed during the run is salvaged as ready", async () => {
    const outDir = join(await tempDir(), "smithers");
    const runner: ClaudeRunner = async ({ cwd }) => {
      // The CLI wrote the mock, then got SIGKILLed composing its final reply.
      await writeFile(join(cwd, "index.html"), "<!doctype html><h1>salvaged mock</h1>", "utf8");
      return { exitCode: 137, stdout: "" };
    };
    const backend = new SmithersBuildBackend({ runner });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe(SMITHERS_ENTRYPOINT);
    expect(result.summary).toContain("Build a pomodoro timer"); // deterministic fallback pitch line
  });

  test("nonzero exit with only a STALE pre-run entrypoint stays failed (no stale salvage)", async () => {
    const outDir = join(await tempDir(), "smithers");
    // A mock from an earlier boot is already on disk…
    await Bun.write(join(outDir, "index.html"), "<!doctype html><h1>stale other idea</h1>");
    // …and mtimes have ms precision: make sure the stale file is strictly older
    // than the run start before the runner crashes without writing anything.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const backend = new SmithersBuildBackend({ runner: async () => ({ exitCode: 1, stdout: "" }) });

    const result = await backend.build(request(outDir));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited 1");
  });

  test("correction mode: existing files + correction reach the prompt; app rewritten in place", async () => {
    const outDir = join(await tempDir(), "smithers");
    const backend = new SmithersBuildBackend({
      runner: async ({ prompt, cwd }) => {
        expect(prompt).toContain("OLD-CONTENT-MARKER");
        expect(prompt).toContain("turn it neon green");
        await writeFile(join(cwd, "index.html"), "<!doctype html><h1>neon</h1>", "utf8");
        return { exitCode: 0, stdout: JSON.stringify({ result: "Turned it neon green." }) };
      },
    });
    // Seed the existing app the correction rewrites in place.
    await Bun.write(join(outDir, "index.html"), "<!doctype html><h1>OLD-CONTENT-MARKER</h1>");

    const result = await backend.build(request(outDir, { correction: "turn it neon green" }));
    expect(result.ok).toBe(true);
    await expect(readFile(join(outDir, "index.html"), "utf8")).resolves.toContain("neon");
  });

  test("correction against an empty directory fails instead of hallucinating a rewrite", async () => {
    const outDir = join(await tempDir(), "smithers");
    const backend = new SmithersBuildBackend({ runner: async () => ({ exitCode: 0, stdout: "" }) });
    const result = await backend.build(request(outDir, { correction: "make it faster" }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no mock to correct");
  });

  test("abort: the signal rejects the run and the result reports 'aborted'", async () => {
    const outDir = join(await tempDir(), "smithers");
    const controller = new AbortController();
    const runner: ClaudeRunner = ({ signal }) =>
      new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new Error("SIGKILLed"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("SIGKILLed")), { once: true });
      });
    const backend = new SmithersBuildBackend({ runner });

    const pending = backend.build(request(outDir, { signal: controller.signal }));
    controller.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
  });
});
