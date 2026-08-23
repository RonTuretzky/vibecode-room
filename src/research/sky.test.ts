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

// ── relate loudness: the 402 can never be silent again ───────────────────────

describe("CloudGraph relate loudness", () => {
  test("a throwing runner (the 402) builds a streak with its reason; warn at 3; a landed tick resets", async () => {
    const traces: SkyTraceEvent[] = [];
    let mode: "throw" | "ok" = "throw";
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      onTrace: (event) => traces.push(event),
      runner: async () => {
        if (mode === "throw") {
          throw new Error("cerebras 402: payment_required");
        }
        return "{}";
      },
    });
    for (let tick = 1; tick <= 3; tick += 1) {
      observeStandardSky(graph); // re-arm the dirty gate
      await graph.relateNow();
      const miss = traces.filter((event) => event.event === "research.sky.miss").at(-1)!;
      expect(miss.meta.reason).toBe("cerebras 402: payment_required");
      expect(graph.agentHealth().missStreak).toBe(tick);
      // debug below the streak threshold, warn at it — silent forever is
      // impossible, log-spam on tick one is avoided.
      expect(miss.level).toBe(tick >= 3 ? "warn" : "debug");
    }
    const snapshot = graph.snapshot();
    expect(snapshot.relate).toEqual({ missStreak: 3, lastMissReason: "cerebras 402: payment_required", agent: null });
    expect(snapshot.agentAtMs).toBeNull();
    // The tick lands → streak clears, agentAtMs stamps. A scripted runner
    // carries no transport provenance — agent stays honestly null.
    mode = "ok";
    observeStandardSky(graph);
    await graph.relateNow();
    expect(graph.agentHealth()).toEqual({ missStreak: 0, lastMissReason: null, agentAtMs: 10_000, agent: null });
    expect(graph.snapshot().relate).toEqual({ missStreak: 0, lastMissReason: null, agent: null });
  });

  test("a stand-in rescue lands the tick with provenance and a loud trace", async () => {
    // The production composite (standin.ts) rescues a failing Cerebras account
    // via the host claude CLI and wraps the reply with WHO answered and WHY
    // the primary could not — the graph must stamp the agent, trace the rescue
    // at warn, and apply the reply like any landed tick.
    const traces: SkyTraceEvent[] = [];
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 55_000,
      onTrace: (event) => traces.push(event),
      runner: async () => ({
        kind: "agent-reply",
        agent: "host-claude",
        standinFor: "cerebras 402: payment_required",
        reply: '{"links":[{"a":"topic-0001","b":"topic-0003","strength":0.8,"reason":"same evening"}]}',
      }),
    });
    observeStandardSky(graph);
    await graph.relateNow();
    const standin = traces.find((event) => event.event === "research.sky.standin");
    expect(standin?.level).toBe("warn");
    expect(standin?.meta.for).toBe("cerebras 402: payment_required");
    expect(standin?.meta.agent).toBe("host-claude");
    expect(graph.agentHealth()).toEqual({
      missStreak: 0,
      lastMissReason: null,
      agentAtMs: 55_000,
      agent: "host-claude",
    });
    expect(graph.snapshot().relate).toEqual({ missStreak: 0, lastMissReason: null, agent: "host-claude" });
    // The wrapped reply itself landed: an agent-source link exists.
    const agentLink = graph.snapshot().links.find((link) => link.source === "agent");
    expect(agentLink?.a).toBe("topic-0001");
    expect(agentLink?.b).toBe("topic-0003");
  });

  test("a miss re-arms the tick — a quiet room still crosses the health threshold", async () => {
    // Without re-arm, a room that stops talking after 2 misses would stall
    // below the degraded streak forever (and never retry into recovery).
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      runner: async () => {
        throw new Error("cerebras 402: payment_required");
      },
    });
    observeStandardSky(graph); // arm ONCE — no new material after this
    await graph.relateNow();
    await graph.relateNow();
    await graph.relateNow();
    expect(graph.agentHealth().missStreak).toBe(3);
  });

  test("timeout and garbage replies carry their own reasons", async () => {
    const hangingGraph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      timeoutMs: 5,
      runner: () => new Promise(() => undefined), // never resolves
    });
    observeStandardSky(hangingGraph);
    await hangingGraph.relateNow();
    expect(hangingGraph.agentHealth().lastMissReason).toBe("timeout");
    const garbageGraph = new CloudGraph({
      intervalMs: 0,
      clock: () => 10_000,
      runner: async () => "no json here at all",
    });
    observeStandardSky(garbageGraph);
    await garbageGraph.relateNow();
    expect(garbageGraph.agentHealth().lastMissReason).toBe("bad-payload");
  });
});

