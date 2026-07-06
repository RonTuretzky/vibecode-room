import type { CueDecision, DispatchedAction, OutputDecision, TranscriptObservation } from "../types";
import { dispatchUtterance, routeKey, toCueDecision, type DispatchContext, type DispatchDecision } from "./dispatch";
import { panicHaltOutputs } from "./panic-feedback";

/**
 * Minimal structural view of the Cue↔Smithers seam executor.
 *
 * `SeamDispatcher` (src/seam/dispatcher.ts) satisfies this shape without
 * routing/ importing the seam module directly — which would create a
 * seam → routing → seam import cycle, since seam/dispatcher.ts already depends
 * on routing/callsigns. Keeping the dependency structural leaves the routing
 * layer pure (transcript → decision) and lets any executor be wired in.
 */
export interface SeamLike<TResult = unknown> {
  dispatch(action: DispatchedAction): Promise<TResult>;
}

export interface RoutedUtterance<TResult = unknown> {
  /** The full natural-language routing decision (route, ack, trace, …). */
  decision: DispatchDecision;
  /** The decision projected into the downstream Cue decision shape. */
  cueDecision: CueDecision;
  /** Exclusive route bucket: `"suggestion" | "steer:<upid>" | "pass"`. */
  route: ReturnType<typeof routeKey>;
  /** The seam result when the decision produced an executable action, else `null`. */
  dispatch: TResult | null;
  /** Audible feedback decisions produced by routing for immediate state/safety feedback. */
  outputs: OutputDecision[];
}

export interface RouteUtteranceToSeamOptions {
  onOutput?: (decision: OutputDecision) => void | Promise<void>;
}

/**
 * Wire the natural-language routing layer to the seam.
 *
 * Decides what a transcript means via {@link dispatchUtterance}, then — only when
 * it resolves to a concrete {@link DispatchedAction} — executes it against the
 * seam. Suggestion, local-effect, and pass decisions never touch the seam, so
 * ambient chatter and low-confidence/un-targeted commands cannot drive Smithers.
 */
export async function routeUtteranceToSeam<TResult>(
  observation: TranscriptObservation,
  context: DispatchContext,
  seam: SeamLike<TResult>,
  options: RouteUtteranceToSeamOptions = {},
): Promise<RoutedUtterance<TResult>> {
  const decision = dispatchUtterance(observation, context);
  const cueDecision = toCueDecision(decision);
  const dispatch = decision.kind === "action" ? await seam.dispatch(decision.action) : null;
  const outputs = outputsForDecision(decision);
  for (const output of outputs) {
    await options.onOutput?.(output);
  }
  return { decision, cueDecision, route: routeKey(decision), dispatch, outputs };
}

function outputsForDecision(decision: DispatchDecision): OutputDecision[] {
  if (decision.kind === "action" && decision.commandId === "panic" && decision.action.type === "halt") {
    return panicHaltOutputs();
  }
  return [];
}
