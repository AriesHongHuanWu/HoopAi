/**
 * ftSeed — free-throw-anchored COURT POSITIONING for the metric 2/3 estimator.
 *
 * One user-asserted free throw gives one known court point: the shooter stood
 * at court (0, ftLineDistanceM). The metric estimator (courtGeometric.ts)
 * already solves the full camera-ground geometry per shot — depth to the rim,
 * depth to the feet, and BOTH lateral offsets — so the anchor's rim-relative
 * camera-ground coordinates (u_a, v_a) pin the two unknowns of the ground-plane
 * similarity transform camera → court:
 *
 *   scale s = ftLineDistanceM / hypot(u_a, v_a)   (the existing FT-calibration
 *                                                  correctionFactor, reused
 *                                                  verbatim from ftCalibration)
 *   yaw  β = atan2(u_a, v_a)                       (camera heading relative to
 *                                                  the court's +Y axis)
 *
 * Per shot thereafter: p_court = s · R(β) · (u, v) → the TRUE corner-aware
 * 3-point line (threePointLine.ts), instead of a single radial threshold.
 * The court-frame X convention matches court registration's image-anchored
 * one (+X ≈ image-right for a camera facing the basket from up-court); a
 * mirrored X cannot change the 2/3 call because classifyCourtPoint uses |x|.
 *
 * IRON RULES (enforced by construction, pinned by tests):
 *   1. POSITION/VALUE ONLY, NEVER OUTCOME. Nothing here reads or writes
 *      make/miss signals; the seed re-labels value/position of shots the
 *      metric path already produced. It can never fabricate a make.
 *   2. REFINES, NEVER GATES. Every reject/null return leaves the default
 *      (metric/heuristic) path byte-identical — a seed can only improve the
 *      2/3 label of an estimate that already exists, never enable, veto, or
 *      block one. The ball-size cap is SHRINK-ONLY (see below).
 *   3. HONEST CONFIDENCE. A single-anchor transform is not a court
 *      registration: ftSeed confidence is capped at 0.75 (medium — 'high'
 *      ≥ 0.8 stays reserved for court registration, see evidence.ts), and the
 *      plain metric distance confidence is capped at 0.7 below that.
 *
 * Pure TS: no I/O, no clocks, no randomness. Unit-tested with synthetic
 * pinhole scenes (same family as courtGeometric/ftCalibration tests).
 */
import { COURT, DETECTION } from './config';
import { estimateShotValueMetric, type MetricShotEstimate } from './courtGeometric';
import type { CourtSpec } from './courtModel';
import {
  deriveFtCalibration,
  type FtAnchor,
  type FtCalibrationRejectReason,
  type FtDistanceCalibration,
} from './ftCalibration';
import { classificationConfidence, classifyCourtPoint } from './threePointLine';
import type { RimGeometry, ShotValue } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Confidence ceiling for an ftSeed 2/3 call. Deliberately BELOW the 0.8
 * 'high' tier boundary (evidence.ts): one anchor point can never earn the
 * badge a full court registration earns.
 */
export const FT_SEED_MAX_CONFIDENCE = 0.75;

/**
 * Confidence ceiling for a plain (un-seeded) metric distanceM 2/3 call —
 * below the ftSeed cap, above nothing: it fixes the "Measured with no
 * confidence" gap without ever outranking better provenance.
 */
export const METRIC_MAX_CONFIDENCE = 0.7;

/**
 * Confidence saturation band for the metric radial margin, meters. Wider than
 * threePointLine's 0.6 default because the focal-length prior dominates the
 * metric estimator's error (±20% f moves distance ±10-20%, courtGeometric.ts)
 * — the same margin should read LESS decisive here than on a court-registered
 * position.
 */
const METRIC_CONFIDENCE_BAND_M = 0.9;

/**
 * Sanity bounds mirroring courtRegistration.ts: a mapped point absurdly far
 * or well behind the baseline means a bad foot / wrong person / far half —
 * bail to null so the caller falls through to the plain metric label.
 */
const MAX_PLACE_DISTANCE_M = 15;
const MAX_BEHIND_BASELINE_M = 3;

