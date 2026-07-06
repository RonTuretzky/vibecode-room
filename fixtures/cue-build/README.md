# Cue build fixture (GAP-006)

A committed, already-"built" stand-in for the upstream
[Cue](https://github.com/jameslbarnes/cue.git) substrate, used to exercise the
`createCueBridge` **harness fast-path** without cloning and compiling the real
repo (which needs network access and a matching toolchain).

## What it is

The layout mirrors a real Cue build closely enough for
`cueSourceBuildAvailable()` (see `src/cue/source.ts`) to report a complete build:

```
fixtures/cue-build/
  packages/core/dist/index.js     # the @cue/core surface the harness wires
  packages/server/dist/index.js   # presence-only (Vibersyn imports @cue/core)
```

`packages/core/dist/index.js` implements exactly the `CueCoreModule` surface
(`CueHarness`, `TextCue`, the other cue classes, `MappedActionTool`, `Triggers`,
`transcriptObservation`). Its `CueHarness.ingest` matches the configured
`TextCue` wake patterns and, on a token match, returns a Cue `"text"` decision —
which the Vibersyn adapter turns into an earcon.

## How to use it

Point the source dir at this fixture; the bridge then selects mode `harness`:

```sh
VIBERSYN_CUE_SOURCE_DIR="$(pwd)/fixtures/cue-build" bun test
```

The unit / integration / e2e tests for ISSUE-0025 set this env var themselves
and restore it afterwards, so plain `bun test` proves both paths:

- with the fixture → `createCueBridge` reports `harness` and emits a harness
  earcon trace (`meta.path === "harness"`);
- with no build → it falls back deterministically to the in-runtime adapter
  (`meta.path === "fallback"`), unchanged from the default.

## CI

No build step is required: the fixture is committed. To instead exercise the
*real* upstream substrate in CI, clone+build it and set `VIBERSYN_CUE_SOURCE_DIR`
at the resulting checkout (`ensureCueSourceBuild()` in `src/cue/source.ts`
documents the toolchain fallbacks).
