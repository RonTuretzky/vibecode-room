import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildRequest } from "../types";
import {
  ELIZA_CODER_CHARACTER,
  ELIZA_ENTRYPOINT,
  ElizaBuildBackend,
  composeBuildState,
  composePitchMessage,
  createCerebrasChatModel,
  extractJsonContent,
  parseFilesContent,
  parsePlanContent,
  processAction,
  sanitizeAppPath,
  writeAppFilesAction,
  type ElizaCoreModule,
  type ElizaGenerateTextParams,
  type ElizaMemory,
  type ElizaModelHandler,
  type ElizaRuntimeLike,
} from "./eliza";

// --- test plumbing ----------------------------------------------------------

function toJson(value: unknown): string {
  return JSON.stringify(value);
}

// A fake @elizaos/core facade that mirrors the real 1.7.2 semantics of the
// slice we use: composePromptFromState substitutes {{keys}} from the top-level
// state (minus text/values/data) merged with state.values, without escaping;
// stringToUuid is deterministic per input.
function fakeCore(): ElizaCoreModule {
  return {
    composePromptFromState: ({ state, template }) => {
      const pool: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(state)) {
        if (!["text", "values", "data"].includes(key)) {
          pool[key] = value;
        }
      }
      Object.assign(pool, state.values);
      return template.replace(/\{\{\{?(\w+)\}?\}\}/gu, (_match, key: string) => String(pool[key] ?? ""));
    },
    stringToUuid: (target) => `uuid-${target}`,
    ModelType: { TEXT_SMALL: "TEXT_SMALL", TEXT_LARGE: "TEXT_LARGE" },
  };
}

// A fake model handler driven by an ordered queue of replies. Any call past the
// end throws loudly, so each test's queue doubles as a spec of exactly how many
// model calls the loop makes.
function queueModel(replies: string[]): ElizaModelHandler & { calls: ElizaGenerateTextParams[] } {
  let index = 0;
  const fn = (async (params: ElizaGenerateTextParams) => {
    fn.calls.push(params);
    if (index >= replies.length) {
      throw new Error(`queueModel: no scripted reply for call #${index + 1}`);
    }
    const reply = replies[index]!;
    index += 1;
    return reply;
  }) as ElizaModelHandler & { calls: ElizaGenerateTextParams[] };
  fn.calls = [];
  return fn;
}

const tempDirs: string[] = [];
async function tempOutDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eliza-backend-"));
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
    prompt: "Build a tiny kaleidoscope toy",
    callsign: null,
    signal: new AbortController().signal,
    onProgress: () => undefined,
    ...overrides,
  };
}

function makeBackend(model: ElizaModelHandler, overrides: Partial<ConstructorParameters<typeof ElizaBuildBackend>[0]> = {}): ElizaBuildBackend {
  return new ElizaBuildBackend({ core: fakeCore(), model, env: {}, ...overrides });
}

// --- outer loop: happy paths -----------------------------------------------

