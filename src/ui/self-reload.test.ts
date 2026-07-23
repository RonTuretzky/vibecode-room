// SELF-HOSTING wall seam: the bootId-change reload decision and the tolerant
// snapshot extractors (self surface + bootId), plus the reload overlay render.
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ProjectorApp } from "./App";
import { demoProjectorSnapshot } from "./demo-data";
import { bootIdOf, selfOf, shouldReloadForBoot, trackBootId, type SelfAwareSnapshot } from "./self-reload";
import type { ProjectorSnapshot } from "./types";

function withSelf(extra: Partial<SelfAwareSnapshot>): ProjectorSnapshot {
  return { ...demoProjectorSnapshot, ...extra } as ProjectorSnapshot;
}

describe("shouldReloadForBoot — the reload decision", () => {
  test("reloads ONLY when a bound bootId sees a different non-empty one", () => {
    expect(shouldReloadForBoot("boot-a", "boot-b")).toBe(true);
    expect(shouldReloadForBoot("boot-a", "boot-a")).toBe(false);
    // Never reload off missing data (old server, malformed frame, first frame).
    expect(shouldReloadForBoot(null, "boot-b")).toBe(false);
    expect(shouldReloadForBoot("boot-a", null)).toBe(false);
    expect(shouldReloadForBoot(null, null)).toBe(false);
    expect(shouldReloadForBoot("", "boot-b")).toBe(false);
  });
});

describe("trackBootId — the page's boot binding fold", () => {
  test("binds to the FIRST bootId, holds it, and demands a reload on change", () => {
    const first = trackBootId(null, withSelf({ bootId: "boot-a" }));
    expect(first).toEqual({ bound: "boot-a", reload: false });
    const same = trackBootId(first.bound, withSelf({ bootId: "boot-a" }));
    expect(same).toEqual({ bound: "boot-a", reload: false });
    const changed = trackBootId(same.bound, withSelf({ bootId: "boot-b" }));
    expect(changed.reload).toBe(true);
    // The binding stays on the ORIGINAL boot — the reload replaces the page.
    expect(changed.bound).toBe("boot-a");
  });

  test("frames without a bootId (old server) never bind and never reload", () => {
    const folded = trackBootId(null, demoProjectorSnapshot);
    expect(folded).toEqual({ bound: null, reload: false });
    const held = trackBootId("boot-a", demoProjectorSnapshot);
    expect(held).toEqual({ bound: "boot-a", reload: false });
  });
});

describe("tolerant extractors", () => {
  test("bootIdOf reads the server field and rejects junk", () => {
    expect(bootIdOf(withSelf({ bootId: "boot-a" }))).toBe("boot-a");
    expect(bootIdOf(demoProjectorSnapshot)).toBeNull();
    expect(bootIdOf(withSelf({ bootId: "" }))).toBeNull();
    expect(bootIdOf({ ...demoProjectorSnapshot, bootId: 7 } as unknown as ProjectorSnapshot)).toBeNull();
  });

  test("selfOf reads the self surface and degrades to null", () => {
    const snapshot = withSelf({ self: { upid: "self", callsign: "mirror", reloadPending: true } });
    expect(selfOf(snapshot)).toEqual({ upid: "self", callsign: "mirror", reloadPending: true });
    expect(selfOf(demoProjectorSnapshot)).toBeNull();
    expect(selfOf(withSelf({ self: null }))).toBeNull();
    expect(selfOf({ ...demoProjectorSnapshot, self: { upid: "self" } } as unknown as ProjectorSnapshot)).toBeNull();
  });
});

describe("the reload overlay", () => {
  test("renders while reloadPending so the wall never looks dead, hidden otherwise", () => {
    const pending = renderToStaticMarkup(
      createElement(ProjectorApp, {
        initialSnapshot: withSelf({ self: { upid: "self", callsign: "mirror", reloadPending: true } }),
      }),
    );
    expect(pending).toContain('data-testid="self-reload-overlay"');
    expect(pending).toContain("room is reloading itself");

    const idle = renderToStaticMarkup(
      createElement(ProjectorApp, {
        initialSnapshot: withSelf({ self: { upid: "self", callsign: "mirror", reloadPending: false } }),
      }),
    );
    expect(idle).not.toContain('data-testid="self-reload-overlay"');
  });
});
