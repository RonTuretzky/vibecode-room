import { z } from "zod";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/);
const backend = z.enum(["smithers", "eliza", "native"]);
const point = z.object({
  x: z.number().finite().min(-1000).max(1000),
  z: z.number().finite().min(-1000).max(1000),
});
const branch = z.object({
  name: z.string().regex(/^(main|concept\/[a-z-]+|room\/[a-z0-9-]+)$/),
  commits: z.number(),
  prUrl: z.string().optional(),
});
export const roomStateSchema = z.object({
  version: z.literal(1),
  registry: z.object({
    records: z.array(
      z.object({
        upid: id,
        runId: z.string(),
        callsign: z.string(),
        state: z.enum(["planning", "active", "paused", "dead"]),
        selected: z.boolean(),
        progressSeq: z.number(),
        lastAction: z.string(),
        updatedAtMs: z.number(),
      }),
    ),
    seeds: z.array(
      z.tuple([
        id,
        z.object({
          workflow: z.string(),
          prompt: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
          steeringWindowId: z.string().nullable(),
          parentId: z.string().nullable(),
        }),
      ]),
    ),
    durableRuns: z.array(
      z.tuple([id, z.object({ runId: z.string(), startedAtMs: z.number() })]),
    ),
    selected: id.nullable(),
  }),
  imports: z.array(
    z.tuple([
      id,
      z.object({
        kind: z.enum(["github", "link", "context"]),
        url: z.string().nullable(),
        callsign: z.string().nullable(),
        task: z.string(),
        status: z.enum(["cloning", "ready", "clone-failed"]),
        atMs: z.number(),
        intent: z.enum(["study", "build"]),
      }),
    ]),
  ),
  builds: z.array(
    z.object({
      input: z.object({
        upid: id,
        ideaId: z.string(),
        prompt: z.string(),
        callsign: z.string().nullable(),
      }),
      revisionSeq: z.number(),
      builds: z.array(
        z.object({
          backend,
          label: z.string(),
          status: z.enum(["building", "ready", "failed"]),
          entrypoint: z
            .string()
            .regex(/^(?!.*\.\.)[^\\]*$/)
            .nullable(),
          hasSlideshow: z.boolean(),
          version: z.number(),
          revisions: z.array(z.unknown()),
        }),
      ),
    }),
  ),
  executions: z.array(
    z.object({
      upid: id,
      lane: z.object({
        status: z.enum(["executing", "built", "failed"]),
        runId: z.string(),
        percent: z.number(),
        label: z.string(),
        startedAtMs: z.number(),
        error: z.string().nullable(),
        filesWritten: z.number().nullable(),
      }),
    }),
  ),
  trees: z.array(
    z.object({
      upid: id,
      tree: z.object({
        branches: z.array(branch),
        remoteUrl: z.string().nullable(),
        adopted: z.boolean().optional(),
      }),
    }),
  ),
  jobs: z.array(
    z.object({
      id,
      upid: id,
      branch: z.string().regex(/^room\/[a-z0-9-]+$/),
      request: z.string(),
      status: z.enum([
        "queued",
        "implementing",
        "validating",
        "committing",
        "ready",
        "failed",
        "cancelled",
        "interrupted",
      ]),
      files: z.array(z.string()),
      checks: z.array(z.string()),
      workspace: z.string(),
      previewDir: z.string().nullable(),
      updatedAtMs: z.number(),
    }),
  ),
  positions: z.record(id, point),
  published: z.array(z.tuple([id, z.unknown()])).optional(),
  interrupted: z.array(
    z.tuple([id, z.enum(["concept", "execution", "import"])]),
  ),
  answers: z.array(z.tuple([id, z.array(z.tuple([z.string(), z.unknown()]))])),
});
