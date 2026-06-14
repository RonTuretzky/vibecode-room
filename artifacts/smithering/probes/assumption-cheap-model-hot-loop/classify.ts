/**
 * Cue hot-loop decision classifier.
 *
 * Mimics the LLM-scored observe.pass vs action decision that Cue makes on each
 * transcript segment. In production this runs inside Cue's Program as the
 * "LLM provider" slot; here we call the model API directly to measure quality,
 * latency, and cost before wiring Cue.
 *
 * Decision: "PASS" (observe.pass) or "ACT" (wake the suggestion engine / route
 * a command).
 */

export type Decision = "PASS" | "ACT";

export interface ClassifyResult {
  decision: Decision;
  reasoning: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

const SYSTEM_PROMPT = `You are the hot-loop decision classifier for Panopticon, an audio-only AI operating system for engineering rooms. You receive transcript segments from a shared room microphone.

Your ONLY job: decide whether this segment warrants waking the suggestion engine ("ACT") or should be silently ignored ("PASS").

ACT when the segment contains:
- A clear, specific, new buildable idea ("we should build X", "let's add Y", "we need a Z")
- A named-process magic word followed by a command (e.g. "Daybreak, pause", "Nightfall kill", "Daybreak fork")
- A panic/stop word ("stop everything", "[callsign] stop")
- A clear accept or reject of a pending suggestion ("yeah let's do it", "no skip it")

PASS for everything else:
- Status updates about existing work
- Discussion, questions, explanations between people
- Code review comments
- Social / off-topic conversation
- Filler words, acknowledgements, incomplete thoughts
- Vague intent that would produce false positives

Your default is PASS. Only ACT when you are confident the segment is actionable.

Respond with exactly one JSON object:
{"decision": "PASS" | "ACT", "reasoning": "<one sentence>"}`;

/** OpenAI-compatible classifier (used for OpenAI gpt-4o-mini as Haiku-tier stand-in) */
export async function classifyWithOpenAI(
  text: string,
  model: string,
  apiKey: string,
  baseUrl = "https://api.openai.com/v1",
): Promise<ClassifyResult> {
  const t0 = performance.now();

  const body = {
    model,
    max_tokens: 128,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Transcript segment: "${text}"` },
    ],
  };

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const latencyMs = performance.now() - t0;

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenAI-compatible API error ${resp.status}: ${err}`);
  }

  const data = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage: { prompt_tokens: number; completion_tokens: number };
  };

  const raw = data.choices[0]?.message?.content ?? "{}";
  let parsed: { decision?: string; reasoning?: string } = {};
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    const m = raw.match(/"decision"\s*:\s*"(PASS|ACT)"/);
    parsed = { decision: m?.[1], reasoning: raw.slice(0, 120) };
  }

  const decision: Decision = parsed.decision === "ACT" ? "ACT" : "PASS";

  return {
    decision,
    reasoning: parsed.reasoning ?? "",
    latencyMs,
    inputTokens: data.usage.prompt_tokens,
    outputTokens: data.usage.completion_tokens,
  };
}

export async function classifyWithCerebras(
  text: string,
  model: string,
  apiKey: string,
): Promise<ClassifyResult> {
  return classifyWithOpenAI(text, model, apiKey, "https://api.cerebras.ai/v1");
}
