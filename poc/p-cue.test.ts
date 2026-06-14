import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { runProbe, type ProbeAssertion } from "./harness";

const PROBE_ID = "probe-cue-substrate";
const REPORT_ROOT = "artifacts/smithering/reports";
const PROBE_ROOT = "artifacts/smithering/probes/probe-cue-substrate";
const TRACE_ROOT = "artifacts/smithering/build/probe-cue-substrate/trace";
const CUE_REPO = "https://github.com/jameslbarnes/cue.git";
const CUE_ROOT = process.env.PANOP_CUE_SOURCE_DIR ?? join(tmpdir(), "panopticon-cue-src");
const DEFAULT_EARCON_BUDGET_MS = 300;
const TARGET_EARCON_BUDGET_MS = 150;
const LATENCY_PROVIDER_DELAY_MS = 65;

type CueCore = Record<string, any>;
type CueServer = Record<string, any>;

describe("P-CUE real Cue substrate probe", () => {
  test("real Cue source exposes Panopticon's required substrate or records owned extensions", async () => {
    const cue = await loadCue();
    const assertions: ProbeAssertion[] = [
      {
        id: "repo-access-source-build",
        behavior: "github.com/jameslbarnes/cue is accessible and built from source",
        falsify: () => {
          expect("not-built").toBe("built");
        },
        run: () => {
          expect(existsSync(join(CUE_ROOT, "packages/core/dist/index.js"))).toBe(true);
          expect(existsSync(join(CUE_ROOT, "packages/server/dist/index.js"))).toBe(true);
        },
      },
      {
        id: "text-cue-latency",
        behavior: "TextCue-triggered harness decision resolves inside the hard earcon budget",
        falsify: async () => {
          await assertTextCueLatency(cue.core, 50);
        },
        run: async () => {
          const budget = Number(process.env.PANOP_P_CUE_LATENCY_BUDGET_MS ?? DEFAULT_EARCON_BUDGET_MS);
          await assertTextCueLatency(cue.core, budget);
        },
      },
      {
        id: "cue-policy-primitives",
        behavior: "TextCue, SpeakerWordCue, IdleCue, WordCountCue, IntervalCue, and cooldownSeconds semantics are evidenced",
        falsify: async () => {
          const result = await exerciseCuePolicies(cue.core);
          expect(result.wordCountBelowThresholdFired).toBe(true);
        },
        run: async () => {
          const result = await exerciseCuePolicies(cue.core);
          expect(result).toMatchObject({
            textCueMatched: true,
            textCueMissedSubstring: true,
            speakerWordMatchedSpeakerA: true,
            speakerWordRejectedSpeakerB: true,
            idleCueFired: true,
            wordCountBelowThresholdFired: false,
            wordCountAtThresholdFired: true,
            intervalFirstObservationDidNotFire: true,
            intervalAfterGapFired: true,
            cooldownSuppressedSecondTextCue: true,
            cooldownAllowedLaterTextCue: true,
          });
        },
      },
      {
        id: "observe-pass-first-class",
        behavior: "observe.pass is a named, loggable, first-class tool result and trace entry",
        falsify: async () => {
          const pass = await exerciseObservePass(cue.core);
          expect(pass.traceTool).toBe("missing.pass");
        },
        run: async () => {
          const pass = await exerciseObservePass(cue.core);
          expect(pass).toMatchObject({
            toolResult: "observe.pass",
            actionCount: 0,
            traceTool: "observe.pass",
            recentKind: "pass_span",
          });
        },
      },
      {
        id: "two-programs-mapped-action-tool",
        behavior: "two independent Programs route independently through MappedActionTool schemas",
        falsify: async () => {
          const routed = await exerciseTwoPrograms(cue.core);
          expect(routed.tools).toEqual(["panopticon.spawn"]);
        },
        run: async () => {
          const routed = await exerciseTwoPrograms(cue.core);
          expect(routed.tools).toEqual(["panopticon.suggest", "panopticon.steer"]);
          expect(routed.actions).toEqual(["suggestion.queue", "smithers.steer"]);
          expect(routed.steerSchemaRequired).toEqual(["callsign", "instruction"]);
        },
      },
      {
        id: "provider-slots-and-transcription-ingress",
        behavior: "transcription, LLM, output, and frame/VLM provider slots accept Panopticon-shaped adapters; qwen-asr JSON ingress is confirmed",
        falsify: async () => {
          const providers = await exerciseProviderSlots(cue.core, cue.server);
          expect(providers.qwenTranscript).toBe("missing transcript");
        },
        run: async () => {
          const providers = await exerciseProviderSlots(cue.core, cue.server);
          expect(providers).toMatchObject({
            qwenReadyProvider: "qwen-asr",
            qwenTranscript: "Panop steer cometa toward tests.",
            qwenSpeaker: "speaker_0",
            qwenAction: "test.qwen",
            vlmReadyProvider: "panopticon-frame",
            vlmAction: "test.frame",
            outputProviderAction: "panopticon.output.apply",
            deepgramExportPresent: true,
          });
        },
      },
      {
        id: "jsonl-trace-files",
        behavior: "Cue recording writes JSONL observation, decision, and action traces with stable ids",
        falsify: async () => {
          const traces = await exerciseJsonlRecording(cue.core, cue.server);
          expect(traces.decisions[0]?.trace?.call?.tool).toBe("observe.pass");
        },
        run: async () => {
          const traces = await exerciseJsonlRecording(cue.core, cue.server);
          expect(traces.observations[0]?.sessionId).toBe("trace-session");
          expect(traces.decisions[0]?.trace?.call?.tool).toBe("panopticon.trace");
          expect(traces.actions[0]?.action?.type).toBe("trace.action");
        },
      },
      {
        id: "http-and-live-event-routes",
        behavior: "HTTP state/agent/observations routes and read-only live event route expose board-consumable state",
        falsify: async () => {
          const routes = await exerciseRoutes(cue.core, cue.server);
          expect(routes.httpState).toBe(404);
        },
        run: async () => {
          const routes = await exerciseRoutes(cue.core, cue.server);
          expect(routes).toMatchObject({
            httpState: 200,
            httpAgent: 200,
            httpObservation: 200,
            eventReady: true,
            transcriptEvent: "route event",
            hasNativeEventSourceSse: false,
          });
        },
      },
    ];

    const report = await runProbe({
      probeId: PROBE_ID,
      assertions,
      reportRoot: REPORT_ROOT,
      cleanReportDir: true,
      correlationId: "p-cue-real-cue-substrate",
      meta: {
        repo: CUE_REPO,
        sourceDir: CUE_ROOT,
        commit: git(CUE_ROOT, ["rev-parse", "HEAD"]),
        primitives: await primitiveMatrix(cue.core, cue.server),
      },
    });

    await writeProbeVerdict(report.status === "passed", report.summary);
  }, 60000);
});

