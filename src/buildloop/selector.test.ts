import { describe, expect, test } from "bun:test";
import { BackendSelector, DEFAULT_BUILD_BACKENDS_CSV, parseEnabledBackends } from "./selector";
import type { BuildBackend, BuildBackendId, BuildRequest, BuildResult } from "./types";

function fakeBackend(id: BuildBackendId, available: { ok: boolean; reason?: string } = { ok: true }): BuildBackend {
  return {
    id,
    label: `${id} backend`,
    async available() {
      return available;
    },
    async build(_req: BuildRequest): Promise<BuildResult> {
      return { ok: true, entrypoint: "index.html", summary: "built" };
    },
  };
}

describe("parseEnabledBackends", () => {
  test("defaults to smithers,native when unset or blank (eliza is opt-in)", () => {
    expect(DEFAULT_BUILD_BACKENDS_CSV).toBe("smithers,native");
    expect([...parseEnabledBackends(undefined)]).toEqual(["smithers", "native"]);
    expect([...parseEnabledBackends("   ")]).toEqual(["smithers", "native"]);
  });

  test("parses a csv with whitespace and casing noise", () => {
    expect([...parseEnabledBackends(" Smithers , ELIZA ,native,, ")]).toEqual(["smithers", "eliza", "native"]);
  });
});

describe("BackendSelector", () => {
  const allThree = () => [fakeBackend("smithers"), fakeBackend("eliza"), fakeBackend("native")];

  test("enabled set comes from VIBERSYN_BUILD_BACKENDS; eliza stays off by default", () => {
    const selector = new BackendSelector({ backends: allThree(), env: {} });
    expect(selector.isEnabled("smithers")).toBe(true);
    expect(selector.isEnabled("native")).toBe(true);
    expect(selector.isEnabled("eliza")).toBe(false);
    expect(selector.enabledBackends().map((backend) => backend.id)).toEqual(["smithers", "native"]);
  });

  test("env csv opts eliza in and can drop defaults", () => {
    const selector = new BackendSelector({ backends: allThree(), env: { VIBERSYN_BUILD_BACKENDS: "eliza" } });
    expect(selector.enabledBackends().map((backend) => backend.id)).toEqual(["eliza"]);
  });

  test("runtime toggle flips a backend and rejects unknown ids", () => {
    const selector = new BackendSelector({ backends: allThree(), env: {} });
    expect(selector.setEnabled("eliza", true)).toBe(true);
    expect(selector.isEnabled("eliza")).toBe(true);
    expect(selector.setEnabled("smithers", false)).toBe(true);
    expect(selector.isEnabled("smithers")).toBe(false);
    expect(selector.setEnabled("garbage", true)).toBe(false);
  });

  test("snapshot reflects enabled + probed availability (unprobed reads unavailable)", async () => {
    const selector = new BackendSelector({
      backends: [fakeBackend("smithers"), fakeBackend("native", { ok: false, reason: "no CLI" })],
      env: {},
    });

    // Before any probe every backend reads unavailable with a "not probed" reason.
    expect(selector.snapshot()).toEqual([
      { id: "smithers", label: "smithers backend", enabled: true, available: false, reason: "not probed yet" },
      { id: "native", label: "native backend", enabled: true, available: false, reason: "not probed yet" },
    ]);

    await selector.probeAll();
    expect(selector.snapshot()).toEqual([
      { id: "smithers", label: "smithers backend", enabled: true, available: true },
      { id: "native", label: "native backend", enabled: true, available: false, reason: "no CLI" },
    ]);
  });

  test("a wedged available() probe times out instead of stalling the snapshot", async () => {
    const wedged: BuildBackend = {
      id: "eliza",
      label: "wedged",
      available: () => new Promise(() => undefined), // never settles
      async build() {
        return { ok: false, entrypoint: null, summary: "", error: "unused" };
      },
    };
    const selector = new BackendSelector({
      backends: [wedged],
      env: { VIBERSYN_BUILD_BACKENDS: "eliza" },
      probeTimeoutMs: 20,
    });
    const availability = await selector.probe("eliza");
    expect(availability.ok).toBe(false);
    expect(availability.reason).toContain("timed out");
  });
});
