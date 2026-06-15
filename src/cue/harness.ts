import type { ASRProvider, DecisionLLM, TTSProvider } from "../providers";
import { CueAdapter, type CueAdapterOptions } from "./adapter";
import { createCuePolicies, type CuePolicyConfig } from "./policies";
import { createCuePrograms } from "./programs";
import { loadCueCore, type CueCoreModule, type CueHarnessInstance } from "./source";

export interface CueHarnessProviders {
  transcription: ASRProvider;
  llm: DecisionLLM;
  output: TTSProvider;
}

export interface PanopticonCueHarness {
  cue: CueCoreModule;
  harness: CueHarnessInstance;
  adapter: CueAdapter;
  providers: CueHarnessProviders;
  risks: string[];
}

export interface PanopticonCueHarnessOptions extends CuePolicyConfig {
  sessionId: string;
  providers: CueHarnessProviders;
  adapter?: Omit<CueAdapterOptions, "sessionId" | "textCueWords">;
}

export async function createPanopticonCueHarness(options: PanopticonCueHarnessOptions): Promise<PanopticonCueHarness> {
  const cue = await loadCueCore();
  const policies = createCuePolicies(cue, options);
  const programs = createCuePrograms(cue);
  const adapter = new CueAdapter({
    sessionId: options.sessionId,
    textCueWords: policies.textCueWords,
    ...options.adapter,
  });

  const harness = new cue.CueHarness({
    sessionId: options.sessionId,
    cues: policies.cues,
    programs: programs.programs,
    tools: programs.tools,
    transcriptionProvider: options.providers.transcription,
    llmProvider: options.providers.llm,
    outputProvider: options.providers.output,
  });

  return {
    cue,
    harness,
    adapter,
    providers: options.providers,
    risks: [
      "D2: speaker-label-stability shim remains adapter-owned around ASR/Cue observation frames.",
      "D2: observe.pass interception and route.pass logging are adapter-owned even though Cue exposes observe.pass.",
      "D2: earcon emission is adapter-owned and triggered by Cue TextCue decisions.",
      ...policies.risks,
      ...programs.risks,
    ],
  };
}
