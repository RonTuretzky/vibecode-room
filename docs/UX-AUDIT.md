# Room flow and UX audit — September 4, 2026

The idea → concept → deck → commissioned-build path works with controlled
external services. The largest product gap is branch growth: it creates Git
history, but the current branch writer does not implement arbitrary requests.
Several interactions also assume the operator already knows the room's keyboard
shortcuts and projector layout.

## What changed in this review

- New runtime projects use UUIDs instead of restarting at `upid-1`. Replacing
  an existing artifact directory archives it before preparing its replacement.
- Generated slideshows have a reachable Deck button in the tree menu.
- API startup, room launcher, Vite proxies and generated previews share port
  resolution: `VIBERSYN_PORT`, then `PORT`, then 8787.
- `bun run dev` starts the API and Vite together. Vite runs on Node, including
  its WebSocket proxy; generated HTML and test reports no longer trigger wall
  reloads. Live data is the default in development.
- Quiet event streams are exempt from Bun's idle timeout. This fixes the
  recurring false “lost the room” banner observed during this audit.
- Default, demo and original-installation profiles, `.env.example`, a doctor
  command and recovery/development documentation replace installation defaults
  in the core startup path.
- Runtime contracts, policy, adapters and self-version management were split
  out of `composition.ts`; scene models/textures and room chrome/connection
  handling were split out of the main UI modules. The original public exports
  remain available. The remaining orchestrators are still large: approximately
  4,750 lines in composition, 5,675 in RoomScene and 3,314 in App. A next pass
  should extract import/steering controllers and scene reconciliation.

The preview API security boundary from the earlier review was outside the
selected fixes and remains a separate item.

## Test setup and limits

The application was launched from its production entry point and operated in
the browser at 1280×720, in both desktop and paired-projector layouts. The import
form was also checked at 390×844. Speech went through the real microphone
WebSocket and transcript pipeline with a scripted recognizer. Model/gateway
responses were controlled fixtures that wrote actual output files.

Repository import, branch creation, grafting and commits used real Git and a
local bare repository. Only the fixture's GitHub URL was rewritten to that local
remote. A test `gh` executable rejected publication, so no real GitHub repo, PR
or deployment was created by these UI exercises.

This establishes application flow and error handling, not real model quality,
audio recognition accuracy, production deployment, camera calibration or
physical projector performance. Those require live integration acceptance tests.

## Flow coverage

| Flow | Evidence / result |
| --- | --- |
| Speech → idea | A unique spoken habit-garden idea appeared in the transcript and tray. |
| Plant | Clicked its orb → Plant → ground. Exactly one project appeared, then a generated preview and deck. |
| Replant and reload | Moved the existing tree through Replant; it remained the same project. Placement was retained on browser reload. |
| Deck and refinement | Opened the generated deck through the restored menu button. Recorded a change, saw the echo and receipt, and observed a new preview revision. |
| Questions → commission | Browser test answered a deck question, saw regenerated artifacts, commissioned a build and opened the resulting app. The controlled run reached built in about 4.6 seconds. |
| Error and duplicate handling | Adversarial deck tests covered failed commission/recovery and duplicate commission requests. |
| Import | Submitted a repository URL through `/submit`; the clone was studied and appeared as an adopted tree. Empty submission showed a useful validation message. |
| Grow a branch | Recorded a request and stopped. `room/welcome-panel-with-accessible` appeared, backed by a real commit. The commit changed `ROOM-NOTES.md`, not the requested app features. |
| Graft onto a branch | Added a second request to the same branch; its commit count advanced to two. Had to reopen the branch card to find Stop after the menu closed. |
| PR failure | Open PR displayed the test publisher's refusal inline. Real GitHub success/merge/deploy was not exercised. |
| Research | Accepted a quest, opened its dossier. The stub reported zero sources and an unverified finding. This does not establish sourced research quality. |
| Guest/phone | Import form fit a phone viewport; guest trackpad page connected. QR overlay honestly reported the loopback-only room as unreachable from a phone. Camera tracking was not exercised. |
| Connection loss | Added a quiet-room regression test. Existing server-loss test showed the warning about 131 ms after shutdown on its successful rerun. |
| Other controls | Standard browser coverage includes deck navigation, keyboard selection, scene layouts, lifecycle controls and overlays. Hardware/gesture and authenticated self-deployment flows remain integration work. |

## Prioritized remaining work

### 1. Make branch growth actually implement the request — high priority

`src/server/steer-applier.ts` appends the spoken text to `ROOM-NOTES.md` and,
for a few keywords, inserts a note into `dashboard/index.html` if that specific
file exists. Its own TODO reserves agent-driven steering for future work.
This behavior is independent of the fake model used in this audit: it is the
production branch-writing implementation.

