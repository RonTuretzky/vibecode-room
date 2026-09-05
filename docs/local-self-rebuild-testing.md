# Local self-rebuild verification — 2026-09-05

Branch: `feature/fully-local-room`. These tests ran on the development Mac with
LM Studio's installed GPT-OSS 120B model (`room-local-code`) and Whisper `base.en`.

The live test room ran at `127.0.0.1:18996` from an independent clone with no
origin remote and a deliberately invalid upstream repository slug. This allowed
real source edits, commits, version switches and supervisor restarts without
changing the user's running room on port 18994 or publishing demo changes.

## Verified outcomes

| Flow | Actual result |
| --- | --- |
| Grow a self-change from Projects | A typed request cut a new `room/*` branch and reached the local coding model. |
| Local edit and green checks | The model changed one Projects heading. The isolated checkout passed typecheck, the unit suite and build; commit `c42fab2` contained one source file and no generated test output. |
| Supervisor and browser | The self-run completed, the server exited 87, the supervisor rebuilt and restarted, and the open browser reconnected automatically. The new heading was visible. |
| Load a previous version | Clicking “climb here” in the tree menu loaded `room/local-self-test`, restarted the room and restored the original Projects heading. |
| Cancel and retry | Cancel work and the tree's stop-growing confirmation aborted local work. Retry launched a fresh run with the same instruction on the same branch. |
| Concurrent requests | A second self-change, version checkout, archive and premature reload were refused while work was active; the running branch did not change. |
| Voice graft and rebuild | Real PCM speech passed through Whisper with Stop pressed before the final transcript. The full instruction reached the selected branch; the model changed the heading, passed all checks, committed `7b0f372`, and restarted the room. The browser showed “local mirror ready”; no sibling branch was created. |
| Failed rebuild recovery | Loading an intentionally broken TSX version caused a real Vite build failure. The supervisor restored branch `room/read-src-ui-projectworkspace-4` at `7b0f372`, preserved rejected commit `8ae6404`, restored the frontend and restarted. The open browser reconnected with the correct heading. |
| Dirty configuration | With an uncommitted `package.json` change, both checkout and archive of the running branch returned 400 and left the branch unchanged. |
| Tend branches | Real API and Git checks archived one inactive test branch, deleted another, and refused deletion of main or the running branch. No remote was configured. |

The successful typed run was `vibersyn-self-mtou2zik-1`; its boot ID changed from
`fa68f28e-e3d0-4021-8287-801fe336bdc7` to
`400b5570-012c-44a3-970f-9dd5b1221004`. Test commits exist only in the isolated
clone; they are not feature changes to ship.

## Fixes driven by these tests

- Self projects now use the self commissioner for typed changes, recording,
  branch selection, cancellation and retry. The Projects panel lists self
  branches and shows a useful ready state.
- The room refuses overlapping changes and dirty checkouts. Version switches
  protect configuration and newly created source files as well as `src/`.
- Late completion events cannot finish a replacement run or revive cancelled
  work. Progress shows actual local-model and validation phases.
- Model responses containing both tool actions and `done` execute the actions
  before completion review. Small edits use exact replacements; source search
  helps the model find code in this large repository.
- Browser checks explain when a frontend build is required before previewing.
- Checks run without inherited room ports/modes, and generated test output stays
  out of self commits. Failed worktrees remain available for inspection.
- Unit tests block accidental discovery or execution of authenticated host AI
  CLIs. Injected test executables remain usable.
- A recording's delayed final retains its target before ordinary command
  matching. Local ASR flushes captured audio and the recording waits for that
  final to be consumed, with a bounded timeout.
- Failed supervisor rebuilds restore the last running source and frontend and
  preserve the rejected branch for inspection.

The voice run was `vibersyn-self-mtoumglk-1`. Boot changed from
`9c0a443f-da19-49d0-adf8-102d7965615e` to
`11e7cd50-491e-426b-aaad-721796a74346`; the failed-rebuild recovery then produced
boot `c20f79fd-2b55-4127-8c95-385c2e6c8c94` on the same good commit.

## Final automated checks

- Full unit/integration suite: **2,608 passed, 20 skipped, 0 failed**.
- Full browser suite: **61 passed** with one worker.
- Typecheck and production build passed. The existing large frontend bundle
  warning remains.
- Focused recording, local-ASR flush and self-composition regressions: **36
  passed**; these are also included in the full unit total.

Browser suites use controlled snapshots/providers. The real model, Whisper,
Git, restart and recovery runs in the table above are separate evidence.

## Scope and limits

These are real model and application tests, not a guarantee that every requested
self-modification will succeed. Earlier attempts exposed malformed model tool
output, dropped actions and a 32-step budget exhausted while searching and
previewing. The fixes above address those failures; model behavior remains
variable and larger changes may still fail safely.

Speech tests inject generated audio into the real browser-mic transport; they do
not test physical microphone acoustics. Live GitHub push, PR merge and remote
branch deletion were deliberately not exercised. Deterministic Git/transport
regressions cover those version-management paths separately.

Local evidence is under `.context/self-rebuild-evidence/`; the independent test
clone is `.context/self-rebuild-e2e/`. Both are intentionally ignored by Git.

Run the supported mode with `bun run local:self`; see [local setup](local-ai.md).
