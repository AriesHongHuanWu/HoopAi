/**
 * Pose-based shooting-form analysis.
 *
 * - {@link OneEuroFilter}: standard One-Euro low-pass for pose landmarks.
 * - {@link FormAnalyzer}: per-frame jump-shot phase detection
 *   (PICKUP → DIP → RISE → RELEASE → FOLLOW_THROUGH) and per-shot
 *   {@link FormMetrics} extraction from filtered COCO-17 keypoints.
 * - {@link coachingTips}: deterministic rule engine turning metrics into at
 *   most 3 prioritized {@link CoachingTip}s (one-cue-at-a-time coaching).
 *
 * Pure TypeScript, analysis-frame pixel space (+y DOWN), time in seconds
 * from camera timestamps. No I/O, no wall clock.
 */
import { FORM } from './config';
import { angleAtDeg } from './geometry';
import type {
  CoachingTip,
  FormMetrics,
  FormPhase,
  Point,
  PoseFrame,
  PoseKeypointName,
  ShootingHand,
  TrackedBall,
} from './types';

// ---------------------------------------------------------------------------
// One-Euro filter
// ---------------------------------------------------------------------------

/** Smoothing factor for a first-order low-pass at `cutoff` Hz and step `dt`. */
function smoothingAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * Standard One-Euro filter (Casiez et al. 2012): an adaptive first-order
 * low-pass whose cutoff rises with signal speed — heavy jitter suppression
 * when a landmark is still, minimal lag when it moves fast.
 *
 * Defaults come from {@link FORM}.oneEuro. Time is in seconds; calls with
 * non-increasing timestamps return the last filtered value unchanged.
 */
export class OneEuroFilter {
  private readonly minCutoff: number;
  private readonly beta: number;
  private readonly dCutoff: number;
  private primed = false;
  private prevT = 0;
  private xHat = 0;
  private dxHat = 0;

  constructor(cfg?: { minCutoff?: number; beta?: number; dCutoff?: number }) {
    this.minCutoff = cfg?.minCutoff ?? FORM.oneEuro.minCutoff;
    this.beta = cfg?.beta ?? FORM.oneEuro.beta;
    this.dCutoff = cfg?.dCutoff ?? FORM.oneEuro.dCutoff;
  }

  /** Feed one sample at time `t` (seconds) and get the filtered value. */
  filter(value: number, t: number): number {
    if (!this.primed) {
      this.primed = true;
      this.prevT = t;
      this.xHat = value;
      this.dxHat = 0;
      return value;
    }
    const dt = t - this.prevT;
    if (dt <= 0) return this.xHat;
    const dx = (value - this.xHat) / dt;
    const aD = smoothingAlpha(this.dCutoff, dt);
    this.dxHat = aD * dx + (1 - aD) * this.dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxHat);
    const a = smoothingAlpha(cutoff, dt);
    this.xHat = a * value + (1 - a) * this.xHat;
    this.prevT = t;
    return this.xHat;
  }

  /** Forget all state; the next `filter()` call passes its input through. */
  reset(): void {
    this.primed = false;
    this.xHat = 0;
    this.dxHat = 0;
    this.prevT = 0;
  }
}

// ---------------------------------------------------------------------------
// FormAnalyzer
// ---------------------------------------------------------------------------

/** Reusable per-landmark filter pair + scratch point (allocation-free push). */
interface LandmarkChannel {
  fx: OneEuroFilter;
  fy: OneEuroFilter;
  pt: Point;
}

/** Wrist y must drop at least this many px below its max to detect the dip. */
const DIP_EPS_PX = 0.25;
/** Ball–wrist separation confirmed after this many consecutive frames. */
const RELEASE_CONFIRM_FRAMES = 2;
/** Ball–wrist separation threshold in ball radii. */
const RELEASE_SEP_RADII = 2;
/** Pickup proximity threshold in shoulder–hip distances. */
const PICKUP_REACH_FACTOR = 1.5;
/** Follow-through elbow angle is averaged over this window after release. */
const FT_AVG_WINDOW_SEC = 0.15;

/** Internal lifecycle stage (finer than the public FormPhase). */
type Stage = 'WAIT' | 'PICKUP' | 'RISE' | 'FOLLOW';

