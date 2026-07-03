/**
 * All pipeline tunables in one place.
 *
 * Values trace back to the July 2026 research pass over open-source shot
 * trackers (avishah3 cleaning gates, SwishAI cooldowns/classes, HomeCourt
 * patent-style net fusion) and Noah/HomeCourt published shooting metrics.
 * Adjust only with the labeled clip benchmark in place.
 */

export const DETECTION = {
  /** Detector input side (letterboxed square). 640 is the floor for a 20–40px ball. */
  inputSize: 640,
  /** Ball confidence gate in open court. */
  ballScoreMin: 0.3,
  /** Relaxed ball gate inside the hoop ROI (occlusion/blur near the rim). */
  ballScoreMinHoopRoi: 0.15,
  /** Rim confidence gate. */
  rimScoreMin: 0.5,
  /** 'ball_in_basket' class gate. */
  ballInBasketScoreMin: 0.35,
  /** Person confidence gate. */
  personScoreMin: 0.4,
} as const;

export const TRACKER = {
  /** Ring-buffer length of accepted ball samples. */
  historyLen: 30,
  /**
   * Reject a detection that jumped more than `jumpDiameters` ball diameters
   * within the last `jumpWindowFrames` frames (avishah3 cleaning gate).
   */
  jumpDiameters: 4,
  jumpWindowFrames: 5,
  /**
   * Max plausible ball speed in diameters/second (~9 m/s over a 0.24 m ball,
   * with margin). On slow devices detections arrive far apart, so the jump
   * gate's allowance must scale with elapsed TIME — the larger of the classic
   * `jumpDiameters` floor and `maxSpeedDiametersPerSec × Δt` wins.
   */
  maxSpeedDiametersPerSec: 40,
  /**
   * Reject clearly non-round boxes (width * 1.4 < height) — likely a body
   * part or netting — unless the sample is flagged as a motion-blur streak.
   */
  aspectWidthFactor: 1.4,
  /** Keep predicting through occlusion for at most this many frames. */
  maxPredictedFrames: 8,
  /** Drop samples older than this from the live buffer (seconds). */
  staleSampleSec: 2.0,
  /** Gravity prior for the constant-acceleration Kalman filter, px/s². Set at runtime from rim size (px-per-meter estimate); this is the fallback. */
  gravityPxPerSec2Fallback: 900,
} as const;

export const RIM = {
  /** Damping factor for the rim lock (EMA weight of the NEW observation). */
  lockAlpha: 0.05,
  /** Re-verify rim position every N seconds. */
  reverifySec: 5,
  /** A rim "moving" more than this × its diagonal in 5 frames is rejected. */
  maxDriftDiagFactor: 0.5,
  /** Crossing span = central fraction of rim width. */
  spanFraction: 0.8,
  /** Up-zone size relative to rim box. */
  upZoneWidthFactor: 4,
  upZoneHeightFactor: 2,
  /** belowY = rim bottom + belowMarginFactor * rim height. */
  belowMarginFactor: 0.5,
  /** Hoop ROI (relaxed ball gate) size relative to rim box. */
  hoopRoiFactor: 2.5,
  /** Net ROI: rim width wide, this × rim height tall, hanging below the rim. */
  netRoiHeightFactor: 1.2,
  /** Rebound buffer: widen the crossing span by this many px on each side. */
  crossingBufferPx: 10,
} as const;

export const SHOT_FSM = {
  /** Resolve an armed shot if the ball has been lost this long (occlusion). */
  lostBallResolveSec: 1.5,
  /** Min seconds between two shot attempts (SwishAI). */
  shotCooldownSec: 1.5,
  /** Min seconds between two scored baskets (SwishAI). */
  basketCooldownSec: 2.0,
  /** Net motion score threshold for the 'net' signal. */
  netMotionThreshold: 0.25,
  /** Threshold multiplier when the ball bounced on the rim (patent-style). */
  netMotionRimBounceFactor: 1.5,
  /** Net burst must occur within this many seconds of the plane crossing. */
  netWindowSec: 0.35,
  /** Samples used for the release-angle fit right after release. */
  releaseAngleSamples: 5,
  /** Max seconds a shot may stay live before force-resolving as unsure. */
  maxLiveSec: 4.0,
} as const;

export const FORM = {
  /** One-Euro filter defaults for pose landmarks. */
  oneEuro: { minCutoff: 1.0, beta: 0.007, dCutoff: 1.0 },
  /** Elbow set-point band, degrees. */
  elbowSetPoint: { min: 75, max: 90, flagBelow: 60, flagAbove: 100 },
  /** Knee flexion band at deepest dip, degrees. */
  kneeFlexion: { min: 100, max: 130, flagStiff: 150, flagDeep: 95 },
  /** Release angle bands, degrees. */
  releaseAngle: { min: 45, max: 55, flagLow: 45, flagHigh: 58 },
  /** Entry angle optimal band (Noah), degrees. */
  entryAngle: { min: 43, max: 47 },
  /** Release-time bins, seconds (HomeCourt definition: pickup → release). */
  releaseTime: { elite: 0.4, nbaAvg: 0.54, good: 0.7, typical: 1.0 },
  /** Follow-through: elbow ≥ this angle held ≥ holdSec after release. */
  followThrough: { elbowMinDeg: 155, holdSec: 0.3 },
  /** Flag consistency when σ(release angle) exceeds this, degrees. */
  releaseAngleStdFlagDeg: 4,
  /** Keypoint score gate below which a landmark is treated as missing. */
  keypointScoreMin: 0.3,
} as const;

export const CLIPS = {
  /** Clip window around a resolved shot, seconds. */
  preRollSec: 6,
  postRollSec: 2,
  /** Merge two clips when they overlap or sit closer than this, seconds. */
  mergeGapSec: 0.5,
} as const;

export const STREAKS = {
  /** Streak lengths that trigger celebration stingers. */
  celebrateAt: [3, 5, 10] as readonly number[],
} as const;

/**
 * Automatic 2/3-point estimation (src/core/court.ts). No manual court
 * calibration — the model already marks the rim and the shooter's foot, and we
 * use the detected rim box width in pixels as a real-world scale reference
 * (regulation rim inner diameter ≈ 0.45 m).
 *
 * A regulation NBA 3-point arc is ~6.75 m at the top; 6.75 / 0.45 ≈ 15 rim
 * widths. But the shooter distance we can measure is the ground gap between the
 * person's foot and the point under the rim IN THE IMAGE PLANE, which is
 * foreshortened by camera angle and perspective — a true 6.75 m shot rarely
 * measures a full 15 rim widths on screen. The default threshold is tuned lower
 * so realistic 3-pt setups classify correctly; treat every result as an
 * ESTIMATE, adjustable per session via {@link adjust3ptThreshold} in court.ts.
 */
export const COURT = {
  /** Regulation rim inner diameter, meters (scale reference). */
  rimDiameterM: 0.45,
  /** NBA 3-pt arc distance at the top, meters (documentation only). */
  threePtDistanceM: 6.75,
  /**
   * Distance (in rim widths, image-plane) at/above which a shot is a 3.
   * Perspective-tuned default — see COURT doc.
   */
  default3ptRimWidths: 9,
  /** Clamp bounds when a session adjusts its 3-pt threshold. */
  min3ptRimWidths: 4,
  max3ptRimWidths: 20,
} as const;

/** Exposed constant: default rim-width distance that classifies a shot as a 3. */
export const DEFAULT_3PT_RIMWIDTHS = COURT.default3ptRimWidths;