/**
 * Ball-size cap heuristic: the ball may plausibly come this much closer to
 * the camera than the rim depth (× the anchor's near-side geometry), so its
 * on-screen size may grow by the same ratio over its expected size at the rim.
 */
const NEAREST_DEPTH_RATIO = 2;
/** Headroom multiplier on the largest expected ball size (keeps real balls). */
const CAP_HEADROOM = 2.5;
/** Absolute floor for the session cap — never tighter than this fraction. */
const MIN_CAP_FRAC = 0.08;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** An accepted free-throw anchor: the full camera→court ground transform. */
export interface FtSeed {
  /** Scale s — the FT-calibration correction factor, reused verbatim. */
  correctionFactor: number;
  /** The anchor's uncalibrated metric estimate, meters (diagnostics). */
  uncalibratedM: number;
  /** Camera heading relative to the court's +Y axis, radians. */
  yawRad: number;
  /**
   * Rim box width at anchor time, analysis px — the staleness sentinel: a
   * live rim width drifting far from this means the camera moved and the
   * transform no longer holds (the pipeline clears the seed).
   */
  anchorRimWidthPx: number;
  /** Rulebook the seed classifies against (FIBA default, NBA-ready). */
  spec: CourtSpec;
}

export type FtSeedResult =
  | { ok: true; seed: FtSeed; calibration: FtDistanceCalibration }
  | { ok: false; reason: FtCalibrationRejectReason };