/**
 * Streaming analyzer for a single shot attempt. Feed every camera frame's
 * pose (+ tracked ball, if any) via {@link FormAnalyzer.push}, then call
 * {@link FormAnalyzer.finalize} once the shot resolves, and
 * {@link FormAnalyzer.reset} before the next attempt.
 *
 * All used landmark coordinates are One-Euro filtered (x and y separately,
 * one filter pair per landmark); keypoints scoring below
 * `FORM.keypointScoreMin` are treated as missing.
 */
export class FormAnalyzer {
  private readonly hand: ShootingHand;
  private readonly frameHeight: number;
  private readonly channels = new Map<PoseKeypointName, LandmarkChannel>();

  private stage: Stage = 'WAIT';
  private currentPhase: FormPhase | null = null;

  private tPickup: number | null = null;

  /** Dip candidate: running max of filtered wrist y since pickup. */
  private dipMaxWristY = -Infinity;
  private dipConfirmed = false;
  private dipElbowDeg: number | null = null;
  private dipKneeDeg: number | null = null;

  /** Release detection (2-consecutive-frame separation streak). */
  private sepStreak = 0;
  private pendingReleaseT = 0;
  private pendingReleaseWristY = 0;
  private pendingReleaseElbowDeg: number | null = null;

  private tRelease: number | null = null;
  private releaseWristY: number | null = null;

  /** Follow-through elbow samples (parallel arrays, numbers only). */
  private readonly ftT: number[] = [];
  private readonly ftDeg: number[] = [];

  constructor(opts: { hand: ShootingHand; frameHeight: number }) {
    this.hand = opts.hand;
    this.frameHeight = opts.frameHeight;
  }

  /**
   * Current shot phase, or null before the ball pickup is detected.
   * 'DIP' and 'RELEASE' are reported exactly on their detection frame.
   */
  get phase(): FormPhase | null {
    return this.currentPhase;
  }

