// Ambient idea detection: windowed, rubric-judged, provenance-carrying. This
// barrel is the public surface; import detection types/engine from here, not from
// individual modules.
export {
  type CandidateVerdict,
  type ContextSpan,
  type DetectedIdea,
  type DetectionInput,
  type DetectionResult,
  type IdeaCandidate,
  type IdeaCandidateStatus,
  type IdeaDetector,
  type JudgedIdea,
  type KnownCandidate,
  type VerifiableIdea,
  type TranscriptTurn,
  contextSpanSchema,
  detectedIdeaSchema,
  detectionResultSchema,
  ideaAssessmentSchema,
  ideaRubricSchema,
  transcriptTurnSchema,
} from "./types";
export {
  DEFAULT_SURFACE_THRESHOLD,
  IDEA_CATEGORIES,
  MIN_SURFACE_INTENT,
  RUBRIC_WEIGHTS,
  clampLevel,
  deriveAssessment,
  normalizeRubric,
  type IdeaAssessment,
  type IdeaCategory,
  type IdeaMaturity,
  type IdeaRubric,
} from "./rubric";
export {
  buildJudgePrompt,
  buildVerifyPrompt,
  groundQuote,
  parseJudgeReply,
  parseVerifyReply,
  renderTurns,
  type ParsedJudgement,
  type VerifyVerdict,
} from "./prompt";
export { TranscriptWindow, groundSpan, type AppendTurnInput, type TranscriptWindowOptions } from "./transcript-window";
export { type ClaudeCliOptions, type ClaudeCliRunner, defaultClaudeCliRunner } from "./claude-cli";
export {
  DEFAULT_HEURISTIC_CLUSTER_GAP_MS,
  DEFAULT_HEURISTIC_CLUSTER_GAP_TURNS,
  DEFAULT_IDEA_DETECTOR_MODEL,
  DEFAULT_IDEA_DETECTOR_TIMEOUT_MS,
  HEURISTIC_DETECTOR_ENV_DEFAULTS,
  HeuristicIdeaDetector,
  type HeuristicIdeaDetectorOptions,
  HostClaudeIdeaDetector,
  HostClaudeIdeaJudge,
  type HostClaudeIdeaDetectorOptions,
  type HostClaudeIdeaJudgeOptions,
  type IdeaDetectorMode,
  type IdeaDetectorSelection,
  type IdeaDetectorSelectionEnv,
  selectIdeaDetector,
} from "./detector";
export { IdeaLedger, type LedgerConfig, type LedgerDelta } from "./ledger";
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