describe("ElizaBuildBackend — build()", () => {
  test("mock kickoff: plan -> implement writes the single-file mock via the action — exactly two model calls, no critique", async () => {
    const model = queueModel([
      toJson({ pitch: "Spin your day into color.", spec: "hero canvas with mirrored wedges, one Spin button" }),
      toJson({ files: { "index.html": "<!doctype html><body>KALEIDO</body>" } }),
    ]);
    const progress: Array<{ label: string; percent?: number }> = [];
    const outDir = await tempOutDir();
    const backend = makeBackend(model);
    const result = await backend.build(makeRequest({ outDir, onProgress: (u) => progress.push(u) }));

    // BuildResult.summary is the headline pitch line.
    expect(result).toEqual({ ok: true, entrypoint: "index.html", summary: "Spin your day into color." });
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toContain("KALEIDO");
    // The queue doubles as the spec: exactly plan + implement, nothing more.
    expect(model.calls).toHaveLength(2);
    // Every prompt is composed from the character templates with the pitch substituted.
    for (const call of model.calls) {
      expect(call.prompt).toContain("Build a tiny kaleidoscope toy");
      expect(call.prompt).not.toContain("{{");
      expect(call.system).toBe(ELIZA_CODER_CHARACTER.system!);
    }
    expect(model.calls[0]!.prompt).toContain("Syn is imagining a concept mock");
    expect(model.calls[1]!.prompt).toContain("Spin your day into color.");
    expect(progress[0]).toMatchObject({ label: "imagining concept" });
    expect(progress.at(-1)).toMatchObject({ label: "mock ready", percent: 100 });
  });

  test("a junk plan never fails the mock — falls back to a pitch-line plan and still implements", async () => {
    const model = queueModel(["prose, not json", toJson({ files: { "index.html": "<html>fallback mock</html>" } })]);
    const outDir = await tempOutDir();
    const result = await makeBackend(model).build(makeRequest({ outDir }));

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Build a tiny kaleidoscope toy");
    expect(result.summary).toContain("concept mock");
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>fallback mock</html>");
  });

  test("model never produces the entrypoint: clean failure after the two-call loop", async () => {
    const model = queueModel([
      toJson({ pitch: "P.", spec: "spec" }),
      toJson({ files: { "app.js": "console.log(1)" } }),
    ]);
    const outDir = await tempOutDir();
    const result = await makeBackend(model).build(makeRequest({ outDir }));

    expect(result.ok).toBe(false);
    expect(result.entrypoint).toBeNull();
    expect(result.error).toContain(ELIZA_ENTRYPOINT);
    expect(model.calls).toHaveLength(2);
  });

  test("unparseable implement reply fails the mock without throwing", async () => {
    const model = queueModel([
      toJson({ pitch: "P.", spec: "spec" }),
      "sorry, I can only reply in prose today",
    ]);
    const outDir = await tempOutDir();
    const result = await makeBackend(model).build(makeRequest({ outDir }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("implement stage");
  });

  test("abort mid-call resolves ok:false error:aborted well within the stop budget", async () => {
    const controller = new AbortController();
    const model: ElizaModelHandler = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    const outDir = await tempOutDir();
    const backend = makeBackend(model);
    const started = Date.now();
    const pending = backend.build(makeRequest({ outDir, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const result = await pending;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// --- correction (steer) mode ------------------------------------------------

describe("ElizaBuildBackend — correction mode", () => {
  test("one revise pass rewrites the existing app", async () => {
    const outDir = await tempOutDir();
    await Bun.write(join(outDir, "index.html"), "<html>red</html>");
    const model = queueModel([toJson({ files: { "index.html": "<html>blue</html>" } })]);
    const result = await makeBackend(model).build(makeRequest({ outDir, correction: "make it blue" }));

    expect(result.ok).toBe(true);
    expect(result.entrypoint).toBe("index.html");
    expect(result.summary).toContain("make it blue");
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>blue</html>");
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.prompt).toContain("make it blue");
    expect(model.calls[0]!.prompt).toContain("<html>red</html>");
  });

  test("correction against an empty outDir fails cleanly", async () => {
    const outDir = await tempOutDir();
    const model = queueModel([]);
    const result = await makeBackend(model).build(makeRequest({ outDir, correction: "make it blue" }));

    expect(result.ok).toBe(false);
    expect(result.error).toContain("no mock");
    expect(model.calls).toHaveLength(0);
  });
});

// --- availability -----------------------------------------------------------

describe("ElizaBuildBackend — available()", () => {
  test("missing @elizaos/core reads unavailable with an actionable reason", async () => {
    const backend = new ElizaBuildBackend({ core: null, model: queueModel([]), env: {} });
    const availability = await backend.available();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("@elizaos/core");
  });

  test("missing CEREBRAS_API_KEY (and no injected model) reads unavailable", async () => {
    const backend = new ElizaBuildBackend({ core: fakeCore(), env: {} });
    const availability = await backend.available();
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("CEREBRAS_API_KEY");
  });

  test("core + injected model is available; core + env key is available", async () => {
    await expect(new ElizaBuildBackend({ core: fakeCore(), model: queueModel([]), env: {} }).available()).resolves.toEqual({ ok: true });
    await expect(new ElizaBuildBackend({ core: fakeCore(), env: { CEREBRAS_API_KEY: "csk-test" } }).available()).resolves.toEqual({
      ok: true,
    });
  });

  test("build() without core fails cleanly instead of throwing", async () => {
    const outDir = await tempOutDir();
    const backend = new ElizaBuildBackend({ core: null, model: queueModel([]), env: {} });
    const result = await backend.build(makeRequest({ outDir }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("@elizaos/core");
  });
});

// --- the Cerebras (OpenAI-compatible) model handler --------------------------

describe("createCerebrasChatModel", () => {
  const signal = new AbortController().signal;
  const okPayload = toJson({ choices: [{ message: { content: "REPLY" } }] });

  test("returns null when no key is provided", () => {
    expect(createCerebrasChatModel({ apiKey: "" })).toBeNull();
    expect(createCerebrasChatModel({ apiKey: "   " })).toBeNull();
  });

  test("posts an OpenAI-compatible chat completion to Cerebras", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init: init! });
      return new Response(okPayload, { status: 200 });
    }) as typeof fetch;
    const model = createCerebrasChatModel({ apiKey: "csk-test", fetchImpl })!;
    const reply = await model({ prompt: "USER PROMPT", system: "SYSTEM PROMPT", signal });

    expect(reply).toBe("REPLY");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    const headers = requests[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer csk-test");
    const body = JSON.parse(String(requests[0]!.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("gemma-4-31b");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([
      { role: "system", content: "SYSTEM PROMPT" },
      { role: "user", content: "USER PROMPT" },
    ]);
  });

  test("a 4xx retries once without response_format", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return bodies.length === 1 ? new Response("no json_object for you", { status: 400 }) : new Response(okPayload, { status: 200 });
    }) as typeof fetch;
    const model = createCerebrasChatModel({ apiKey: "csk-test", fetchImpl })!;

    await expect(model({ prompt: "p", signal })).resolves.toBe("REPLY");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.response_format).toBeDefined();
    expect(bodies[1]!.response_format).toBeUndefined();
  });

  test("a persistent server error surfaces the status", async () => {
    const fetchImpl = (async (_url: unknown) => new Response("boom", { status: 500 })) as typeof fetch;
    const model = createCerebrasChatModel({ apiKey: "csk-test", fetchImpl })!;
    await expect(model({ prompt: "p", signal })).rejects.toThrow("Cerebras HTTP 500");
  });

  test("the request carries the caller's abort signal", async () => {
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      (init!.signal as AbortSignal).throwIfAborted();
      return new Response(okPayload, { status: 200 });
    }) as typeof fetch;
    const model = createCerebrasChatModel({ apiKey: "csk-test", fetchImpl })!;
    const aborted = AbortSignal.abort();
    await expect(model({ prompt: "p", signal: aborted })).rejects.toThrow();
  });

  test("CEREBRAS_MODEL-style override is honored", async () => {
    let sentModel: unknown;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sentModel = (JSON.parse(String(init!.body)) as Record<string, unknown>).model;
      return new Response(okPayload, { status: 200 });
    }) as typeof fetch;
    const model = createCerebrasChatModel({ apiKey: "csk-test", model: "llama-4-x", fetchImpl })!;
    await model({ prompt: "p", signal });
    expect(sentModel).toBe("llama-4-x");
  });
});

