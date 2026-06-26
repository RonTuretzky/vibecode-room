import { CueAdapter, type CueDecisionLog } from "../cue/adapter";
import {
  createPanopticonCueHarness,
  type CueHarnessProviders,
  type PanopticonCueHarness,
} from "../cue/harness";
import { cueSourceBuildAvailable, cueSourceRoot, type CueIngestResult } from "../cue/source";
import type { TraceProcessor } from "../obs/trace";
import type { TranscriptObservation } from "../types";

// Which Cue path the bridge actually selected for this runtime. `harness` means
// the upstream Cue substrate was built and is driving wake/earcon detection;
// `fallback` means the deterministic in-runtime CueAdapter path is active.
export type CueBridgeMode = "harness" | "fallback";

export interface CueBridgeSelection {
  mode: CueBridgeMode;
  // Human-readable reason for the selection, surfaced to operators via the log
  // hook so it is obvious which path is live (and why the harness was skipped).
  reason: string;
}

export interface CueBridgeOptions {
  sessionId: string;
  providers: CueHarnessProviders;
  // The existing in-runtime CueAdapter (textCueWords ['panop']) the runtime
  // already constructs. The fallback path drives wake/earcon detection through
  // it, and the harness path reuses its wake-word list for the documented words.
  fallbackAdapter: CueAdapter;
  textCueWords?: readonly string[];
  // Injection seams for tests: detect the build and construct the harness. They
  // default to the real Cue source detector / harness factory.
  buildAvailable?: () => boolean;
  createHarness?: (options: {
    sessionId: string;
    providers: CueHarnessProviders;
    textCueWords: readonly string[];
    trace: TraceProcessor;
    clock: () => number;
  }) => Promise<PanopticonCueHarness>;
  trace: TraceProcessor;
  clock?: () => number;
  // Operator-visible selection log (defaults to console.log) so the active path
  // is reported once at startup.
  onLog?: (message: string) => void;
}

// The documented wake word for the deterministic fast-path. The runtime adapter
// is constructed with exactly this list, so the bridge mirrors it.
export const DEFAULT_CUE_WAKE_WORDS = ["panop"] as const;

export interface CueBridge {
  readonly mode: CueBridgeMode;
  readonly selection: CueBridgeSelection;
  // Route one live FINAL observation through the active Cue path exactly once,
  // emitting a wake/earcon trace event when a wake word is present. Returns the
  // adapter decision log (earcons/actions/events) or null for non-final input.
  observeFinal(observation: TranscriptObservation): Promise<CueDecisionLog | null>;
}

// Construct the Cue wake/earcon bridge, selecting the upstream harness fast-path
// when a Cue build is present and falling back to the deterministic in-runtime
// CueAdapter otherwise. Selection never throws: a missing build (or a harness
// that fails to construct) gracefully degrades to the fallback adapter.
export async function createCueBridge(options: CueBridgeOptions): Promise<CueBridge> {
  const textCueWords = options.textCueWords ?? [...DEFAULT_CUE_WAKE_WORDS];
  const clock = options.clock ?? (() => performance.now());
  const buildAvailable = options.buildAvailable ?? cueSourceBuildAvailable;
  const createHarness = options.createHarness ?? defaultCreateHarness;
  const log = options.onLog ?? ((message: string) => console.log(message));

  if (buildAvailable()) {
    try {
      const harness = await createHarness({
        sessionId: options.sessionId,
        providers: options.providers,
        textCueWords,
        trace: options.trace,
        clock,
      });
      const selection: CueBridgeSelection = {
        mode: "harness",
        reason: `Cue build present at ${cueSourceRoot()}`,
      };
      log(`[cue-bridge] active path: harness — ${selection.reason}`);
      return new HarnessCueBridge(harness, selection);
    } catch (error) {
      const reason = `Cue build detected but harness construction failed (${
        error instanceof Error ? error.message : String(error)
      }); using in-runtime fallback adapter`;
      log(`[cue-bridge] active path: fallback — ${reason}`);
      return new FallbackCueBridge(options.fallbackAdapter, textCueWords, { mode: "fallback", reason });
    }
  }

  const reason = "no Cue build (set PANOP_CUE_SOURCE_DIR to enable the harness fast-path)";
  log(`[cue-bridge] active path: fallback — ${reason}`);
  return new FallbackCueBridge(options.fallbackAdapter, textCueWords, { mode: "fallback", reason });
}

async function defaultCreateHarness(options: {
  sessionId: string;
  providers: CueHarnessProviders;
  textCueWords: readonly string[];
  trace: TraceProcessor;
  clock: () => number;
}): Promise<PanopticonCueHarness> {
  return createPanopticonCueHarness({
    sessionId: options.sessionId,
    providers: options.providers,
    textCueWords: [...options.textCueWords],
    adapter: { trace: options.trace, clock: options.clock },
  });
}

// Harness fast-path: ingest the observation through the upstream Cue harness and
// hand the resulting Cue decision to the harness-owned adapter, which emits the
// earcon trace on a TextCue match.
class HarnessCueBridge implements CueBridge {
  constructor(
    private readonly harness: PanopticonCueHarness,
    readonly selection: CueBridgeSelection,
  ) {}

  get mode(): CueBridgeMode {
    return this.selection.mode;
  }

  async observeFinal(observation: TranscriptObservation): Promise<CueDecisionLog | null> {
    if (!observation.isFinal) {
      return null;
    }
    const frame = this.harness.cue.transcriptObservation(observation.text, {
      speaker: observation.speaker ?? undefined,
    });
    const result = (await this.harness.harness.ingest(frame)) as CueIngestResult;
    return this.harness.adapter.handleResult(observation, result);
  }
}

// Deterministic fallback: there is no upstream Cue harness, so the bridge does
// the wake-word match itself and synthesizes the Cue TextCue decision the adapter
// expects. This drives the existing in-runtime CueAdapter to the same textcue
// earcon trace the harness path would produce.
class FallbackCueBridge implements CueBridge {
  constructor(
    private readonly adapter: CueAdapter,
    private readonly textCueWords: readonly string[],
    readonly selection: CueBridgeSelection,
  ) {}

  get mode(): CueBridgeMode {
    return this.selection.mode;
  }

  async observeFinal(observation: TranscriptObservation): Promise<CueDecisionLog | null> {
    if (!observation.isFinal) {
      return null;
    }
    return this.adapter.handleResult(observation, fallbackIngestResult(observation.text, this.textCueWords));
  }
}

// Build the CueIngestResult the adapter expects from a plain wake-word match.
// When a wake word is present we surface it as a Cue "text" decision (so the
// adapter emits the earcon); otherwise the result is an empty ambient pass.
export function fallbackIngestResult(text: string, words: readonly string[]): CueIngestResult {
  const matched = firstWakeWord(text, words);
  return {
    cues: matched === undefined ? [] : [{ name: "text", metadata: { pattern: matched } }],
    toolResults: [],
  };
}

function firstWakeWord(text: string, words: readonly string[]): string | undefined {
  const tokens = new Set(
    text
      .toLocaleLowerCase("en-US")
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 0),
  );
  return words.map((word) => word.toLocaleLowerCase("en-US")).find((word) => tokens.has(word));
}
