/**
 * 2D constant-acceleration Kalman filter for ball tracking.
 *
 * State vector: [x, y, vx, vy] in analysis-frame pixels / px-per-second.
 * Gravity enters as a KNOWN control acceleration on y — with screen +y DOWN,
 * gravity is a POSITIVE ay (see types.ts coordinate convention). Because the
 * dominant acceleration is modeled explicitly, process noise only has to
 * absorb small unmodeled effects (drag, spin, detector box wobble), which
 * lets the filter smooth hard while still tracking a fast parabola.
 *
 * Implementation notes:
 * - Plain inlined 4x4 matrix math, no dependencies.
 * - All matrices/scratch buffers are preallocated in the constructor; the
 *   per-frame methods allocate only the tiny {x,y,vx,vy} result object.
 * - The covariance P is re-symmetrized after every measurement update to
 *   keep float32-ish drift from accumulating.
 * - Time comes exclusively from caller-supplied camera timestamps (seconds);
 *   dt <= 0 steps are skipped gracefully (state is left untouched).
 */

/** Snapshot of the filter state (analysis-frame px, px/s). */
export interface KalmanState {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Construction options for {@link BallKalman}. */
export interface BallKalmanOptions {
  /**
   * Gravity prior, px/s², POSITIVE (screen +y is down). Typically derived
   * from the rim size at runtime; see TRACKER.gravityPxPerSec2Fallback.
   */
  gravityPxPerSec2: number;
  /**
   * Standard deviation of UNMODELED acceleration, px/s² (default 120).
   * Gravity is already modeled, so this only covers drag/spin/model error.
   * Larger = more responsive, smaller = smoother.
   */
  processNoise?: number;
  /**
   * Standard deviation of the detector's ball-center measurement, px
   * (default 2). Larger = trust detections less.
   */
  measurementNoise?: number;
}

/** Default unmodeled-acceleration std, px/s². */
const DEFAULT_PROCESS_NOISE = 120;
/** Default measurement std, px. */
const DEFAULT_MEASUREMENT_NOISE = 2;
/** Initial velocity variance, (px/s)² — velocity is unknown at init. */
const INIT_VELOCITY_VAR = 1e6;

/**
 * 2D constant-acceleration Kalman filter with a gravity control input,
 * tracking a basketball's center across camera frames.
 *
 * Usage per frame: call {@link BallKalman.update} when a detection is
 * accepted, or {@link BallKalman.predict} to coast through occlusion.
 * Call {@link BallKalman.init} to (re)seed the track from a fresh detection.
 */
export class BallKalman {
  /** Gravity control acceleration on y, px/s² (positive = down). */
  private readonly g: number;
  /** Unmodeled-acceleration std, px/s². */
  private readonly qStd: number;
  /** Measurement std, px. */
  private readonly rStd: number;

  /** State [x, y, vx, vy]. */
  private readonly s = new Float64Array(4);
  /** Covariance P, 4x4 row-major. */
  private readonly P = new Float64Array(16);
  /** Transition matrix F, rebuilt each predict step. */
  private readonly F = new Float64Array(16);
  /** Scratch for F*P. */
  private readonly FP = new Float64Array(16);
  /** Scratch for the new covariance. */
  private readonly newP = new Float64Array(16);
  /** Kalman gain K, 4x2 row-major. */
  private readonly K = new Float64Array(8);

  private isInit = false;
  /** Timestamp (s) the state currently refers to. */
  private lastT = 0;

  constructor(opts: BallKalmanOptions) {
    this.g = opts.gravityPxPerSec2;
    this.qStd = opts.processNoise ?? DEFAULT_PROCESS_NOISE;
    this.rStd = opts.measurementNoise ?? DEFAULT_MEASUREMENT_NOISE;
  }

  /** True once {@link BallKalman.init} (or a first update) has seeded the track. */
  get initialized(): boolean {
    return this.isInit;
  }

  /** Current state snapshot, or null before initialization. */
  get state(): KalmanState | null {
    if (!this.isInit) return null;
    const s = this.s;
    return { x: s[0], y: s[1], vx: s[2], vy: s[3] };
  }

  /**
   * Reset the filter from a fresh ball detection at time `t` (seconds).
   * Position is trusted at measurement noise level; velocity starts at 0
   * with a very large variance so the first few updates determine it.
   */
  init(x: number, y: number, t: number): void {
    const s = this.s;
    s[0] = x;
    s[1] = y;
    s[2] = 0;
    s[3] = 0;

    const P = this.P;
    P.fill(0);
    const posVar = this.rStd * this.rStd;
    P[0] = posVar; // var(x)
    P[5] = posVar; // var(y)
    P[10] = INIT_VELOCITY_VAR; // var(vx)
    P[15] = INIT_VELOCITY_VAR; // var(vy)

    this.lastT = t;
    this.isInit = true;
  }

  /**
   * Advance the state to time `t` (seconds) WITHOUT consuming a measurement
   * (use while the ball is occluded) and return the predicted state.
   * A non-positive dt (duplicate or out-of-order timestamp) is skipped: the
   * state is returned unchanged and the internal clock is not moved.
   * @throws Error when called before {@link BallKalman.init}.
   */
  predict(t: number): KalmanState {
    if (!this.isInit) {
      throw new Error('BallKalman.predict called before init');
    }
    const dt = t - this.lastT;
    if (dt > 0) {
      this.timeUpdate(dt);
      this.lastT = t;
    }
    const s = this.s;
    return { x: s[0], y: s[1], vx: s[2], vy: s[3] };
  }