// --- character, state, templates ---------------------------------------------

describe("character templates and state composition", () => {
  const stageExtras: Record<string, string[]> = {
    plan: [],
    implement: ["headline", "spec"],
    revise: ["specLine", "filesJson", "issues"],
  };

  test("every {{key}} in every template resolves from composeBuildState + the stage extras", () => {
    const core = fakeCore();
    const message = composePitchMessage(core, { upid: "upid-9", ideaId: "idea-9", prompt: "a pitch", callsign: "moose" });
    for (const [stage, extraKeys] of Object.entries(stageExtras)) {
      const template = ELIZA_CODER_CHARACTER.templates![stage]!;
      const extras = Object.fromEntries(extraKeys.map((key) => [key, `<${key}>`]));
      const state = composeBuildState(ELIZA_CODER_CHARACTER, message, extras);
      for (const match of template.matchAll(/\{\{(\w+)\}\}/gu)) {
        expect(state.values).toContainKey(match[1]!);
      }
      const composed = core.composePromptFromState({ state, template });
      expect(composed).not.toContain("{{");
      expect(composed).toContain("a pitch");
    }
  });

  test("composePitchMessage derives stable eliza ids and carries the pitch as Content.text", () => {
    const core = fakeCore();
    const req = { upid: "upid-2", ideaId: "idea-7", prompt: "the pitch", callsign: null };
    const first = composePitchMessage(core, req);
    const second = composePitchMessage(core, req);
    expect(first.id).toBe(second.id);
    expect(first.roomId).toBe("uuid-vibersyn-room-upid-2");
    expect(first.content.text).toBe("the pitch");
    expect(first.content.source).toBe("vibersyn");
  });
});

// --- the WRITE_APP_FILES action ----------------------------------------------

