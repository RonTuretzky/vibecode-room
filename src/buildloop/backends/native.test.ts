import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequest } from "../types";
import {
  NativeBuildBackend,
  NATIVE_ENTRYPOINT,
  createCerebrasModel,
  createClaudeCliModel,
  createFailoverModel,
  extractJsonObject,
  parseCritiqueReply,
  parseFilesReply,
  parsePlanReply,
  resolveClaudeCli,
  sanitizeRelativePath,
  type BuildStage,
  type ModelCall,
  type ModelCallRequest,
} from "./native";

// --- test plumbing ----------------------------------------------------------

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

// A fake ModelCall driven by a per-stage script of replies, popped in order.
// Any call to a stage with no (more) scripted replies throws loudly — every
// test must account for every model call the loop makes, so the assertions
// double as a spec of exactly how many times each stage is hit.
function scriptedModel(script: Partial<Record<BuildStage, string[]>>): ModelCall & { calls: ModelCallRequest[] } {
  const cursor: Partial<Record<BuildStage, number>> = {};
  const fn = (async (call: ModelCallRequest) => {
    fn.calls.push(call);
    const list = script[call.stage] ?? [];
    const index = cursor[call.stage] ?? 0;
    if (index >= list.length) {
      throw new Error(`scriptedModel: no more scripted replies for stage "${call.stage}" (call #${index + 1})`);
    }
    cursor[call.stage] = index + 1;
    return list[index]!;
  }) as ModelCall & { calls: ModelCallRequest[] };
  fn.calls = [];
  return fn;
}

const tempDirs: string[] = [];
async function tempOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "native-backend-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
  tempDirs.length = 0;
});

