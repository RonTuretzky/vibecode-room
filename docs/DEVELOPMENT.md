# Development and recovery

## Artifacts survive new sessions

New projects receive UUID-based IDs. Their directories keep those IDs after a
restart, so another session cannot allocate the same path. Replacing a legacy
commission or scaffold moves the old directory atomically to
`<root>/.history/<project-id>/<timestamp>-<uuid>/` before building again. A failed
archive stops preparation instead of deleting work. No automatic pruning runs.

Current commissioned outputs are under `artifacts/vibersyn-runs/`; concept
outputs and repository seeds are under `builds/`. Open a saved `index.html` or
serve its directory locally to inspect a previous output. Archive directories
are ordinary files and can be copied back for recovery. Room restart does not
resume an in-flight model run or automatically restore its UI card.

## Module ownership

- `src/config/network.ts`: API port validation and internal origin.
- `src/config/profiles.ts` and `room-profiles/`: installation defaults and precedence.
- `src/server/runtime-contract.ts`: runtime interfaces, without runtime imports.
- `src/server/runtime-policy.ts`: speech/acceptance policy and snapshot projections.
- `src/server/runtime-adapters.ts`: gateway, registry and audio adapters.
- `src/server/self-versions.ts`: self-branch listing, checkout, merge and pruning.
- `src/server/composition.ts`: service assembly and the live room lifecycle.
- `src/ui/scene-model.ts`: scene contracts, tree state, picking payloads and framing rules.
- `src/ui/scene-textures.ts`: texture, label and sky object factories.
- `src/ui/room-chrome.tsx`: clock, fullscreen, microphone and transcript controls.
- `src/ui/use-room-connection.ts`: state synchronization, SSE and reconnect cleanup.

Existing exported names remain available from the original modules while
consumers migrate. Renderer reconciliation and runtime state transitions are
still substantial; keep future features behind these boundaries rather than
adding unrelated helpers back to the orchestrating components.

## Validation

```sh
bun run typecheck
bun test
bun run test:e2e
bun run test:live
```

The default browser suite tests the production build. The live suite uses real
HTTP/SSE/microphone plumbing with scripted external services; it does not prove
real hardware, provider latency, or an authenticated GitHub deployment.
The host subscription probe is explicitly enabled with
`VIBERSYN_LIVE_SUBSCRIPTION_TEST=1 bun test poc/a-llm-sub.test.ts`.

On machines that globally sign commits, use a per-command test override
`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=commit.gpgsign GIT_CONFIG_VALUE_0=false bun test`
so temporary fixture commits do not wait for a signing prompt. This does not
change the user's Git configuration.

## Branch implementation and recovery

Imported repository changes now run through `src/server/branch-jobs.ts`. Each
request clones the selected `room/*` tip into a separate job directory under
`builds/<upid>/.branch-jobs/`. The local Claude CLI implements the request, then
the room checks the staged diff and runs available `typecheck`, `test`, and
`build` package scripts. Failed checks or cancellation leave the branch tip
untouched. Jobs expose changed files, passed checks, an error, and a static
preview when a usable HTML entry exists. Framework apps needing a running
application server still need their project-specific launch procedure.

`VIBERSYN_CLAUDE_CLI` selects the executable and `VIBERSYN_BRANCH_MODEL` selects
the model (default `sonnet`). The existing `VIBERSYN_STEER_APPLIER=0` switch
disables branch writing. `VIBERSYN_BRANCH_WRITER=notes` explicitly selects the
old deterministic notes demo; it is never used automatically after an agent
failure. Jobs do not push, open PRs, or deploy. Opening a PR pushes the branch's
existing commits and no longer snapshots the original checkout over them.

The production entry saves room metadata atomically in
`builds/.room-state.json`. Set `VIBERSYN_STATE_FILE` to another path or `off` to
disable it. Demo profiles disable persistence; test harnesses use their own
temporary state file. Directly constructed runtimes persist only when a
`stateFile` option is passed, so unit tests cannot read an operator's garden.

Restart restores project identities, seeds, selection, import briefs, concept
and app previews, branch jobs, published links and shared positions. Previously
running work is shown as interrupted. Retry is explicit; execution retry first
reconciles/cancels the old gateway run and uses a new run ID. A failed recovery
preserves the original state file and shows its error in the UI. Keep the state
file **and** its referenced artifact directories together when moving a room.
No external agent or publication is started merely by loading saved state.

Generated concept previews can forward only their own execute/steer/answer and
idea-dismiss actions. Branch previews have no room API access. Hidden files,
repository internals, dependencies, and symlinks outside the preview directory
are excluded from static serving.

Use **Projects** for search, status, retry, cancellation and typed changes.
**Add project** opens a desktop form; the QR/phone form remains available with
`q`. An active recording has persistent Stop/Cancel controls even when a menu
closes. **Background research** and **Open research view** are separate dock
actions. Paired projector cameras label their locked view and disable Fit;
normal desktop views retain camera controls. Rendering resolution adapts to
sustained frame load, while DOM controls and text stay at full resolution.
