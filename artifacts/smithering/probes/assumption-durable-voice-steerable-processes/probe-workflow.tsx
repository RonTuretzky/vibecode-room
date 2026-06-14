// @jsxImportSource smithers-orchestrator
/**
 * probe-workflow.tsx
 *
 * Minimal durable process for the voice-steerable assumption probe.
 * Loops until a stop signal, recording each steer payload verbatim.
 * No LLM agent — uses WaitForEvent + static Task outputs only.
 */
import { WaitForEvent, createSmithers } from "smithers-orchestrator";
import { Sequence } from "smithers-orchestrator";
import { z } from "zod";

const inputSchema = z.object({
  processId: z.string(),
  directive: z.string().default("stand by"),
});

const steerSchema = z.object({
  text: z.string().default(""),
  stop: z.boolean().default(false),
});

const stepSchema = z.object({
  loopN: z.number(),
  received: z.string(),
  processId: z.string(),
  stoppedAt: z.string().nullable(),
});

const loopId = "steer-loop";

const { Workflow, Task, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  steer: steerSchema,
  step: stepSchema,
});

export default smithers((ctx) => {
  const steer = steerSchema.safeParse(ctx.latest(outputs.steer, "steer"));
  const instruction = steer.success ? steer.data.text : "";
  const shouldStop = steer.success && steer.data.stop;
  const iteration = ctx.iterations?.[loopId] ?? 0;
  const correlationId = `steer:${iteration}`;

  return (
    <Workflow name="panopticon-probe-process">
      <Loop id={loopId} until={shouldStop} maxIterations={100}>
        <Sequence>
          <WaitForEvent
            id="steer"
            event="steer"
            correlationId={correlationId}
            output={outputs.steer}
          />
          <Task id="step" output={outputs.step}>
            {{
              loopN: iteration,
              received: instruction,
              processId: ctx.input.processId,
              stoppedAt: shouldStop ? new Date().toISOString() : null,
            }}
          </Task>
        </Sequence>
      </Loop>
    </Workflow>
  );
});
