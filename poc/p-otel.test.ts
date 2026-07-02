import { afterEach, describe, expect, test } from "bun:test";
import { createGenAiOtlpPayload, GenAiOtlpExporter } from "../src/obs/otel";

const servers: Bun.Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

describe("P-OTEL informational probe", () => {
  test("exports Smithers GenAI spans to a Langfuse-compatible OTLP endpoint", async () => {
    const received: unknown[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        received.push(await request.json());
        return new Response(null, { status: process.env.VIBERSYN_RBG_OTEL_EXPORT_FAIL === "1" ? 503 : 200 });
      },
    });
    servers.push(server);

    const exporter = new GenAiOtlpExporter({
      endpoint: `http://${server.hostname}:${server.port}/api/public/otel/v1/traces`,
      serviceName: "vibersyn-test",
    });
    const result = await exporter.exportCall({
      correlationId: "corr-otel-001",
      upid: "upid-otel-001",
      runId: "run-otel-001",
      provider: "smithers",
      model: "codex",
      operation: "agent",
      promptTokens: 10,
      completionTokens: 5,
      startedAtMs: 1,
      endedAtMs: 8,
    });

    expect(result).toEqual(expect.objectContaining({ attempted: true, ok: true, status: 200 }));
    expect(received).toHaveLength(1);
    expect(JSON.stringify(received[0])).toContain("gen_ai.system");
    expect(JSON.stringify(received[0])).toContain("vibersyn.correlation_id");
  });

  test("payload carries OpenTelemetry GenAI semantic convention attributes", () => {
    const payload = createGenAiOtlpPayload({
      correlationId: "corr-otel-002",
      upid: "upid-otel-002",
      runId: "run-otel-002",
      provider: process.env.VIBERSYN_RBG_OTEL_DROP_GENAI === "1" ? "" : "smithers",
      model: "codex",
      operation: "chat",
      promptTokens: 3,
      completionTokens: 2,
      startedAtMs: 2,
      endedAtMs: 4,
    });
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    const keys = span.attributes.map((attribute) => attribute.key);

    expect(keys).toContain("gen_ai.system");
    expect(keys).toContain("gen_ai.operation.name");
    expect(keys).toContain("gen_ai.request.model");
    expect(keys).toContain("gen_ai.usage.input_tokens");
    expect(keys).toContain("vibersyn.upid");
    expect(span.name).toBe("gen_ai.chat");
    expect(JSON.stringify(payload)).toContain("smithers");
  });
});
