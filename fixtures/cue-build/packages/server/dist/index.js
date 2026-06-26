// Minimal pre-built Cue @cue/server substrate fixture (ISSUE-0025 / GAP-006).
//
// cueSourceBuildAvailable() treats a build as complete only when BOTH the core
// and server dist entrypoints exist (see src/cue/source.ts). Panopticon only
// imports @cue/core, so this server entrypoint exists solely to satisfy that
// completeness check and is intentionally empty.
export {};
