/**
 * depthRatioGate — the size-based depth-ratio PARALLAX VETO.
 *
 * THE INSIGHT: pinhole depth from a known size is Z = f·W/w_px, so the RATIO
 * of ball depth to rim depth cancels the focal length entirely:
 *
 *     ratio = Z_ball / Z_rim = (D_ball · w_rim_px) / (W_RIM · d_ball_px)
 *
 * A true make has the ball AT the rim's depth (ratio ≈ 1, within the rim's
 * own ~0.25m physical depth zone). An airball crossing the 2D rim line while
 * flying a meter IN FRONT of the hoop ("bread ball") has ratio < 1; a pass
 * behind the backboard has ratio > 1. No camera intrinsics needed — only the
 * user's ball-size setting and pixel measurements.
 *
 * THE HONEST PART (all thresholds post-adversarial-verification):
 *  - The gate is a VETO ONLY. It may flip geo true→false. It NEVER confirms
 *    a make, never flips miss→make, and below its confidence floor it stays
 *    SILENT. Grazing airballs (< ~0.7-1.8m separation depending on range)
 *    are undetectable and remain owned by net/cls fusion.
 *  - Noise is modeled in log space; the veto fires only beyond a blur-bias
 *    allowance PLUS k·σ, with σ from the ball-radius and rim-width pixel
 *    noise (rim σ widened when the lock looked contaminated).
 *  - Pixel-size floors (rim ≥ 40px, ball ≥ 16px) gate enablement — they
 *    self-select the regimes where the math verifiably discriminates, under
 *    any framing. At 3-pt camera ranges the gate is structurally blind and
 *    says so via `disableReason`.
 *
 * Pure TypeScript, stateless, unit-testable.
 */
import { BALL_SIZES_M, COURT, DEPTH_GATE } from './config';

export type BallSizeSetting = 7 | 6 | 5;

/** View bands (full classifier in viewBand.ts). */
export type ViewBandName =
  | 'side_wing'
  | 'behind_shooter'
  | 'under_hoop'
  | 'overhead'
  | 'elevated_far'
  | 'degraded';

export interface DepthGateInput {
  /** Mean ball diameter over the pre-crossing selection, px. */
  ballDiaPxAvg: number | null;
  /** Surviving real samples behind that average. */
  nRealSamples: number;
  /** Locked rim box width, px. */
  rimWidthPx: number;
  /** Rim lock's box aspect looked contaminated (bracket/net/pad). */
  rimLockContaminated: boolean;
  ballSize: BallSizeSetting;
  viewBand: ViewBandName;
  /** Crossing derived from real (not predicted-only) samples. */
  crossingReal: boolean;
  rimBounce: boolean;
  /** Strong ball_in_basket context (layup-ish) — gate stays out of it. */
  clsStrongContext: boolean;
  /** Focal prior, px — shapes the make zone ONLY, never enters the ratio. */
  fPriorPx?: number;
}

export interface DepthGateResult {
  decision: 'silent' | 'veto_front' | 'veto_behind';
  /** Measured depth ratio (Z_ball/Z_rim); NaN when unmeasurable. */
  ratio: number;
  /** 1σ of ln(ratio) under the noise model. */
  sigmaLn: number;
  /** Make-zone half-width actually used (distance-scaled). */
  zoneHalf: number;
  /** |ln distance| beyond the zone edge, in σ units (diagnostics). */
  snr: number;
  enabled: boolean;
  disableReason?: string;
}

const SILENT = (reason: string, ratio = NaN): DepthGateResult => ({
  decision: 'silent',
  ratio,
  sigmaLn: NaN,
  zoneHalf: NaN,
  snr: 0,
  enabled: false,
  disableReason: reason,
});

/** Bands where the plane-crossing geometry (and thus the veto) is meaningful. */
const GATE_BANDS: readonly ViewBandName[] = ['side_wing', 'behind_shooter'];

/**
 * Single-sample depth consistency for the reappearance corroborator: is THIS
 * ball detection at the rim's depth? Same log-space math as the main gate but
 * with N=1 noise (no averaging) and no view/context gating — the caller (the
 * reappearance test) owns that. Returns 'unknown' below the pixel floors.
 * NO upper size cap by design: the close-front airball renders BIGGEST, and
 * skipping big balls was exactly the verified false-make hole.
 */
