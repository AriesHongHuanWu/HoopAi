/**
 * courtRegistration — the top-tier 2/3 source: a calibrated image→court
 * homography that turns a foot pixel into a true court position, then a
 * corner-accurate 2/3 via the real 3-point line.
 *
 * This is what beats a distance-only classifier: because the homography encodes
 * the full camera↔court perspective, it works from ANY placement (side-on,
 * baseline, top) and it knows the difference between a corner and a wing — so
 * corner 3s stop being mis-scored. A registration is optional: with none, the
 * pipeline keeps its metric→heuristic fallbacks unchanged.
 *
 * Pure: the homography + spec come from a calibration ritual or auto court-line
 * detection; this module only consumes them. Unit-testable end to end.
 */
import { applyHomography, type Homography } from './courtHomography';
import { classificationConfidence, classifyCourtPoint } from './threePointLine';
import type { CourtSpec } from './courtModel';
import type { ShotValue } from './types';

export interface CourtRegistration {
  /** Image(analysis px) → court(meters) homography. */
  homography: Homography;
  /** Which rulebook's 3-point line to classify against. */
  spec: CourtSpec;
}

export interface RegistrationEstimate {
  value: ShotValue;
  /** Shooter's court-plane position (meters, basket origin). */
  courtX: number;
  courtY: number;
  /** Radial ground distance to the basket point, meters. */
  distanceM: number;
  /** Which part of the 3-point line decided it. */
  region: 'corner' | 'arc';
  /** Signed meters beyond (+) / inside (−) the line. */
  marginM: number;
  /** 0.5..1 confidence from how clear of the line the shot is. */
  confidence: number;
}

/**
 * Sanity bound: a foot that maps well behind the baseline or absurdly far is a
 * bad tap / mis-detected foot / a shot from the far half — none of which this
 * registration can place, so we bail to the fallback rather than emit a wrong
 * call. Deep legitimate 3s (~9 m) stay comfortably inside.
 */
const MAX_PLACE_DISTANCE_M = 15;
const MAX_BEHIND_BASELINE_M = 3;

/**
 * Classify a shot's 2/3 from a court registration and the shooter's foot pixel
 * (analysis-frame px, same space the homography was calibrated in). Returns
 * null when the mapped position is implausible — caller falls back.
 */
export function classifyByRegistration(
  reg: CourtRegistration,
  footX: number,
  footY: number,
): RegistrationEstimate | null {
  if (!Number.isFinite(footX) || !Number.isFinite(footY)) return null;
  const pt = applyHomography(reg.homography, footX, footY);
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;

  const distanceM = Math.hypot(pt.x, pt.y);
  if (distanceM > MAX_PLACE_DISTANCE_M) return null;
  // y < 0 is behind the basket point; deeply behind the baseline is impossible.
  if (pt.y < -MAX_BEHIND_BASELINE_M) return null;

  const cls = classifyCourtPoint(pt.x, pt.y, reg.spec);
  return {
    value: cls.value,
    courtX: pt.x,
    courtY: pt.y,
    distanceM,
    region: cls.region,
    marginM: cls.marginM,
    confidence: classificationConfidence(cls.marginM),
  };
}