// ── star retention: turns survive retirement as gists ────────────────────────

describe("CloudGraph star retention", () => {
  function loopWithWindow(windowTurns: number): ResearchLoop {
    return new ResearchLoop({
      sessionId: "star-test",
      suggester: new NoopSuggester(),
      agent: new NoopAgent(),
      suggestIntervalMs: 0,
      conceptTree: new ConceptTree({ model: null }),
      cloudGraph: new CloudGraph({ runner: null, intervalMs: 0 }),
      windowTurns,
    });
  }

  test("retiring >12 turns through one cloud keeps the 12 freshest gists and counts the elided", () => {
    const loop = loopWithWindow(4);
    let atMs = 0;
    for (let index = 0; index < 20; index += 1) {
      atMs += 30_000;
      loop.ingestTurn({
        speaker: index % 2 === 0 ? "s1" : "s2",
        text: `rocket engine thrust chamber test number ${index} looked strong`,
        atMs,
      });
    }
    const cloud = loop.sky().clouds.find((entry) => entry.label.toLowerCase().includes("rocket"))!;
    // 20 ingested, 4 still live → 16 retired; cap 12, 4 elided.
    expect(cloud.stars).toHaveLength(12);
    expect(cloud.elidedCount).toBe(4);
    // Newest-kept, chronological, with REAL text.
    const numbers = cloud.stars.map((star) => Number(/number (\d+)/.exec(star.gist)![1]));
    expect(numbers).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (const star of cloud.stars) {
      expect(star.gist.length).toBeLessThanOrEqual(80);
      expect(star.gist).toContain("rocket engine");
      expect(star.speaker).not.toBeNull();
      expect(star.atMs).toBeGreaterThan(0);
    }
  });

  test("agent merges concatenate stars chronologically, cap enforced, elided sums", async () => {
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 99_000,
      runner: async () => JSON.stringify({ merges: [{ into: "topic-0002", from: ["topic-0001"], reason: "same" }] }),
    });
    observeStandardSky(graph);
    // Retire the solar turns by observing without their topic or turns.
    graph.observe(
      [
        topic("topic-0002", "battery storage", ["t3", "t4"], 31_000),
        topic("topic-0003", "opera rehearsal", ["t5"], 41_000),
      ],
      [...BATTERY_TURNS, ...OPERA_TURNS],
    );
    // Then retire a battery turn too so the survivor has its own star.
    graph.observe(
      [
        topic("topic-0002", "battery storage", ["t4"], 31_000),
        topic("topic-0003", "opera rehearsal", ["t5"], 41_000),
      ],
      [BATTERY_TURNS[1]!, ...OPERA_TURNS],
    );
    await graph.relateNow();
    const survivor = graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0002")!;
    expect(survivor.stars.map((star) => star.id)).toEqual(["t1", "t2", "t3"]);
    expect(survivor.stars.map((star) => star.atMs)).toEqual([1_000, 11_000, 21_000]);
    expect(survivor.elidedCount).toBe(0);
  });

  test("a full 24-cloud snapshot stays under the SSE budget (<25KB)", () => {
    const graph = new CloudGraph({ runner: null, intervalMs: 0, clock: () => 10_000_000 });
    // 24 topics × 14 turns each, all retired through a shrinking window.
    const allTopics: ConceptTopic[] = [];
    const allTurns: TranscriptTurn[] = [];
    for (let index = 0; index < 24; index += 1) {
      const ids: string[] = [];
      for (let member = 0; member < 14; member += 1) {
        const id = `t-${index}-${member}`;
        ids.push(id);
        allTurns.push(
          turn(id, `subject ${index} item ${member} with a long enough sentence to fill a gist to the eighty char cap x`, index * 10_000 + member * 100, `speaker_${member % 6}`),
        );
      }
      allTopics.push(topic(`topic-${String(index + 1).padStart(4, "0")}`, `Subject thread ${index} alpha beta gamma delta`, ids, index * 10_000 + 1_400));
    }
    graph.observe(allTopics, allTurns);
    graph.observe(allTopics, []); // retire everything
    const size = JSON.stringify(graph.snapshot()).length;
    expect(graph.snapshot().clouds).toHaveLength(24);
    expect(size).toBeLessThan(25_000);
  });
});

