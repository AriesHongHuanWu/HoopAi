/**
 * courtGeometric — METRIC 2/3-point estimation from pinhole geometry, using
 * the rim as a real-world ruler. Replaces the image-plane "rim widths"
 * heuristic (court.ts) whenever it can run confidently; falls back otherwise.
 *
 * THE GEOMETRY (+y down, camera pitch θ positive = tilted up):
 *   - Rim depth from its known diameter:  Z_rim = f · 0.45 / w_rim_px
 *   - A pixel row's world elevation angle: α(y) = atan((cy_img − y)/f) + θ
 *   - Camera height from the rim anchor (rim center sits at 3.05 m):
 *       h_cam = 3.05 − Z_rim · tan(α(y_rim))
 *   - Shooter's feet are ON THE FLOOR (height 0), so their ray pins depth:
 *       Z_feet = h_cam / tan(−α(y_feet))        (feet must be below horizon)
 *   - Lateral offsets: X(x, Z) = (x − cx_img) · Z / f
 *   - Ground distance shooter → hoop base:
 *       d = hypot(Z_feet − Z_rim, X_feet − X_rim)
 *
 * f (focal length in analysis px) comes from a prior (COURT.focalPxDefault,
 * clamped) — a ±20% f error moves d by roughly ±10-20% depending on layout,
 * which the confidence gates + hysteresis absorb for the 2-vs-3 CALL even
 * when the meter value is imperfect. Pure TS, unit-testable with synthetic
 * pinhole scenes where ground truth is exact.
 */
import { COURT, DEPTH_GATE } from './config';
import type { Box, ShotValue } from './types';

export interface MetricShotInput {
  /** Locked rim box, analysis px. */
  rimBox: Box;
  /** Shooter's feet (pose-ankle midpoint or person-box bottom), analysis px. */
  footX: number;
  footY: number;
  /** Analysis frame size (square side, e.g. 640). */
  frameSize: number;
  /** Camera pitch at rim lock, degrees, +up. Null → assume level (0°). */
  pitchDeg: number | null;
  /** Focal length prior in analysis px (default COURT/DEPTH_GATE prior). */
  focalPx?: number;
}

export interface MetricShotEstimate {
  value: ShotValue;
  /** Ground distance shooter → hoop base, meters. */
  distanceM: number;
  /** Diagnostics for telemetry/debug. */
  zRimM: number;
  zFeetM: number;
  camHeightM: number;
}

/** Rim center height above the floor, meters (regulation). */
const RIM_HEIGHT_M = 3.05;
/** Enablement floors/sanity bounds — outside them return null (fallback). */
const MIN_RIM_WIDTH_PX = 30;
const MIN_FEET_BELOW_HORIZON_DEG = 2;
const CAM_HEIGHT_RANGE_M: readonly [number, number] = [0.05, 3.2];
const Z_RIM_RANGE_M: readonly [number, number] = [2, 25];
const Z_FEET_RANGE_M: readonly [number, number] = [0.5, 30];

const DEG = Math.PI / 180;

/**
 * Metric estimate of the shot's 2/3 value, or null when the scene geometry
 * can't support a confident answer (caller falls back to the heuristic).
 */
export function estimateShotValueMetric(input: MetricShotInput): MetricShotEstimate | null {
  const { rimBox, footX, footY, frameSize, pitchDeg } = input;
  const f = Math.min(
    1400,
    Math.max(500, input.focalPx ?? DEPTH_GATE.focalPxDefault),
  );
  const c = frameSize / 2; // optical center of the letterboxed square
  const theta = (pitchDeg ?? 0) * DEG;

  const wRim = rimBox.width;
  if (!(wRim >= MIN_RIM_WIDTH_PX)) return null;

  // Rim depth + camera height from the 0.45 m / 3.05 m anchors.
  const zRim = (f * COURT.rimDiameterM) / wRim;
  if (zRim < Z_RIM_RANGE_M[0] || zRim > Z_RIM_RANGE_M[1]) return null;
  const yRim = rimBox.y + rimBox.height / 2;
  const alphaRim = Math.atan((c - yRim) / f) + theta;
  const camH = RIM_HEIGHT_M - zRim * Math.tan(alphaRim);
  if (camH < CAM_HEIGHT_RANGE_M[0] || camH > CAM_HEIGHT_RANGE_M[1]) return null;

  // Feet ray must point meaningfully below the horizon.
  const alphaFeet = Math.atan((c - footY) / f) + theta;
  if (alphaFeet > -MIN_FEET_BELOW_HORIZON_DEG * DEG) return null;
  const zFeet = camH / Math.tan(-alphaFeet);
  if (
    !Number.isFinite(zFeet) ||
    zFeet < Z_FEET_RANGE_M[0] ||
    zFeet > Z_FEET_RANGE_M[1]
  ) {
    return null;
  }

  // Lateral offsets at each depth, then the planar ground distance.
  const xRim = ((rimBox.x + rimBox.width / 2 - c) * zRim) / f;
  const xFeet = ((footX - c) * zFeet) / f;
  const d = Math.hypot(zFeet - zRim, xFeet - xRim);
  if (!Number.isFinite(d) || d < 0.3 || d > 30) return null;

  return {
    value: d >= COURT.threePtDistanceM ? 3 : 2,
    distanceM: d,
    zRimM: zRim,
    zFeetM: zFeet,
    camHeightM: camH,
  };
}
