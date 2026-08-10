# Demo-Day Runbook — labor.fun / convent-profile (2026-08-10)

The show: import `RonTuretzky/convent-profile` as a garden tree → the tree finds
`residency.convent.fun` and blooms the LIVE house board on a holo panel → grow a
real branch by dwell → record-steer a change by voice → one-dwell REAL PR to the
origin repo → issues #11/#12 hang as fruit on the holo branch → take an issue →
loop. Dwell + talk only.

## Start order (cold boot)

1. **Gateway FIRST, from THIS worktree** (self-runs execute in the gateway's cwd
   — a stale gateway from another worktree commits elsewhere; burned us once):
   ```
   cd ~/conductor/workspaces/vibecode-room/surabaya/.smithers && PORT=7331 nohup bun run gateway > /tmp/gateway-surabaya.log 2>&1 &
   lsof -nP -iTCP:7331 -sTCP:LISTEN   # then: lsof -p <pid> -a -d cwd → MUST be …/surabaya/.smithers
   ```
2. **Room server under the supervisor** (NO `--watch` — a file save must never
   reboot the room mid-demo):
   ```
   cd ~/conductor/workspaces/vibecode-room/surabaya
   set -a; source .env; set +a
   VIBERSYN_HANDS_TLS_CERT="$PWD/artifacts/hands-tls/cert.pem" VIBERSYN_HANDS_TLS_KEY="$PWD/artifacts/hands-tls/key.pem" \
   HOST=0.0.0.0 VIBERSYN_PORT=8788 nohup bash scripts/self-supervisor.sh > /tmp/vibersyn-self.log 2>&1 &
   ```
3. **Gesture stack**: gesture server :8770 (`room.flat-2kinect.json`, `--flat`),
   arcade bridge :8771 if the joystick is wanted, hands bridge :9980 from a
   TERMINAL WITH CAMERA PERMISSION (`--real-hands` path; agent shells can't).
4. **Walls**: `http://<host>:8788/?wall=A&flat=1&gesture=1` and `…?wall=B&flat=1&gesture=1`,
   fullscreen via mouse (dwell can't requestFullscreen). Ceiling:
   `…?wall=C&research=1&zen=1`. DevTools CLOSED everywhere.

## T-45 checklist

- [ ] **.env demo flags**: `VIBERSYN_AUTO_ACCEPT=0` and `VIBERSYN_CAPTURE_MODE=0`
      **in .env itself** (they are 1 today!) — a mid-demo restart re-arms them
      from env, not from the dock. Then dock-verify: Auto-Build OFF,
      Self-Rebuild OFF, `curl -s localhost:8788/api/state | grep -o '"autoAccept":[a-z]*'`.
- [ ] **Salem session**: Telegram `@SalemConventBot` → `/dashboard` → consume the
      magic link ONCE via `curl -sI '<link>'` and copy the `salem_session`
      Set-Cookie value into `.env` as `VIBERSYN_SALEM_SID=…`, restart server,
      then `curl -s localhost:8788/salem/healthz` → `{"ok":true,…}`. (Sids last
      ~45 days; a droplet restart invalidates — re-harvest if healthz fails.)
- [ ] **PAT**: `set -a; source .env; set +a; GH_TOKEN="$VIBERSYN_GITHUB_PAT" gh api repos/RonTuretzky/convent-profile --jq .permissions.push` → `true`.
- [ ] **Issues**: #11 (welcome note) and #12 (night mode) still OPEN on
      convent-profile (they are the fruit).
- [ ] Deploy map present in .env: `VIBERSYN_DEPLOY_MAP=RonTuretzky/convent-profile=https://residency.convent.fun`.
- [ ] Kinect A+B alive (autocal :8801 proxied at /api/autocal/*), or fall back
      to `?dwell=mouse` on the wall URLs — every demo surface is plain buttons,
      mouse and dwell are interchangeable mid-show.
- [ ] Optional safety net: pre-import convent-profile on a hidden window at
      T-30 and keep the tree warm (skip the live import beat if nerves).

## Recovery drills

- **Server dies / reboots**: supervisor relaunches it, BUT state is memory-only —
  the imported tree, branches, and prUrl are gone. Recovery: re-run the import
  (~30s: QR or `curl -X POST localhost:8788/api/projects/import -H 'content-type: application/json' -d '{"url":"https://github.com/RonTuretzky/convent-profile"}'`),
  re-dwell. Narrate as "the room wakes fresh".
- **Holo panel blank / 401**: sid died → panel shows the branded login fallback,
  not a blank frame. Re-harvest sid (above) after the demo beat; skip to branch/PR
  beats meanwhile — they don't need the panel.
- **PR button errors**: the popup shows the honest error line. Usual causes: PAT
  revoked (re-check T-45 step) or network. The dry-run pattern is proven — retry
  once, else narrate the PR from the phone (`gh pr create` in a pocket terminal).
- **Gateway dead** (self-runs refuse / heartbeats stop): restart per step 1.
  NEVER let a gateway from another worktree grab :7331.
- **Surprise trees appear**: Auto-Build got re-armed — dock toggle OFF, dismiss
  the stray via its tree menu 🗑 (two-stage).
- **Exit-87 self-reload mid-demo**: only possible if Self-Rebuild is ON — keep
  it OFF for the show (the cat already proved the loop; don't run it live unless
  it IS the beat).

## GIFs

`artifacts/demo-gifs/` (git-ignored, survives restarts): one GIF per beat —
import, holo bloom, branch+steer, PR, issue-fruit take. Regenerate:
`bun scripts/capture-demo-gifs.ts` (Playwright frames → ffmpeg palette GIF).

## The beats (compressed)

1. (Optional) guided demo step 1 — orb dwell literacy, then Exit.
2. QR import → convent-profile → tree sprouts, "that repo is private — the room
   is authenticated as me."
3. Dwell tree → menu shows owner/repo + **Live app ▸** → holo panel blooms with
   the REAL board ("GitHub's API doesn't even know this URL — the room read the
   README like a person").
4. Panel chrome by dwell: board pages, scroll. (Voice on the panel only if the
   panel-verbs shipped — otherwise dwell is the story.)
5. Tree menu → **Grow a branch ▸** → limb appears.
6. RecordSteerToggle → speak the change → toggle off → commit ticks on the limb.
7. Dwell branch tip → **Open PR ▸** → live PR URL on the popup; phone-verify.
8. Pan to the holo issues branch → dwell fruit #11 → **Take this issue** →
   issue-branch grows, steer armed → loop to 6.
9. Encore only: merge on phone → droplet deploys ~2min → re-open holo panel →
   the spoken change is LIVE in production.
