# VoxTerm ASR provider

`src/providers/asr/voxterm.ts` exposes `VoxTermASRProvider`, which implements the
`ASRProvider` seam (`stream(audio): AsyncIterable<TranscriptObservation>`) by
bridging VoxTerm real-time transcript segments into the strict
`transcriptObservationSchema` shape.

## Why a fork is required

dmarzzz/VoxTerm `main` ships transcription as a **markdown / file poller** only
(see `docs/planning/03-eng.md:1280` — "voxterm (markdown file poller)"). A file
re-read on an interval cannot drive Panopticon's low-latency observation loop:
there is no real-time, per-segment event, so interim hypotheses and word-final
latency are not observable.

This provider therefore depends on a forked branch that adds a real-time segment
IPC:

| field     | value                                                              |
| --------- | ------------------------------------------------------------------ |
| repo      | `github.com/dmarzzz/VoxTerm`                                       |
| branch    | `panopticon/realtime-segment-ipc`                                 |
| fork base | `64521b623ffdbbe456b5428445e43933898bb4b3`                        |

The `panopticon/realtime-segment-ipc` branch carries the real-time segment IPC
patch on top of `dmarzzz/VoxTerm` **HEAD** at the time of integration. The
fork-base SHA above is that exact upstream commit — it is verifiable today with:

```sh
git ls-remote https://github.com/dmarzzz/VoxTerm HEAD
# 64521b623ffdbbe456b5428445e43933898bb4b3  HEAD
```

Pinning the fork base (rather than only a branch name) keeps the build
reproducible even as the branch is force-updated: the IPC patch is always read as
a diff against this commit. The matching pin lives in the `voxterm.ts` header
comment.

> Re-pin both this table and the `voxterm.ts` header comment whenever the branch
> is rebased onto a newer upstream commit for a build.

## IPC contract

The forked VoxTerm child emits **newline-delimited JSON segment frames** (one per
line) on its stdout / a Unix domain socket as each partial or final hypothesis is
produced:

```jsonc
{
  "utteranceId": "<string|number>", // stable across interims + the final commit
                                     // of the SAME spoken utterance
  "text":        "<string>",        // current hypothesis text
  "final":       false,             // false = interim, true = committed/final
  "speaker":     0,                 // optional: number → speaker_N, string passthrough, or null
  "startedAtMs": 1000,              // optional: wall-clock ms the utterance began
  "emittedAtMs": 1040               // optional: wall-clock ms this frame was emitted
}
```

### Mapping to `TranscriptObservation`

| TranscriptObservation | source                                                              |
| --------------------- | ------------------------------------------------------------------- |
| `text`                | `segment.text`                                                      |
| `isFinal`             | `segment.final`                                                    |
| `speaker`             | `segment.speaker` normalized (`N → speaker_N`, string passthrough, else `null`) |
| `sessionId`           | provider-configured session id                                      |
| `latencyMs`           | `max(0, round(receivedAt − (emittedAtMs ?? startedAtMs)))`, else `0` |
| `utteranceId`         | `"<prefix>-<sanitized segment.utteranceId>"` — stable per utterance  |

Interim frames (`final: false`) yield `isFinal: false`; committed frames
(`final: true`) yield `isFinal: true` with the same stable `utteranceId` as the
interims that preceded them.

## Injectable transport (no mic / process / network in tests)

The segment feed is injected through the `VoxTermSegmentSource` interface:

```ts
interface VoxTermSegmentSource {
  open(audio: AudioReadableStream): AsyncIterable<VoxTermSegment>;
}
```

Production binds `open` to the forked VoxTerm child process. Tests bind it to a
synthetic in-memory feed via the exported `arraySegmentSource(segments)` helper,
so unit, integration, and e2e tests run with no real VoxTerm process,
microphone, or network. See `src/providers/asr/voxterm.test.ts` and
`test/e2e/voxterm-asr.e2e.ts` (fixture: `fixtures/voxterm/session.jsonl`).

## Construction

The provider is constructed only through the providers barrel
(`src/providers/index.ts`). Registry/barrel wiring is handled in ISSUE-0002 — do
not import `providers/asr/voxterm` directly from outside `src/providers`.