function makeRequest(overrides: Partial<BuildRequest> & { outDir: string }): BuildRequest {
  return {
    upid: "upid-1",
    ideaId: "idea-1",
    prompt: "Build a tiny todo app",
    callsign: null,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

// --- outer loop: happy paths -----------------------------------------------

describe("NativeBuildBackend — build()", () => {
  test("plan -> implement -> critique(pass): writes files, no revise needed", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "A tiny todo app.", spec: "single page list", files: [{ path: "index.html", purpose: "entrypoint" }] })],
      implement: [toJson({ files: { "index.html": "<!doctype html><body>TODO</body>" } })],
      critique: [toJson({ pass: true, issues: [] })],
    });
    const progress: Array<{ label: string; percent?: number }> = [];
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, onProgress: (u) => progress.push(u) }));

    expect(result).toEqual({ ok: true, entrypoint: "index.html", summary: "A tiny todo app." });
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toContain("TODO");
    expect(model.calls.map((c) => c.stage)).toEqual(["plan", "implement", "critique"]);
    expect(progress[0]).toMatchObject({ label: "planning" });
    expect(progress.at(-1)).toMatchObject({ label: "ready", percent: 100 });
  });

  test("critique fails once, revise fixes it, second critique passes", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: [toJson({ files: { "index.html": "<html>v1</html>" } })],
      critique: [toJson({ pass: false, issues: ["missing footer"] }), toJson({ pass: true, issues: [] })],
      revise: [toJson({ files: { "index.html": "<html>v2 with footer</html>" } })],
    });
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result).toEqual({ ok: true, entrypoint: "index.html", summary: "S" });
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>v2 with footer</html>");
    expect(model.calls.map((c) => c.stage)).toEqual(["plan", "implement", "critique", "revise", "critique"]);
  });

  test("exhausts iterations without passing: still ships, summary notes the rough edges", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: [toJson({ files: { "index.html": "<html>v1</html>" } })],
      critique: [toJson({ pass: false, issues: ["issueA"] }), toJson({ pass: false, issues: ["issueB"] })],
      revise: [toJson({ files: { "index.html": "<html>v2</html>" } })],
    });
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model, maxIterations: 2 });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("S Known rough edges: issueB.");
    expect(model.calls.map((c) => c.stage)).toEqual(["plan", "implement", "critique", "revise", "critique"]);
  });

  test("implement stage returns unparseable JSON: build fails cleanly", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: ["not json at all"],
    });
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result.ok).toBe(false);
    expect(result.entrypoint).toBeNull();
    expect(result.error).toBe("implement stage returned no parseable {files} JSON");
  });

  test("model never produces index.html: fails with a clear error, never calls critique/revise", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "other.html", purpose: "x" }] })],
      implement: [toJson({ files: { "other.html": "<html>not the entrypoint</html>" } })],
    });
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model, maxIterations: 1 });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result.ok).toBe(false);
    expect(result.entrypoint).toBeNull();
    expect(result.error).toBe(`the model never produced an ${NATIVE_ENTRYPOINT} entrypoint`);
    expect(model.calls.map((c) => c.stage)).toEqual(["plan", "implement"]);
  });

  test("revise returns unparseable JSON mid-loop: ships the current version, summary notes the issues", async () => {
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: [toJson({ files: { "index.html": "<html>v1</html>" } })],
      critique: [toJson({ pass: false, issues: ["issueA"] })],
      revise: ["I'm sorry, I can't emit JSON right now"],
    });
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result.ok).toBe(true);
    expect(result.summary).toBe("S Known rough edges: issueA.");
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>v1</html>");
    expect(model.calls.map((c) => c.stage)).toEqual(["plan", "implement", "critique", "revise"]);
  });

  test("traversal paths from the model are dropped end-to-end — nothing escapes outDir", async () => {
    const parent = await tempOutDir();
    const outDir = join(parent, "app"); // nested so we own the parent we assert against
    const model = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: [toJson({ files: { "index.html": "<html>ok</html>", "../evil.html": "pwned", "/abs/evil.html": "pwned" } })],
      critique: [toJson({ pass: true, issues: [] })],
    });
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir }));

    expect(result.ok).toBe(true);
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>ok</html>");
    expect(existsSync(join(parent, "evil.html"))).toBe(false);
    expect(existsSync("/abs/evil.html")).toBe(false);
  });

  test("abort mid-loop (during critique) surfaces as a clean aborted result", async () => {
    const controller = new AbortController();
    const scripted = scriptedModel({
      plan: [toJson({ summary: "S", spec: "spec", files: [{ path: "index.html", purpose: "x" }] })],
      implement: [toJson({ files: { "index.html": "<html>v1</html>" } })],
    });
    const model: ModelCall = async (call) => {
      if (call.stage === "critique") {
        controller.abort();
        call.signal.throwIfAborted();
      }
      return scripted(call);
    };
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, signal: controller.signal }));

    expect(result).toEqual({
      ok: false,
      entrypoint: null,
      summary: "Build aborted by emergency stop.",
      error: "aborted",
    });
  });

  test("aborted signal short-circuits before any model call", async () => {
    const controller = new AbortController();
    controller.abort();
    const model = scriptedModel({});
    const outDir = await tempOutDir();
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, signal: controller.signal }));

    expect(result).toEqual({
      ok: false,
      entrypoint: null,
      summary: "Build aborted by emergency stop.",
      error: "aborted",
    });
    expect(model.calls).toHaveLength(0);
  });
});

// --- correction / steer mode -------------------------------------------------

describe("NativeBuildBackend — correction (steer) mode", () => {
  test("applies a spoken correction to an existing app", async () => {
    const outDir = await tempOutDir();
    await Bun.write(join(outDir, "index.html"), "<html>old</html>");
    const model = scriptedModel({ revise: [toJson({ files: { "index.html": "<html>corrected</html>" } })] });
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, correction: "make the button blue" }));

    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe("index.html");
    expect(result.summary).toBe('Applied spoken correction: "make the button blue".');
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>corrected</html>");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.stage).toBe("revise");
    expect(model.calls[0]!.user).toContain("make the button blue");
  });

  test("errors cleanly when there is nothing on disk to correct", async () => {
    const outDir = await tempOutDir();
    const model = scriptedModel({ revise: [toJson({ files: { "index.html": "<html>x</html>" } })] });
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, correction: "make it pop" }));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("steer requested but the build directory has no app to correct");
    expect(model.calls).toHaveLength(0);
  });

  test("errors cleanly when the correction pass returns unparseable JSON", async () => {
    const outDir = await tempOutDir();
    await Bun.write(join(outDir, "index.html"), "<html>old</html>");
    const model = scriptedModel({ revise: ["not json"] });
    const backend = new NativeBuildBackend({ model });
    const result = await backend.build(makeRequest({ outDir, correction: "make it pop" }));

    expect(result.ok).toBe(false);
    expect(result.error).toBe("correction pass returned no parseable {files} JSON");
  });
});

