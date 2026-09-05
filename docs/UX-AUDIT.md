# Room flow and UX audit — September 4, 2026

The audit findings have been implemented on `improve/room-reliability-and-ux`.
Branch requests now produce validated code changes, active recordings remain
reachable, and room metadata and placement survive a restart.

## Implemented fixes

| Finding | Result |
| --- | --- |
| Branch growth only wrote notes | Branch jobs clone the selected branch into an isolated workspace, invoke the coding agent, run available checks and commit changes to that branch. The UI reports files, checks, failures and previews. Notes mode requires explicit configuration. |
| Grafting hid the recorder | Grafting retains its card; a room-level bar keeps the target, recent transcript, Stop and Cancel visible across overlays. The bar identifies an inactive microphone and offers Start microphone. |
| Restart lost the garden | Atomic, versioned state restores projects, seeds, imports, branches, previews, answers, published links and placement. In-flight work becomes interrupted and requires explicit retry. Malformed state is preserved and reported. |
| Positions differed between windows | Placement is stored by the server, broadcast through SSE and restored with room state. |
| Progress contradicted actual work | A shared status model distinguishes concepts, commissioned apps and branch jobs. Stalled concept work shows elapsed time and a recovery action. Cancellation preserves the project for retry. |
| Core actions were hidden | Visible Projects, Add project and Help controls; searchable project list; Plant beside Build; desktop import form; typed changes in projects and deck refinement. Panels collapse while planting. |
| Laptop/projector controls were misleading | Locked projector views label and disable Fit. DOM project selection avoids precise canvas picking. Adaptive canvas resolution responds to sustained frame load. The import dialog supports Escape, focus restoration and keyboard focus containment. |
| Research controls were ambiguous | Background research and Open research view are separate actions. Feature requests are excluded from the simple factual-claim heuristic. |
| Old browser tests targeted removed controls | Recording, provider and stall tests now follow the visible project workspace. The branch journey verifies working HTML changes, grafting, cancellation, failure feedback and restart recovery. |
| Preview API allowed unrelated room operations | Generated previews can forward only scoped execute/steer/answer/dismiss actions. Branch previews have no room API access. Static serving rejects hidden paths and symlink escapes. |

The earlier fixes are retained: UUID project IDs, archival before replacing
artifacts, restored Deck entry, shared port configuration, Node-based Vite with
HTTP/SSE/WebSocket proxies, quiet SSE connection handling, portable profiles,
environment template, doctor command, and module extraction. New recovery,
branch-job, process-command, status and workspace code lives in separate modules.
The main scene and runtime orchestrators remain large; further decomposition
is maintenance work, rather than a missing user flow.

## Exercised flows

- Speech → idea → Build/Plant → concept preview and deck.
- Replanting with exactly one project, persistence on reload and synchronization
  to a second browser window.
- Deck navigation, question answering, typed/spoken refinement, commissioning,
  generated application rendering, duplicate requests and failure recovery.
- Desktop and phone import; repository study; grow and graft with real local Git.
  The new fixture adds a working dark-mode control, then adds a reset control
  to the same branch and exercises both controls in the resulting preview.
- Branch validation failure, cancellation, retry, and restoring completed
  previews and interrupted jobs without automatically launching an agent.
- Persistent recording controls, no-microphone feedback, empty recordings,
  transcript/receipt feedback, research controls and provider degradation.
- Quiet connections, server loss, lifecycle controls, layout and overlay actions.

## Test environment and limits

Browser journeys launch the production server and built UI. The recognizer is
scripted but goes through the real microphone WebSocket and transcript pipeline.
The branch/deck rigs control model and gateway responses and write actual files;
Git import, branch creation, isolation, commits and grafting use a local bare
remote. GitHub publication is refused by the test publisher.

Manual browser checks use desktop and phone-sized viewports. These checks do
not establish physical microphone/ASR accuracy, real model output quality,
authenticated GitHub publication/deployment, camera tracking or physical
projector performance. Static branch previews work when an HTML entry exists;
applications requiring their own server use their project-specific launch
instructions. Preview filtering limits files and API forwarding; agent execution
is local and is not a security sandbox for untrusted repositories.

## Validation

- Full live browser suite: **32 passed, 1 skipped, 0 failed** (10.6 minutes). The existing skipped case concerns naming 3D issue-fruit/limb hit targets.
- TypeScript and production build passed.
- Full unit suite passed in CI, with **20 optional live-integration tests skipped**.
- Standard browser checks: **59 existing cases passed**; the new phone layout/focus check passed after repairing an 8-pixel overflow, header overlap and clipped scene controls.
- Focused command, recovery and Gateway regressions: **10 passed, 1 optional integration skipped**. Earlier loaded full Mac runs encountered subprocess/Gateway timing failures; the affected cases pass in isolation and CI.
- The CI gate now also runs planting, branch/recovery and deck commissioning against controlled providers with real HTTP, files and Git. Its whole-journey timeout allows multiple server boots; per-operation deadlines remain enforced.

The software-rendered live run measured transcript-to-DOM p95 at **274 ms**
and server-disconnect feedback at **257 ms**. Canvas picking remained slower
(about **819 ms** median before lowering the initial software-renderer resolution), so the accessible Projects
list is the reliable selection path under software rendering. Physical-GPU
acceptance is still required; adaptive resolution does not establish that
every projector meets its frame or input-latency target.
