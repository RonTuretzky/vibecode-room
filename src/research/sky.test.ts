import { describe, expect, test } from "bun:test";
import type { TranscriptTurn } from "../detect/types";
import { ResearchLoop } from "./loop";
import { CloudGraph, readSkyIntervalMs, type CloudRelateRequest, type SkyTraceEvent } from "./sky";
import { ConceptTree, type ConceptTopic } from "./tree";
import type { ResearchAgent, ResearchReport, ResearchSuggester, ResearchSuggestion } from "./types";

// The conversation sky's server half: the fold-before-death accumulator, the
// deterministic lexical linker, and the recurrent (manually ticked here —
// intervalMs 0) relate thread with per-entry validation and provenance.

// ── fixtures ─────────────────────────────────────────────────────────────────

function turn(id: string, text: string, atMs: number, speaker: string | null = "s1"): TranscriptTurn {
  return { id, speaker, text, atMs };
}

function topic(id: string, label: string, turnIds: string[], freshAtMs: number): ConceptTopic {
  return { id, label, turnIds, freshAtMs };
}

// Two-cloud graph with overlapping vocabulary (rocket ∩ engine) plus quests —
// the smallest sky the lexical linker and the relate tick both act on.
const SOLAR_TURNS = [
  turn("t1", "solar panel inverter efficiency numbers today", 1_000),
  turn("t2", "solar panel inverter efficiency dropped", 11_000, "s2"),
];
const BATTERY_TURNS = [
  turn("t3", "battery storage smooths solar panel inverter output", 21_000),
  turn("t4", "battery storage keeps solar panel efficiency stable", 31_000, "s2"),
];
const OPERA_TURNS = [turn("t5", "the opera rehearsal moved to thursday evening", 41_000)];

function observeStandardSky(graph: CloudGraph): void {
  graph.observe(
    [
      topic("topic-0001", "solar panel efficiency", ["t1", "t2"], 11_000),
      topic("topic-0002", "battery storage", ["t3", "t4"], 31_000),
      topic("topic-0003", "opera rehearsal", ["t5"], 41_000),
    ],
    [...SOLAR_TURNS, ...BATTERY_TURNS, ...OPERA_TURNS],
  );
}

// ── the accumulator: memory beyond the rolling window ────────────────────────

describe("CloudGraph accumulator", () => {
  test("a topic the window killed survives as a dead cloud with its turn count", () => {
    // Real loop, real tree (heuristic-only), real window: 10 solar turns, then
    // 45 rocket turns. Window 40 drops every solar turn → ConceptTree deletes
    // the solar topic (branches never outlive their dialogue) — but the SKY
    // remembers: the cloud keeps its folded turn count with liveTopicId null.
    const loop = new ResearchLoop({
      sessionId: "sky-test",
      suggester: new NoopSuggester(),
      agent: new NoopAgent(),
      suggestIntervalMs: 0,
      conceptTree: new ConceptTree({ model: null }),
      cloudGraph: new CloudGraph({ runner: null, intervalMs: 0 }),
    });
    let atMs = 0;
    for (let index = 0; index < 10; index += 1) {
      // Spaced past the coalesce gap, alternating speakers — 10 distinct turns.
      atMs += 10_000;
      loop.ingestTurn({ speaker: index % 2 === 0 ? "s1" : "s2", text: `solar panel inverter efficiency reading ${index}`, atMs });
    }
    for (let index = 0; index < 45; index += 1) {
      atMs += 10_000;
      loop.ingestTurn({ speaker: index % 2 === 0 ? "s1" : "s2", text: `rocket engine thrust chamber test ${index}`, atMs });
    }
    expect(loop.turns()).toHaveLength(40);
    // The live tree only knows the rocket topic now.
    expect(loop.topics()).toHaveLength(1);
    const sky = loop.sky();
    expect(sky.clouds).toHaveLength(2);
    const solar = sky.clouds.find((cloud) => cloud.label.toLowerCase().includes("solar"));
    const rocket = sky.clouds.find((cloud) => cloud.label.toLowerCase().includes("rocket"));
    expect(solar?.liveTopicId).toBeNull();
    expect(solar?.turnCount).toBe(10);
    expect(rocket?.liveTopicId).not.toBeNull();
    // 45 rocket turns total: 5 retired past the window + 40 live.
    expect(rocket?.turnCount).toBe(45);
    expect(sky.agentAtMs).toBeNull();
  });

  test("reset clears clouds, links, and the agent stamp", async () => {
    const graph = new CloudGraph({ runner: async () => '{"links":[{"a":"topic-0001","b":"topic-0002","strength":0.9,"reason":"x"}]}', intervalMs: 0, clock: () => 99 });
    observeStandardSky(graph);
    await graph.relateNow();
    expect(graph.snapshot().agentAtMs).toBe(99);
    graph.reset();
    expect(graph.snapshot().clouds).toHaveLength(0);
    expect(graph.snapshot().links).toHaveLength(0);
    expect(graph.snapshot().agentAtMs).toBeNull();
  });
});

