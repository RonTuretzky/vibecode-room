# Panopticon — architecture & integration seams

This V0 implements the Session-1 spec natively (so it runs with zero external
services) while keeping the **adapter seams** where the four evaluated projects
plug in. The mapping below is the contract for that integration.

## The agreed stack

| Spec layer | This repo (V0, native) | Drop-in backend |
|---|---|---|
| META-SESSION / session manager (always-on outer loop) | `core/meta-session.ts` | **elizaOS** `AgentRuntime` + autonomy service + task system |
| Suggestion / wake policy (always-on listen → "should I build this?") | `core/suggestion-engine.ts` | **cue** harness (cue policy / `observe.pass`) |
| Process = durable unit of work (the inner loop) | `core/process.ts` | **Smithers** workflow (`<Ralph>`, SQLite resume/fork/replay) |
| Kernels: STT · TTS · LLM · VLM, and the plug-in agent | `core/brain/*` + browser Web Speech API | **plugin-local-inference** (whisper.cpp · Kokoro · llama.cpp) inside an **Eliza** agent |

Why this shape (from the design conversation): Eliza is *built* to be always-on
and event-driven, so it owns the outer loop; cue's wake policy is exactly the
unsolved "suggestion threshold"; Smithers is best at durable, forkable,
multi-step *process* work, so it moves inward; local-inference supplies the cheap
hot-loop kernels (no Opus in the hot loop).

## File → spec map

| File | Spec | Responsibility |
|---|---|---|
| `core/types.ts` | §5.2, §5.3, §5.6, §4 | domain types: metadata, modes, events, config |
| `core/meta-session.ts` | §5 root | always-on outer loop, autonomy tick, selection, snapshot |
| `core/process-manager.ts` | §5.1 | create/modify/kill/fork/merge/import/export/pause/resume/switch_mode |
| `core/process.ts` | §5.3 | per-process session loop: input→pre→action→post→output |
| `core/hooks.ts` | §5.3, C6 | per-loop & per-action hooks; pre-spawn check, pre-kill archive |
| `core/suggestion-engine.ts` | §5.5, C3 | always-on wake policy, bubbles, TTL, merge, model-initiated |
| `core/input-router.ts` | §5.4, C2/C3 | identify→select→parse→action; ambient-vs-steer routing |
| `core/brain/{mock,anthropic}.ts` | §5.9 | the two model tiers behind one interface |
| `server/index.ts` | §5.4, §5.7 | REST commands, `/ws` event stream, QR pairing |
| `web/*` | §5.6, §5.7, §4 | Pro spatial board + steer panel; mobile device; knobs |

## Seam contracts (how to swap in the real backends)

**elizaOS as the outer loop.** `MetaSession` is intentionally thin: a tick loop +
ownership of the sub-engines. To replace it, register the Process-Manager
functions as Eliza **actions**, the hooks as **providers** (pre) / **evaluators**
(post), the autonomy tick as Eliza's **autonomy service**, and the event bus as
Eliza's message bus. Rooms/worlds/entities map to the physical room + people.
*Open risk:* Eliza is persona-centric — confirm a headless orchestrator runtime.
*Open risk:* two schedulers — Eliza task system owns *which processes wake*;
Smithers owns *what happens inside one process*. Keep that boundary hard.

**cue as the wake policy.** `SuggestionEngine.tick()` is the cue loop: a
deterministic gate (rate/cooldown/min-content) then a cheap model call that may
return `null` (`observe.pass`). Replace `brain.suggest()` with a cue
`CueHarness` reading the transcript stream; keep the bubble lifecycle (TTL,
merge, accept→spawn) here.

**Smithers as the process.** Today `Process.tick()` calls `brain.step()` in-proc.
To make a process a real durable workflow, implement `Process` as a Smithers run:
`fork()` → Smithers `fork`, pause/resume → workflow suspend/resume, the
implement→validate→review→fix cycle → `<Ralph>`. The `container` metadata field
is where the sandbox (gVisor/Daytona) id goes.

**plugin-local-inference as kernels.** `AnthropicBrain` proves the brain seam;
a `LocalInferenceBrain` would call whisper.cpp (STT), llama.cpp (LLM) and Kokoro
(TTS) via an Eliza agent carrying the plugin. The browser Web Speech API mic is
the V0 stand-in for whisper.cpp on the ambient channel.

## Event model

Everything publishes to `EventBus` (`core/bus.ts`); the server fans it to clients
over `/ws` (cue-style passive `/events` stream). Clients are read-only over the
socket and drive state changes via REST — so any number of Pro screens and paired
phones stay in sync.

## Not yet built (spec V1 / wishlist — explicit)

- Audio+Video **Easy mode**: pinch/point spatial selection (§6.2)
- Spatial diarization (voice→hand→process), gyroscope wand (§6.3)
- Speculative process *selection* (§6.3)
- Real container isolation per process (currently in-process) — needs the
  Smithers/sandbox seam wired
- Persistence across restarts (currently in-memory) — SQLite via the Smithers seam
