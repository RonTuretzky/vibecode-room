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
