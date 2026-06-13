import type { Hook, HookContext, PMFunction } from "./types.ts";

/**
 * Session-loop hooks (§5.3). There are two granularities:
 *   - per-loop: run on every Input→Action→Output tick (pre and post)
 *   - per-action: run around a specific Process-Manager function (e.g. pre-kill)
 *
 * Pre-hooks: test, auth, cache/memory optimize, pre-spawn resource check,
 *            pre-kill context archive.
 * Post-hooks: cleanup, logging.
 */
export class HookRegistry {
  private loopPre: Hook[] = [];
  private loopPost: Hook[] = [];
  private actionPre = new Map<PMFunction, Hook[]>();
  private actionPost = new Map<PMFunction, Hook[]>();

  onLoopPre(h: Hook) {
    this.loopPre.push(h);
    return this;
  }
  onLoopPost(h: Hook) {
    this.loopPost.push(h);
    return this;
  }
  onActionPre(fn: PMFunction, h: Hook) {
    (this.actionPre.get(fn) ?? this.actionPre.set(fn, []).get(fn)!).push(h);
    return this;
  }
  onActionPost(fn: PMFunction, h: Hook) {
    (this.actionPost.get(fn) ?? this.actionPost.set(fn, []).get(fn)!).push(h);
    return this;
  }

  async runLoopPre(ctx: HookContext) {
    for (const h of this.loopPre) await h(ctx);
  }
  async runLoopPost(ctx: HookContext) {
    for (const h of this.loopPost) await h(ctx);
  }
  async runActionPre(fn: PMFunction, ctx: HookContext) {
    for (const h of this.actionPre.get(fn) ?? []) await h(ctx);
  }
  async runActionPost(fn: PMFunction, ctx: HookContext) {
    for (const h of this.actionPost.get(fn) ?? []) await h(ctx);
  }
}

/** The default hook set described on the whiteboard (§5.3). */
export function defaultHooks(archive: (upid: string, ctx: HookContext) => void): HookRegistry {
  return new HookRegistry()
    // pre-loop: auth + memory optimize
    .onLoopPre((ctx) => {
      ctx.scratch.authed = true; // placeholder for real auth/test gate
    })
    // pre-spawn resource check (create + fork)
    .onActionPre("create", (ctx) => ctx.log("pre-spawn: resource check ok"))
    .onActionPre("fork", (ctx) => ctx.log("pre-spawn: resource check ok"))
    // pre-kill: archive context (C6 — context preserved across lifecycle)
    .onActionPre("kill", (ctx) => {
      ctx.log("pre-kill: archiving context");
      archive(ctx.process.upid, ctx);
    })
    // post-loop: cleanup + logging
    .onLoopPost((ctx) => {
      delete ctx.scratch.authed;
    });
}