async function loadCue(): Promise<{ core: CueCore; server: CueServer }> {
  ensureCueSource();
  await mkdir(TRACE_ROOT, { recursive: true });
  await appendTrace("cue.repo", {
    repo: CUE_REPO,
    sourceDir: CUE_ROOT,
    commit: git(CUE_ROOT, ["rev-parse", "HEAD"]),
  });
  const core = await import(pathToFileURL(join(CUE_ROOT, "packages/core/dist/index.js")).href);
  const server = await import(pathToFileURL(join(CUE_ROOT, "packages/server/dist/index.js")).href);
  return { core, server };
}

function ensureCueSource(): void {
  if (!existsSync(join(CUE_ROOT, ".git"))) {
    execFileSync("git", ["clone", "--depth", "1", CUE_REPO, CUE_ROOT], { stdio: "pipe" });
  }
  execFileSync("git", ["ls-remote", CUE_REPO, "HEAD"], { stdio: "pipe" });
  if (!existsSync(join(CUE_ROOT, "packages/core/dist/index.js"))) {
    execFileSync("pnpm", ["install"], { cwd: CUE_ROOT, stdio: "pipe" });
    execFileSync("pnpm", ["build"], { cwd: CUE_ROOT, stdio: "pipe" });
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function assertTextCueLatency(core: CueCore, budgetMs: number): Promise<void> {
  const { CueHarness, TextCue, MappedActionTool, Triggers, transcriptObservation } = core;
  const harness = new CueHarness({
    sessionId: "latency-session",
    cues: [new TextCue(["panop"])],
    programs: [
      {
        name: "latency-program",
        triggers: [Triggers.onCue("text")],
        allowedTools: ["panopticon.latency"],
        llmProvider: {
          async infer() {
            await sleep(LATENCY_PROVIDER_DELAY_MS);
            return [{ tool: "panopticon.latency", arguments: { ack: true } }];
          },
        },
      },
    ],
    tools: [
      new MappedActionTool({
        name: "panopticon.latency",
        description: "Measure TextCue-to-action latency.",
        inputSchema: {
          type: "object",
          required: ["ack"],
          properties: { ack: { type: "boolean" } },
        },
        mapper: (call: any) => [{ type: "latency.ack", payload: call.arguments }],
      }),
    ],
  });

  const started = performance.now();
  const result = await harness.ingest(transcriptObservation("Panop status", { speaker: "speaker_0" }));
  const latencyMs = performance.now() - started;
  await appendTrace("cue.text_latency", {
    latencyMs,
    budgetMs,
    targetMs: TARGET_EARCON_BUDGET_MS,
    hardMs: DEFAULT_EARCON_BUDGET_MS,
    cueCount: result.cues.length,
    tool: result.toolResults[0]?.tool ?? null,
  });
  expect(result.cues.some((cue: any) => cue.name === "text")).toBe(true);
  expect(result.toolResults[0]?.tool).toBe("panopticon.latency");
  expect(latencyMs).toBeLessThanOrEqual(budgetMs);
  expect(latencyMs).toBeLessThanOrEqual(TARGET_EARCON_BUDGET_MS);
}

async function exerciseCuePolicies(core: CueCore): Promise<Record<string, boolean>> {
  const {
    ConversationState,
    IdleCue,
    IntervalCue,
    SpeakerWordCue,
    TextCue,
    WordCountCue,
    transcriptObservation,
    transcriptionStreamObservation,
  } = core;
  const state = new ConversationState();
  const textCue = new TextCue(["panop"]);
  const cooldownCue = new TextCue(["panop"], { cooldownSeconds: 2 });
  const speakerWordCue = new SpeakerWordCue(["halt"], { speaker: "speaker_0" });
  const idleCue = new IdleCue();
  const wordCountCue = new WordCountCue(3);
  const intervalCue = new IntervalCue(10);

  const textObservation = transcriptObservation("Panop please listen", {
    speaker: "speaker_0",
    words: [{ text: "Panop", speaker: "speaker_0" }],
    timestamp: 1,
  });
  const substringObservation = transcriptObservation("panopticon is longer", {
    speaker: "speaker_0",
    timestamp: 2,
  });
  const speakerA = transcriptObservation("halt", {
    speaker: "speaker_0",
    words: [{ text: "halt", speaker: "speaker_0" }],
    timestamp: 3,
  });
  const speakerB = transcriptObservation("halt", {
    speaker: "speaker_1",
    words: [{ text: "halt", speaker: "speaker_1" }],
    timestamp: 4,
  });
  const twoWords = transcriptObservation("one two", { timestamp: 5 });
  const thirdWord = transcriptObservation("three", { timestamp: 6 });
  const firstInterval = transcriptObservation("moving", { timestamp: 10 });
  const secondInterval = transcriptObservation("still moving", { timestamp: 21 });
  const cooldownFirst = transcriptObservation("panop", { timestamp: 30 });
  const cooldownSecond = transcriptObservation("panop", { timestamp: 31 });
  const cooldownLater = transcriptObservation("panop", { timestamp: 33 });

  state.appendObservation(twoWords);
  const below = wordCountCue.maybeCue(twoWords, state);
  state.appendObservation(thirdWord);
  const atThreshold = wordCountCue.maybeCue(thirdWord, state);
  const firstCooldown = cooldownCue.maybeCue(cooldownFirst, state);
  const secondCooldown = cooldownCue.maybeCue(cooldownSecond, state);
  const laterCooldown = cooldownCue.maybeCue(cooldownLater, state);

  const result = {
    textCueMatched: textCue.maybeCue(textObservation, state)?.name === "text",
    textCueMissedSubstring: textCue.maybeCue(substringObservation, state) === undefined,
    speakerWordMatchedSpeakerA: speakerWordCue.maybeCue(speakerA, state)?.metadata?.speaker === "speaker_0",
    speakerWordRejectedSpeakerB: speakerWordCue.maybeCue(speakerB, state) === undefined,
    idleCueFired: idleCue.maybeCue(
      transcriptionStreamObservation("stream_idle", { idleForSeconds: 10, thresholdSeconds: 10 }),
      state,
    )?.name === "idle",
    wordCountBelowThresholdFired: Boolean(below),
    wordCountAtThresholdFired: atThreshold?.metadata?.wordCount === 3,
    intervalFirstObservationDidNotFire: intervalCue.maybeCue(firstInterval, state) === undefined,
    intervalAfterGapFired: intervalCue.maybeCue(secondInterval, state)?.metadata?.elapsedSeconds === 11,
    cooldownSuppressedSecondTextCue: Boolean(firstCooldown) && secondCooldown === undefined,
    cooldownAllowedLaterTextCue: laterCooldown?.name === "text",
  };
  await appendTrace("cue.policy_primitives", result);
  return result;
}

async function exerciseObservePass(core: CueCore): Promise<Record<string, unknown>> {
  const { CueHarness, TextCue, Triggers, transcriptObservation } = core;
  const harness = new CueHarness({
    sessionId: "pass-session",
    cues: [new TextCue(["ambient"])],
    programs: [
      {
        name: "ambient-pass",
        triggers: [Triggers.onCue("text")],
        allowedTools: [],
        llmProvider: {
          infer() {
            return [{ tool: "observe.pass", arguments: { reason: "ambient-no-action" } }];
          },
        },
      },
    ],
  });
  const result = await harness.ingest(transcriptObservation("ambient chatter", { timestamp: 1 }));
  const recent = harness.state.decisionHistory.recent({ maxItems: 5, includePassSpans: true })[0];
  const trace = harness.state.decisionHistory.trace[0];
  const output = {
    toolResult: result.toolResults[0]?.tool,
    actionCount: result.toolResults[0]?.actions.length,
    traceTool: trace?.call?.tool,
    recentKind: recent?.kind,
  };
  await appendTrace("cue.observe_pass", output);
  return output;
}

async function exerciseTwoPrograms(core: CueCore): Promise<Record<string, unknown>> {
  const { CueHarness, MappedActionTool, TextCue, Triggers, transcriptObservation } = core;
  const tools = [
    new MappedActionTool({
      name: "panopticon.suggest",
      description: "Queue a conservative ambient suggestion.",
      inputSchema: {
        type: "object",
        required: ["concept"],
        properties: { concept: { type: "string" } },
      },
      mapper: (call: any) => [{ type: "suggestion.queue", payload: call.arguments }],
    }),
    new MappedActionTool({
      name: "panopticon.steer",
      description: "Deliver a steering instruction to a named durable process.",
      inputSchema: {
        type: "object",
        required: ["callsign", "instruction"],
        properties: {
          callsign: { type: "string" },
          instruction: { type: "string" },
          stop: { type: "boolean" },
        },
      },
      mapper: (call: any) => [{ type: "smithers.steer", payload: call.arguments }],
    }),
  ];
  const harness = new CueHarness({
    sessionId: "routing-session",
    cues: [new TextCue(["build"]), new TextCue(["cometa"])],
    programs: [
      {
        name: "ambient-C2",
        triggers: [Triggers.onCue("text")],
        allowedTools: ["panopticon.suggest"],
        llmProvider: {
          infer({ cue, tools: eligibleTools }: any) {
            if (cue.metadata?.pattern !== "build") return [];
            if (!eligibleTools.some((tool: any) => tool.name === "panopticon.suggest")) return [];
            return [{ tool: "panopticon.suggest", arguments: { concept: "add replay tests" } }];
          },
        },
      },
      {
        name: "steering-C3",
        triggers: [Triggers.onCue("text")],
        allowedTools: ["panopticon.steer"],
        llmProvider: {
          infer({ cue, tools: eligibleTools }: any) {
            if (cue.metadata?.pattern !== "cometa") return [];
            if (!eligibleTools.some((tool: any) => tool.name === "panopticon.steer")) return [];
            return [{ tool: "panopticon.steer", arguments: { callsign: "cometa", instruction: "focus tests" } }];
          },
        },
      },
    ],
    tools,
  });
  const result = await harness.ingest(transcriptObservation("build idea, cometa focus tests", { timestamp: 1 }));
  const output = {
    tools: result.toolResults.map((entry: any) => entry.tool),
    actions: result.toolResults.flatMap((entry: any) => entry.actions.map((action: any) => action.type)),
    steerSchemaRequired: tools[1].spec().inputSchema.required,
  };
  await appendTrace("cue.two_programs", output);
  return output;
}

async function exerciseProviderSlots(core: CueCore, serverModule: CueServer): Promise<Record<string, unknown>> {
  const { CueHarness, ManualHeartbeat, MappedActionTool, Triggers } = core;
  const {
    customVLMProvider,
    deepgramTranscriptionProvider,
    qwenAsrTranscriptionProvider,
    startServer,
  } = serverModule;
  const handledOutputActions: string[] = [];
  const server = await startServer({
    port: 0,
    transcriptionProvider: qwenAsrTranscriptionProvider(),
    vlmProvider: customVLMProvider({
      name: "panopticon-frame",
      connect({ client, ingestDescription, send }: any) {
        client.on("message", async (raw: Buffer) => {
          const message = JSON.parse(raw.toString());
          const results = await ingestDescription(message.description, { timestamp: 1 });
          send({ type: "frame.results", results });
        });
      },
    }),
    outputProviders: [
      {
        provider: "panopticon.output",
        actions: { "panopticon.output.apply": { method: "POST", endpoint: "/apply" } },
        handleAction(action: any) {
          handledOutputActions.push(action.type);
        },
      },
    ],
    createHarness({ sessionId }: any) {
      return new CueHarness({
        sessionId,
        cues: [new ManualHeartbeat()],
        programs: [
          {
            name: "capture-qwen",
            triggers: [Triggers.onCue("manual")],
            allowedTools: ["test.capture_provider"],
            llmProvider: {
              infer({ state }: any) {
                return [
                  {
                    tool: "test.capture_provider",
                    arguments: {
                      transcript: state.transcriptText(),
                      frame: state.latestVisionDescription ?? "",
                    },
                  },
                ];
              },
            },
          },
        ],
        tools: [
          new MappedActionTool({
            name: "test.capture_provider",
            description: "Capture provider-slot ingress.",
            mapper: (call: any) => [
              { type: call.arguments.frame ? "test.frame" : "test.qwen", payload: call.arguments },
              { type: "panopticon.output.apply", payload: call.arguments },
            ],
          }),
        ],
      });
    },
  });

  let qwenWs: WebSocket | undefined;
  let vlmWs: WebSocket | undefined;
  try {
    qwenWs = new WebSocket(`${server.url().replace("http", "ws")}/sessions/provider/transcription`);
    await waitForOpen(qwenWs);
    const qwenReady = await waitForMessage<any>(qwenWs, (message) => message.type === "transcriber.ready");
    qwenWs.send(
      JSON.stringify({
        type: "qwen_asr.transcript",
        transcript: "Panop steer cometa toward tests.",
        isFinal: true,
        speaker: "speaker_0",
        words: [{ text: "cometa", speaker: "speaker_0" }],
        rawInferenceMs: 12,
        sentAtMs: Date.now(),
      }),
    );
    const qwenMessage = await waitForMessage<any>(qwenWs, (message) => message.type === "qwen_asr.transcript");

    vlmWs = new WebSocket(`${server.url().replace("http", "ws")}/sessions/provider/vlm`);
    await waitForOpen(vlmWs);
    const vlmReady = await waitForMessage<any>(vlmWs, (message) => message.type === "vlm.ready");
    vlmWs.send(JSON.stringify({ description: "A frame shows the process board." }));
    const vlmMessage = await waitForMessage<any>(vlmWs, (message) => message.type === "frame.results");

    const output = {
      qwenReadyProvider: qwenReady.provider,
      qwenTranscript: qwenMessage.transcript,
      qwenSpeaker: qwenMessage.results?.[0]?.observation?.payload?.speaker,
      qwenAction: qwenMessage.results?.[0]?.toolResults?.[0]?.actions?.[0]?.type,
      vlmReadyProvider: vlmReady.provider,
      vlmAction: vlmMessage.results?.[0]?.toolResults?.[0]?.actions?.[0]?.type,
      outputProviderAction: handledOutputActions.at(-1),
      deepgramExportPresent: typeof deepgramTranscriptionProvider === "function",
    };
    await appendTrace("cue.provider_slots", output);
    return output;
  } finally {
    qwenWs?.close();
    vlmWs?.close();
    await server.close();
  }
}

async function exerciseJsonlRecording(core: CueCore, serverModule: CueServer): Promise<Record<string, any[]>> {
  const { CueHarness, ManualHeartbeat, MappedActionTool, Triggers, transcriptObservation } = core;
  const { startServer } = serverModule;
  const runDir = await mkdtemp(join(tmpdir(), "p-cue-recording-"));
  const server = await startServer({
    port: 0,
    recording: { dir: runDir },
    createHarness({ sessionId }: any) {
      return new CueHarness({
        sessionId,
        cues: [new ManualHeartbeat()],
        programs: [
          {
            name: "trace-program",
            triggers: [Triggers.onCue("manual")],
            allowedTools: ["panopticon.trace"],
            llmProvider: {
              infer() {
                return [{ tool: "panopticon.trace", arguments: { stable: true } }];
              },
            },
          },
        ],
        tools: [
          new MappedActionTool({
            name: "panopticon.trace",
            description: "Emit trace action.",
            mapper: (call: any) => [{ type: "trace.action", payload: call.arguments }],
          }),
        ],
      });
    },
  });
  try {
    const response = await fetch(`${server.url()}/sessions/trace-session/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transcriptObservation("trace me", { timestamp: 1 })),
    });
    expect(response.status).toBe(200);
    const observations = parseJsonl(await readFile(join(runDir, "trace-session", "observations.jsonl"), "utf8"));
    const decisions = parseJsonl(await readFile(join(runDir, "trace-session", "decisions.jsonl"), "utf8"));
    const actions = parseJsonl(await readFile(join(runDir, "trace-session", "actions.jsonl"), "utf8"));
    const output = { observations, decisions, actions };
    await appendTrace("cue.jsonl_recording", {
      observationCount: observations.length,
      decisionCount: decisions.length,
      actionCount: actions.length,
    });
    return output;
  } finally {
    await server.close();
  }
}

async function exerciseRoutes(core: CueCore, serverModule: CueServer): Promise<Record<string, unknown>> {
  const { CueHarness, ManualHeartbeat, Triggers, transcriptObservation } = core;
  const { startServer } = serverModule;
  const server = await startServer({
    port: 0,
    createHarness({ sessionId }: any) {
      return new CueHarness({
        sessionId,
        cues: [new ManualHeartbeat()],
        programs: [
          {
            name: "route-pass",
            triggers: [Triggers.onCue("manual")],
            llmProvider: {
              infer() {
                return [{ tool: "observe.pass", arguments: { reason: "route-test" } }];
              },
            },
          },
        ],
      });
    },
  });
  let ws: WebSocket | undefined;
  try {
    const stateResponse = await fetch(`${server.url()}/sessions/route/state`);
    const agentResponse = await fetch(`${server.url()}/sessions/route/agent`);
    ws = new WebSocket(`${server.url().replace("http", "ws")}/sessions/route/events`);
    await waitForOpen(ws);
    const ready = await waitForMessage<any>(ws, (message) => message.type === "ready");
    const transcript = waitForMessage<any>(ws, (message) => message.type === "transcript");
    const observationResponse = await fetch(`${server.url()}/sessions/route/observations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(transcriptObservation("route event", { timestamp: 1 })),
    });
    const transcriptEvent = await transcript;
    const sseProbe = await fetch(`${server.url()}/sessions/route/events`, {
      headers: { accept: "text/event-stream" },
    });
    const output = {
      httpState: stateResponse.status,
      httpAgent: agentResponse.status,
      httpObservation: observationResponse.status,
      eventReady: ready.sessionId === "route",
      transcriptEvent: transcriptEvent.text,
      hasNativeEventSourceSse: sseProbe.headers.get("content-type")?.includes("text/event-stream") ?? false,
    };
    await appendTrace("cue.routes", output);
    return output;
  } finally {
    ws?.close();
    await server.close();
  }
}

async function primitiveMatrix(core: CueCore, serverModule: CueServer): Promise<Record<string, unknown>> {
  return {
    confirmedPrimitives: [
      "TextCue",
      "SpeakerWordCue",
      "IdleCue",
      "WordCountCue",
      "IntervalCue.intervalSeconds",
      "TextCue.cooldownSeconds",
      "observe.pass",
      "CueHarness",
      "SemanticProgram",
      "MappedActionTool",
      "transcriptionProvider",
      "llmProvider",
      "outputProviders",
      "vlmProvider",
      "recording.JSONL",
      "HTTP state/agent/observations",
      "WebSocket events",
      "qwen-asr JSON transcription ingress",
      "voxterm transcription provider",
    ],
    ownedExtensionsRequired: [
      "Panopticon transcript normalization adds sessionId/correlationId fields around Cue transcript observations.",
      "Earcon emission remains adapter-owned; Cue supplies the deterministic TextCue result.",
      "IntervalCue does not expose cooldownSeconds directly; cadence throttling must combine intervalSeconds with adapter/tool cooldown.",
      "Cue exposes WebSocket events, not native EventSource SSE; board SSE requires a thin bridge if EventSource is mandatory.",
      "Current Cue source exports deepgramTranscriptionProvider in addition to qwen-asr and voxterm; ENG-T-10 should target the qwen-asr JSON shape when Panopticon owns ASR.",
    ],
    exports: {
      TextCue: typeof core.TextCue === "function",
      SpeakerWordCue: typeof core.SpeakerWordCue === "function",
      IdleCue: typeof core.IdleCue === "function",
      WordCountCue: typeof core.WordCountCue === "function",
      IntervalCue: typeof core.IntervalCue === "function",
      CueHarness: typeof core.CueHarness === "function",
      MappedActionTool: typeof core.MappedActionTool === "function",
      qwenAsrTranscriptionProvider: typeof serverModule.qwenAsrTranscriptionProvider === "function",
      voxtermTranscriptionProvider: typeof serverModule.voxtermTranscriptionProvider === "function",
      deepgramTranscriptionProvider: typeof serverModule.deepgramTranscriptionProvider === "function",
      startServer: typeof serverModule.startServer === "function",
    },
  };
}

async function writeProbeVerdict(green: boolean, summary: string): Promise<void> {
  await writeJson(join(PROBE_ROOT, "verdict.json"), {
    green,
    ticketId: PROBE_ID,
    summary,
  });
}

async function appendTrace(event: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(TRACE_ROOT, { recursive: true });
  const line = JSON.stringify({
    level: "info",
    event,
    sessionId: "p-cue",
    correlationId: "p-cue-real-cue-substrate",
    latencyMs: typeof meta.latencyMs === "number" ? meta.latencyMs : undefined,
    meta,
  });
  await appendFile(join(TRACE_ROOT, "p-cue.jsonl"), `${line}\n`, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJsonl(contents: string): Array<Record<string, any>> {
  return contents
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForMessage<T>(ws: WebSocket, accept: (message: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket message."));
    }, 3000);
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as T;
      if (!accept(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      ws.off("error", onError);
    };
    ws.on("message", onMessage);
    ws.on("error", onError);
  });
}
