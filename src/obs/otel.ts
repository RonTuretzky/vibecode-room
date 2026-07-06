export interface GenAiCallInput {
  correlationId: string;
  upid: string;
  runId: string;
  provider: string;
  model: string;
  operation: "chat" | "completion" | "tool" | "agent";
  promptTokens?: number;
  completionTokens?: number;
  startedAtMs?: number;
  endedAtMs?: number;
  attributes?: Record<string, string | number | boolean>;
}

export interface OtlpExporterOptions {
  endpoint?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  serviceName?: string;
}

export interface OtlpExportResult {
  attempted: boolean;
  ok: boolean;
  status?: number;
  body?: string;
}

export class GenAiOtlpExporter {
  readonly endpoint?: string;
  readonly headers: Record<string, string>;
  readonly fetchImpl: typeof fetch;
  readonly serviceName: string;

  constructor(options: OtlpExporterOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.LANGFUSE_OTLP_ENDPOINT;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? fetch;
    this.serviceName = options.serviceName ?? "vibersyn-smithers";
  }

  async instrumentAgentCall<T>(input: GenAiCallInput, run: () => Promise<T> | T): Promise<T> {
    const startedAtMs = input.startedAtMs ?? performance.now();
    try {
      const result = await run();
      await this.exportCall({ ...input, startedAtMs, endedAtMs: input.endedAtMs ?? performance.now() });
      return result;
    } catch (error) {
      await this.exportCall({
        ...input,
        startedAtMs,
        endedAtMs: input.endedAtMs ?? performance.now(),
        attributes: {
          ...input.attributes,
          "error.type": error instanceof Error ? error.name : "unknown",
        },
      });
      throw error;
    }
  }

  async exportCall(input: GenAiCallInput): Promise<OtlpExportResult> {
    if (this.endpoint === undefined || this.endpoint.length === 0) {
      return { attempted: false, ok: true };
    }

    const payload = createGenAiOtlpPayload(input, this.serviceName);
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...this.headers,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.text().catch(() => "");
    return { attempted: true, ok: response.ok, status: response.status, body };
  }
}

export function createGenAiOtlpPayload(input: GenAiCallInput, serviceName = "vibersyn-smithers") {
  const startedAtMs = input.startedAtMs ?? 0;
  const endedAtMs = input.endedAtMs ?? startedAtMs;
  const attributes: Record<string, string | number | boolean> = {
    "service.name": serviceName,
    "gen_ai.system": input.provider,
    "gen_ai.operation.name": input.operation,
    "gen_ai.request.model": input.model,
    "gen_ai.response.model": input.model,
    "vibersyn.correlation_id": input.correlationId,
    "vibersyn.upid": input.upid,
    "vibersyn.smithers.run_id": input.runId,
    ...input.attributes,
  };

  if (input.promptTokens !== undefined) {
    attributes["gen_ai.usage.input_tokens"] = input.promptTokens;
  }
  if (input.completionTokens !== undefined) {
    attributes["gen_ai.usage.output_tokens"] = input.completionTokens;
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: otlpAttributes({ "service.name": serviceName }),
        },
        scopeSpans: [
          {
            scope: { name: "vibersyn.obs.otel", version: "0.0.1" },
            spans: [
              {
                traceId: fixedHex(input.correlationId, 32),
                spanId: fixedHex(`${input.upid}:${input.runId}`, 16),
                name: `gen_ai.${input.operation}`,
                kind: 2,
                startTimeUnixNano: millisToNanos(startedAtMs),
                endTimeUnixNano: millisToNanos(endedAtMs),
                attributes: otlpAttributes(attributes),
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

function otlpAttributes(attributes: Record<string, string | number | boolean>) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value:
      typeof value === "number"
        ? { doubleValue: value }
        : typeof value === "boolean"
          ? { boolValue: value }
          : { stringValue: value },
  }));
}

function millisToNanos(ms: number): string {
  return String(Math.max(0, Math.round(ms * 1_000_000)));
}

function fixedHex(value: string, length: number): string {
  const bytes = new TextEncoder().encode(value);
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash).toString(16).padStart(length, "0").slice(0, length);
}