describe("writeAppFilesAction / processAction", () => {
  const runtime: ElizaRuntimeLike = {
    agentId: "uuid-agent",
    character: ELIZA_CODER_CHARACTER,
    useModel: async () => "",
  };

  function responseWith(files: unknown): ElizaMemory {
    return {
      entityId: "uuid-agent",
      agentId: "uuid-agent",
      roomId: "uuid-room",
      content: { text: "", actions: [writeAppFilesAction.name], files },
    };
  }

  test("validate rejects content without a usable files map", async () => {
    await expect(writeAppFilesAction.validate(runtime, responseWith(undefined))).resolves.toBe(false);
    await expect(writeAppFilesAction.validate(runtime, responseWith("nope"))).resolves.toBe(false);
    await expect(writeAppFilesAction.validate(runtime, responseWith({ "../evil.html": "x" }))).resolves.toBe(false);
    await expect(writeAppFilesAction.validate(runtime, responseWith({ "index.html": "x" }))).resolves.toBe(true);
  });

  test("handler writes sanitized changed files only and reports them via callback", async () => {
    const outDir = await tempOutDir();
    const project = new Map<string, string>([["styles.css", "body{}"]]);
    const callbacks: unknown[] = [];
    const message = responseWith({
      "index.html": "<html>hi</html>",
      "styles.css": "body{}", // unchanged — skipped
      "../evil.html": "muahaha", // unsafe — skipped
      "assets/app.js": "console.log(1)",
    });
    const state = composeBuildState(ELIZA_CODER_CHARACTER, message);
    const result = await processAction(writeAppFilesAction, runtime, message, state, { outDir, project }, async (content) => {
      callbacks.push(content);
      return [];
    });

    expect(result.success).toBe(true);
    expect(result.data?.written).toEqual(["index.html", "assets/app.js"]);
    expect(result.values?.entrypointPresent).toBe(true);
    await expect(Bun.file(join(outDir, "index.html")).text()).resolves.toBe("<html>hi</html>");
    await expect(Bun.file(join(outDir, "assets/app.js")).text()).resolves.toBe("console.log(1)");
    await expect(Bun.file(join(outDir, "..", "evil.html")).exists()).resolves.toBe(false);
    expect(callbacks).toHaveLength(1);
  });

  test("processAction refuses when the response content does not request the action", async () => {
    const message: ElizaMemory = { entityId: "e", roomId: "r", content: { text: "", files: { "index.html": "x" } } };
    const outDir = await tempOutDir();
    const result = await processAction(writeAppFilesAction, runtime, message, composeBuildState(ELIZA_CODER_CHARACTER, message), {
      outDir,
      project: new Map(),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("WRITE_APP_FILES");
  });
});

// --- pure parsing -------------------------------------------------------------

describe("extractJsonContent", () => {
  test("parses bare JSON, fenced JSON, and JSON embedded in prose", () => {
    expect(extractJsonContent('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJsonContent('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(extractJsonContent('Sure! Here you go: {"a": 1} — enjoy.')).toEqual({ a: 1 });
    // Nested objects and booleans survive intact (the reason this backend does
    // NOT use core.parseJSONObjectFromText — its normalizer corrupts both).
    expect(extractJsonContent('{"files": {"index.html": "<b>x</b>"}, "pass": false}')).toEqual({
      files: { "index.html": "<b>x</b>" },
      pass: false,
    });
  });

  test("returns null for arrays, prose, and garbage", () => {
    expect(extractJsonContent("[1,2]")).toBeNull();
    expect(extractJsonContent("no json here")).toBeNull();
    expect(extractJsonContent("{broken")).toBeNull();
  });
});

describe("parsePlanContent", () => {
  test("keeps a good {pitch, spec} plan; tolerates a legacy summary key", () => {
    const plan = parsePlanContent({ pitch: "Punchy line.", spec: "Spec." }, "pitch");
    expect(plan.summary).toBe("Punchy line.");
    expect(plan.spec).toBe("Spec.");
    const legacy = parsePlanContent({ summary: "Old summary.", spec: "Spec." }, "pitch");
    expect(legacy.summary).toBe("Old summary.");
  });

  test("null or junk falls back to a pitch-line plan from the room's pitch", () => {
    const fromNull = parsePlanContent(null, "my pitch");
    expect(fromNull.summary).toContain("my pitch");
    expect(fromNull.summary).toContain("concept mock");
    expect(fromNull.spec).toContain("my pitch");
    const fromJunk = parsePlanContent({ nonsense: 1 }, "my pitch");
    expect(fromJunk.summary).toContain("my pitch");
  });
});

describe("parseFilesContent", () => {
  test('accepts {"files": {...}} and a bare all-string map; drops non-strings', () => {
    expect(parseFilesContent({ files: { "index.html": "<html/>", junk: 3 } })).toEqual(new Map([["index.html", "<html/>"]]));
    expect(parseFilesContent({ "index.html": "<html/>", "app.js": "x" })).toEqual(
      new Map([
        ["index.html", "<html/>"],
        ["app.js", "x"],
      ]),
    );
  });

  test("returns null when nothing usable is present", () => {
    expect(parseFilesContent(null)).toBeNull();
    expect(parseFilesContent({ files: "not a map" })).toBeNull();
    expect(parseFilesContent({ mixed: "yes", other: 4 })).toBeNull();
    expect(parseFilesContent({ files: {} })).toBeNull();
  });
});

describe("sanitizeAppPath", () => {
  test("keeps clean relative paths, normalizes ./", () => {
    expect(sanitizeAppPath("index.html")).toBe("index.html");
    expect(sanitizeAppPath("./assets/app.js")).toBe("assets/app.js");
  });

  test("rejects traversal, absolute, drive-letter, backslash, and empty paths", () => {
    for (const bad of ["../up.html", "a/../b.js", "/etc/passwd", "C:evil", "a\\b.js", "", "a//b", "."]) {
      expect(sanitizeAppPath(bad)).toBeNull();
    }
  });
});
