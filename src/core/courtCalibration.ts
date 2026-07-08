/**
 * courtCalibration — the pure engine behind the "tap the court" ritual.
 *
 * The user freezes a frame and taps a handful of known court landmarks (the
 * hoop, the two spots where the 3-point line meets the baseline, the top of the
 * arc). Each tap pairs an image pixel with a KNOWN court coordinate
 * (courtModel.ts); four of them solve an image→court homography
 * (courtHomography.ts), which becomes a {@link CourtRegistration} the pipeline
 * uses for corner-accurate, placement-agnostic 2/3.
 *
 * This module owns the state machine + validation only — collect taps, know
 * when enough are in, solve, and REJECT a bad calibration (sloppy taps that
 * don't form a consistent court) via reprojection error. Pure + fully
 * unit-testable; the freeze-frame + tap UI lives in the app layer.
 */
import { solveHomography, applyHomography, type Correspondence } from './courtHomography';
import {
  CALIBRATION_LANDMARK_IDS,
  courtLandmarks,
  type CourtSpec,
  type LandmarkId,
} from './courtModel';
import type { CourtRegistration } from './courtRegistration';

/** One placed landmark: which court point, and where it was tapped in the image. */
export interface CalibrationTap {
  landmarkId: LandmarkId;
  /** Analysis-frame pixel the user tapped. */
  image: { x: number; y: number };
}

export interface CalibrationSession {
  spec: CourtSpec;
  /** Taps placed so far (at most one per landmark; a re-tap replaces it). */
  taps: readonly CalibrationTap[];
}

/**
 * Max acceptable mean reprojection error, meters. After solving, each tapped
 * landmark is mapped back through the homography; if the taps don't form a
 * consistent court (mis-taps, wrong landmark, a moved camera mid-ritual) the
 * points won't agree and we reject rather than register a wrong court.
 */
const MAX_REPROJECTION_ERROR_M = 0.5;

export function startCalibration(spec: CourtSpec): CalibrationSession {
  return { spec, taps: [] };
}

/** Place (or replace) the tap for a landmark. Immutable. */
export function withTap(
  session: CalibrationSession,
  landmarkId: LandmarkId,
  image: { x: number; y: number },
): CalibrationSession {
  const taps = session.taps.filter((t) => t.landmarkId !== landmarkId);
  return { ...session, taps: [...taps, { landmarkId, image }] };
}

/** Remove a landmark's tap (e.g. user wants to redo it). Immutable. */
export function withoutTap(session: CalibrationSession, landmarkId: LandmarkId): CalibrationSession {
  return { ...session, taps: session.taps.filter((t) => t.landmarkId !== landmarkId) };
}

/** The landmark ids still needed before a registration can be built. */
export function missingLandmarks(session: CalibrationSession): LandmarkId[] {
  const placed = new Set(session.taps.map((t) => t.landmarkId));
  return CALIBRATION_LANDMARK_IDS.filter((id) => !placed.has(id));
}

/** True once every primary landmark has a tap (enough to solve). */
export function isComplete(session: CalibrationSession): boolean {
  return missingLandmarks(session).length === 0;
}

export type CalibrationReject =
  /** Not all primary landmarks are placed yet. */
  | 'incomplete'
  /** The taps are degenerate (collinear/coincident) — no homography. */
  | 'degenerate'
  /** Solved, but the taps don't agree on a consistent court. */
  | 'high-error';

export type CalibrationResult =
  | { ok: true; registration: CourtRegistration; reprojectionErrorM: number }
  | { ok: false; reason: CalibrationReject };

/**
 * Build correspondences from the taps' known court coordinates, solve the
 * image→court homography, and validate it by reprojection. On success returns
 * a {@link CourtRegistration} ready for the pipeline.
 */
export function buildRegistration(session: CalibrationSession): CalibrationResult {
  if (!isComplete(session)) return { ok: false, reason: 'incomplete' };

  const landmarks = courtLandmarks(session.spec);
  const courtOf = (id: LandmarkId) => landmarks.find((l) => l.id === id)!.court;

  const correspondences: Correspondence[] = session.taps.map((t) => ({
    image: t.image,
    court: courtOf(t.landmarkId),
  }));

  const H = solveHomography(correspondences);
  if (!H) return { ok: false, reason: 'degenerate' };

  // Reprojection check: map each tapped pixel back to the court and compare to
  // the landmark's true coordinate. A consistent calibration agrees tightly.
  let sumErr = 0;
  for (const c of correspondences) {
    const p = applyHomography(H, c.image.x, c.image.y);
    if (!p) return { ok: false, reason: 'degenerate' };
    sumErr += Math.hypot(p.x - c.court.x, p.y - c.court.y);
  }
  const reprojectionErrorM = sumErr / correspondences.length;
  if (!(reprojectionErrorM <= MAX_REPROJECTION_ERROR_M)) {
    return { ok: false, reason: 'high-error' };
  }

  return {
    ok: true,
    registration: { homography: H, spec: session.spec },
    reprojectionErrorM,
  };
}
