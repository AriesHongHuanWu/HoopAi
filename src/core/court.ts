/**
 * Automatic 2/3-point estimation — "AI marks rim + shooter, distance estimated".
 *
 * There is NO manual court calibration. The trained detector already gives us
 * (a) the rim bounding box and (b) the shooter's foot position (person-box foot
 * midpoint, normalized 0..1 in {@link ResolvedShot.originX}/originY). This
 * module turns those into an estimated point value.
 *
 * METHOD (pragmatic — every result is an ESTIMATE)
 * ------------------------------------------------
 * The detected rim box WIDTH in pixels is a real-world scale reference: a
 * regulation rim is ~0.45 m across (COURT.rimDiameterM). We measure the
 * shooter's ground distance to the point directly under the rim IN THE IMAGE
 * PLANE — from the de-normalized foot position to the rim center — and express
 * it in "rim widths" (distancePx / rimWidthPx). A shot is classified as a 3
 * when that distance meets/exceeds a threshold (COURT.default3ptRimWidths,
 * exported as DEFAULT_3PT_RIMWIDTHS in config.ts; per-session adjustable via
 * {@link adjust3ptThreshold}).
 *
 * CAVEATS (why it's an estimate, not a measurement):
 *   - Image-plane distance is foreshortened by camera angle/perspective; we do
 *     not unproject to the floor plane.
 *   - A missing originY (foot y unknown) removes our vertical cue, so we fall
 *     back to horizontal distance only and drop the confidence.
 *   - A null origin (no person tracked) can't be placed at all ⇒ value 2,
 *     confidence 0.
 *
 * Pure: no I/O, no wall-clock. Coordinates are analysis-frame pixels (+y DOWN),
 * consistent with the rest of the pipeline (see types.ts).
 */
import { COURT } from './config';
import type { RimGeometry, ShotValue } from './types';

export type { ShotValue } from './types';

/** Result of a single 2/3-point estimate. */
export interface ShotValueEstimate {
  /** Estimated point value. */
  value: ShotValue;
  /** Shooter's image-plane distance to under-the-rim, in rim widths. */
  distanceRimWidths: number;
  /** 0..1 confidence in the classification (lower when cues are missing). */
  confidence: number;
}

/** Clamp helper (local; geometry.clamp is fine too but keep this module lean). */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Estimate whether a shot was a 2 or a 3.
 *
 * @param rim       Locked rim geometry (its box width is the scale reference).
 * @param originX   Shooter foot x, normalized 0..1, or null (no person).
 * @param originY   Shooter foot y, normalized 0..1, or null (unknown height).
 * @param frame     Analysis-frame dimensions, to de-normalize the origin.
 * @param threshold Rim-width distance at/above which the shot is a 3. Defaults
 *                  to COURT.default3ptRimWidths (DEFAULT_3PT_RIMWIDTHS).
 *
 * Guarantees:
 *   - null originX ⇒ { value: 2, distanceRimWidths: 0, confidence: 0 }.
 *   - Degenerate rim width (≤ 0) ⇒ same safe fallback (can't build a scale).
 *   - Missing originY ⇒ horizontal-only distance, confidence halved.
 */
export function estimateShotValue(
  rim: RimGeometry,
  originX: number | null,
  originY: number | null,
  frame: { width: number; height: number },
  threshold: number = COURT.default3ptRimWidths,
): ShotValueEstimate {
  const rimWidthPx = rim.box.width;
  // No shooter, or no usable scale ⇒ can't estimate. Default to a 2.
  if (originX === null || rimWidthPx <= 0 || frame.width <= 0) {
    return { value: 2, distanceRimWidths: 0, confidence: 0 };
  }

  // De-normalize the shooter foot to analysis-frame pixels.
  const footX = originX * frame.width;
  const haveY = originY !== null && frame.height > 0;
  const footY = haveY ? (originY as number) * frame.height : rim.cy;

  // Ground distance to the point under the rim, in the image plane.
  const dx = footX - rim.cx;
  const dy = footY - rim.cy;
  const distancePx = haveY ? Math.hypot(dx, dy) : Math.abs(dx);
  const distanceRimWidths = distancePx / rimWidthPx;

  const value: ShotValue = distanceRimWidths >= threshold ? 3 : 2;

  // Confidence: how decisively the distance sits on one side of the threshold,
  // scaled by how far it is from the boundary (a band of ~half the threshold
  // reaches full confidence). Missing originY halves it.
  const margin = Math.abs(distanceRimWidths - threshold);
  const band = Math.max(threshold * 0.5, 1);
  let confidence = clamp(margin / band, 0, 1);
  // Floor so a clean classification isn't reported as near-zero confidence.
  confidence = clamp(0.5 + confidence * 0.5, 0.5, 1);
  if (!haveY) confidence *= 0.5;

  return { value, distanceRimWidths, confidence };
}

/**
 * Clamp a proposed per-session 3-point threshold (rim widths) into the sane
 * band from config. Sessions can nudge this up/down (e.g. after eyeballing a
 * few shots) without touching the global default.
 */
export function adjust3ptThreshold(rimWidths: number): number {
  if (!Number.isFinite(rimWidths)) return COURT.default3ptRimWidths;
  return clamp(rimWidths, COURT.min3ptRimWidths, COURT.max3ptRimWidths);
}
