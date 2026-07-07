/**
 * BallTracker — collapses raw per-frame detector output into a single clean
 * `TrackedBall` stream.
 *
 * Per frame (see {@link BallTracker.step}):
 *   1. Candidate gating on class + confidence (relaxed inside the hoop ROI).
 *   2. Cleaning gates (avishah3-style): non-round boxes are rejected unless
 *      they look like a motion-blur streak along the current velocity, and
 *      teleporting detections are rejected against the last accepted sample.
 *   3. The best surviving candidate (score weighted by inverse distance to
 *      the Kalman prediction) feeds a constant-acceleration Kalman filter;
 *      short occlusions are bridged with pure predictions, long ones reset
 *      the track.
 *
 * Pure TypeScript: no I/O, no wall clock — time comes exclusively from the
 * camera frame timestamps carried in `FrameDetections.t` (seconds).
 * Coordinates are analysis-frame pixels, +y down (ball rising ⇒ vy < 0).
 */
import { DETECTION, TRACKER } from './config';
import { boxCenter, boxContains, distance } from './geometry';
import { BallKalman } from './kalman';
import type {
  BallSample,
  Box,
  Detection,
  FrameDetections,
  TrackedBall,
} from './types';

/** EMA weight of the NEW observation when smoothing the radius estimate. */
const RADIUS_EMA_ALPHA = 0.12;

/**
 * Hard clamp on how much the smoothed radius may change in a single accepted
 * frame, as a fraction of the current smoothed radius. Box sizes are noisy
 * frame-to-frame; without this clamp even a well-behaved EMA lets one oversized
 * box visibly pump the drawn circle. A real ball's apparent size changes slowly,
 * so 12%/frame is generous for genuine motion while killing the balloon/jitter.
 */
const RADIUS_MAX_STEP_FRAC = 0.12;

/**
 * Motion-blur streak exception: an elongated box is accepted only when the
 * ball is moving faster than this many diameters per frame along the box's
 * long axis.
 */
const BLUR_STREAK_MIN_DIAMETERS_PER_FRAME = 2;

/** Fallback inter-frame interval (seconds) before any sample exists. */
const NOMINAL_FRAME_DT = 1 / 30;

/** Constructor options for {@link BallTracker}. */
export interface BallTrackerOptions {
  /**
   * Gravity prior for the Kalman filter, analysis-frame px/s² (+y down).
   * Defaults to `TRACKER.gravityPxPerSec2Fallback`.
   */
  gravityPxPerSec2?: number;
}

/** Kalman state snapshot (position px, velocity px/s, +y down). */
interface KalmanEstimate {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Internal: a gated candidate with its precomputed center. */
interface Candidate {
  det: Detection;
  cx: number;
  cy: number;
}

/**
 * Turns raw per-frame detections into one clean {@link TrackedBall} stream.
 *
 * Stateful and single-track: exactly one ball is followed at a time. Call
 * {@link BallTracker.step} once per analysed camera frame in timestamp order.
 */
export class BallTracker {
  private kalman: BallKalman;

  private readonly gravityPxPerSec2: number;

  /** Ring buffer of the last `TRACKER.historyLen` accepted+predicted samples. */
  private readonly history: BallSample[] = [];

  /** EMA-smoothed ball radius (px); null until the first accepted detection. */
  private smoothedR: number | null = null;

  /** Consecutive frames emitted from pure Kalman prediction. */
  private predictedStreak = 0;

  /** Number of `step` calls so far (frame counter for the jump window). */
  private frameIndex = 0;

  /** `frameIndex` at which the last real detection was accepted. */
  private lastAcceptFrame = Number.NEGATIVE_INFINITY;

  /** Timestamp (seconds) of the last accepted detection, for the jump gate. */
  private lastAcceptT: number | null = null;

  /** The last accepted (non-predicted) sample, for the jump gate. */
  private lastAccept: BallSample | null = null;

  /** Timestamp of the last emitted sample (accepted or predicted), seconds. */
  private lastSampleT: number | null = null;