// --- available() -------------------------------------------------------------

describe("NativeBuildBackend — available()", () => {
  test("an injected model is always available", async () => {
    const backend = new NativeBuildBackend({ model: async () => "x" });
    expect(await backend.available()).toEqual({ ok: true });
  });

  test("CEREBRAS_API_KEY in env is sufficient", async () => {
    const backend = new NativeBuildBackend({ env: { CEREBRAS_API_KEY: "some-key" } });
    expect(await backend.available()).toEqual({ ok: true });
  });

  test("no key and no claude CLI: unavailable with a reason", async () => {
    const backend = new NativeBuildBackend({ env: {}, claudeCliPath: "/nonexistent/claude-binary-xyz" });
    const result = await backend.available();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("CEREBRAS_API_KEY");
  });
});

// --- pure reply parsing --------------------------------------------------------

describe("parsePlanReply", () => {
  test("parses a well-formed plan, dropping unsafe paths and ensuring the entrypoint leads", () => {
    const out = parsePlanReply(
      toJson({
        summary: "Sum",
        spec: "Spec text",
        files: [
          { path: "style.css", purpose: "styles" },
          { path: "../evil.html", purpose: "escape attempt" },
        ],
      }),
      "pitch text",
    );
    expect(out.summary).toBe("Sum");
    expect(out.spec).toBe("Spec text");
    expect(out.manifest.map((f) => f.path)).toEqual(["index.html", "style.css"]);
  });

  test("falls back to a single-file plan on unparseable input, never throwing", () => {
    const out = parsePlanReply("not json", "a todo app");
    expect(out.summary).toBe("A self-contained web app built from the room's pitch: a todo app.");
    expect(out.manifest).toEqual([{ path: "index.html", purpose: "the whole app (markup, styles, script inline)" }]);
  });
});

describe("parseFilesReply", () => {
  test("parses the nested {files: {...}} shape", () => {
    const out = parseFilesReply(toJson({ files: { "index.html": "<html></html>" } }));
    expect(out).toEqual(new Map([["index.html", "<html></html>"]]));
  });

  test("tolerates a bare top-level path->content map", () => {
    const out = parseFilesReply(toJson({ "index.html": "<html></html>", "app.js": "console.log(1)" }));
    expect(out).toEqual(
      new Map([
        ["index.html", "<html></html>"],
        ["app.js", "console.log(1)"],
      ]),
    );
  });

  test("returns null when values aren't all strings and there's no files key", () => {
    expect(parseFilesReply(toJson({ "index.html": "<html></html>", flag: true }))).toBeNull();
  });

  test("returns null on unparseable text", () => {
    expect(parseFilesReply("nope, no json here")).toBeNull();
  });
});

describe("parseCritiqueReply", () => {
  test("parses an explicit pass", () => {
    expect(parseCritiqueReply(toJson({ pass: true, issues: [] }))).toEqual({ pass: true, issues: [] });
  });

  test("parses an explicit fail with issues", () => {
    expect(parseCritiqueReply(toJson({ pass: false, issues: ["broken button"] }))).toEqual({
      pass: false,
      issues: ["broken button"],
    });
  });

  test("a fail with no issues gets a synthesized issue so revise has something to act on", () => {
    expect(parseCritiqueReply(toJson({ pass: false }))).toEqual({
      pass: false,
      issues: ["Critique failed the app without specifics; improve fidelity to the idea and overall polish."],
    });
  });

  test("an unparseable critique counts as a pass — never wedges the loop", () => {
    expect(parseCritiqueReply("sorry, I can't review that")).toEqual({ pass: true, issues: [] });
  });
});

