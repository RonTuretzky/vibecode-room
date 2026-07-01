// Ambient idea detection: windowed, inference-driven, provenance-carrying. This
// barrel is the public surface; import detection types/engine from here, not from
// individual modules.
export {
  type ContextSpan,
  type DetectedIdea,
  type DetectionInput,
  type DetectionResult,
  type IdeaCandidate,
  type IdeaCandidateStatus,
  type IdeaDetector,
  type KnownCandidate,
  type TranscriptTurn,
  contextSpanSchema,
  detectedIdeaSchema,
  detectionResultSchema,
  transcriptTurnSchema,
} from "./types";
export { TranscriptWindow, groundSpan, renderTurns, type AppendTurnInput, type TranscriptWindowOptions } from "./transcript-window";
export { type ClaudeCliOptions, type ClaudeCliRunner, defaultClaudeCliRunner } from "./claude-cli";
export {
  DEFAULT_IDEA_DETECTOR_MODEL,
  DEFAULT_IDEA_DETECTOR_TIMEOUT_MS,
  HeuristicIdeaDetector,
  HostClaudeIdeaDetector,
  type HostClaudeIdeaDetectorOptions,
  type IdeaDetectorMode,
  type IdeaDetectorSelection,
  type IdeaDetectorSelectionEnv,
  buildDetectionPrompt,
  parseDetectionReply,
  selectIdeaDetector,
} from "./detector";
export { reconcile, statusForConfidence, type ReconcileOptions, type ReconcileResult } from "./reconciler";
export {
  scoreDetection,
  scoreGrounding,
  scorePitchQuality,
  scoreStructure,
  toScorableIdea,
  type ScorableIdea,
  type ScoreResult,
} from "./scorers";
export {
  DETECTION_ENGINE_ENV_DEFAULTS,
  IdeaDetectionEngine,
  readDetectionEngineConfig,
  type DetectionEngineConfig,
  type DetectionEngineOptions,
  type DetectionRunResult,
  type DetectionTraceEvent,
  type SchedulingState,
} from "./engine";
