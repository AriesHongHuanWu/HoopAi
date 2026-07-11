/**
 * BallTracker — collapses raw per-frame detector output into a single clean
 * `TrackedBall` stream.
 *
 * Per frame (see {@link BallTracker.step}):
 *   1. Candidate gating on class + confidence (relaxed inside the hoop ROI,
 *      while continuing a fresh flight, and — after a pose-gated release
 *      event — near the released wrist; see setReleaseEvent).
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
import type {
  GateUsed,
  TrackerStepStats,
} from './acquisitionFunnel';
import { DETECTION, GATE_EPS_SEC, RELEASE, TRACKER } from './config';
import { boxCenter, boxContains, distance } from './geometry';
import { BallKalman } from './kalman';
import type { LightProfile } from './lightProfile';
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

/**
 * Rescue sighting ring-buffer capacity. Adoption needs TRACKER.rescueFrames
 * (3) coherent sightings; one extra slot lets the window slide without the
 * buffer thrashing at exactly the threshold.
 */
const RESCUE_BUF_CAP = 4;

/**
 * Max wall-clock gap (seconds) between successive corridor points for the
 * capsule test to bridge them. Older last-points fall back to the plain
 * point-in-tube test — a segment across a long detection gap would sweep
 * far more court than the corridor prior justifies.
 */
const CORRIDOR_CAPSULE_MAX_GAP_SEC = 0.35;

/**
 * EMA weight of the newest inter-step interval when tracking the mean sample
 * cadence. Low (0.1) so a single long gap (occlusion, a dropped frame) barely
 * moves the estimate — the estimate must reflect the DEVICE'S steady fps, not
 * transient stalls, since it scales the frame-count gates.
 */
const DT_EMA_ALPHA = 0.1;

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

