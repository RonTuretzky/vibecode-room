import { describe, expect, test } from "bun:test";
import { ResearchLoop } from "./loop";
import { CloudGraph } from "./sky";
import { ConceptTree, contentWorthiness } from "./tree";
import type { ResearchAgent, ResearchReport, ResearchSuggester, ResearchSuggestion } from "./types";
import { questCloudId, resolveConstellations } from "../ui/sky/constellation-layout";

// SYNTH-CONVERSATION E2E (server side): a scripted evening with everything the
// live room throws at the pipeline — six content threads, two mid-sentence
// fragment pairs (same speaker, 8-12s final-arrival gaps), a cross-mic ECHO of
// every line (the rig's two mics), and >40% backchannel babble. The whole
// repaired pipeline must hold at once: echoes dedupe, fragments merge, babble
// forms no named topic, and quests anchor to the right asterism.

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

const THREADS: Array<[string, string]> = [
  ["s1", "the solar inverter efficiency numbers dropped nine percent overnight on the roof array"],
  ["s2", "vending machines that accept crypto payments could settle nightly with the exchange"],
  ["s1", "the kabul weather forecast says heavy snow across the passes tomorrow evening"],
  ["s3", "our multiplayer scene needs the texture packs reviewed before the friday build"],
  ["s2", "the investor deck should lead with five hundred k a year in event space revenue"],
  ["s3", "smart boards in middle school classrooms changed how the teachers ran discussions"],
];
const BABBLE = ["yep", "oh my god", "sure sure", "thats fine", "okay okay", "enough enough enough"];

describe("synth conversation e2e: dedupe + merge + babble + anchors, all at once", () => {
  test("six named constellations, merged fragments, deduped echoes, dust ≥ babble", () => {
    const loop = new ResearchLoop({
      sessionId: "synth",
      suggester: new NoopSuggester(),
      agent: new NoopAgent(),
      suggestIntervalMs: 0,
      conceptTree: new ConceptTree({ model: null }),
      cloudGraph: new CloudGraph({ runner: null, intervalMs: 0 }),
      windowTurns: 60,
    });
    let atMs = 0;
    // Every spoken line arrives TWICE (the second mic echoes ~120ms later
    // under a different diarization label).
    const speakBoth = (speaker: string, text: string) => {
      atMs += 30_000;
      loop.ingestTurn({ speaker, text, atMs });
      loop.ingestTurn({ speaker: `${speaker}-echo`, text, atMs: atMs + 120 });
    };
    // Interleave: content thread, then babble (>40% of lines are babble).
    for (let index = 0; index < THREADS.length; index += 1) {
      const [speaker, text] = THREADS[index]!;
      speakBoth(speaker, text);
      speakBoth(index % 2 === 0 ? "s4" : "s5", BABBLE[index]!);
    }
    // TWO mid-sentence fragment pairs, same speaker, 8-12s later finals, an
    // echo interleaved between the halves (the operator's exact wound).
    atMs += 30_000;
    loop.ingestTurn({ speaker: "s1", text: "and the inverter vendor said the replacement", atMs });
    loop.ingestTurn({ speaker: "s1-echo", text: "and the inverter vendor said the replacement", atMs: atMs + 130 });
    loop.ingestTurn({ speaker: "s1", text: "solar panel ships thursday", atMs: atMs + 9_600 });
    atMs += 40_000;
    loop.ingestTurn({ speaker: "s3", text: "so the multiplayer texture packs reviewed", atMs });
    loop.ingestTurn({ speaker: "s3-echo", text: "so the multiplayer texture packs reviewed", atMs: atMs + 90 });
    loop.ingestTurn({ speaker: "s3", text: "tonight before the build freezes", atMs: atMs + 11_800 });

    // ECHOES DEDUPED: no surviving turn belongs to an -echo speaker with
    // duplicate text; every spoken line appears once.
    const texts = loop.turns().map((turn) => turn.text);
    expect(new Set(texts).size).toBe(texts.length);
    // FRAGMENT PAIRS are single turns, judged whole.
    expect(texts.some((text) => text === "and the inverter vendor said the replacement solar panel ships thursday")).toBe(true);
    expect(texts.some((text) => text === "so the multiplayer texture packs reviewed tonight before the build freezes")).toBe(true);
    // SIX content threads → named topics; babble founds nothing. (The two
    // fragment sentences join their threads or stand as content — but never
    // as one-babble-word topics.)
    const topics = loop.topics();
    expect(topics.length).toBeGreaterThanOrEqual(6);
    for (const topic of topics) {
      const members = loop.turns().filter((turn) => topic.turnIds.includes(turn.id));
      expect(members.some((turn) => contentWorthiness(turn.text) === "content")).toBe(true);
    }
    // DUST ≥ the babble count: every babble line is windowed but topic-less.
    const dustTurns = loop.turns().filter((turn) => contentWorthiness(turn.text) === "dust");
    expect(dustTurns.length).toBeGreaterThanOrEqual(BABBLE.length);
    for (const dust of dustTurns) {
      expect(topics.some((topic) => topic.turnIds.includes(dust.id))).toBe(false);
    }
    // QUEST ANCHOR: research the solar fragment turn — the planet must hang
    // from the SOLAR constellation via questCloudId.
    loop.setActive(true);
    const solarTurn = loop.turns().find((turn) => turn.text.includes("inverter vendor"))!;
    const quest = loop.researchTurn(solarTurn.id)!;
    const sky = loop.sky();
    const dialogue = loop.turns().map((turn) => ({
      id: turn.id,
      speaker: turn.speaker,
      atMs: turn.atMs,
      topicId: topics.find((topic) => topic.turnIds.includes(turn.id))?.id ?? null,
    }));
    const constellations = resolveConstellations(topics, sky, dialogue);
    const anchorId = questCloudId(quest.contextSpan.endTurnId, dialogue, constellations);
    expect(anchorId).not.toBeNull();
    const anchor = constellations.find((entry) => entry.id === anchorId)!;
    const anchorTopic = topics.find((topic) => topic.id === (anchor.liveTopicId ?? anchor.id))!;
    expect(anchorTopic.turnIds).toContain(solarTurn.id);
    // The sky snapshot's naming gate agrees: every rendered constellation
    // backing a real thread is named.
    for (const cloud of sky.clouds) {
      expect(cloud.named).toBe(true);
    }
  });
});