export function depthConsistencyAtSample(
  ballDiaPx: number,
  rimWidthPx: number,
  ballSize: BallSizeSetting,
  fPriorPx?: number,
): 'ok' | 'front' | 'behind' | 'unknown' {
  if (
    !Number.isFinite(ballDiaPx) ||
    ballDiaPx < DEPTH_GATE.minBallDiaPx ||
    rimWidthPx < DEPTH_GATE.minRimWidthPx
  ) {
    return 'unknown';
  }
  const ratio =
    (BALL_SIZES_M[ballSize] * rimWidthPx) / (COURT.rimDiameterM * ballDiaPx);
  const sigmaLn = Math.sqrt(
    (DEPTH_GATE.sigmaBallRadiusPx / (ballDiaPx / 2)) ** 2 +
      (DEPTH_GATE.sigmaRimWidthPx / rimWidthPx) ** 2,
  );
  const f = fPriorPx ?? DEPTH_GATE.focalPxDefault;
  const zEst = (f * COURT.rimDiameterM) / rimWidthPx;
  const zoneHalf = Math.min(
    DEPTH_GATE.makeZoneClampHi,
    Math.max(DEPTH_GATE.makeZoneClampLo, DEPTH_GATE.makeZoneScaleM / zEst),
  );
  const threshold = DEPTH_GATE.blurAllowanceLn + DEPTH_GATE.k * sigmaLn;
  if (Math.log((1 - zoneHalf) / ratio) > threshold) return 'front';
  if (Math.log(ratio / (1 + zoneHalf)) > threshold) return 'behind';
  return 'ok';
}

export function depthRatioGate(input: DepthGateInput): DepthGateResult {
  const {
    ballDiaPxAvg,
    nRealSamples,
    rimWidthPx,
    rimLockContaminated,
    ballSize,
    viewBand,
    crossingReal,
    rimBounce,
    clsStrongContext,
  } = input;

  // ---- Enablement floor: every condition must hold or the gate is silent.
  if (!GATE_BANDS.includes(viewBand)) return SILENT(`view band ${viewBand}`);
  if (rimBounce) return SILENT('rim bounce — depth at crossing is chaotic');
  if (clsStrongContext) return SILENT('strong cls context (layup)');
  if (!crossingReal) return SILENT('crossing interpolated from predictions');
  if (rimWidthPx < DEPTH_GATE.minRimWidthPx) {
    return SILENT(`rim ${rimWidthPx.toFixed(0)}px < ${DEPTH_GATE.minRimWidthPx}px floor`);
  }
  if (ballDiaPxAvg == null || !Number.isFinite(ballDiaPxAvg) || ballDiaPxAvg <= 0) {
    return SILENT('no usable pre-crossing ball samples');
  }
  if (ballDiaPxAvg < DEPTH_GATE.minBallDiaPx) {
    return SILENT(`ball ${ballDiaPxAvg.toFixed(1)}px < ${DEPTH_GATE.minBallDiaPx}px floor`);
  }
  if (nRealSamples < DEPTH_GATE.minRealSamples) {
    return SILENT(`only ${nRealSamples} real samples`);
  }

  // ---- The ratio (focal length cancels).
  const dBall = BALL_SIZES_M[ballSize];
  const ratio = (dBall * rimWidthPx) / (COURT.rimDiameterM * ballDiaPxAvg);

  // ---- Noise model, log space.
  const rAvg = ballDiaPxAvg / 2;
  const sigmaR =
    DEPTH_GATE.sigmaBallRadiusPx / DEPTH_GATE.avgNoiseDivisor(nRealSamples);
  const sigmaW = rimLockContaminated
    ? DEPTH_GATE.sigmaRimWidthContaminatedPx
    : DEPTH_GATE.sigmaRimWidthPx;
  const sigmaLn = Math.sqrt(
    (sigmaR / rAvg) ** 2 + (sigmaW / rimWidthPx) ** 2,
  );

  // ---- Distance-scaled make zone (the rim has ~0.25m of physical depth; its
  // angular share shrinks with distance). f prior shapes ONLY this buffer.
  const f = input.fPriorPx ?? DEPTH_GATE.focalPxDefault;
  const zEst = (f * COURT.rimDiameterM) / rimWidthPx; // camera→rim, meters
  const zoneHalf = Math.min(
    DEPTH_GATE.makeZoneClampHi,
    Math.max(DEPTH_GATE.makeZoneClampLo, DEPTH_GATE.makeZoneScaleM / zEst),
  );

  // ---- Veto rule: beyond zone + blur allowance + k·σ, in ln space.
  const threshold = DEPTH_GATE.blurAllowanceLn + DEPTH_GATE.k * sigmaLn;
  const frontDist = Math.log((1 - zoneHalf) / ratio); // >0 ⇒ in front of zone
  const behindDist = Math.log(ratio / (1 + zoneHalf)); // >0 ⇒ behind zone

  if (frontDist > threshold) {
    return {
      decision: 'veto_front',
      ratio,
      sigmaLn,
      zoneHalf,
      snr: frontDist / sigmaLn,
      enabled: true,
    };
  }
  if (behindDist > threshold) {
    return {
      decision: 'veto_behind',
      ratio,
      sigmaLn,
      zoneHalf,
      snr: behindDist / sigmaLn,
      enabled: true,
    };
  }
  return {
    decision: 'silent',
    ratio,
    sigmaLn,
    zoneHalf,
    snr: Math.max(frontDist, behindDist, 0) / sigmaLn,
    enabled: true,
  };
}
