import { describe, expect, it } from "bun:test";
import {
  DEFAULT_BASE_BRANCH,
  DEFAULT_INTEGRATION_BRANCH,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_PROBE_CONCURRENCY,
  resolveBuildConfig,
} from "./core.ts";

// Regression suite for the smoke-smithering-panopticon-4-0 failure. smithers stores input
// fields the caller omits as SQL NULL (db/zodToTable strips the Zod .default() wrapper), so
// `ctx.input.integrationBranch` arrived as `null`. build:setup then emitted
// {integrationBranch:null,baseBranch:null,…} and the buildSetup z.string() output schema
// rejected it ("expected string, received null"). resolveBuildConfig closes that gap.
describe("resolveBuildConfig", () => {
  it("maps the REAL ctx.input shape (omitted fields surface as null) to the documented defaults", () => {
    // This is exactly what `ctx.input` looked like for the failed smoke run: only `smoke`
    // was set at launch, so every other column came back null from the durable input row.
    const cfg = resolveBuildConfig({
      smoke: true,
      integrationBranch: null,
      baseBranch: null,
      maxConcurrency: null,
      probeConcurrency: null,
      requireDeliveryGate: null,
    });
    expect(cfg.integrationBranch).toBe(DEFAULT_INTEGRATION_BRANCH);
    expect(cfg.baseBranch).toBe(DEFAULT_BASE_BRANCH);
    expect(cfg.maxConcurrency).toBe(DEFAULT_MAX_CONCURRENCY);
    expect(cfg.probeConcurrency).toBe(DEFAULT_PROBE_CONCURRENCY);
    expect(cfg.smoke).toBe(true);
    expect(cfg.requireDeliveryGate).toBe(true); // null is not an explicit opt-out
  });

  it("defaults every field from the parent's exact launch payload ({smoke:true})", () => {
    // smithering.tsx runSmokeAttempt launches with JSON.stringify({ smoke: true }) only.
    expect(resolveBuildConfig({ smoke: true })).toEqual({
      smoke: true,
      integrationBranch: DEFAULT_INTEGRATION_BRANCH,
      baseBranch: DEFAULT_BASE_BRANCH,
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      probeConcurrency: DEFAULT_PROBE_CONCURRENCY,
      requireDeliveryGate: true,
    });
  });

  it("defaults the full-mode payload ({smoke:false}) too", () => {
    const cfg = resolveBuildConfig({ smoke: false });
    expect(cfg.smoke).toBe(false);
    expect(cfg.integrationBranch).toBe(DEFAULT_INTEGRATION_BRANCH);
    expect(cfg.baseBranch).toBe(DEFAULT_BASE_BRANCH);
    expect(cfg.requireDeliveryGate).toBe(true);
  });

  it("never throws and never yields a null/empty branch for hostile inputs", () => {
    for (const bad of [undefined, null, {}, 42, "x", [], true, NaN]) {
      const cfg = resolveBuildConfig(bad as unknown);
      expect(typeof cfg.integrationBranch).toBe("string");
      expect(cfg.integrationBranch.trim().length).toBeGreaterThan(0);
      expect(typeof cfg.baseBranch).toBe("string");
      expect(cfg.baseBranch.trim().length).toBeGreaterThan(0);
      expect(Number.isFinite(cfg.maxConcurrency)).toBe(true);
      expect(Number.isFinite(cfg.probeConcurrency)).toBe(true);
    }
  });

  it("treats empty / whitespace-only branch strings as missing (fail to the default)", () => {
    for (const s of [{ integrationBranch: "" }, { integrationBranch: "   " }, { baseBranch: "" }, { baseBranch: " " }]) {
      const cfg = resolveBuildConfig(s);
      expect(cfg.integrationBranch.trim()).not.toBe("");
      expect(cfg.baseBranch.trim()).not.toBe("");
    }
  });

  it("preserves explicit caller overrides verbatim", () => {
    expect(
      resolveBuildConfig({
        smoke: false,
        integrationBranch: "smithering/integration-x",
        baseBranch: "develop",
        maxConcurrency: 3,
        probeConcurrency: 5,
        requireDeliveryGate: false,
      }),
    ).toEqual({
      smoke: false,
      integrationBranch: "smithering/integration-x",
      baseBranch: "develop",
      maxConcurrency: 3,
      probeConcurrency: 5,
      requireDeliveryGate: false,
    });
  });

  it("only treats requireDeliveryGate===false as an opt-out (everything else defaults ON)", () => {
    expect(resolveBuildConfig({ requireDeliveryGate: false }).requireDeliveryGate).toBe(false);
    expect(resolveBuildConfig({ requireDeliveryGate: true }).requireDeliveryGate).toBe(true);
    expect(resolveBuildConfig({ requireDeliveryGate: undefined }).requireDeliveryGate).toBe(true);
    expect(resolveBuildConfig({}).requireDeliveryGate).toBe(true);
  });

  it("upholds the land-lane hard guard: the resolved integration branch is never base/main", () => {
    // landTicketBranch refuses to land when integrationBranch is falsy, 'main', or === base.
    const cfg = resolveBuildConfig({ smoke: true });
    expect(cfg.integrationBranch).toBeTruthy();
    expect(cfg.integrationBranch).not.toBe("main");
    expect(cfg.integrationBranch).not.toBe(cfg.baseBranch);
  });
});