  /**
   * Feed one frame: the detected pose and the tracked ball (null when the
   * ball is not visible this frame). Landmarks are filtered internally.
   */
  push(pose: PoseFrame, ball: TrackedBall | null): void {
    const t = pose.t;

    // Instantaneous phases advance to their follow-up phase on the next frame.
    if (this.currentPhase === 'DIP') this.currentPhase = 'RISE';
    else if (this.currentPhase === 'RELEASE') this.currentPhase = 'FOLLOW_THROUGH';

    const side = this.hand;
    const other: ShootingHand = side === 'right' ? 'left' : 'right';

    const shoulder = this.landmark(pose, `${side}_shoulder` as PoseKeypointName);
    const elbow = this.landmark(pose, `${side}_elbow` as PoseKeypointName);
    const wrist = this.landmark(pose, `${side}_wrist` as PoseKeypointName);
    const hip = this.landmark(pose, `${side}_hip` as PoseKeypointName);
    const knee = this.landmark(pose, `${side}_knee` as PoseKeypointName);
    const ankle = this.landmark(pose, `${side}_ankle` as PoseKeypointName);

    const elbowDeg =
      shoulder && elbow && wrist ? angleAtDeg(shoulder, elbow, wrist) : null;

    let kneeDeg = hip && knee && ankle ? angleAtDeg(hip, knee, ankle) : null;
    if (kneeDeg == null) {
      // Fall back to the non-shooting side when shooting-side leg is missing.
      const oHip = this.landmark(pose, `${other}_hip` as PoseKeypointName);
      const oKnee = this.landmark(pose, `${other}_knee` as PoseKeypointName);
      const oAnkle = this.landmark(pose, `${other}_ankle` as PoseKeypointName);
      kneeDeg = oHip && oKnee && oAnkle ? angleAtDeg(oHip, oKnee, oAnkle) : null;
    }

    switch (this.stage) {
      case 'WAIT': {
        if (ball && wrist && shoulder && hip) {
          const reach =
            PICKUP_REACH_FACTOR *
            Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y);
          const dBallWrist = Math.hypot(ball.cx - wrist.x, ball.cy - wrist.y);
          if (dBallWrist <= reach && ball.cy > shoulder.y) {
            this.stage = 'PICKUP';
            this.currentPhase = 'PICKUP';
            this.tPickup = t;
            this.dipMaxWristY = wrist.y;
            this.dipElbowDeg = elbowDeg;
            this.dipKneeDeg = kneeDeg;
          }
        }
        break;
      }
      case 'PICKUP': {
        if (wrist) {
          if (wrist.y >= this.dipMaxWristY) {
            // Still dipping (or holding): track the lowest wrist point.
            this.dipMaxWristY = wrist.y;
            this.dipElbowDeg = elbowDeg;
            this.dipKneeDeg = kneeDeg;
          } else if (this.dipMaxWristY - wrist.y > DIP_EPS_PX) {
            // Wrist started rising: the dip frame is behind us.
            this.dipConfirmed = true;
            this.stage = 'RISE';
            this.currentPhase = 'DIP';
          }
        }
        this.checkRelease(t, ball, wrist, elbowDeg);
        break;
      }
      case 'RISE': {
        this.checkRelease(t, ball, wrist, elbowDeg);
        break;
      }
      case 'FOLLOW': {
        if (
          this.tRelease != null &&
          elbowDeg != null &&
          t - this.tRelease <= FORM.followThrough.holdSec + 1e-9
        ) {
          this.ftT.push(t);
          this.ftDeg.push(elbowDeg);
        }
        break;
      }
    }
  }

  /**
   * Combine pose-derived metrics with the ball-derived angles measured by
   * the shot FSM. Anything unmeasurable (missing landmarks, phase never
   * reached) is null — never NaN.
   */
  finalize(shot: {
    entryAngleDeg: number | null;
    releaseAngleDeg: number | null;
  }): FormMetrics {
    const tRelease = this.tRelease;

    let releaseTimeMs: number | null = null;
    if (tRelease != null && this.tPickup != null) {
      releaseTimeMs = (tRelease - this.tPickup) * 1000;
    }

    let followThroughElbowDeg: number | null = null;
    let followThroughHeldMs: number | null = null;
    if (tRelease != null && this.ftT.length > 0) {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < this.ftT.length; i++) {
        const ft = this.ftT[i]!;
        if (ft - tRelease <= FT_AVG_WINDOW_SEC + 1e-9) {
          sum += this.ftDeg[i]!;
          n++;
        }
      }
      if (n > 0) followThroughElbowDeg = sum / n;

      // Duration the elbow stayed extended, from release, without a break.
      let heldEnd: number | null = null;
      for (let i = 0; i < this.ftT.length; i++) {
        if (this.ftDeg[i]! >= FORM.followThrough.elbowMinDeg) {
          heldEnd = this.ftT[i]!;
        } else {
          break;
        }
      }
      const capMs = FORM.followThrough.holdSec * 1000;
      followThroughHeldMs =
        heldEnd == null ? 0 : Math.min((heldEnd - tRelease) * 1000, capMs);
    }

    let releaseHeightNorm: number | null = null;
    if (this.releaseWristY != null && this.frameHeight > 0) {
      releaseHeightNorm = 1 - this.releaseWristY / this.frameHeight;
    }

    return {
      setPointElbowDeg: this.dipConfirmed ? this.dipElbowDeg : null,
      kneeFlexionDeg: this.dipConfirmed ? this.dipKneeDeg : null,
      releaseAngleDeg: shot.releaseAngleDeg,
      entryAngleDeg: shot.entryAngleDeg,
      releaseTimeMs,
      followThroughHeldMs,
      followThroughElbowDeg,
      releaseHeightNorm,
    };
  }

  /** Clear all per-shot state (keeps filter instances, resets their state). */
  reset(): void {
    for (const ch of this.channels.values()) {
      ch.fx.reset();
      ch.fy.reset();
    }
    this.stage = 'WAIT';
    this.currentPhase = null;
    this.tPickup = null;
    this.dipMaxWristY = -Infinity;
    this.dipConfirmed = false;
    this.dipElbowDeg = null;
    this.dipKneeDeg = null;
    this.sepStreak = 0;
    this.pendingReleaseElbowDeg = null;
    this.tRelease = null;
    this.releaseWristY = null;
    this.ftT.length = 0;
    this.ftDeg.length = 0;
  }

  /**
   * RELEASE: ball–wrist distance > 2×ball radius for 2 consecutive frames
   * with the ball moving up (vy < 0). Release time/height are taken from the
   * FIRST frame of the streak.
   */
  private checkRelease(
    t: number,
    ball: TrackedBall | null,
    wrist: Point | null,
    elbowDeg: number | null,
  ): void {
    if (!ball || !wrist) {
      this.sepStreak = 0;
      return;
    }
    const d = Math.hypot(ball.cx - wrist.x, ball.cy - wrist.y);
    if (d > RELEASE_SEP_RADII * ball.r && ball.vy < 0) {
      if (this.sepStreak === 0) {
        this.pendingReleaseT = t;
        this.pendingReleaseWristY = wrist.y;
        this.pendingReleaseElbowDeg = elbowDeg;
      }
      this.sepStreak++;
      if (this.sepStreak >= RELEASE_CONFIRM_FRAMES) {
        this.tRelease = this.pendingReleaseT;
        this.releaseWristY = this.pendingReleaseWristY;
        // A release without a detected rise still fixes the dip candidate.
        if (this.tPickup != null) this.dipConfirmed = true;
        if (this.pendingReleaseElbowDeg != null) {
          this.ftT.push(this.pendingReleaseT);
          this.ftDeg.push(this.pendingReleaseElbowDeg);
        }
        if (elbowDeg != null) {
          this.ftT.push(t);
          this.ftDeg.push(elbowDeg);
        }
        this.stage = 'FOLLOW';
        this.currentPhase = 'RELEASE';
      }
    } else {
      this.sepStreak = 0;
    }
  }

  /**
   * Filtered position of one landmark, or null when missing / low-score.
   * Reuses one Point per landmark to stay allocation-free per frame.
   */
  private landmark(pose: PoseFrame, name: PoseKeypointName): Point | null {
    const raw = pose.keypoints[name];
    if (!raw || raw.score < FORM.keypointScoreMin) return null;
    let ch = this.channels.get(name);
    if (!ch) {
      ch = {
        fx: new OneEuroFilter(FORM.oneEuro),
        fy: new OneEuroFilter(FORM.oneEuro),
        pt: { x: 0, y: 0 },
      };
      this.channels.set(name, ch);
    }
    ch.pt.x = ch.fx.filter(raw.x, pose.t);
    ch.pt.y = ch.fy.filter(raw.y, pose.t);
    return ch.pt;
  }
}