/** Distance from point (px,py) to segment (ax,ay)-(bx,by). Degenerate segment = point distance. */
export function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 0) return Math.hypot(px - ax, py - ay);
  const u = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  const uc = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - (ax + uc * dx), py - (ay + uc * dy));
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
   * Timestamp of the previous `step` call (ANY frame, detection or not), for
   * the cadence EMA. Distinct from `lastSampleT`, which only tracks emitted
   * samples — the device fps is what matters for gate scaling, so every step
   * counts, including empty (occluded) frames.
   */
  private lastStepT: number | null = null;

  /**
   * EMA of the inter-step interval (seconds) — the tracker's own live estimate
   * of the device sample cadence, used to convert NOMINAL_FPS frame-count
   * gates into a wall-clock-correct number of THIS device's frames (see
   * config.scaleFrameGate). Seeded to the nominal 30 fps interval so the very
   * first gates behave exactly as before until real timing accrues.
   */
  private meanStepDt = NOMINAL_FRAME_DT;

  /**
   * Pose-gated release event (wrist position + camera time), or null. While
   * fresh (RELEASE.seedWindowSec) it opens a wrist-local relaxed score gate
   * in pickCandidate. Survives resetTrack() on purpose — reacquiring after
   * the track died at release is exactly its job.
   */
  private releaseSeed: { x: number; y: number; t: number } | null = null;

  /**
   * Previous frame's flight-corridor point (+ tube radius, camera seconds),
   * for the capsule test in pickCandidate. Like releaseSeed this is an
   * EXTERNAL prior independent of the track, so it survives resetTrack() and
   * is cleared only by reset(). lastCorridorT = -Infinity means "none yet".
   */
  private lastCorridorX = 0;

  private lastCorridorY = 0;

  private lastCorridorTubeR = 0;

  private lastCorridorT = Number.NEGATIVE_INFINITY;

  /**
   * Scene-light profile from the pipeline (see setLightProfile). An
   * ENVIRONMENTAL setting, not track state: it survives resetTrack()/reset()
   * on purpose — the gym doesn't get brighter because the track died.
   */
  private lightProfile: LightProfile = 'bright';
  /** Per-model cold-gate override (see setColdGate); null = DETECTION default. */
  private coldGate: number | null = null;

  /**
   * Per-session ball-size cap override (see setSessionBallSizeCap); null =
   * DETECTION.ballMaxSizeFraction. Matches coldGate's lifecycle exactly:
   * survives resetTrack() AND reset() — the pipeline explicitly nulls it on
   * reAim/reset/stale-drift.
   */
  private sessionMaxSizeFrac: number | null = null;

  /** Persistence-rescue master switch (settings.trackerRescue, see setRescue). */
  private rescueEnabled = true;

  /**
   * Coherent-sighting ring buffer for the persistence rescue (see
   * maybeRescue): recent ball dets in the [ballScoreMin, activeColdFloor)
   * band that passed every NON-score gate. Cleared on any acceptance and on
   * resetTrack()/reset() — an adopted or dead track invalidates the chain.
   */
  private readonly rescueBuf: { x: number; y: number; r: number; t: number }[] =
    [];

  /**
   * Per-step gate telemetry (see acquisitionFunnel.ts). ONE object mutated
   * in place every step (allocation-light on the JS thread); read a copy via
   * lastStepStats(). Recording only — never feeds any gate decision.
   */
  private readonly stats: TrackerStepStats = {
    ballDets: 0,
    floor: DETECTION.ballScoreMin,
    gate: 'none',
    rejScore: 0,
    rejSize: 0,
    rejAspect: 0,
    rejJump: 0,
    lastReject: null,
    accepted: false,
    rescued: false,
  };

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
  /**
   * The device's estimated inter-frame interval (seconds), an EMA of the step
   * timestamps. Exposed so the flight-arc / occlusion modules scale their
   * frame-count gates off ONE shared cadence estimate (see scaleFrameGate).
   */
  estimatedStepDt(): number {
    return this.meanStepDt;
  }

  /**
   * @param corridor Optional flight-corridor prior (FlightArc.corridorPoint from
   *   the PREVIOUS frame, one-frame lag like the release seed): the predicted
   *   parabola point + a tube radius. A candidate inside the tube gets the
   *   relaxed flight-continuation score floor even with no live track, so a
   *   faint mid-arc ball keeps being detected across the WHOLE flight, not only
   *   inside the hoop ROI. Null / omitted = today's behavior exactly.
   */
  step(
    frame: FrameDetections,
    hoopRoi: Box | null,
    corridor?: { p: { x: number; y: number }; tubeR: number } | null,
  ): TrackedBall | null {
    const t = frame.t;
    this.frameIndex++;
    this.resetStats();
    // Track the device cadence from consecutive step timestamps (forward gaps
    // only — a non-monotonic or repeated timestamp is ignored rather than
    // poisoning the EMA). Every frame counts, occluded ones included: fps, not
    // detection density, is what the frame-count gates must scale by.
    if (this.lastStepT !== null && t > this.lastStepT) {
      const dt = t - this.lastStepT;
      this.meanStepDt += DT_EMA_ALPHA * (dt - this.meanStepDt);
    }
    this.lastStepT = t;
    this.pruneStale(t);

    const candidate = this.pickCandidate(frame, hoopRoi, corridor ?? null);
    // Record this frame's corridor point only AFTER pickCandidate has used
    // it — the capsule spans the PREVIOUS and CURRENT points, so recording
    // first would collapse the segment to a point.
    if (corridor != null) {
      this.lastCorridorX = corridor.p.x;
      this.lastCorridorY = corridor.p.y;
      this.lastCorridorTubeR = corridor.tubeR;
      this.lastCorridorT = t;
    }
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

  /**
   * Pose-gated release event from the pipeline (analysis px, camera
   * seconds). For RELEASE.seedWindowSec after `t`, candidates within
   * RELEASE.seedRadiusFrac of the frame side around (x, y) — the shooting
   * wrist at release — pass at the relaxed DETECTION.ballScoreMinTracking
   * even with NO fresh track. WHY: the just-released ball is small, fast
   * and motion-blurred, scoring in the 0.12–0.19 band exactly when cold
   * acquisition demands 0.2 — so the flight was often never picked up at
   * all. The wrist is an independent, pose-derived prior on where the ball
   * MUST be right now, substituting for the Kalman-prediction locality the
   * tracking gate normally requires. Positions and times in, no wall clock
   * — the tracker stays pure and deterministic.
   */
  setReleaseEvent(x: number, y: number, t: number): void {
    this.releaseSeed = { x, y, t };
  }

  /**
   * Scene-light profile from the pipeline (classified in
   * src/core/lightProfile.ts off the worklet's mean-luma estimate). In
   * 'dark' scenes ONLY, the COLD acquisition score floor relaxes from
   * DETECTION.ballScoreMin to DETECTION.ballScoreMinDark — a real ball in
   * low light scores systematically lower, so the 0.2 gate was rejecting it
   * before a track could ever start. 'dim' and 'bright' change nothing.
   * Every other defense (jump gate, aspect gate, size cap, doubled Kalman
   * measurement noise for sub-ballScoreMin samples) stays fully armed.
   */
  setLightProfile(profile: LightProfile): void {
    this.lightProfile = profile;
  }

  /**
   * Per-model COLD-acquisition gate override (open court, non-dark). Different
   * detectors score the ball differently — a noisier one needs a higher bar to
   * START a track without letting phantom boxes in — so the active model sets
   * its own floor here. null restores the DETECTION.ballScoreMin default. Never
   * touches the tracking-continuation or dark floors (those stay as configured).
   */
  setColdGate(gate: number | null): void {
    this.coldGate = gate;
  }

  /** Per-session max ball-box size cap (fraction of frame side), derived from a
   *  successful FT-seed anchor (src/core/ftSeed.ts). SHRINK-ONLY: clamped to the
   *  config default so it can never loosen the gate; null restores the default.
   *  Tracking-layer only — removing candidates can never fabricate a make. */
  setSessionBallSizeCap(frac: number | null): void {
    this.sessionMaxSizeFrac =
      frac != null && Number.isFinite(frac) && frac > 0
        ? Math.min(frac, DETECTION.ballMaxSizeFraction)
        : null;
  }

  /**
   * Master switch for the persistence rescue (see maybeRescue), forwarded
   * from settings.trackerRescue by the pipeline. Default true; the setting is
   * the escape hatch mirroring useFlightArc. Toggling never touches any other
   * gate — with rescue off the tracker is byte-identical to the legacy path.
   */
  setRescue(enabled: boolean): void {
    this.rescueEnabled = enabled;
  }

  /**
   * Copy of the LAST step's gate telemetry (see acquisitionFunnel.ts). One
   * small object per call, allocated on the JS thread — acceptable; callers
   * that poll faster than the pipeline should compare with funnelChanged.
   */
  lastStepStats(): TrackerStepStats {
    return { ...this.stats };
  }

  /** Clears all tracker state, including the sample history. */
  reset(): void {
    this.resetTrack();
    this.history.length = 0;
    this.frameIndex = 0;
    this.releaseSeed = null;
    this.lastCorridorT = Number.NEGATIVE_INFINITY;
    // Cadence estimate survives a track drop (resetTrack) — the device fps
    // doesn't change when a track dies — but a full reset() is a new session,
    // so re-seed it to the nominal interval.
    this.lastStepT = null;
    this.meanStepDt = NOMINAL_FRAME_DT;
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
    // A dead track invalidates the rescue sighting chain too (reset() also
    // lands here). coldGate + sessionMaxSizeFrac survive BOTH on purpose —
    // they are per-model/per-session environment, not track state.
    this.rescueBuf.length = 0;
  }

  /** Zeroes the per-step telemetry at the top of step() (in place, no alloc). */
  private resetStats(): void {
    const s = this.stats;
    s.ballDets = 0;
    // Overwritten with the ACTIVE floor in pickCandidate; pre-seeded with the
    // default so an early-out step still reports something sane.
    s.floor =
      this.lightProfile === 'dark'
        ? DETECTION.ballScoreMinDark
        : (this.coldGate ?? DETECTION.ballScoreMin);
    s.gate = 'none';
    s.rejScore = 0;
    s.rejSize = 0;
    s.rejAspect = 0;
    s.rejJump = 0;
    s.lastReject = null;
    s.accepted = false;
    s.rescued = false;
  }

  /**
   * Extrapolates the current Kalman state to time `t` WITHOUT mutating the
   * filter (read-only projection, used for candidate weighting and the
   * blur-streak gate). Physics-correct coast: the Kalman already knows
   * gravity; the cheap projection should too, so candidate weighting and the
   * blur-streak axis stay honest during descent. DETECTION-side only — the
   * FSM judges the same raw ball.
   */
  private projectStateTo(t: number): KalmanEstimate | null {
    if (!this.kalman.initialized) return null;
    const s = this.kalman.state;
    if (s === null) return null;
    const dt =
      this.lastSampleT !== null && t > this.lastSampleT
        ? t - this.lastSampleT
        : 0;
    const g = this.gravityPxPerSec2;
    return {
      x: s.x + s.vx * dt,
      y: s.y + s.vy * dt + 0.5 * g * dt * dt,
      vx: s.vx,
      vy: s.vy + g * dt,
    };
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
    corridor: { p: { x: number; y: number }; tubeR: number } | null,
  ): Candidate | null {
    const t = frame.t;
    const pred = this.projectStateTo(t);
    const dt = this.frameDt(t);

    // Cold-acquisition floor: relaxed to ballScoreMinDark in genuinely DARK
    // scenes only (see setLightProfile) — a real low-light ball scores under
    // the 0.2 open-court gate, so no track ever started. Invariant across the
    // detections of one frame, so hoisted out of the loop.
    const coldFloor =
      this.lightProfile === 'dark'
        ? DETECTION.ballScoreMinDark
        : (this.coldGate ?? DETECTION.ballScoreMin);
    this.stats.floor = coldFloor;
    // Session size cap (shrink-only, see setSessionBallSizeCap), hoisted out
    // of the hot loop.
    const sizeCapFrac = this.sessionMaxSizeFrac ?? DETECTION.ballMaxSizeFraction;

    let best: Candidate | null = null;
    let bestWeight = Number.NEGATIVE_INFINITY;
    let bestGate: GateUsed = 'none';
    // First rescue adoption this frame (see maybeRescue) — applied only if NO
    // candidate survives the normal path, so it can never displace one.
    let rescueAdopt: Candidate | null = null;

    // Fresh track ⇒ flight-continuation mode: the jump gate is still armed
    // (a candidate must land near the prediction), so the score floor drops
    // to ballScoreMinTracking. See the config rationale — this is what keeps
    // the ball tracked THROUGH its flight instead of only near the rim.
    // TIME-based window (jumpWindowSec) so "fresh" means the same ~167 ms of
    // wall clock at 8 fps as at 30 fps — a frame count would have kept the
    // relaxed floor open ~4× longer on a slow phone, letting noise continue a
    // long-dead track.
    const trackFresh =
      this.lastAccept !== null &&
      this.lastAcceptT !== null &&
      t - this.lastAcceptT <= TRACKER.jumpWindowSec + GATE_EPS_SEC;

    // Wrist-seeded reacquisition (see setReleaseEvent): while the release
    // seed is fresh, candidates near the released wrist get the SAME relaxed
    // floor as flight continuation — the wrist position plays the role the
    // Kalman prediction plays for trackFresh, so a faint just-released ball
    // can START (not only continue) a track. seedRadius < 0 = inactive.
    let seedRadius = -1;
    let seedX = 0;
    let seedY = 0;
    const seed = this.releaseSeed;
    if (seed !== null && t >= seed.t && t - seed.t <= RELEASE.seedWindowSec) {
      seedRadius =
        Math.max(frame.frameWidth, frame.frameHeight) * RELEASE.seedRadiusFrac;
      seedX = seed.x;
      seedY = seed.y;
    }

    for (const det of frame.detections) {
      if (det.cls !== 'ball') continue;
      this.stats.ballDets++;

      const center = boxCenter(det.box);
      const inHoopRoi = hoopRoi !== null && boxContains(hoopRoi, center);
      const nearWrist =
        seedRadius >= 0 &&
        Math.hypot(center.x - seedX, center.y - seedY) <= seedRadius;
      // Flight-corridor relaxation (S2): a candidate sitting on the predicted
      // full-flight parabola (within the tube) gets the relaxed floor even with
      // no live track — the corridor is the locality that trackFresh's jump gate
      // provides, so a faint mid-arc ball keeps the flight alive across the WHOLE
      // frame. This is the standing relaxation the arc lacked away from the rim.
      // Capsule between successive corridor points closes the low-fps gap where
      // a fast ball lands between two per-frame tube tests; still a score-floor
      // relaxation only — never feeds judgment.
      const inCorridor =
        corridor !== null &&
        (t - this.lastCorridorT <= CORRIDOR_CAPSULE_MAX_GAP_SEC
          ? distToSegment(
              center.x,
              center.y,
              this.lastCorridorX,
              this.lastCorridorY,
              corridor.p.x,
              corridor.p.y,
            ) <= Math.max(corridor.tubeR, this.lastCorridorTubeR)
          : Math.hypot(center.x - corridor.p.x, center.y - corridor.p.y) <=
            corridor.tubeR);
      // Locality prior for the cold aspect gate: an EXTERNAL "the ball must
      // be here" signal (flight corridor or released wrist) that substitutes
      // for the Kalman-velocity locality a live track would provide.
      const hasLocalityPrior = inCorridor || nearWrist;
      const scoreGate = inHoopRoi
        ? DETECTION.ballScoreMinHoopRoi
        : trackFresh || nearWrist || inCorridor
          ? DETECTION.ballScoreMinTracking
          : coldFloor;
      if (det.score < scoreGate) {
        this.stats.rejScore++;
        this.stats.lastReject = 'score';
        // Persistence rescue: a det in the raised-cold-gate band may still
        // accumulate toward adoption (never displaces a normal acceptance).
        if (rescueAdopt === null) {
          rescueAdopt = this.maybeRescue(
            det,
            center.x,
            center.y,
            frame,
            pred,
            dt,
            trackFresh,
            coldFloor,
            sizeCapFrac,
            hasLocalityPrior,
          );
        }
        continue;
      }

      // Reject an implausibly LARGE ball box (a near-frame-size false positive
      // that the round-aspect gate lets through and that paints a giant circle
      // over the whole screen). A real basketball never fills half the frame.
      // sizeCapFrac is the config default unless a session FT-seed anchor
      // SHRANK it (see setSessionBallSizeCap — never looser than the default).
      if (
        det.box.width > frame.frameWidth * sizeCapFrac ||
        det.box.height > frame.frameHeight * sizeCapFrac
      ) {
        this.stats.rejSize++;
        this.stats.lastReject = 'size';
        continue;
      }

      if (!this.passesAspectGate(det.box, pred, dt, hasLocalityPrior)) {
        this.stats.rejAspect++;
        this.stats.lastReject = 'aspect';
        continue;
      }
      if (!this.passesJumpGate(center.x, center.y, t)) {
        this.stats.rejJump++;
        this.stats.lastReject = 'jump';
        continue;
      }

      // Score weighted by inverse distance to the Kalman prediction.
      const weight =
        pred !== null
          ? det.score / (1 + distance(center, pred))
          : det.score;
      if (weight > bestWeight) {
        bestWeight = weight;
        best = { det, cx: center.x, cy: center.y };
        bestGate = inHoopRoi
          ? 'hoopRoi'
          : trackFresh || nearWrist || inCorridor
            ? 'tracking'
            : 'cold';
      }
    }

    if (best === null && rescueAdopt !== null) {
      // No candidate survived the normal path but the rescue chain matured:
      // adopt the banded det. One-sided by construction — it only ever ADDS a
      // tracked ball where today there was none, and the FSM judge path sees
      // the same vetted TrackedBall stream either way.
      best = rescueAdopt;
      bestGate = 'cold';
      this.stats.rescued = true;
    }
    if (best !== null) {
      // Any acceptance restarts phantom accumulation — the chain either got
      // adopted or is superseded by a real track.
      this.rescueBuf.length = 0;
    }
    this.stats.accepted = best !== null;
    this.stats.gate = bestGate;
    return best;
  }

  /**
   * Persistence rescue (recall-up, judgment-untouched — flag-gated by
   * settings.trackerRescue via setRescue).
   *
   * WHY: DetectionBoxes draws balls at DETECTION.ballScoreMin (0.2) while a
   * per-model cold gate (setColdGate — nano-v2's 0.35) may demand far more to
   * START a track, so a real ball in the 0.2..0.35 band is visibly "seen"
   * yet never tracked. A single banded det is exactly the phantom the raised
   * gate exists to reject — but a det that passes every NON-score gate and
   * reappears COHERENTLY (rescueFrames sightings within rescueWindowSec,
   * stepping ≤ rescueMaxStepDiameters diameters) with real net travel
   * (≥ rescueMinTravelDiameters diameters, killing static lights/rafters/
   * background hoops) is behaving like a ball, not like noise. The band is
   * [ballScoreMin, activeColdFloor): EMPTY unless a per-model gate raised the
   * floor, so default models are provably unaffected.
   *
   * Returns the adopted candidate when the chain matures, else null after
   * (possibly) extending the chain. One sighting per frame: same-timestamp
   * duplicates are ignored.
   */
  private maybeRescue(
    det: Detection,
    cx: number,
    cy: number,
    frame: FrameDetections,
    pred: KalmanEstimate | null,
    dt: number,
    trackFresh: boolean,
    coldFloor: number,
    sizeCapFrac: number,
    hasLocalityPrior: boolean,
  ): Candidate | null {
    if (!this.rescueEnabled || trackFresh) return null;
    // The rescue band. Note dark scenes LOWER the floor below ballScoreMin,
    // which makes the band empty there too — dark already has its own relief.
    if (det.score < DETECTION.ballScoreMin || det.score >= coldFloor) {
      return null;
    }
    // Every non-score gate must still pass — the rescue bridges the score
    // band ONLY; size/aspect/jump keep their full authority.
    if (
      det.box.width > frame.frameWidth * sizeCapFrac ||
      det.box.height > frame.frameHeight * sizeCapFrac
    ) {
      return null;
    }
    if (!this.passesAspectGate(det.box, pred, dt, hasLocalityPrior)) {
      return null;
    }
    if (!this.passesJumpGate(cx, cy, frame.t)) return null;

    const t = frame.t;
    const r = (det.box.width + det.box.height) / 4;
    // Drop sightings that fell out of the coherence window.
    while (
      this.rescueBuf.length > 0 &&
      this.rescueBuf[0].t < t - TRACKER.rescueWindowSec
    ) {
      this.rescueBuf.shift();
    }
    const tail =
      this.rescueBuf.length > 0
        ? this.rescueBuf[this.rescueBuf.length - 1]
        : null;
    if (tail !== null) {
      // One sighting per frame keeps "N coherent times" meaning N frames.
      if (t <= tail.t) return null;
      if (
        Math.hypot(cx - tail.x, cy - tail.y) >
        TRACKER.rescueMaxStepDiameters * (2 * r)
      ) {
        // Incoherent with the accumulating chain — start over from here.
        this.rescueBuf.length = 0;
      }
    }
    this.rescueBuf.push({ x: cx, y: cy, r, t });
    if (this.rescueBuf.length > RESCUE_BUF_CAP) this.rescueBuf.shift();

    if (this.rescueBuf.length >= TRACKER.rescueFrames) {
      const first = this.rescueBuf[0];
      const travel = Math.hypot(cx - first.x, cy - first.y);
      if (travel >= TRACKER.rescueMinTravelDiameters * (2 * r)) {
        return { det, cx, cy };
      }
    }
    return null;
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
   *
   * COLD elongated boxes (no Kalman prediction) used to be rejected
   * unconditionally — which silently killed the very first detection of a
   * fast, motion-blurred ball, so the flight was never picked up at all.
   * `hasLocalityPrior` (candidate inside the flight corridor or the wrist-
   * seed radius) is an EXTERNAL "the ball must be here" prior that
   * substitutes for the missing velocity: with it a cold streak is accepted;
   * without it (the default) legacy behavior is byte-identical. Bounded by
   * construction — never a blanket relaxation.
   */
  private passesAspectGate(
    box: Box,
    pred: KalmanEstimate | null,
    dtSec: number,
    hasLocalityPrior = false,
  ): boolean {
    const tallSkinny = box.width * TRACKER.aspectWidthFactor < box.height;
    const wideShort = box.height * TRACKER.aspectWidthFactor < box.width;
    if (!tallSkinny && !wideShort) return true;

    // Elongated box. Blur-streak exception requires a known fast velocity —
    // or, cold, an external locality prior standing in for it.
    if (pred === null) return hasLocalityPrior;
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
   * sample within the `jumpWindowSec` wall-clock window. Once the last
   * acceptance is older than the window the gate releases so the track can
   * re-acquire anywhere.
   *
   * TIME-AWARE for slow devices in BOTH dimensions:
   *  - the WINDOW is wall-clock (jumpWindowSec) so it releases after the same
   *    ~167 ms regardless of fps — a frame count would keep the gate armed
   *    625 ms at 8 fps, blocking a legitimate re-acquire for far too long;
   *  - the ALLOWANCE is the larger of the classic `jumpDiameters` floor and a
   *    max-plausible-speed budget (`maxSpeedDiametersPerSec × Δt`), because at
   *    low fps a legitimately fast ball covers far more ground between
   *    detections.
   */
  private passesJumpGate(cx: number, cy: number, t: number): boolean {
    const last = this.lastAccept;
    if (last === null) return true;
    if (
      this.lastAcceptT !== null &&
      t - this.lastAcceptT > TRACKER.jumpWindowSec + GATE_EPS_SEC
    ) {
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
      // Low-confidence detections are noisier measurements: anything under
      // the full open-court gate (hoop-ROI relaxed, flight-continuation,
      // wrist-seeded AND dark-relaxed cold accepts alike) gets the doubled
      // measurement noise so it nudges rather than yanks the track. The
      // reference is deliberately ballScoreMin — NOT the dark floor — so a
      // sub-0.2 sample accepted in the dark is still down-weighted.
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
