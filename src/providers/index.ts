export type {
  ASRProvider,
  AudioReadableStream,
  DecisionInput,
  DecisionLLM,
  DecisionMessage,
  DecisionOutput,
  DecisionRole,
  TTSOptions,
  TTSProvider,
} from "./types";
export {
  createAudioCredentialSource,
  createModelCredentialSource,
  rejectRawModelCredentials,
  type AudioCredentialOptions,
  type AudioCredentialProvider,
  type ModelCredentialOptions,
  type ModelSubscriptionProvider,
} from "./credentials";
// Concrete providers are constructed only through this barrel — the sanctioned
// provider seam (see ENG-T-04 in providers/boundary.test.ts). Consumers outside
// src/providers must not reach into providers/{asr,tts,llm}/* directly.
export { DeepgramNova3ASRProvider, type DeepgramNova3ASROptions } from "./asr/deepgram";
export { ReplayASRProvider, type ReplayASRSource } from "./asr/replay";
export { NoopTTSProvider, type NoopTTSCall } from "./tts/noop";

// --- ASR registry / factory (ISSUE-0002) ---------------------------------
// Append-only block: kept at the end of the barrel so it does not conflict
// with the LLM/TTS registry issues editing the export list above. The VoxTerm
// provider and the ASR registry are reachable only through this barrel, like
// every other concrete provider (see ENG-T-04 in providers/boundary.test.ts).
export {
  VoxTermASRProvider,
  arraySegmentSource,
  normalizeVoxTermSegment,
  type VoxTermASROptions,
  type VoxTermNormalizeOptions,
  type VoxTermSegment,
  type VoxTermSegmentSource,
} from "./asr/voxterm";
export {
  selectAsrProvider,
  MIC_CLOSE_TIMEOUT_MS,
  type AsrProviderMode,
  type AsrSelection,
  type AsrSelectionEnv,
  type AsrSelectionOptions,
} from "./asr/registry";

// --- DecisionLLM registry / factory (ISSUE-0005) -------------------------
// Append-only block: kept at the end of the barrel so it does not conflict
// with the ASR/TTS registry issues editing the export list above. The concrete
// deciders and the decision registry are reachable only through this barrel,
// like every other concrete provider (see ENG-T-04 in providers/boundary.test.ts).
export { HeuristicDecisionLLM, HEURISTIC_DECISION_POLICY, type HeuristicDecisionLLMOptions } from "./llm/heuristic";
export {
  ClaudeDecisionLLM,
  DEFAULT_CLAUDE_DECISION_MODEL,
  createFetchTransport,
  type ClaudeDecisionLLMOptions,
  type ClaudeMessagesTransport,
} from "./llm/claude";
export { ReplayDecisionLLM, type ReplayDecisionRecord } from "./llm/replay";
export {
  selectDecisionLLM,
  DEFAULT_CLAUDE_DECISION_COMMAND,
  type DecisionLLMMode,
  type DecisionLLMSelection,
  type DecisionLLMSelectionEnv,
  type DecisionLLMSelectionOptions,
} from "./llm/registry";

// --- TTS registry / factory (ISSUE-0007) ---------------------------------
// Append-only block: kept at the end of the barrel so it does not conflict
// with the ASR/LLM registry issues editing the export list above. The real
// streaming provider and the TTS registry are reachable only through this
// barrel, like every other concrete provider (see ENG-T-04 in
// providers/boundary.test.ts).
export {
  ElevenLabsFlashTTSProvider,
  createElevenLabsFlashTTSFromEnv,
  type ElevenLabsEnvTTS,
  type ElevenLabsFlashTTSOptions,
  type TTSTransport,
  type TTSTransportRequest,
} from "./tts/elevenlabs";
export {
  selectTtsProvider,
  DEFAULT_TTS_CREDENTIAL_VARIABLE,
  type TtsProviderMode,
  type TtsSelection,
  type TtsSelectionEnv,
  type TtsSelectionOptions,
} from "./tts/registry";