  /**
   * @param opts Optional tracker configuration; see {@link BallTrackerOptions}.
   */
  constructor(opts: BallTrackerOptions = {}) {
    this.gravityPxPerSec2 =
      opts.gravityPxPerSec2 ?? TRACKER.gravityPxPerSec2Fallback;
    this.kalman = new BallKalman({ gravityPxPerSec2: this.gravityPxPerSec2 });
  }

  /**
   * Per-frame entry point. Feed every analysed frame in timestamp order.
   *
   * @param frame   Raw detector output for one camera frame.
   * @param hoopRoi Relaxed-confidence zone around the hoop (from the rim
   *                lock), or null before the rim is locked.
   * @returns The tracked ball for this frame — a filtered detection
   *          (`predicted: false`), a Kalman-bridged prediction during short
   *          occlusion (`predicted: true`, `score: 0`) — or null when there
   *          is no live track.
   */
  step(frame: FrameDetections, hoopRoi: Box | null): TrackedBall | null {
    const t = frame.t;
    this.frameIndex++;
    this.pruneStale(t);

    const candidate = this.pickCandidate(frame, hoopRoi);
    if (candidate !== null) {
      return this.accept(candidate, t);
    }

    // No usable detection this frame: bridge short occlusions by prediction.
    if (this.kalman.initialized) {
      // Bridge for at most `maxPredictedSec` of WALL-CLOCK time since the last
      // real detection (device-independent), capped by `maxPredictedFrames` as
      // a safety net on unusually fast pipelines.
      const bridgedSec = this.lastAcceptT !== null ? t - this.lastAcceptT : 0;
      if (
        this.predictedStreak < TRACKER.maxPredictedFrames &&
        bridgedSec <= TRACKER.maxPredictedSec
      ) {
        const est = this.kalman.predict(t);
        // Cull a runaway prediction that has coasted well off-frame rather than
        // emitting a ghost ball there (precision guard — see config): during a
        // long occlusion the constant-velocity term keeps marching in a straight
        // line, and a ghost at an absurd position could feed the FSM a fake
        // rim-plane crossing. A real ball is on-screen when a make/miss is at
        // stake, so dropping a generously-off-frame prediction costs nothing.
        const margin =
          Math.max(frame.frameWidth, frame.frameHeight) *
          TRACKER.predictOffFrameMarginFrac;
        if (
          est.x < -margin ||
          est.x > frame.frameWidth + margin ||
          est.y < -margin ||
          est.y > frame.frameHeight + margin
        ) {
          this.resetTrack();
          return null;
        }
        this.predictedStreak++;
        const sample: BallSample = {
          cx: est.x,
          cy: est.y,
          r: this.smoothedR ?? 0,
          t,
          score: 0,
          predicted: true,
        };
        this.pushHistory(sample);
        this.lastSampleT = t;
        return {
          cx: sample.cx,
          cy: sample.cy,
          r: sample.r,
          t,
          score: 0,
          predicted: true,
          vx: est.vx,
          vy: est.vy,
        };
      }
      // Occluded too long: the ball is gone. Drop the track.
      this.resetTrack();
    }
    return null;
  }

  /**
   * Ring buffer of the most recent accepted + predicted samples, oldest
   * first, capped at `TRACKER.historyLen` and pruned of samples older than
   * `TRACKER.staleSampleSec` (relative to the latest stepped frame).
   *
   * Returns a live readonly view (no copy); consume it synchronously or
   * copy before the next `step` call.
   */
  getHistory(): readonly BallSample[] {
    return this.history;
  }