/** An ftSeed-placed shot: court position + corner-aware 2/3 call. */
export interface FtSeedEstimate {
  value: ShotValue;
  /** Court-plane position, meters, basket origin (courtModel frame). */
  courtX: number;
  courtY: number;
  /** Ground distance shooter → basket point, meters (= hypot(x, y)). */
  distanceM: number;
  /** Which part of the 3-point line decided it. */
  region: 'corner' | 'arc';
  /** Signed distance to the line, meters (+ = beyond, a 3). */
  marginM: number;
  /** 0..1, capped at {@link FT_SEED_MAX_CONFIDENCE} — never 'high'. */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Derive the full FT seed (scale + yaw) from a captured FT anchor, or reject
 * with the same reasons as the plain FT calibration. deriveFtCalibration is
 * the single source of truth for the accept band and the scale factor; this
 * only adds the yaw read off the anchor's camera-ground geometry.
 *
 * Rejection is always safe: the caller keeps the default estimation path,
 * which must remain byte-identical (iron rule 2).
 */
export function deriveFtSeed(anchor: FtAnchor, spec: CourtSpec): FtSeedResult {
  const cal = deriveFtCalibration(anchor);
  if (!cal.ok) return { ok: false, reason: cal.reason };

  // Re-run the EXACT per-shot estimator on the anchor, uncalibrated, to read
  // the geometry the factor was derived from (deriveFtCalibration just ran
  // this same pure call and accepted it, so est is non-null in practice; the
  // defensive reject keeps the contract airtight).
  const est = estimateShotValueMetric({
    rimBox: anchor.rim.box,
    footX: anchor.footPx.x,
    footY: anchor.footPx.y,
    frameSize: anchor.frameSize,
    pitchDeg: anchor.pitchDeg,
    ...(anchor.focalPx !== undefined ? { focalPx: anchor.focalPx } : {}),
    ...(anchor.rimHeightM !== undefined ? { rimHeightM: anchor.rimHeightM } : {}),
  });
  if (est == null) return { ok: false, reason: 'no-metric-estimate' };

  // Anchor in the rim-relative camera-ground frame: u = lateral (+image-right),
  // v = rim depth − feet depth (+ = shooter on the camera side of the rim).
  const u = est.lateralM;
  const v = est.zRimM - est.zFeetM;

  return {
    ok: true,
    seed: {
      correctionFactor: cal.calibration.correctionFactor,
      uncalibratedM: cal.calibration.uncalibratedM,
      yawRad: Math.atan2(u, v),
      anchorRimWidthPx: anchor.rim.box.width,
      spec,
    },
    calibration: cal.calibration,
  };
}

// ---------------------------------------------------------------------------
// Per-shot classification
// ---------------------------------------------------------------------------

/**
 * Map a metric shot estimate onto the court plane through the seed and
 * classify it against the TRUE (corner-aware) 3-point line. Null on any
 * sanity bail — the caller falls through to the plain metric/heuristic label
 * (iron rule 2: this only re-labels shots the metric path already accepted).
 *
 * Math (the anchor itself maps to (0, +ftLineDistanceM) by construction):
 *   x = s · (u·cosβ − v·sinβ),  y = s · (u·sinβ + v·cosβ)
 */
export function classifyByFtSeed(
  seed: FtSeed,
  est: MetricShotEstimate,
): FtSeedEstimate | null {
  const u = est.lateralM;
  const v = est.zRimM - est.zFeetM;
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;

  const cosB = Math.cos(seed.yawRad);
  const sinB = Math.sin(seed.yawRad);
  const x = seed.correctionFactor * (u * cosB - v * sinB);
  const y = seed.correctionFactor * (u * sinB + v * cosB);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  const distanceM = Math.hypot(x, y);
  if (distanceM > MAX_PLACE_DISTANCE_M) return null;
  // y < 0 is behind the basket point; deeply behind the baseline is impossible.
  if (y < -MAX_BEHIND_BASELINE_M) return null;

  const cls = classifyCourtPoint(x, y, seed.spec);
  return {
    value: cls.value,
    courtX: x,
    courtY: y,
    distanceM,
    region: cls.region,
    marginM: cls.marginM,
    confidence: Math.min(
      FT_SEED_MAX_CONFIDENCE,
      classificationConfidence(cls.marginM),
    ),
  };
}

/**
 * Confidence for a plain metric-path 2/3 call from its radial distance —
 * the margin against the arc radius on a WIDER saturation band than court
 * positions get (the focal prior dominates the error), capped at
 * {@link METRIC_MAX_CONFIDENCE} so 'metric' can never read as 'high' tier.
 * Non-finite input returns the 0.5 floor (an honest "coin-flip-plus" label).
 */
export function metricValueConfidence(distanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0.5;
  return Math.min(
    METRIC_MAX_CONFIDENCE,
    classificationConfidence(
      distanceM - COURT.threePtDistanceM,
      METRIC_CONFIDENCE_BAND_M,
    ),
  );
}

// ---------------------------------------------------------------------------
// Detection-accuracy dividend: session ball-size cap
// ---------------------------------------------------------------------------

/**
 * Session cap (fraction of the frame side) for the ball detector's max-size
 * reject, derived from the anchored scene scale: the expected ball width at
 * rim depth is rimWidthPx · (ballDiamM / rimDiameterM); the ball plausibly
 * comes {@link NEAREST_DEPTH_RATIO}× closer than the rim, and we keep
 * {@link CAP_HEADROOM}× headroom on top, floored at {@link MIN_CAP_FRAC}.
 *
 * SHRINK-ONLY by construction (min with DETECTION.ballMaxSizeFraction) — and
 * BallTracker.setSessionBallSizeCap enforces the same min again, so this can
 * only REMOVE oversized candidates, never admit new ones or score/arm
 * anything (iron rule: removing candidates cannot fabricate a make).
 *
 * `ballDiamM` comes from config BALL_SIZES_M (the user's ball size setting).
 * Null (= no cap, keep the default) when the inputs can't support the math.
 */
export function ftSeedBallSizeCapFrac(
  seed: FtSeed,
  rim: RimGeometry,
  frameWidth: number,
  ballDiamM: number,
): number | null {
  if (!(seed.correctionFactor > 0)) return null;
  if (!(rim.box.width > 0)) return null;
  if (!(frameWidth > 0)) return null;
  if (!Number.isFinite(ballDiamM) || ballDiamM <= 0) return null;

  const expectedAtRimPx = rim.box.width * (ballDiamM / COURT.rimDiameterM);
  const maxExpectedFrac = (expectedAtRimPx * NEAREST_DEPTH_RATIO) / frameWidth;
  return Math.min(
    DETECTION.ballMaxSizeFraction,
    Math.max(MIN_CAP_FRAC, CAP_HEADROOM * maxExpectedFrac),
  );
}
