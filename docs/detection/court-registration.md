# Court registration — corner-accurate 2/3 for any camera placement

## The problem it solves

The old 2/3 estimators (`court.ts` heuristic, `courtGeometric.ts` metric) treat
the 3-point line as a **circle** — one distance threshold from the basket. The
real line is an **arc** (6.75 m FIBA / 7.24 m NBA at the top) that **flattens
into straight lines in the corners** (6.60 / 6.70 m). So a corner shooter can be
*closer* than the arc radius yet still behind the line — a legitimate 3 that a
single radial threshold scores as a 2. This is the exact case court-registration
apps (HomeCourt) get right and distance-only apps get wrong.

## Why a homography (and why it handles ALL placements)

Fixing corners needs the shooter's position in **court** coordinates (along the
baseline vs toward center court), not camera coordinates. A single uncalibrated
camera can't separate those — only the *radial* distance is orientation-
invariant. A **homography** (plane-to-plane projective map) from ≥4 known
image↔court correspondences encodes the full camera↔court perspective, so it is
**inherently orientation-agnostic**: side-on, baseline, top-of-key — any angle
maps a foot pixel to a true court position, and the real-line classifier then
gives a corner-accurate 2/3.

## What is built + unit-tested (all pure, offline)

| Module | Role | Tests |
|---|---|---|
| `core/courtModel.ts` | FIBA/NBA specs (arc, corner, junction) + landmark court coords | via others |
| `core/threePointLine.ts` | the REAL line classifier (arc + corner cutoffs) + signed margin | 13 |
| `core/courtHomography.ts` | normalized-DLT image→court solver (exact 4-pt, LS N>4) + apply | 8 |
| `core/courtRegistration.ts` | foot px → court m → corner-accurate 2/3, with an implausibility bail | 6 |
| `core/courtCalibration.ts` | the tap-ritual engine: collect 5 landmarks, solve, reproject-validate | 7 |
| `components/hud/overlayMapping.ts` | `mapViewToAnalysis` — tap→analysis-px inverse (round-trip) | +2 |

Wired as the **top-priority** 2/3 source in `shotPipeline` (above metric, above
heuristic) when a registration + shooter foot exist; **null → the existing path
is byte-identical** (no regression).

## The calibration ritual (shipped, needs on-device tap-accuracy check)

`components/hud/CourtCalibrationOverlay.tsx` + `state/courtCalibrationStore.ts`:
a "Calibrate court" bottom-bar chip freezes nothing (the tripod camera is
static) and asks the user to tap five landmarks — the hoop, both spots where the
3-point line meets the baseline, the top of the arc, and the FT-line center.
Five (not the minimal four) makes the solve **overdetermined**, so a mis-tap
shows up as reprojection error and is rejected. **Re-aim clears the
registration** — a moved camera invalidates the homography.

## Auto court-line detection — design for the device phase

**Not built:** this is on-device computer vision that needs real court footage to
develop and validate; it cannot be built blind. The design:

1. **Key insight — only YAW is missing.** The pinhole solve (`courtGeometric`)
   already recovers scale, camera height, and pitch from the rim ruler. The one
   thing it can't get is the court's rotation about vertical (which way the
   baseline runs). Auto-detection's real job is to recover that yaw.
2. **Minimal auto:** detect ONE strong court line (baseline or a lane line) via
   Canny→Hough on the locked frame; its direction fixes the yaw. Combined with
   the pinhole scale/height, that yields a full homography with **zero taps**.
3. **Full auto:** detect several lines + the 3-pt arc (ellipse fit), take their
   intersections as candidate landmarks, and RANSAC-match them to the court
   model → homography. More robust, more compute.
4. **Plug-in point:** whatever the detector produces, it becomes
   `Correspondence[]` fed to the *already-built + tested* `solveHomography`, and
   the result is a `CourtRegistration` the pipeline already consumes. So the
   device phase only needs the detector — the geometry is done.
5. **Fallback ladder:** auto → if low-confidence, offer the tap ritual → if
   skipped, the metric/heuristic radial estimators. Always a safe path.

**Risks:** faint/painted-over/absent lines, wood-grain false edges, occlusion,
low light. A court-line **segmentation model** (sports-field registration nets)
is the robust long-term answer but needs a labeled dataset. The tap ritual is
the reliable path that works on every court **today**.
