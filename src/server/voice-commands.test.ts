import { describe, expect, test } from "bun:test";
import { matchWakePhrase, parseVoiceCommand, phoneticKey, voiceCommandLabel, wakeWordFromEnv, type VoiceCommandKind } from "./voice-commands";

describe("phoneticKey", () => {
  test("folds the canonical wake word to the contract example key", () => {
    expect(phoneticKey("vibersyn")).toBe("vbrsn");
  });

  test("applies the fold rules: ph→f, c/q→k, z→s, y→i, vowel-drop, repeat-collapse", () => {
    expect(phoneticKey("phase")).toBe("fs");
    expect(phoneticKey("quick")).toBe("k"); // q→k, c→k, k → repeats collapse to one k
    expect(phoneticKey("zesty")).toBe("st"); // z→s collapses into the s, trailing y→i is a dropped vowel
    expect(phoneticKey("vibe or sin")).toBe(phoneticKey("vibersyn")); // separators are stripped
  });
});

describe("matchWakePhrase — must-match variants (contract)", () => {
  const MUST_MATCH = ["vibersyn", "viber sin", "vibersin", "vibe or sin", "viper sin"];
  for (const phrase of MUST_MATCH) {
    test(`matches "${phrase}"`, () => {
      expect(matchWakePhrase(phrase)).not.toBeNull();
    });
  }

  test("matches mid-sentence and reports the text after the wake window", () => {
    const match = matchWakePhrase("hey vibersyn build it");
    expect(match).not.toBeNull();
    expect(match!.matched).toBe("vibersyn");
    expect(match!.afterWake).toBe("build it");
  });

  test("multi-token windows join for the fuzzy match and afterWake starts past them", () => {
    const match = matchWakePhrase("vibe or sin, stop everything");
    expect(match).not.toBeNull();
    expect(match!.matched).toBe("vibe or sin");
    expect(match!.afterWake).toBe("stop everything");
  });

  test("punctuation and casing are ignored", () => {
    const match = matchWakePhrase("Vibersyn, build it!");
    expect(match).not.toBeNull();
    expect(match!.afterWake).toBe("build it");
  });
});

describe("matchWakePhrase — must NOT match ordinary speech (contract)", () => {
  const MUST_NOT_MATCH = [
    "let's build a dashboard",
    "the weather has been really nice today",
    "we should ship the replay prototype",
    "yes",
    "stop everything",
  ];
  for (const phrase of MUST_NOT_MATCH) {
    test(`does not match "${phrase}"`, () => {
      expect(matchWakePhrase(phrase)).toBeNull();
    });
  }

  test("short tokens cannot luck into edit-distance range (joined length >= 5 rule)", () => {
    expect(matchWakePhrase("vie in")).toBeNull();
  });

  // Near-miss room talk that sits within 2 raw edits of "vibersyn" — the scaled
  // edit budget (1 for windows shorter than the name) and the first-letter
  // anchor must keep all of it from executing commands.
  const NEAR_MISS_ROOM_TALK = ["vibes in", "vibes on", "fiber sync", "fibers in", "good vibes only"];
  for (const phrase of NEAR_MISS_ROOM_TALK) {
    test(`near-miss "${phrase}" is not a wake phrase`, () => {
      expect(matchWakePhrase(phrase)).toBeNull();
    });
  }

  // A wake word ADDRESSES the room, so it must lead the utterance (small filler
  // allowance). Mid/late-sentence mentions are idea material, not commands.
  test("a mid-sentence product mention is NOT a wake phrase (stays idea material)", () => {
    expect(matchWakePhrase("we should theme the vibersyn tray next")).toBeNull();
  });
  test("a trailing mention does not fire bare-wake capture", () => {
    expect(matchWakePhrase("let's do this vibersyn")).toBeNull();
  });
  test("leading filler before the wake word is tolerated", () => {
    expect(matchWakePhrase("hey vibersyn build it")?.afterWake).toBe("build it");
    expect(matchWakePhrase("ok so vibersyn capture")?.afterWake).toBe("capture");
  });

  test("a split-up name never leaves its own fragments in afterWake (best-window)", () => {
    expect(matchWakePhrase("vibersy n build it")?.afterWake).toBe("build it");
  });
});

describe("matchWakePhrase — custom wake word", () => {
  test("matches a VIBERSYN_WAKE_WORD override instead of the default", () => {
    expect(matchWakePhrase("okay jarvis do it", "jarvis")).not.toBeNull();
    expect(matchWakePhrase("vibersyn build it", "jarvis")).toBeNull();
  });

  test("wakeWordFromEnv defaults to vibersyn and honors the override", () => {
    expect(wakeWordFromEnv({})).toBe("vibersyn");
    expect(wakeWordFromEnv({ VIBERSYN_WAKE_WORD: "  " })).toBe("vibersyn");
    expect(wakeWordFromEnv({ VIBERSYN_WAKE_WORD: "jarvis" })).toBe("jarvis");
  });

  test("a wake word shorter than 5 chars disables fuzziness (exact token only)", () => {
    expect(matchWakePhrase("kit build it", "kit")?.afterWake).toBe("build it");
    expect(matchWakePhrase("kid build it", "kit")).toBeNull();
    expect(matchWakePhrase("fit build it", "kit")).toBeNull();
  });
});

describe("parseVoiceCommand — the exact command table (contract)", () => {
  const CASES: Array<[string, VoiceCommandKind | null]> = [
    // capture-on: bare wake word or an explicit start phrase
    ["", "capture-on"],
    ["capture", "capture-on"],
    ["start capturing", "capture-on"],
    ["listen", "capture-on"],
    // capture-off
    ["stop capturing", "capture-off"],
    ["capture off", "capture-off"],
    ["stand down", "capture-off"],
    // build
    ["build it", "build"],
    ["build that", "build"],
    ["build this", "build"],
    ["accept", "build"],
    ["ship it", "build"],
    ["yes", "build"],
    // dismiss
    ["dismiss", "dismiss"],
    ["skip", "dismiss"],
    ["no", "dismiss"],
    ["next", "dismiss"],
    // auto-build toggle
    ["auto build on", "auto-on"],
    ["auto build off", "auto-off"],
    ["auto-build on", "auto-on"], // hyphen is a token separator
    // emergency
    ["emergency", "emergency"],
    ["stop everything", "emergency"],
    ["kill everything", "emergency"],
    ["shut down", "emergency"],
    // anything else → null (traced but not executed)
    ["make me a sandwich", null],
    ["build a dashboard", null],
    ["capture the flag", null],
  ];
  for (const [input, expected] of CASES) {
    test(`"${input}" → ${expected ?? "null"}`, () => {
      expect(parseVoiceCommand(input)?.kind ?? null).toBe(expected);
    });
  }

  test("normalizes punctuation and casing before the table lookup", () => {
    expect(parseVoiceCommand("Build it!")?.kind).toBe("build");
    expect(parseVoiceCommand("  SHIP IT.  ")?.kind).toBe("build");
  });
});

describe("voiceCommandLabel", () => {
  test("maps kinds to the snapshot's human-readable labels", () => {
    expect(voiceCommandLabel({ kind: "capture-on" })).toBe("capture on");
    expect(voiceCommandLabel({ kind: "build" })).toBe("build");
    expect(voiceCommandLabel({ kind: "emergency" })).toBe("emergency stop");
  });
});
