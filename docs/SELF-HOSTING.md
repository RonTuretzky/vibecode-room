# Self-hosting mode — the room builds the room

`VIBERSYN_SELF_MODE=1` (or `./run-room.sh --self`, which sets it and adds the
supervisor loop) makes the project being built by the vibecoding room *the
vibecoding room itself*, and reloads the room when it lands a change.

## The mirror project

At boot the runtime pins a standing project on the wall:

| fact            | value                                             |
| --------------- | ------------------------------------------------- |
| upid            | `self` (reserved)                                 |
| spoken callsign | `mirror` (reserved in the allocator; phonetically clear of the wake word `vibersyn`) |
| title/task      | `Vibersyn Room`                                   |
| stage           | `SELF` (card badge `🪞 SELF`; scene node like any project) |
| kickoff lanes   | none — steering is its only build path            |

Reserved means reserved: `mirror` sits in the `CallsignAllocator`'s
reserved-word list (self mode only), so the namer/allocator can never hand it
— or a phonetic near-miss — to another process.

## Steering the room

Click-steer the SELF card, say **"mirror, <instruction>"**, or POST
`/api/process/self/steer {"text": …}`. Every steer surface funnels through the
registry's one orchestrator chokepoint (`selfRoutingOrchestrator`), which
routes the SELF upid into `SelfCommissioner.steer` (src/self/commission.ts):

1. Snapshot `git HEAD` (sha + subject).
2. Launch a durable **`vibersyn-self`** gateway run (claude subscription;
   `.smithers/workflows/vibersyn-self.tsx`, sibling of `vibersyn-process`),
   runId `vibersyn-self-<bootNonce>-<n>`. The agent works inside the room's own
   repo under hard guardrails: smallest change; never touch `gesture-wall/`,
   `.smithers/`, `artifacts/`, `builds/`, `dist/`, or anything dirty in git at
   run start; must pass `bunx tsc --noEmit && bun run build`; commit ONLY its
   own files by explicit path as `self: <summary>` with no attribution.
3. The SELF card shows executing telemetry (percent/label from live run
   events) like any commission, with a poll watchdog for missed terminal
   frames. The watchdog also GIVES UP after 8 consecutive unanswered probes
   (gateway died / run lost): the lane settles failed ("lost contact…") so the
   mirror never wedges in "executing" refusing every steer until a restart.

Serialized: a second steer while a run executes (or a reload drains) is
refused politely with a spoken ack ("Mirror is mid-change…" / "The room is
reloading itself…"). A steer whose durable launch FAILS (gateway down) settles
the lane failed and speaks "Mirror could not start that change…" — never a
silent shrug. `POST /api/process/self/execute` is refused (400) — for the
mirror, steering *is* commissioning.

## The green gate (room-side, never trusted)

When the run reaches a terminal state the room re-reads `git HEAD`: only a
**new** commit whose subject starts with `self:` counts as green. Green flips
the lane to `built` and arms the reload. Anything else — run failed/cancelled,
no commit, wrong subject, git unreadable, aborted by emergency stop — settles
the lane `failed` with the reason on the card: no reload, no commit of broken
state. Emergency stop aborts an in-flight self-run like any commission.

## Reload on change

- **Trigger**: the green path calls `runtime.requestSelfReload()` (also
  exposed as `POST /api/self/reload`, 404 unless self mode). The trigger
  re-verifies the last self-run reported green, refuses if a reload is already
  in flight, publishes `snapshot.self.reloadPending = true` (walls show the
  "room is reloading itself…" overlay), drains ~750 ms
  (`VIBERSYN_SELF_RELOAD_DELAY_MS`), then **exits 87**.
- **Supervisor** (`scripts/self-supervisor.sh` — run by `run-room.sh --self`,
  or started DIRECTLY with the launch env: it cd's to the repo root, exports
  `VIBERSYN_SELF_MODE=1` itself, and builds `dist/` once when missing):
  exit 87 → `bun install && bun run build` → relaunch the server, same env
  (the env lives in the supervisor process; every relaunch inherits it).
  A failed rebuild still relaunches on the old build (loud warning) so the
  wall stays alive. Exit 0 / SIGINT / SIGTERM end the loop (stops are
  forwarded to the server child — no orphaned port-holder). **Crash guard**:
  any other exit relaunches; a quick crash-loop (< `VIBERSYN_SELF_CRASH_WINDOW_S`
  uptime, more than `VIBERSYN_SELF_CRASH_RETRIES` times) with fresh commits
  since the last good boot `git revert`s them (bad commits stay in history),
  rebuilds, and relaunches the restored source — the room never dies mid-demo
  over a bad self-commit. Only a crash-loop with nothing left to revert (an
  environment problem) ends the loop.
- **Walls**: `/api/health` and the snapshot carry a stable per-boot `bootId`.
  Each page binds to the first bootId it sees; when the reconnected SSE
  stream / state resync delivers a different one, `location.reload()` — both
  walls pick up the new build automatically (`src/ui/self-reload.ts`).

## Env / surfaces

- `VIBERSYN_SELF_MODE=1` — everything above; off by default (no pinned card,
  `/api/self/reload` 404s, snapshot `self: null`).
- `VIBERSYN_SELF_RELOAD_DELAY_MS` — exit-87 drain window (default 750).
- Supervisor crash-guard knobs: `VIBERSYN_SELF_CRASH_WINDOW_S` (default 30),
  `VIBERSYN_SELF_CRASH_RETRIES` (default 2), `VIBERSYN_SELF_CRASH_BACKOFF_S`
  (default 1).
- Supervisor test seams: `VIBERSYN_SELF_SERVER_CMD`, `VIBERSYN_SELF_BUILD_CMD`,
  `VIBERSYN_SELF_ROOT`.
- Tests: `src/self/commission.test.ts` (commissioner, green gate, reserved
  callsign, routing), `src/server/composition.self.test.ts` (integration:
  pin → steer → green → 87), `src/ui/self-reload.test.ts` (bootId reload
  decision + overlay), `src/self/supervisor.test.ts` (loop behavior).