// ── the deterministic lexical linker (the offline sky) ───────────────────────

describe("CloudGraph lexical linker", () => {
  test("overlapping vocabularies link with source lexical and a shared-token reason", () => {
    const graph = new CloudGraph({ runner: null, intervalMs: 0, clock: () => 50_000 });
    observeStandardSky(graph);
    const links = graph.snapshot().links;
    const solarBattery = links.find(
      (link) => [link.a, link.b].includes("topic-0001") && [link.a, link.b].includes("topic-0002"),
    );
    expect(solarBattery).toBeDefined();
    expect(solarBattery?.source).toBe("lexical");
    expect(solarBattery?.strength).toBeGreaterThan(0);
    // The reason names the actual overlap — "solar"/"panel" bridge the bags.
    expect(solarBattery?.reason).toContain("solar");
    // Disjoint vocabulary (opera) stays unlinked.
    expect(links.some((link) => [link.a, link.b].includes("topic-0003"))).toBe(false);
    // Deterministic: same inputs, same links.
    expect(graph.snapshot().links).toEqual(links);
  });

  test("a research quest bridges its home cloud to the cloud its claim matches", () => {
    const graph = new CloudGraph({ runner: null, intervalMs: 0, clock: () => 50_000 });
    graph.observe(
      [
        topic("topic-0001", "solar", ["t1", "t2"], 11_000),
        topic("topic-0003", "opera", ["t5"], 41_000),
      ],
      [...SOLAR_TURNS, ...OPERA_TURNS],
      [
        {
          id: "rq-1",
          status: "proposed",
          topic: "Opera acoustics",
          // Grounded in the opera turn, but the claim's vocabulary lives in
          // the solar cloud — cross-topic evidence.
          claim: "solar panel inverter noise disrupts the rehearsal",
          turnId: "t5",
        },
      ],
    );
    const bridge = graph.snapshot().links.find((link) => link.reason.startsWith("research bridge"));
    expect(bridge).toBeDefined();
    expect(bridge?.source).toBe("lexical");
    expect([bridge?.a, bridge?.b]).toContain("topic-0001");
    expect([bridge?.a, bridge?.b]).toContain("topic-0003");
  });
});

// ── the recurrent relate tick ────────────────────────────────────────────────