  /**
   * Predict to time `t` (seconds), then correct with the measured ball
   * center (x, y). Returns the corrected state.
   *
   * `measurementNoiseScale` (default 1) scales the measurement std for this
   * sample only — pass > 1 for low-confidence detections (e.g. blurred or
   * inside the hoop ROI) so they nudge rather than yank the track.
   *
   * When called before init, the filter seeds itself from the measurement
   * (equivalent to `init(x, y, t)`).
   */
  update(x: number, y: number, t: number, measurementNoiseScale = 1): KalmanState {
    if (!this.isInit) {
      this.init(x, y, t);
      const s = this.s;
      return { x: s[0], y: s[1], vx: s[2], vy: s[3] };
    }

    const dt = t - this.lastT;
    if (dt > 0) {
      this.timeUpdate(dt);
      this.lastT = t;
    }

    this.measurementUpdate(x, y, measurementNoiseScale);
    const s = this.s;
    return { x: s[0], y: s[1], vx: s[2], vy: s[3] };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Time update (predict step): x = F x + B u, P = F P Fᵀ + Q. */
  private timeUpdate(dt: number): void {
    const s = this.s;
    const g = this.g;

    // State: constant velocity + known gravity control on y.
    s[0] += s[2] * dt;
    s[1] += s[3] * dt + 0.5 * g * dt * dt;
    // vx unchanged
    s[3] += g * dt;

    // F = I with dt coupling position<-velocity.
    const F = this.F;
    F.fill(0);
    F[0] = 1;
    F[2] = dt; // x <- vx
    F[5] = 1;
    F[7] = dt; // y <- vy
    F[10] = 1;
    F[15] = 1;

    // FP = F * P
    const P = this.P;
    const FP = this.FP;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) {
          acc += F[r * 4 + k] * P[k * 4 + c];
        }
        FP[r * 4 + c] = acc;
      }
    }

    // P = FP * Fᵀ
    const newP = this.newP;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let k = 0; k < 4; k++) {
          acc += FP[r * 4 + k] * F[c * 4 + k];
        }
        newP[r * 4 + c] = acc;
      }
    }

    // P += Q (discrete white-noise acceleration model, variance q per axis).
    const q = this.qStd * this.qStd;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt3 * dt;
    const qPos = q * (dt4 / 4);
    const qPosVel = q * (dt3 / 2);
    const qVel = q * dt2;
    newP[0] += qPos; //   var(x)
    newP[2] += qPosVel; // cov(x, vx)
    newP[5] += qPos; //   var(y)
    newP[7] += qPosVel; // cov(y, vy)
    newP[8] += qPosVel; // cov(vx, x)
    newP[10] += qVel; //  var(vx)
    newP[13] += qPosVel; // cov(vy, y)
    newP[15] += qVel; //  var(vy)

    P.set(newP);
  }

  /**
   * Measurement update (correct step) with z = [x, y], H = [I₂ 0].
   * Exploits H's structure: S is the top-left 2x2 of P plus R.
   */
  private measurementUpdate(zx: number, zy: number, noiseScale: number): void {
    const s = this.s;
    const P = this.P;

    const rs = this.rStd * (noiseScale > 0 ? noiseScale : 1);
    const R = rs * rs;

    // Innovation.
    const ix = zx - s[0];
    const iy = zy - s[1];

    // S = H P Hᵀ + R (2x2).
    const S00 = P[0] + R;
    const S01 = P[1];
    const S10 = P[4];
    const S11 = P[5] + R;
    const det = S00 * S11 - S01 * S10;
    if (!(Math.abs(det) > 1e-12)) return; // degenerate — skip the correction
    const inv = 1 / det;
    const Si00 = S11 * inv;
    const Si01 = -S01 * inv;
    const Si10 = -S10 * inv;
    const Si11 = S00 * inv;

    // K = P Hᵀ S⁻¹ (4x2); P Hᵀ is the first two columns of P.
    const K = this.K;
    for (let r = 0; r < 4; r++) {
      const p0 = P[r * 4];
      const p1 = P[r * 4 + 1];
      K[r * 2] = p0 * Si00 + p1 * Si10;
      K[r * 2 + 1] = p0 * Si01 + p1 * Si11;
    }

    // x = x + K * innovation.
    for (let r = 0; r < 4; r++) {
      s[r] += K[r * 2] * ix + K[r * 2 + 1] * iy;
    }

    // P = (I - K H) P  ⇒  P[r][c] -= K[r][0]*P[0][c] + K[r][1]*P[1][c].
    const newP = this.newP;
    for (let r = 0; r < 4; r++) {
      const k0 = K[r * 2];
      const k1 = K[r * 2 + 1];
      for (let c = 0; c < 4; c++) {
        newP[r * 4 + c] = P[r * 4 + c] - (k0 * P[c] + k1 * P[4 + c]);
      }
    }

    // Symmetrize P to fight numerical drift.
    for (let r = 0; r < 4; r++) {
      P[r * 4 + r] = newP[r * 4 + r];
      for (let c = r + 1; c < 4; c++) {
        const m = (newP[r * 4 + c] + newP[c * 4 + r]) / 2;
        P[r * 4 + c] = m;
        P[c * 4 + r] = m;
      }
    }
  }
}
