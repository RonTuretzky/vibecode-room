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
