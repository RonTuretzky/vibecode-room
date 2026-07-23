# Calibration: 2026-07-23 — camera repositioned toward wall B

The session's best calibration; archived verbatim so it can be restored with
`cp calibrations/2026-07-23-camera-reposition/room.json room.json`.

## Physical setup
- One Orbbec Gemini 335 (CP0E8530002Y), room's far corner, shifted ~20-30 cm
  toward wall B's side; both projected images fully in the color frame.
- Lit image widths (tape-measured, stored in walls.<id>.width_m):
  wall A = 2.10 m, wall B = 2.276 m. Corner at exactly 90.0 deg.
- Calibrated with room lights DOWN (dot contrast); play with lights UP.

## Quality
| | detected | kept | fitted | pinned | fit error |
|---|---|---|---|---|---|
| wall A | 7/9 | 5 | 2.37 m | 2.10 m | 13% |
| wall B | 7/9 | 4 | 2.52 m | 2.28 m | 10.5% (best of session) |

- Wall B's far/oblique markers recovered by the retry pass (0.24 discs).
- server.smoothing = 2.5 (user-tuned live).
