/**
 * threePointLine — the REAL 3-point line, not a circle.
 *
 * The single biggest 2/3 error in a distance-only classifier is treating the
 * 3-point line as one radius. It isn't: it's an ARC of `arcRadiusM` from the
 * basket that FLATTENS into two straight lines in the corners at the shorter
 * `cornerDistanceM`. So a corner shooter can be CLOSER than the arc radius yet
 * still behind the line — a legitimate 3 that a radial threshold calls a 2.
 *
 * Given a shooter's position on the court plane (meters, basket at the origin,
 * frame per {@link module:courtModel}), this classifies 2 vs 3 against the
 * actual line, with a signed margin (how far beyond/inside the line) for
 * confidence and hysteresis.
 *
 * Pure + exact — unit-tested against hand-derived geometry, including the
 * corner cases the radial method gets wrong. Requires COURT-ALIGNED coordinates
 * (from a homography); it deliberately does NOT accept raw camera coordinates,
 * because corner-vs-wing cannot be told apart without knowing court orientation.
 */
import { cornerJunctionY, type CourtSpec } from './courtModel';
import type { ShotValue } from './types';

export interface ThreePointClassification {
  value: ShotValue;
  isThree: boolean;
  /** Which part of the line decided it. */
  region: 'corner' | 'arc';
  /**
   * Signed distance to the line, meters: positive = beyond the line (a 3),
   * negative = inside it (a 2), ~0 = right on the line. Its magnitude drives
   * confidence and a hysteresis band so a borderline shot doesn't flicker.
   */
  marginM: number;
}

/**
 * Classify a court-plane point (x = along baseline, y = into court, meters,
 * basket at origin) as a 2 or a 3 against the true line for `spec`.
 *
 * In the corner band (y at/below where the corner line meets the arc) the
 * boundary is the straight line |x| = cornerDistance; beyond it, the arc.
 */
export function classifyCourtPoint(
  x: number,
  y: number,
  spec: CourtSpec,
): ThreePointClassification {
  const ax = Math.abs(x);
  const junctionY = cornerJunctionY(spec);

  if (y <= junctionY) {
    // Corner column: the flattened straight line at |x| = cornerDistance.
    const marginM = ax - spec.cornerDistanceM;
    const isThree = marginM >= 0;
    return { value: isThree ? 3 : 2, isThree, region: 'corner', marginM };
  }

  // Above the corners: the circular arc.
  const r = Math.hypot(x, y);
  const marginM = r - spec.arcRadiusM;
  const isThree = marginM >= 0;
  return { value: isThree ? 3 : 2, isThree, region: 'arc', marginM };
}

/**
 * A 0..1 confidence that mirrors the heuristic estimator's shape: how
 * decisively the point sits on one side of the line, saturating to full
 * confidence about `bandM` meters clear of it, floored at 0.5 for any clean
 * call so a confident classification never reads as near-zero.
 */
export function classificationConfidence(marginM: number, bandM = 0.6): number {
  const c = Math.min(1, Math.abs(marginM) / Math.max(bandM, 0.01));
  return Math.min(1, Math.max(0.5, 0.5 + c * 0.5));
}
