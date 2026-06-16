export {
  deterministicCompare,
  dispatchUtterance,
  routeKey,
  toCueDecision,
  type ActiveProcess,
  type AckKind,
  type DispatchContext,
  type DispatchDecision,
  type PendingSuggestionState,
  type RouteKind,
  type SteeringWindow,
} from "./dispatch";
export { COMMAND_HANDLERS, assertHandlerCoverage, type CommandHandler, type HandlerOutput, type LocalEffect } from "./handlers";
export { routeUtteranceToSeam, type RoutedUtterance, type SeamLike } from "./seam-bridge";
export {
  DOCUMENTED_COMMANDS,
  ROUTING_ENV_DEFAULTS,
  includesPhrase,
  loadRoutingVocabulary,
  matchPhrase,
  normalizeSpeech,
  type DocumentedCommand,
  type DocumentedCommandId,
  type RoutingVocabulary,
  type VocabularyEnvKey,
} from "./vocabulary";