// ── dust: babble never earns a cloud, agent dusting is loud + reversible ─────

describe("CloudGraph dust", () => {
  test("retired dust turns fold into the graph-level ledger, never a cloud", () => {
    const loop = new ResearchLoop({
      sessionId: "dust-test",
      suggester: new NoopSuggester(),
      agent: new NoopAgent(),
      suggestIntervalMs: 0,
      conceptTree: new ConceptTree({ model: null }),
      cloudGraph: new CloudGraph({ runner: null, intervalMs: 0 }),
      windowTurns: 3,
    });
    let atMs = 0;
    const speak = (speaker: string, text: string) => {
      atMs += 30_000;
      loop.ingestTurn({ speaker, text, atMs });
    };
    speak("s1", "solar panel inverter efficiency dropped again today");
    speak("s2", "yep");
    speak("s1", "battery storage smooths the inverter output curve nicely");
    speak("s2", "oh my god");
    speak("s1", "the rehearsal moved to thursday evening at the opera house");
    speak("s2", "sure sure");
    const sky = loop.sky();
    // Babble formed no cloud at all…
    for (const cloud of sky.clouds) {
      expect(cloud.turnCount).toBeGreaterThan(0);
      expect(cloud.label.toLowerCase()).not.toContain("yep");
    }
    // …and the retired babble is in the dust ledger (window 3 dropped the
    // first two dust turns by now).
    expect(sky.dust!.length).toBeGreaterThanOrEqual(1);
  });

  test("the agent dust verb un-names a cloud (traced) and growth reverses it", async () => {
    const traces: SkyTraceEvent[] = [];
    const graph = new CloudGraph({
      intervalMs: 0,
      clock: () => 50_000,
      onTrace: (event) => traces.push(event),
      runner: async () => JSON.stringify({ dust: [{ id: "topic-0001", reason: "pure backchannel" }] }),
    });
    observeStandardSky(graph);
    expect(graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0001")!.named).toBe(true);
    await graph.relateNow();
    const dusted = graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0001")!;
    expect(dusted.named).toBe(false);
    expect(graph.snapshot().agentAtMs).toBe(50_000); // dusting IS the agent speaking
    expect(traces.some((event) => event.event === "research.sky.dust")).toBe(true);
    // Growth past the dusted-at count restores the name (reversible).
    graph.observe(
      [
        topic("topic-0001", "solar panel efficiency", ["t1", "t2", "t6"], 45_000),
        topic("topic-0002", "battery storage", ["t3", "t4"], 31_000),
        topic("topic-0003", "opera rehearsal", ["t5"], 41_000),
      ],
      [
        ...SOLAR_TURNS,
        ...BATTERY_TURNS,
        ...OPERA_TURNS,
        turn("t6", "solar panel inverter efficiency recovered fully", 45_000),
      ],
    );
    expect(graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0001")!.named).toBe(true);
  });

  test("a thin accumulation surfaces unnamed even without the agent", () => {
    const graph = new CloudGraph({ runner: null, intervalMs: 0, clock: () => 50_000 });
    observeStandardSky(graph);
    const opera = graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0003")!;
    // 5 distinct content tokens < the 6-token naming bar.
    expect(opera.named).toBe(false);
    const solar = graph.snapshot().clouds.find((cloud) => cloud.id === "topic-0001")!;
    expect(solar.named).toBe(true);
  });
});
