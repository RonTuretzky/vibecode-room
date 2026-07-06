import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cueCoreEntrypoint, cueServerEntrypoint, cueSourceBuildAvailable, cueSourceRoot } from "./source";

// ISSUE-0025 (GAP-006): cueSourceBuildAvailable is the gate createCueBridge uses
// to pick the upstream harness fast-path over the in-runtime fallback. These
// unit tests prove the gate toggles purely on the presence/absence of a built
// substrate under VIBERSYN_CUE_SOURCE_DIR — without cloning or building anything.

// The committed pre-built Cue fixture: a complete (core + server dist) build.
const FIXTURE = join(import.meta.dir, "../../fixtures/cue-build");

const priorSourceDir = process.env.VIBERSYN_CUE_SOURCE_DIR;
const tempDirs: string[] = [];

afterEach(() => {
  if (priorSourceDir === undefined) {
    delete process.env.VIBERSYN_CUE_SOURCE_DIR;
  } else {
    process.env.VIBERSYN_CUE_SOURCE_DIR = priorSourceDir;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibersyn-cue-source-"));
  tempDirs.push(dir);
  return dir;
}

describe("cueSourceRoot / entrypoints — resolve under VIBERSYN_CUE_SOURCE_DIR", () => {
  test("cueSourceRoot honours VIBERSYN_CUE_SOURCE_DIR and the entrypoints hang off it", () => {
    process.env.VIBERSYN_CUE_SOURCE_DIR = FIXTURE;
    expect(cueSourceRoot()).toBe(FIXTURE);
    expect(cueCoreEntrypoint()).toBe(join(FIXTURE, "packages/core/dist/index.js"));
    expect(cueServerEntrypoint()).toBe(join(FIXTURE, "packages/server/dist/index.js"));
  });

  test("cueSourceRoot falls back to a tmp cache dir when the env var is unset", () => {
    delete process.env.VIBERSYN_CUE_SOURCE_DIR;
    expect(cueSourceRoot()).toBe(join(tmpdir(), "vibersyn-cue-src"));
  });
});

describe("cueSourceBuildAvailable — gates harness vs fallback on build presence", () => {
  test("a complete build (core + server dist present) reports available", () => {
    process.env.VIBERSYN_CUE_SOURCE_DIR = FIXTURE;
    expect(cueSourceBuildAvailable()).toBe(true);
  });

  test("no build present (empty dir) reports unavailable", () => {
    process.env.VIBERSYN_CUE_SOURCE_DIR = freshTempDir();
    expect(cueSourceBuildAvailable()).toBe(false);
  });

  test("a partial build (core dist present, server dist missing) reports unavailable", () => {
    const root = freshTempDir();
    process.env.VIBERSYN_CUE_SOURCE_DIR = root;
    const core = cueCoreEntrypoint();
    mkdirSync(dirname(core), { recursive: true });
    writeFileSync(core, "export {};\n", "utf8");

    // Only the core entrypoint exists, so the build is incomplete.
    expect(cueSourceBuildAvailable()).toBe(false);

    // Writing the server entrypoint completes the build and flips the gate.
    const server = cueServerEntrypoint();
    mkdirSync(dirname(server), { recursive: true });
    writeFileSync(server, "export {};\n", "utf8");
    expect(cueSourceBuildAvailable()).toBe(true);
  });
});