  /** Clears all tracker state, including the sample history. */
  reset(): void {
    this.resetTrack();
    this.history.length = 0;
    this.frameIndex = 0;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Drops the live track (Kalman, radius, gates) but keeps the history. */
  private resetTrack(): void {
    this.kalman = new BallKalman({ gravityPxPerSec2: this.gravityPxPerSec2 });
    this.smoothedR = null;
    this.predictedStreak = 0;
    this.lastAcceptFrame = Number.NEGATIVE_INFINITY;
    this.lastAcceptT = null;
    this.lastAccept = null;
    this.lastSampleT = null;
  }

  /**
   * Extrapolates the current Kalman state to time `t` WITHOUT mutating the
   * filter (constant-velocity read-only projection, used for candidate
   * weighting and the blur-streak gate).
   */
  private projectStateTo(t: number): KalmanEstimate | null {
    if (!this.kalman.initialized) return null;
    const s = this.kalman.state;
    if (s === null) return null;
    const dt =
      this.lastSampleT !== null && t > this.lastSampleT
        ? t - this.lastSampleT
        : 0;
    return { x: s.x + s.vx * dt, y: s.y + s.vy * dt, vx: s.vx, vy: s.vy };
  }

  /** Inter-frame interval used to convert px/s speeds to px/frame. */
  private frameDt(t: number): number {
    if (this.lastSampleT !== null && t > this.lastSampleT) {
      return t - this.lastSampleT;
    }
    return NOMINAL_FRAME_DT;
  }

  /**
   * Applies confidence + cleaning gates and returns the best surviving ball
   * candidate (score weighted by inverse distance to the Kalman prediction
   * once the filter is initialized), or null.
   */
  private pickCandidate(
    frame: FrameDetections,
    hoopRoi: Box | null,
  ): Candidate | null {
    const t = frame.t;
    const pred = this.projectStateTo(t);
    const dt = this.frameDt(t);

    let best: Candidate | null = null;
    let bestWeight = Number.NEGATIVE_INFINITY;

    // Fresh track ⇒ flight-continuation mode: the jump gate is still armed
    // (a candidate must land near the prediction), so the score floor drops
    // to ballScoreMinTracking. See the config rationale — this is what keeps
    // the ball tracked THROUGH its flight instead of only near the rim.
    const trackFresh =
      this.lastAccept !== null &&
      this.frameIndex - this.lastAcceptFrame <= TRACKER.jumpWindowFrames;

    for (const det of frame.detections) {
      if (det.cls !== 'ball') continue;

      const center = boxCenter(det.box);
      const inHoopRoi = hoopRoi !== null && boxContains(hoopRoi, center);
      const scoreGate = inHoopRoi
        ? DETECTION.ballScoreMinHoopRoi
        : trackFresh
          ? DETECTION.ballScoreMinTracking
          : DETECTION.ballScoreMin;
      if (det.score < scoreGate) continue;

      // Reject an implausibly LARGE ball box (a near-frame-size false positive
      // that the round-aspect gate lets through and that paints a giant circle
      // over the whole screen). A real basketball never fills half the frame.
      if (
        det.box.width > frame.frameWidth * DETECTION.ballMaxSizeFraction ||
        det.box.height > frame.frameHeight * DETECTION.ballMaxSizeFraction
      ) {
        continue;
      }

      if (!this.passesAspectGate(det.box, pred, dt)) continue;
      if (!this.passesJumpGate(center.x, center.y, t)) continue;

      // Score weighted by inverse distance to the Kalman prediction.
      const weight =
        pred !== null
          ? det.score / (1 + distance(center, pred))
          : det.score;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = { det, cx: center.x, cy: center.y };
      }
    }
    return best;
  }

  /**
   * Rejects clearly non-round boxes UNLESS the box looks like a motion-blur
   * streak elongated roughly along the current velocity direction while the
   * ball moves faster than 2 diameters per frame.
   *
   * Symmetric in both axes: a box tall-and-skinny
   * (`width * aspectWidthFactor < height`, likely a limb or netting) is
   * gated exactly like a wide-and-short one
   * (`height * aspectWidthFactor < width`, likely a horizontal limb/arm or a
   * fast crosscourt-pass motion-blur smear) — each checked against the
   * blur-streak exception for velocity along its own elongation axis.
   */
  private passesAspectGate(
    box: Box,
    pred: KalmanEstimate | null,
    dtSec: number,
  ): boolean {
    const tallSkinny = box.width * TRACKER.aspectWidthFactor < box.height;
    const wideShort = box.height * TRACKER.aspectWidthFactor < box.width;
    if (!tallSkinny && !wideShort) return true;

    // Elongated box. Blur-streak exception requires a known fast velocity.
    if (pred === null) return false;
    const diameter =
      2 * (this.smoothedR ?? Math.min(box.width, box.height) / 2);
    if (diameter <= 0) return false;
    const speedPxPerFrame = Math.hypot(pred.vx, pred.vy) * dtSec;
    if (speedPxPerFrame <= BLUR_STREAK_MIN_DIAMETERS_PER_FRAME * diameter) {
      return false;
    }
    // Axis-aligned boxes only elongate vertically or horizontally, so "along
    // velocity" means the velocity is within 45° of the box's long axis.
    if (tallSkinny) return Math.abs(pred.vy) >= Math.abs(pred.vx);
    return Math.abs(pred.vx) >= Math.abs(pred.vy);
  }

