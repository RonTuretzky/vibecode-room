import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enforceLocalAi, localBaseUrl } from "../config/local";
import { localComplete, probeLocalAi } from "./local";
import { runLocalAgent, safeAgentPath } from "./local-agent";
import { selectResearchSuggester } from "../research/suggester";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];
test("local code review receives the latest file once, including live steering", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-review-"));
  dirs.push(root);
  await writeFile(join(root, "index.html"), "OLD FILE");
  const replies = [
    { actions: [{ tool: "read", path: "./index.html" }] },
    { actions: [{ tool: "write", path: "index.html", content: "NEW FILE" }] },
    { done: true, summary: "Updated" },
    { pass: true, issues: [] },
  ];
  let review: any;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = (await request.json()) as any;
      if (replies.length === 1)
        review = JSON.parse(body.messages.at(-1).content);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(replies.shift()) } }],
      });
    },
  });
  servers.push(server);
  let steering = ["Preserve the timer"];
  await runLocalAgent(root, "Update the app", {
    env: { VIBERSYN_LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1` },
    signal: AbortSignal.timeout(3000),
    browserCheck: async () => "Page loaded",
    checkpoint: async () => {
      const next = steering;
      steering = [];
      return next;
    },
  });
  expect(review.files).toEqual({ "index.html": "NEW FILE" });
  expect(review.request).toContain("Preserve the timer");
});
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

test("local profile overrides inherited cloud providers and telemetry, preserving GitHub access", () => {
  const env = enforceLocalAi({
    VIBERSYN_ROOM_PROFILE: "local",
    VIBERSYN_DECISION_LLM: "claude",
    VIBERSYN_ASR_PROVIDER: "deepgram",
    VIBERSYN_BUILD_BACKENDS: "smithers,eliza",
    ANTHROPIC_API_KEY: "cloud-secret",
    LANGFUSE_OTLP_ENDPOINT: "https://telemetry.example",
    VIBERSYN_SMITHERS_GATEWAY_URL: "https://gateway.example",
    GH_TOKEN: "github-token",
  });
  expect(env.VIBERSYN_DECISION_LLM).toBe("local");
  expect(env.VIBERSYN_ASR_PROVIDER).toBe("local");
  expect(env.VIBERSYN_BUILD_BACKENDS).toBe("native");
  expect(env.ANTHROPIC_API_KEY).toBe("");
  expect(env.LANGFUSE_OTLP_ENDPOINT).toBe("");
  expect(env.VIBERSYN_SMITHERS_GATEWAY_URL).toBe("");
  expect(env.GH_TOKEN).toBe("github-token");
});

test("local inference rejects remote endpoints and credential-bearing URLs", () => {
  for (const url of [
    "https://api.openai.com/v1",
    "http://localhost.evil.test/v1",
    "http://user:pass@localhost:1234/v1",
    "file:///tmp/model",
    "http://192.168.1.1/v1",
  ])
    expect(() => localBaseUrl({ VIBERSYN_LOCAL_LLM_URL: url })).toThrow();
});

test("LM Studio completions route the selected model without cloud credentials and normalize Harmony framing", async () => {
  let body: any;
  let auth: string | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      auth = request.headers.get("authorization");
      body = await request.json();
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content:
                '<|channel|>final <|constrain|>JSON<|message|>{"ok":true}',
            },
          },
        ],
      });
    },
  });
  servers.push(server);
  const env = {
    VIBERSYN_LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1`,
    VIBERSYN_LOCAL_CODE_MODEL: "coding-model",
    OPENAI_API_KEY: "do-not-send",
    ANTHROPIC_API_KEY: "do-not-send",
  };
  expect(
    await localComplete(
      [
        { role: "system", content: "Feature instructions" },
        { role: "user", content: "test" },
      ],
      {
        env,
        purpose: "code",
        schema: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    ),
  ).toBe('{"ok":true}');
  expect(body.model).toBe("coding-model");
  expect(body.response_format).toBeUndefined();
  expect(
    body.messages.filter((message: any) => message.role === "system"),
  ).toHaveLength(1);
  expect(body.messages[0].content).toContain("Feature instructions");
  expect(body.messages[0].content).toContain("JSON INSTANCE");
  expect(auth).toBeNull();
});

test("HTTP failure and truncation fail explicitly without following a cloud redirect", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response(null, {
        status: 302,
        headers: { location: "https://api.openai.com/v1" },
      });
    },
  });
  servers.push(server);
  const env = { VIBERSYN_LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1` };
  await expect(
    localComplete([{ role: "user", content: "test" }], { env }),
  ).rejects.toThrow("No cloud fallback");
  expect(requests).toBe(1);
  server.reload({
    fetch: () =>
      Response.json({
        choices: [{ finish_reason: "length", message: { content: "partial" } }],
      }),
  });
  await expect(
    localComplete([{ role: "user", content: "test" }], { env }),
  ).rejects.toThrow("token budget");
});

test("model availability checks the actual selected identifiers", async () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => Response.json({ data: [{ id: "installed" }] }),
  });
  servers.push(server);
  const env = {
    VIBERSYN_LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1`,
    VIBERSYN_LOCAL_MODEL: "missing",
  };
  expect((await probeLocalAi(env)).ok).toBe(false);
  expect(
    (await probeLocalAi({ ...env, VIBERSYN_LOCAL_MODEL: "installed" })).ok,
  ).toBe(true);
});

test("aborted work queued behind local inference never reaches the server", async () => {
  let requests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch() {
      requests++;
      await gate;
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    },
  });
  servers.push(server);
  const env = { VIBERSYN_LOCAL_LLM_URL: `http://127.0.0.1:${server.port}/v1` };
  const call = (signal?: AbortSignal) =>
    localComplete([{ role: "user", content: "test" }], { env, signal });
  const first = call(),
    second = call();
  const abort = new AbortController();
  const queued = call(abort.signal);
  abort.abort(new Error("cancelled queued request"));
  await expect(queued).rejects.toThrow("cancelled queued request");
  release();
  await Promise.all([first, second]);
  expect(requests).toBe(2);
});

test("agent file tools reject traversal, secrets, git metadata and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-agent-paths-"));
  dirs.push(root);
  await mkdir(join(root, "src"));
  await symlink(tmpdir(), join(root, "outside"));
  for (const path of [
    "../outside",
    ".env.local",
    ".git/config",
    "outside/secret",
  ])
    await expect(safeAgentPath(root, path)).rejects.toThrow();
  expect(await safeAgentPath(root, "src/app.ts")).toBe(
    join(root, "src/app.ts"),
  );
});

test("local research reports malformed inference instead of silently returning no suggestions", async () => {
  const input = {
    sessionId: "local",
    correlationId: "local",
    turns: [],
    known: [],
  };
  const env = { VIBERSYN_LOCAL_AI: "1" };
  const bad = selectResearchSuggester(env, {
    runner: async () => "[{broken}]",
  });
  await expect(bad.suggester.suggest(input)).rejects.toThrow();
  const empty = selectResearchSuggester(env, { runner: async () => "[]" });
  expect(await empty.suggester.suggest(input)).toEqual([]);
});
