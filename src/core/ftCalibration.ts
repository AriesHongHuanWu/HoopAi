/**
 * ftCalibration — OPTIONAL free-throw-line calibration for the metric 2/3
 * estimator (courtGeometric.ts).
 *
 * Zero-friction positioning is the product rule: the rim's known 0.45 m width
 * stays the DEFAULT ruler and works untouched when the user skips this. When
 * the user chooses to stand at the free-throw line for a moment, we get one
 * known ground-truth distance — the FT line is 4.19 m (15 ft from the
 * backboard; rim center 0.375 m + 1.575 m inside) from the rim center's floor
 * projection — and can solve for the metric estimator's residual scale error
 * (dominated by the focal-length prior, ±20% f moves distance ±10-20%):
 *
 *   correctionFactor = 4.19 / estimatedM(footAtLine)
 *
 * The factor multiplies the estimator's distanceM before the 2/3 threshold.
 * DESIGN RULE: calibration only ever REFINES distance for 2/3 classification;
 * it never gates shots and never blocks a session — every reject here simply
 * means "keep the uncalibrated default".
 *
 * Pure TS: no I/O, no clocks. Unit-testable with the same synthetic pinhole
 * scenes as courtGeometric.
 */
import { estimateShotValueMetric } from './courtGeometric';
import type { RimGeometry } from './types';

/**
 * FT line → rim-center floor projection, meters. 15 ft (4.572 m) from the
 * backboard minus the rim's inset (0.375 m overhang + backboard offset), i.e.
 * ~4.191 m — rounded to the value the whole feature is specced on.
 */
export const FT_LINE_DISTANCE_M = 4.19;

/**
 * Acceptance band for the UNCALIBRATED estimate of the FT-line anchor, meters.
 * A foot the estimator already places wildly off the plausible FT range means
 * the anchor itself is bad (wrong person latched, mid-walk capture, degenerate
 * geometry) — deriving a "correction" from it would poison every later call.
 */
const ACCEPT_RANGE_M: readonly [number, number] = [2, 9];

/** One captured FT-line anchor: where the shooter stood, against which rim. */
export interface FtAnchor {
  /** Shooter's foot midpoint (median over the capture window), analysis px. */
  footPx: { x: number; y: number };
  /** The locked rim geometry the anchor was captured against. */
  rim: RimGeometry;
  /** Analysis frame size (square side, e.g. 640) — same as MetricShotInput. */
  frameSize: number;
  /** IMU camera pitch at capture, degrees +up. Null → assume level (0°). */
  pitchDeg: number | null;
  /**
   * Focal prior override in analysis px (tests). MUST match what the per-shot
   * estimator uses, or the derived factor corrects the wrong quantity — the
   * pipeline leaves this unset on both sides so they share the default prior.
   */
  focalPx?: number;
}

/** A derived, accepted calibration. */
export interface FtDistanceCalibration {
  /** Multiplier applied to the metric estimator's distanceM (before 2/3). */
  correctionFactor: number;
  /** The uncalibrated FT-anchor estimate that produced it (diagnostics). */
  uncalibratedM: number;
}

export type FtCalibrationRejectReason =
  /** Anchor fields non-finite / foot outside the analysis square. */
  | 'invalid-anchor'
  /** The metric estimator's own gates refused the anchor scene (rim too
   *  small/far, feet at/above horizon, implausible camera height…). */
  | 'no-metric-estimate'
  /** Estimator ran but placed the "FT line" outside [2, 9] m — bad anchor. */
  | 'estimate-out-of-range';

export type FtCalibrationResult =
  | { ok: true; calibration: FtDistanceCalibration }
  | { ok: false; reason: FtCalibrationRejectReason };

/**
 * Derive the distance correction from a captured FT-line anchor, or reject it
 * with a reason. Rejection is always safe — callers keep the uncalibrated
 * default path, which must remain byte-identical.
 */
export function deriveFtCalibration(anchor: FtAnchor): FtCalibrationResult {
  const { footPx, rim, frameSize } = anchor;
  if (
    !Number.isFinite(footPx.x) ||
    !Number.isFinite(footPx.y) ||
    !Number.isFinite(frameSize) ||
    frameSize <= 0 ||
    footPx.x < 0 ||
    footPx.x > frameSize ||
    footPx.y < 0 ||
    footPx.y > frameSize ||
    !(rim.box.width > 0)
  ) {
    return { ok: false, reason: 'invalid-anchor' };
  }

  // Run the EXACT per-shot estimator on the anchor, so the derived factor
  // corrects precisely the quantity later shots will report (same focal
  // prior, same rim/pitch gates).
  const est = estimateShotValueMetric({
    rimBox: rim.box,
    footX: footPx.x,
    footY: footPx.y,
    frameSize,
    pitchDeg: anchor.pitchDeg,
    ...(anchor.focalPx !== undefined ? { focalPx: anchor.focalPx } : {}),
  });
  if (est == null) return { ok: false, reason: 'no-metric-estimate' };
  if (est.distanceM < ACCEPT_RANGE_M[0] || est.distanceM > ACCEPT_RANGE_M[1]) {
    return { ok: false, reason: 'estimate-out-of-range' };
  }

  // Inside the band the factor is bounded to [4.19/9, 4.19/2] ≈ [0.47, 2.1]
  // by construction — no separate plausibility clamp needed.
  return {
    ok: true,
    calibration: {
      correctionFactor: FT_LINE_DISTANCE_M / est.distanceM,
      uncalibratedM: est.distanceM,
    },
  };
}

/**
 * Component-wise median of foot samples (analysis px) — the anchor builder's
 * noise filter. The shooter is standing still at the line, so the median
 * shrugs off the odd mis-latched person box / flickering ankle keypoint that
 * a mean would smear into the anchor. Null for an empty sample set.
 */
export function medianFootPoint(
  points: readonly { x: number; y: number }[],
): { x: number; y: number } | null {
  if (points.length === 0) return null;
  const xs = points.map((p) => p.x).sort((a, b) => a - b);
  const ys = points.map((p) => p.y).sort((a, b) => a - b);
  return { x: median(xs), y: median(ys) };
}

/** Median of a pre-sorted array (mean of the two central values when even). */
function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