  /**
   * Rejects detections that jumped implausibly far from the last ACCEPTED
   * sample within `jumpWindowFrames` frames. Once the last acceptance is
   * older than the window the gate releases so the track can re-acquire
   * anywhere.
   *
   * TIME-AWARE for slow devices: when inference runs below 30fps (older
   * phones on CPU), consecutive detections are far apart in time and a
   * legitimately fast ball covers far more ground between them. The allowance
   * is therefore the larger of the classic `jumpDiameters` floor and a
   * max-plausible-speed budget (`maxSpeedDiametersPerSec × Δt`).
   */
  private passesJumpGate(cx: number, cy: number, t: number): boolean {
    const last = this.lastAccept;
    if (last === null) return true;
    if (this.frameIndex - this.lastAcceptFrame > TRACKER.jumpWindowFrames) {
      return true;
    }
    const elapsedSec =
      this.lastAcceptT !== null ? Math.max(0, t - this.lastAcceptT) : 0;
    const allowedDiameters = Math.max(
      TRACKER.jumpDiameters,
      TRACKER.maxSpeedDiametersPerSec * elapsedSec,
    );
    const maxDist = allowedDiameters * (2 * last.r);
    const dx = cx - last.cx;
    const dy = cy - last.cy;
    return Math.hypot(dx, dy) <= maxDist;
  }

  /** Feeds an accepted detection into the filter and emits the sample. */
  private accept(candidate: Candidate, t: number): TrackedBall {
    const { det, cx, cy } = candidate;

    // Radius: EMA-smoothed half of the mean of width/height, with a hard
    // per-frame change clamp so one noisy/oversized box can't pump the drawn
    // circle (the balloon/jitter fix). First detection seeds directly.
    const rRaw = (det.box.width + det.box.height) / 4;
    if (this.smoothedR === null) {
      this.smoothedR = rRaw;
    } else {
      const target = this.smoothedR + RADIUS_EMA_ALPHA * (rRaw - this.smoothedR);
      const maxStep = this.smoothedR * RADIUS_MAX_STEP_FRAC;
      const delta = Math.max(-maxStep, Math.min(maxStep, target - this.smoothedR));
      this.smoothedR += delta;
    }

    let est: KalmanEstimate;
    if (!this.kalman.initialized) {
      this.kalman.init(cx, cy, t);
      est = this.kalman.state ?? { x: cx, y: cy, vx: 0, vy: 0 };
    } else {
      // Low-confidence (hoop-ROI relaxed) detections are noisier measurements.
      const noiseScale =
        det.score >= DETECTION.ballScoreMin ? undefined : 2;
      est = this.kalman.update(cx, cy, t, noiseScale);
    }

    this.predictedStreak = 0;
    this.lastAcceptFrame = this.frameIndex;
    this.lastAcceptT = t;
    const sample: BallSample = {
      cx: est.x,
      cy: est.y,
      r: this.smoothedR,
      t,
      score: det.score,
      predicted: false,
    };
    this.lastAccept = sample;
    this.lastSampleT = t;
    this.pushHistory(sample);
    return {
      cx: sample.cx,
      cy: sample.cy,
      r: sample.r,
      t,
      score: sample.score,
      predicted: false,
      vx: est.vx,
      vy: est.vy,
    };
  }

  /** Appends to the ring buffer, evicting the oldest past `historyLen`. */
  private pushHistory(sample: BallSample): void {
    this.history.push(sample);
    if (this.history.length > TRACKER.historyLen) {
      this.history.shift();
    }
  }

  /** Drops history samples older than `staleSampleSec` before time `t`. */
  private pruneStale(t: number): void {
    const cutoff = t - TRACKER.staleSampleSec;
    while (this.history.length > 0 && this.history[0].t < cutoff) {
      this.history.shift();
    }
  }
}
