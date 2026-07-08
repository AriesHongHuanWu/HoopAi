/**
 * courtModel — the half-court's real-world geometry, in METERS, used by the
 * court-registration 2/3 pipeline (threePointLine.ts + courtHomography.ts).
 *
 * COORDINATE FRAME (the "court plane", z = 0 floor):
 *   - Origin = the BASKET POINT: the spot on the floor directly under the rim
 *     center. This is the natural center for the 3-point arc.
 *   - +X runs ALONG the baseline (toward a sideline).
 *   - +Y runs INTO the court (away from the baseline, toward center court).
 *   - The baseline itself sits at Y = -basketFromBaselineM (behind the basket).
 *
 * Everything a shooter needs for a correct 2/3 call lives here as real specs,
 * not pixel heuristics: the 3-point arc radius, the flattened corner distance,
 * and the Y where the corner straight-line meets the arc. Two rulebooks are
 * supported (FIBA is Hoopilot's default; NBA has a deeper, more-flattened arc).
 *
 * Pure data + tiny pure helpers. No I/O, no clocks.
 */

/** Which rulebook's 3-point geometry to classify against. */
export type CourtStandard = 'fiba' | 'nba';

export interface CourtSpec {
  standard: CourtStandard;
  /** 3-point ARC radius from the basket point, meters (top-of-key distance). */
  arcRadiusM: number;
  /**
   * Perpendicular distance from the basket point to each CORNER straight line,
   * meters. Smaller than the arc radius — which is exactly why a corner 3 is
   * closer than a top-of-key 3, and why a single radial threshold mis-calls it.
   */
  cornerDistanceM: number;
  /** Rim center's floor projection → baseline, meters (basket point inset). */
  basketFromBaselineM: number;
  /** Free-throw line → basket point along +Y, meters (a calibration landmark). */
  ftLineDistanceM: number;
}

/**
 * FIBA half-court (Hoopilot default; used across Asia/Europe/international).
 * Arc 6.75 m, corner 6.60 m. Rim center 1.575 m off the baseline.
 */
export const FIBA_COURT: CourtSpec = {
  standard: 'fiba',
  arcRadiusM: 6.75,
  cornerDistanceM: 6.6,
  basketFromBaselineM: 1.575,
  ftLineDistanceM: 4.19,
};

/**
 * NBA half-court. Arc 7.24 m (23'9"), corner 6.70 m (22'). The bigger arc/
 * corner gap is where the single-radial-threshold error is largest.
 */
export const NBA_COURT: CourtSpec = {
  standard: 'nba',
  arcRadiusM: 7.24,
  cornerDistanceM: 6.7,
  basketFromBaselineM: 1.575,
  ftLineDistanceM: 4.19,
};

export const COURT_SPECS: Record<CourtStandard, CourtSpec> = {
  fiba: FIBA_COURT,
  nba: NBA_COURT,
};

/**
 * The +Y at which a corner straight line meets the arc: where the vertical
 * line |X| = cornerDistance intersects the circle of radius arcRadius. Below
 * this Y the boundary is the straight corner line; above it, the arc.
 *
 *   Yj = sqrt(arcRadius² − cornerDistance²)
 */
export function cornerJunctionY(spec: CourtSpec): number {
  const d = spec.arcRadiusM * spec.arcRadiusM - spec.cornerDistanceM * spec.cornerDistanceM;
  return d > 0 ? Math.sqrt(d) : 0;
}

/**
 * A named, human-tappable court landmark and its exact court-plane coordinate.
 * These are the correspondences a calibration ritual collects (tap the point
 * in the frozen frame → we know its metric position → solve the homography).
 */
export interface CourtLandmark {
  id: LandmarkId;
  /** Short instruction shown during the tap ritual. */
  label: string;
  /** Court-plane position, meters, in the frame documented above. */
  court: { x: number; y: number };
}

export type LandmarkId =
  | 'basket'
  | 'cornerThreeLeft'
  | 'cornerThreeRight'
  | 'topOfArc'
  | 'ftCenter';

/**
 * The canonical landmark set for a given rulebook, chosen so the four PRIMARY
 * points (basket + both corner-3s-at-baseline + top of the arc) are always
 * visible, unambiguous to tap, and in general position (no three collinear) —
 * enough for an exact 4-point homography. FT center is an optional 5th for a
 * least-squares refine.
 */
export function courtLandmarks(spec: CourtSpec): CourtLandmark[] {
  const baseY = -spec.basketFromBaselineM;
  return [
    { id: 'basket', label: 'Center of the hoop (on the floor)', court: { x: 0, y: 0 } },
    {
      id: 'cornerThreeLeft',
      label: 'Where the 3-point line meets the baseline (left)',
      court: { x: -spec.cornerDistanceM, y: baseY },
    },
    {
      id: 'cornerThreeRight',
      label: 'Where the 3-point line meets the baseline (right)',
      court: { x: spec.cornerDistanceM, y: baseY },
    },
    { id: 'topOfArc', label: 'Top of the 3-point arc', court: { x: 0, y: spec.arcRadiusM } },
    { id: 'ftCenter', label: 'Center of the free-throw line', court: { x: 0, y: spec.ftLineDistanceM } },
  ];
}

/** The four primary landmarks (exact homography). */
export const PRIMARY_LANDMARK_IDS: readonly LandmarkId[] = [
  'basket',
  'cornerThreeLeft',
  'cornerThreeRight',
  'topOfArc',
];
