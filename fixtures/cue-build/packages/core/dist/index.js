// Minimal pre-built Cue @cue/core substrate fixture (ISSUE-0025 / GAP-006).
//
// The upstream Cue harness fast-path in src/server/cue-bridge.ts is normally
// gated behind cloning and compiling https://github.com/jameslbarnes/cue.git,
// which needs network access and a matching toolchain. This fixture is a
// committed, already-"built" stand-in: pointing VIBERSYN_CUE_SOURCE_DIR here makes
// cueSourceBuildAvailable() report a build, so createCueBridge selects mode
// 'harness' and loadCueCore() imports this module instead of building from
// source. It implements exactly the @cue/core surface that the Vibersyn
// harness wires (see CueCoreModule in src/cue/source.ts) — no more.

export class TextCue {
  constructor(patterns, options = {}) {
    this.name = "text";
    this.patterns = [...patterns];
    this.cooldownSeconds = options.cooldownSeconds;
  }
}

export class WordCountCue {
  constructor(minWords) {
    this.name = "wordcount";
    this.minWords = minWords;
  }
}

export class IdleCue {
  constructor(options = {}) {
    this.name = "idle";
    this.options = options;
  }
}

export class IntervalCue {
  constructor(intervalSeconds) {
    this.name = "interval";
    this.intervalSeconds = intervalSeconds;
  }
}

export class MappedActionTool {
  constructor(config) {
    this.name = config?.name;
    this.config = config;
  }
}

export const Triggers = {
  onCue(name) {
    return { kind: "onCue", cue: name };
  },
};

export function transcriptObservation(text, options = {}) {
  return { type: "transcript", text, ...options };
}

// The harness substrate. It scans the configured cues for the TextCue's wake
// patterns and, on a token match, surfaces a Cue "text" decision the Vibersyn
// adapter turns into an earcon. No match is an ambient pass (no cues, no tools).
export class CueHarness {
  constructor(config) {
    this.config = config ?? {};
  }

  async ingest(observation) {
    const text = typeof observation?.text === "string" ? observation.text : "";
    const textCue = (this.config.cues ?? []).find((cue) => Array.isArray(cue?.patterns));
    const matched = firstMatch(text, textCue?.patterns ?? []);
    if (matched === undefined) {
      return { cues: [], toolResults: [] };
    }
    return { cues: [{ name: "text", metadata: { pattern: matched } }], toolResults: [] };
  }
}

function firstMatch(text, patterns) {
  const tokens = new Set(
    text
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0),
  );
  return patterns.map((pattern) => String(pattern).toLocaleLowerCase("en-US")).find((pattern) => tokens.has(pattern));
}