The UI's “growing your change” receipt overstates that result. My request for a
dark-mode toggle and progress chart produced a notes-only commit. Implement a
branch-scoped agent job with validation, a changed-file summary and preview.
Until then, label this result “request saved on branch” and clearly identify
the notes writer. A successful commit alone is not evidence of a completed task.

### 2. Keep recording visible throughout grafting — high priority

`TreeMenu.tsx` calls `onClose()` after `steerOntoTreeBranch` succeeds. The server
is then recording, but the menu and Stop control disappear. The room header
continues to say “ambient listening.” Clicking the small branch label restores
the branch card and its active recorder.

Open the branch card automatically, or retain the menu with a recorder. Add a
persistent room-level recording bar showing the target, transcript, Stop and
Cancel. Changing overlays should never hide an active recording.

### 3. Restore projects and work after a restart — high priority

This change preserves files and prevents ID collisions. The registry, imports,
selection and execution bookkeeping remain in memory. Files surviving on disk
does not restore the garden or resume a model run. Plant positions are stored
in browser-local storage, so they also do not define a shared layout across
devices. Persist project metadata and provide an explicit recovery screen,
with resumable/interrupted states instead of silently starting an empty room.

### 4. Give the room one consistent account of progress — high priority

A generated concept was ready while its tree still read “planning · 0% · spawn”;
after refinement it read “planning · 12% · steer.” These percentages describe
different systems. “ALL CLEAR” also appears when integrations are stubbed, and
“READ-ONLY” sits above controls that start builds and alter Git repositories.

Use one project status model: concept generating → concept ready → queued →
implementing → validating → preview ready / failed. Show provider availability
separately. Put last progress, failure reason, retry and cancel in the tree's
normal menu, including before any deck exists. The current stall test cannot
reach its subject because its old build-lane control was removed.

### 5. Make the core actions discoverable — medium priority

The prominent idea tray offers Build/Dismiss, while Plant requires hitting the
small 3D orb. Import and Help are available through `q` and `h`, but are absent
from the visible controls dock in the tested desktop view. Refinement copy says
“Type a change,” yet the revealed surface only offers a recording button.

Add Plant beside Build, visible Add project / Help actions, and a text fallback
for refinement. Show the proposed ground position clearly and temporarily
collapse obstructing panels while planting. The basic phone import form is
already a useful, simple model to follow.

### 6. Separate laptop and projector layouts — medium priority

In the paired flat projector view, an orb and tree were partly off the right
edge and Fit did not move them: the split-frustum view is intentionally locked.
The interface still advertised Fit as if it worked normally. In the standard
desktop view the same trees were accessible. Panels and a large fullscreen
prompt consumed much of the usable lower screen at 1280×720.

Explain locked views, disable incompatible camera controls, and reserve safe
screen regions for menus. Provide a searchable DOM project list so choosing a
tree does not require precise canvas picking. Test keyboard focus and screen
reader actions as first-class flows.

### 7. Distinguish research settings from the research display — medium priority

The room-wide research switch controls the engine; the display is selected
separately by `?research=1`. The keyboard help implies a single mode switch.
Make “run background research” and “open research view” explicit actions.
The heuristic proposed fact-checking a feature request during this run, so
evaluate proposal relevance separately from whether the pipeline completes.

### 8. Maintain tests as product behavior changes — medium priority

Several live tests still target removed tree-menu record/build-lane buttons or
old dock controls. These failures conceal whether the currently reachable
journeys work. Move recording tests to the deck refinement or adopted-branch
surface, preserve their collection/receipt/error assertions, and add the full
plant → branch → implementation journey with assertions on actual code changes.

Performance measurements in the live audit used SwiftShader software rendering:
roughly 13–15 fps at 1920×1080, and approximately 1.4 seconds from sampled canvas
presses to menu display under test load. These are diagnostic observations,
not measurements of a physical GPU/projector. Profile the target hardware
before choosing rendering changes; prefer adaptive quality and larger hit areas.

## Validation results

- TypeScript checks and production build passed.
- Standard browser suite: **59 passed**.
- Broad live audit: **20 passed, 9 failed, 1 skipped** initially. One failure
  was the old deck-entry selector; updated it to the restored Deck button and
  both deck-decision tests then passed. Eight older live cases remain red or
  unreachable as described above; this is not an all-green live suite.
- New quiet-stream test passed. Server-disconnect test passed on isolated
  rerun; one combined run failed earlier during scripted speech setup.
- Full Bun suite: **2,550 passed, 20 skipped, 3 failed**, with three associated
  timeout errors in fake Claude CLI subprocess tests. The complete affected
  file passed independently: **55 passed, 0 failed**. The full-run failures
  remain unresolved test reliability work; they are not hidden or weakened.
- Dev-server checks verified JSON state, SSE and the microphone WebSocket
  through Vite on a nondefault API port.

The next implementation pass should prioritize real branch edits, persistent
recording controls and recovery. A visual redesign will be more useful once
those flows have unambiguous outcomes.
