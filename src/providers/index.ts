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