describe("extractJsonObject", () => {
  test("parses bare JSON", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  test("extracts JSON from a fenced ```json block", () => {
    expect(extractJsonObject('here you go:\n```json\n{"a":1}\n```\nhope that helps')).toEqual({ a: 1 });
  });

  test("extracts the outermost JSON object embedded in prose", () => {
    expect(extractJsonObject('Sure! {"a":1} — let me know if you need more.')).toEqual({ a: 1 });
  });

  test("returns null for non-JSON prose", () => {
    expect(extractJsonObject("no braces here")).toBeNull();
  });
});

describe("sanitizeRelativePath", () => {
  test("passes through a normal relative path", () => {
    expect(sanitizeRelativePath("assets/app.js")).toBe("assets/app.js");
  });

  test("strips a leading ./", () => {
    expect(sanitizeRelativePath("./index.html")).toBe("index.html");
  });

  test("rejects an absolute path", () => {
    expect(sanitizeRelativePath("/etc/passwd")).toBeNull();
  });

  test("rejects a drive-letter path", () => {
    expect(sanitizeRelativePath("C:/Users/x")).toBeNull();
  });

  test("rejects backslashes", () => {
    expect(sanitizeRelativePath("a\\b.html")).toBeNull();
  });

  test("rejects .. traversal", () => {
    expect(sanitizeRelativePath("a/../../etc/passwd")).toBeNull();
  });

  test("rejects a bare . path segment", () => {
    expect(sanitizeRelativePath("a/./b.html")).toBeNull();
  });
});

// --- model seam: failover + Cerebras HTTP shape (fakes only, no network) -----

describe("createFailoverModel", () => {
  test("uses cerebras when it succeeds; claude is never called", async () => {
    let cerebrasCalls = 0;
    let claudeCalls = 0;
    const model = createFailoverModel({
      cerebras: async () => {
        cerebrasCalls += 1;
        return "cerebras-reply";
      },
      claude: async () => {
        claudeCalls += 1;
        return "claude-reply";
      },
    });
    const out = await model({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal });
    expect(out).toBe("cerebras-reply");
    expect(cerebrasCalls).toBe(1);
    expect(claudeCalls).toBe(0);
  });

  test("fails over to claude after the failure budget, then stays sticky on claude", async () => {
    let cerebrasCalls = 0;
    let claudeCalls = 0;
    const model = createFailoverModel({
      cerebras: async () => {
        cerebrasCalls += 1;
        throw new Error("cerebras boom");
      },
      claude: async () => {
        claudeCalls += 1;
        return "claude-reply";
      },
      maxCerebrasFailures: 2,
    });
    const call = { stage: "plan" as const, system: "s", user: "u", signal: new AbortController().signal };

    expect(await model(call)).toBe("claude-reply");
    expect(cerebrasCalls).toBe(2); // budget exhausted within the first logical call
    expect(claudeCalls).toBe(1);

    expect(await model(call)).toBe("claude-reply");
    expect(cerebrasCalls).toBe(2); // sticky — no further cerebras attempts
    expect(claudeCalls).toBe(2);
  });

  test("an abort propagates immediately instead of falling over to claude", async () => {
    const controller = new AbortController();
    let cerebrasCalls = 0;
    let claudeCalls = 0;
    const model = createFailoverModel({
      cerebras: async () => {
        cerebrasCalls += 1;
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      },
      claude: async () => {
        claudeCalls += 1;
        return "claude-reply";
      },
    });
    await expect(model({ stage: "plan", system: "s", user: "u", signal: controller.signal })).rejects.toThrow();
    expect(cerebrasCalls).toBe(1);
    expect(claudeCalls).toBe(0);
  });

  test("throws a clear error when neither cerebras nor claude are available", async () => {
    const model = createFailoverModel({ cerebras: null, claude: null });
    await expect(
      model({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal }),
    ).rejects.toThrow(/no usable model/);
  });
});

describe("createCerebrasModel (fake fetchImpl — no real network)", () => {
  test("returns the chat-completion content on success", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }] }), { status: 200 })) as unknown as typeof fetch;
    const model = createCerebrasModel({ apiKey: "k", fetchImpl });
    expect(model).not.toBeNull();
    const out = await model!({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal });
    expect(out).toBe("hello");
  });

  test("retries once without response_format on a 4xx, then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("bad request", { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok after retry" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const model = createCerebrasModel({ apiKey: "k", fetchImpl });
    const out = await model!({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal });
    expect(out).toBe("ok after retry");
    expect(calls).toBe(2);
  });

  test("throws with the HTTP status when both attempts fail", async () => {
    const fetchImpl = (async () => new Response("server exploded", { status: 500 })) as unknown as typeof fetch;
    const model = createCerebrasModel({ apiKey: "k", fetchImpl });
    await expect(model!({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal })).rejects.toThrow(
      /Cerebras HTTP 500/,
    );
  });

  test("throws when the response has no message content", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [] }), { status: 200 })) as unknown as typeof fetch;
    const model = createCerebrasModel({ apiKey: "k", fetchImpl });
    await expect(model!({ stage: "plan", system: "s", user: "u", signal: new AbortController().signal })).rejects.toThrow(
      /no message content/,
    );
  });

  test("returns null (no model) when there's no API key", () => {
    const fetchImpl = (async () => new Response("{}")) as unknown as typeof fetch;
    expect(createCerebrasModel({ apiKey: "", fetchImpl })).toBeNull();
  });
});