// ---------------------------------------------------------------------------
// Coaching engine
// ---------------------------------------------------------------------------

/** Internal tip candidate carrying its normalized band deviation. */
interface TipCandidate extends CoachingTip {
  /** Deviation outside the ideal band, normalized by the band width. */
  dev: number;
}

function pushBandTip(
  out: TipCandidate[],
  metric: CoachingTip['metric'],
  severity: 1 | 2,
  title: string,
  message: string,
  dev: number,
): void {
  out.push({ metric, severity, title, message, dev });
}

/**
 * Deterministic coaching rule engine over one shot's {@link FormMetrics}
 * (plus optional session-level release-angle consistency).
 *
 * Returns AT MOST 3 tips, sorted by severity descending (ties broken by
 * larger band deviation). Among all notable band violations, exactly ONE tip
 * — the worst relative deviation from its ideal band — is promoted to
 * severity 3 (one cue at a time). The slow-release flag is informational
 * only (severity 1, never promoted).
 */
export function coachingTips(
  metrics: FormMetrics,
  sessionStd?: { releaseAngleStdDeg: number | null },
): CoachingTip[] {
  const cands: TipCandidate[] = [];
  const E = FORM.elbowSetPoint;
  const K = FORM.kneeFlexion;
  const R = FORM.releaseAngle;
  const N = FORM.entryAngle;

  // Elbow set point at the dip.
  const elbow = metrics.setPointElbowDeg;
  if (elbow != null) {
    const w = E.max - E.min;
    if (elbow < E.min) {
      pushBandTip(
        cands,
        'setPointElbowDeg',
        elbow < E.flagBelow ? 2 : 1,
        'Raise your set point',
        `Your elbow was at ${Math.round(elbow)}° in the dip — get it closer to ${E.min}–${E.max}° before you rise.`,
        (E.min - elbow) / w,
      );
    } else if (elbow > E.max) {
      pushBandTip(
        cands,
        'setPointElbowDeg',
        elbow > E.flagAbove ? 2 : 1,
        'Lower your set point',
        `Your elbow opened to ${Math.round(elbow)}° in the dip — keep it in the ${E.min}–${E.max}° pocket.`,
        (elbow - E.max) / w,
      );
    }
  }

  // Knee flexion at the deepest dip.
  const knee = metrics.kneeFlexionDeg;
  if (knee != null) {
    const w = K.max - K.min;
    if (knee > K.max) {
      pushBandTip(
        cands,
        'kneeFlexionDeg',
        knee >= K.flagStiff ? 2 : 1,
        'Bend your knees',
        `Legs were nearly straight (${Math.round(knee)}°) — load into your legs for power and rhythm.`,
        (knee - K.max) / w,
      );
    } else if (knee < K.min) {
      pushBandTip(
        cands,
        'kneeFlexionDeg',
        knee <= K.flagDeep ? 2 : 1,
        'Ease the dip',
        `You sank to ${Math.round(knee)}° at the knees — a shallower, quicker load keeps the shot fluid.`,
        (K.min - knee) / w,
      );
    }
  }

  // Release angle (from ball trajectory).
  const rel = metrics.releaseAngleDeg;
  if (rel != null) {
    const w = R.max - R.min;
    if (rel < R.min) {
      pushBandTip(
        cands,
        'releaseAngleDeg',
        rel < R.flagLow + 1e-9 ? 2 : 1,
        'Add arc',
        `The ball left at ${Math.round(rel)}° — aim for a ${R.min}–${R.max}° launch.`,
        (R.min - rel) / w,
      );
    } else if (rel > R.max) {
      pushBandTip(
        cands,
        'releaseAngleDeg',
        rel > R.flagHigh ? 2 : 1,
        'Flatten slightly',
        `The ball left at ${Math.round(rel)}° — bring the launch back toward ${R.min}–${R.max}°.`,
        (rel - R.max) / w,
      );
    }
  }

  // Entry angle vs the Noah 43–47° band.
  const entry = metrics.entryAngleDeg;
  if (entry != null) {
    const w = N.max - N.min;
    if (entry < N.min) {
      pushBandTip(
        cands,
        'entryAngleDeg',
        2,
        'Shoot with more arc',
        `The ball came in flat at ${Math.round(entry)}° — a ${N.min}–${N.max}° entry gives the ball the biggest target.`,
        (N.min - entry) / w,
      );
    } else if (entry > N.max) {
      pushBandTip(
        cands,
        'entryAngleDeg',
        2,
        'Bring the arc down',
        `The ball dropped in at ${Math.round(entry)}° — flatten toward the ${N.min}–${N.max}° window.`,
        (entry - N.max) / w,
      );
    }
  }

  // Follow-through collapse: elbow under threshold within the hold window.
  const ftDeg = metrics.followThroughElbowDeg;
  const ftHeld = metrics.followThroughHeldMs;
  const holdMs = FORM.followThrough.holdSec * 1000;
  const ftCollapsed =
    (ftDeg != null && ftDeg < FORM.followThrough.elbowMinDeg) ||
    (ftHeld != null && ftHeld < holdMs);
  if (ftCollapsed) {
    const dev =
      ftDeg != null && ftDeg < FORM.followThrough.elbowMinDeg
        ? (FORM.followThrough.elbowMinDeg - ftDeg) /
          (180 - FORM.followThrough.elbowMinDeg)
        : (holdMs - (ftHeld ?? 0)) / holdMs;
    pushBandTip(
      cands,
      'followThroughElbowDeg',
      2,
      'Hold your follow-through',
      'Keep the arm extended and the wrist snapped until the ball hits the rim.',
      dev,
    );
  }

  // Session consistency (release-angle spread).
  const std = sessionStd?.releaseAngleStdDeg;
  if (std != null && std > FORM.releaseAngleStdFlagDeg) {
    pushBandTip(
      cands,
      'consistency',
      2,
      'Consistency over power',
      `Your release angle is varying ±${Math.round(std)}° — groove one identical motion before adding range.`,
      (std - FORM.releaseAngleStdFlagDeg) / FORM.releaseAngleStdFlagDeg,
    );
  }

  // Slow release: informational only, never the headline cue.
  const rt = metrics.releaseTimeMs;
  if (rt != null && rt > FORM.releaseTime.typical * 1000) {
    cands.push({
      metric: 'releaseTimeMs',
      severity: 1,
      title: 'Quicken your release',
      message: `From pickup to release took ${(rt / 1000).toFixed(2)}s — game speed is under ${FORM.releaseTime.typical.toFixed(1)}s.`,
      dev: 0,
    });
  }

  // Promote exactly one severity-3 headline: the worst notable band deviation.
  let worst = -1;
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i]!;
    if (c.severity === 2 && (worst === -1 || c.dev > cands[worst]!.dev)) {
      worst = i;
    }
  }
  if (worst >= 0) cands[worst]!.severity = 3;

  cands.sort((a, b) => b.severity - a.severity || b.dev - a.dev);

  const out: CoachingTip[] = [];
  for (let i = 0; i < cands.length && i < 3; i++) {
    const c = cands[i]!;
    out.push({
      metric: c.metric,
      severity: c.severity,
      title: c.title,
      message: c.message,
    });
  }
  return out;
}