describe("CloudGraph relate tick", () => {
  test("a scripted reply applies agent links, names, and the honesty stamp", async () => {
    const requests: CloudRelateRequest[] = [];
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 77_000,
      runner: async (request) => {
        requests.push(request);
        return JSON.stringify({
          links: [{ a: "topic-0001", b: "topic-0003", strength: 0.8, reason: "both about evening logistics" }],
          names: [{ id: "topic-0001", name: "Solar Efficiency" }],
        });
      },
    });
    observeStandardSky(graph);
    await graph.relateNow();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.clouds.map((cloud) => cloud.id)).toEqual(["topic-0001", "topic-0002", "topic-0003"]);
    const sky = graph.snapshot();
    const agentLink = sky.links.find((link) => link.source === "agent");
    expect(agentLink?.a).toBe("topic-0001");
    expect(agentLink?.b).toBe("topic-0003");
    expect(agentLink?.strength).toBeCloseTo(0.8, 5);
    // Lexical links still ride beside the agent's.
    expect(sky.links.some((link) => link.source === "lexical")).toBe(true);
    const named = sky.clouds.find((cloud) => cloud.id === "topic-0001");
    expect(named?.label).toBe("Solar Efficiency");
    expect(named?.labelSource).toBe("agent");
    expect(sky.agentAtMs).toBe(77_000);
  });

  test("merges fold a DEAD cloud into the survivor and re-point its links", async () => {
    const traces: SkyTraceEvent[] = [];
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 88_000,
      onTrace: (event) => traces.push(event),
      runner: async () =>
        JSON.stringify({ merges: [{ into: "topic-0002", from: ["topic-0001"], reason: "same energy thread" }] }),
    });
    observeStandardSky(graph);
    // Second observe without the solar topic (and without its turns): the
    // solar turns retire into their cloud, which goes dead — mergeable.
    graph.observe(
      [
        topic("topic-0002", "battery storage", ["t3", "t4"], 31_000),
        topic("topic-0003", "opera rehearsal", ["t5"], 41_000),
      ],
      [...BATTERY_TURNS, ...OPERA_TURNS],
    );
    await graph.relateNow();
    const sky = graph.snapshot();
    expect(sky.clouds.map((cloud) => cloud.id)).toEqual(["topic-0002", "topic-0003"]);
    const survivor = sky.clouds.find((cloud) => cloud.id === "topic-0002");
    // 2 battery members + the 2 folded solar turns.
    expect(survivor?.turnCount).toBe(4);
    expect(traces.some((event) => event.event === "research.sky.merge")).toBe(true);
  });

  test("a merge of a LIVE cloud is rejected entry-by-entry, valid siblings apply", async () => {
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 91_000,
      runner: async () =>
        JSON.stringify({
          // topic-0001 is live → rejected; the link beside it must still land.
          merges: [{ into: "topic-0002", from: ["topic-0001"], reason: "nope" }],
          links: [
            { a: "topic-0001", b: "topic-0002", strength: 2.5, reason: "clamped" },
            { a: "topic-9999", b: "topic-0002", strength: 0.5, reason: "unknown id" },
          ],
          names: [{ id: "topic-9999", name: "Ghost" }],
        }),
    });
    observeStandardSky(graph);
    await graph.relateNow();
    const sky = graph.snapshot();
    expect(sky.clouds).toHaveLength(3);
    const agentLinks = sky.links.filter((link) => link.source === "agent");
    expect(agentLinks).toHaveLength(1);
    expect(agentLinks[0]!.strength).toBe(1); // clamped into 0..1
    expect(sky.agentAtMs).toBe(91_000);
  });

  test("garbage output leaves the sky untouched and the agent stamp null", async () => {
    const traces: SkyTraceEvent[] = [];
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 12_000,
      onTrace: (event) => traces.push(event),
      runner: async () => "the model rambled with no json at all",
    });
    observeStandardSky(graph);
    await graph.relateNow();
    const sky = graph.snapshot();
    expect(sky.agentAtMs).toBeNull();
    expect(sky.links.every((link) => link.source === "lexical")).toBe(true);
    expect(traces.some((event) => event.event === "research.sky.reject")).toBe(true);
  });

  test("runner null is lexical-only: relateNow no-ops, links still present", async () => {
    const graph = new CloudGraph({ runner: null, intervalMs: 0, clock: () => 60_000 });
    observeStandardSky(graph);
    await graph.relateNow();
    const sky = graph.snapshot();
    expect(sky.agentAtMs).toBeNull();
    expect(sky.links.length).toBeGreaterThan(0);
  });

  test("the dirty gate: an unchanged graph never re-asks the model", async () => {
    let calls = 0;
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      runner: async () => {
        calls += 1;
        return "{}";
      },
    });
    observeStandardSky(graph);
    await graph.relateNow();
    await graph.relateNow();
    expect(calls).toBe(1);
    observeStandardSky(graph); // new material re-arms the gate
    await graph.relateNow();
    expect(calls).toBe(2);
  });

  test("ticks never overlap: a second relateNow joins the in-flight one", async () => {
    let calls = 0;
    let release: (() => void) | null = null;
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      runner: async () => {
        calls += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "{}";
      },
    });
    observeStandardSky(graph);
    const first = graph.relateNow();
    const second = graph.relateNow();
    expect(second).toBe(first);
    release!();
    await graph.settle();
    expect(calls).toBe(1);
  });
});

// ── env knob ─────────────────────────────────────────────────────────────────

describe("readSkyIntervalMs", () => {
  test("defaults, honors overrides, 0 disables, negatives throw", () => {
    expect(readSkyIntervalMs({})).toBe(60_000);
    expect(readSkyIntervalMs({ VIBERSYN_SKY_INTERVAL_MS: "120000" })).toBe(120_000);
    expect(readSkyIntervalMs({ VIBERSYN_SKY_INTERVAL_MS: "0" })).toBe(0);
    expect(() => readSkyIntervalMs({ VIBERSYN_SKY_INTERVAL_MS: "-5" })).toThrow();
    expect(() => readSkyIntervalMs({ VIBERSYN_SKY_INTERVAL_MS: "soon" })).toThrow();
  });
});

// ── inert research stubs (the sky tests never run suggestion rounds) ─────────

class NoopSuggester implements ResearchSuggester {
  async suggest(): Promise<ResearchSuggestion[]> {
    return [];
  }
}

class NoopAgent implements ResearchAgent {
  async research(): Promise<ResearchReport> {
    return { summary: "", confidence: "low", findings: [], biasNotes: [], sources: [], followUps: [] };
  }
}