describe("resolveClaudeCli", () => {
  test("an explicit path that exists wins", () => {
    const existing = process.execPath; // guaranteed to exist
    expect(resolveClaudeCli({ cliPath: existing })).toBe(existing);
  });

  test("an explicit path that doesn't exist resolves to null (no fallback)", () => {
    expect(resolveClaudeCli({ cliPath: "/nonexistent/claude-binary-xyz" })).toBeNull();
  });

  test("falls back to VIBERSYN_CLAUDE_CLI from env when no explicit path is given", () => {
    const existing = process.execPath;
    expect(resolveClaudeCli({ env: { VIBERSYN_CLAUDE_CLI: existing } })).toBe(existing);
  });
});

// --- claude CLI model: fake local executables, no real claude, no network ----

describe("createClaudeCliModel (fake CLI script)", () => {
  async function fakeCli(body: string): Promise<string> {
    const dir = await tempOutDir();
    const path = join(dir, "fake-claude");
    await Bun.write(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  const call = () => ({ stage: "plan" as const, system: "s", user: "u", signal: new AbortController().signal });

  test("unwraps the JSON envelope's result string", async () => {
    const cli = await fakeCli(`echo '{"result":"model says hi"}'`);
    const model = createClaudeCliModel({ cliPath: cli })!;
    await expect(model(call())).resolves.toBe("model says hi");
  });

  test("falls back to raw stdout when the reply isn't an envelope", async () => {
    const cli = await fakeCli(`echo 'plain text reply'`);
    const model = createClaudeCliModel({ cliPath: cli })!;
    await expect(model(call())).resolves.toBe("plain text reply");
  });

  test("a non-zero exit is an error, never a model reply", async () => {
    const cli = await fakeCli(`echo 'partial output'; exit 3`);
    const model = createClaudeCliModel({ cliPath: cli })!;
    await expect(model(call())).rejects.toThrow(/exited with code 3/);
  });

  test("an is_error envelope is an error, never a model reply", async () => {
    const cli = await fakeCli(`echo '{"is_error":true,"result":"credit balance too low"}'`);
    const model = createClaudeCliModel({ cliPath: cli })!;
    await expect(model(call())).rejects.toThrow(/claude CLI reported an error: credit balance too low/);
  });

  test("abort kills the subprocess and settles well inside the ~2s budget", async () => {
    const cli = await fakeCli(`sleep 30`);
    const model = createClaudeCliModel({ cliPath: cli })!;
    const controller = new AbortController();
    const started = Date.now();
    const pending = model({ stage: "plan", system: "s", user: "u", signal: controller.signal });
    setTimeout(() => controller.abort(), 25);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("its own timeout kills the subprocess and rejects", async () => {
    const cli = await fakeCli(`sleep 30`);
    const model = createClaudeCliModel({ cliPath: cli, timeoutMs: 50 })!;
    await expect(model(call())).rejects.toThrow();
  });
});
