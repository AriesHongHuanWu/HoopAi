/**
 * JS-thread pipeline orchestrator.
 *
 * The camera worklet does the heavy lifting (GPU resize → TFLite runSync →
 * output parsing → optional net-motion scalar) and ships ONE small payload
 * per analysed frame to the JS thread via scheduleOnRN. This class consumes
 * those payloads and runs the tracking/decision core, then fans out UI events.
 *
 * v2 upgrade path: move this whole class into the worklet runtime and swap
 * the scheduleOnRN hop for direct SharedValue writes (docs/ARCHITECTURE.md §2).
 */
import { DETECTION, RIM, SHOT_FSM } from '../core/config';
import { BallTracker } from '../core/ballTracker';
import { estimateShotValue } from '../core/court';
import { FormAnalyzer, coachingTips } from '../core/formAnalysis';
import { RimLock } from '../core/rimLock';
import { estimateShotValueMetric } from '../core/courtGeometric';
import { evalArc, fitArc, predictLanding } from '../core/trajectory';
import { ShotFsm } from '../core/shotFsm';
import { classifyViewBand } from '../core/viewBand';
import type {
  BallSample,
  Box,
  Detection,
  FrameDetections,
  PoseFrame,
  ResolvedShot,
  RimGeometry,
  ShootingHand,
  ShotPhase,
  TrackedBall,
} from '../core/types';

/** Payload produced by the camera worklet for every analysed frame. */
export interface FramePayload {
  frame: FrameDetections;
  /** 0..1 motion score inside the current net ROI (0 when not computed). */
  netMotionScore: number;
  /**
   * Pose keypoints for this frame, present only when form analysis is enabled
   * and the pose model ran. Null/undefined otherwise (analysis is skipped).
   */
  pose?: PoseFrame | null;
}

export interface PipelineEvents {
  /** Fired once when the rim first locks (and again after re-locks). */
  onRimLocked?: (rim: RimGeometry) => void;
  /** Camera-bump detected: rim drifted, tracking paused until re-lock. */
  onRimDrift?: () => void;
  /** Fired on every analysed frame — drive overlays from this. */
  onFrame?: (state: PipelineFrameState) => void;
  /** Fired exactly once per resolved shot. */
  onShot?: (shot: ResolvedShot) => void;
}

export interface PipelineFrameState {
  t: number;
  ball: TrackedBall | null;
  rim: RimGeometry | null;
  phase: ShotPhase;
  liveTrajectory: readonly { cx: number; cy: number }[];
  frameWidth: number;
  frameHeight: number;
  /** Raw model detections this frame (analysis px) — for the debug box overlay. */
  detections: readonly Detection[];
  /** Seconds left on the pre-lock "hold steady" countdown (rounds up to a 3-2-1
   *  reticle in the HUD), or null when not counting / already locked. */
  rimCountdown: number | null;
  /**
   * PREDICTED landing point of the live shot (analysis px): the fitted arc
   * extrapolated to the rim plane, updated every frame while the shot flies.
   * inSpan = the prediction lands within the rim's crossing span (on target).
   * Null outside SHOT_LIVE or before the fit is trustworthy.
   */
  predictedLanding: { x: number; y: number; inSpan: boolean } | null;
  /**
   * Sampled FUTURE arc from the ball's latest sample to the predicted landing
   * (flattened x,y pairs, analysis px) — what the HUD draws as the dashed
   * "where it's going" path while the ball itself may be undetected. Empty
   * when no trustworthy prediction exists.
   */
  predictedPath: number[];
}

export class ShotPipeline {
  private readonly tracker = new BallTracker({});
  private readonly rimLock = new RimLock({ lockHoldSec: RIM.lockHoldSec });
  private fsm: ShotFsm | null = null;
  private events: PipelineEvents;
  private lastRim: RimGeometry | null = null;
  private wasDrifted = false;

  /** Pose-based form analyzer (lazy; only alive while pose frames arrive). */
  private form: FormAnalyzer | null = null;
  private formHand: ShootingHand = 'right';
  /** Ball size (Settings > Player) — forwarded to the FSM's depth gate. */
  private ballSize: 7 | 6 | 5 = 7;
  /** Depth-ratio parallax veto flag (Settings, experimental). Applied when
   *  the FSM is created at rim lock — i.e. per session. */
  private depthVeto = false;
  /** Metric 2/3 estimation flag (Settings, experimental). */
  private metric23 = false;
  /** Reappearance corroborator flag (Settings, experimental). */
  private reappearance = false;
  /** Camera pitch at/around rim lock from the IMU, degrees +up; null = no IMU. */
  private viewPitchDeg: number | null = null;
  private sawPoseThisShot = false;
  /** Latest pose ankle-midpoint (analysis px) — the pose-based shooter foot for
   *  2/3 estimation. Null until a pose with a visible ankle arrives. */
  private lastPoseFootPx: { x: number; y: number } | null = null;

  constructor(events: PipelineEvents = {}) {
    this.events = events;
  }

  setEvents(events: PipelineEvents): void {
    this.events = events;
  }

  /** Shooting hand for form analysis (from Settings). */
  setFormHand(hand: ShootingHand): void {
    this.formHand = hand;
  }

  /** Ball size (from Settings) — the depth gate's metric ruler. */
  setBallSize(size: 7 | 6 | 5): void {
    this.ballSize = size;
    this.fsm?.setBallSize(size);
  }

  /** Depth-ratio parallax veto (from Settings). Takes effect at rim lock. */
  setDepthVeto(enabled: boolean): void {
    this.depthVeto = enabled;
  }

  /** Metric 2/3 estimation (from Settings). */
  setMetric23(enabled: boolean): void {
    this.metric23 = enabled;
  }

  /** Reappearance corroborator (from Settings). Takes effect at rim lock. */
  setReappearance(enabled: boolean): void {
    this.reappearance = enabled;
  }

  /** IMU camera pitch, degrees +up (EMA'd by the engine). Feeds the view-band
   *  classifier at rim lock and the metric 2/3 estimator per shot. */
  setViewPitch(pitchDeg: number | null): void {
    this.viewPitchDeg = pitchDeg;
  }

  /** Manual rim override from the live tap-to-set-rim. */
  setManualRim(box: Box, frame: { width: number; height: number }): void {
    this.rimLock.setManual(box);
    const rim = this.rimLock.geometry;
    if (rim) this.adoptRim(rim, frame);
  }

  /**
   * Drop the current rim lock and return to acquiring (the "Re-aim" control).
   * Only clears the rim + its derived geometry — the ball tracker/FSM stay put
   * (a re-aim mid-session shouldn't wipe an in-flight shot's context).
   */
  reAim(): void {
    this.rimLock.reset();
    this.lastRim = null;
    this.wasDrifted = false;
  }

  get rimGeometry(): RimGeometry | null {
    return this.lastRim;
  }

  /** Feed one worklet payload. Returns the frame state (also sent to onFrame). */
  step(payload: FramePayload): PipelineFrameState {
    const { frame, netMotionScore } = payload;
    const dims = { width: frame.frameWidth, height: frame.frameHeight };

    const rim = this.rimLock.step(frame, frame.t) ?? this.rimLock.geometry;
    if (rim && rim !== this.lastRim) this.adoptRim(rim, dims);

    if (this.rimLock.driftDetected && !this.wasDrifted) {
      this.wasDrifted = true;
      this.events.onRimDrift?.();
    } else if (!this.rimLock.driftDetected && this.wasDrifted) {
      // Re-locked after a camera bump — announce so the UI clears its banner.
      this.wasDrifted = false;
      if (this.lastRim) this.events.onRimLocked?.(this.lastRim);
    }

    const ball = this.tracker.step(frame, this.lastRim?.hoopRoi ?? null);

    // Form analysis (opt-in): feed each frame's pose to the analyzer so it can
    // track the shot phases (dip → release → follow-through). Entirely skipped
    // when no pose arrives, so it never touches the normal detection path.
    const pose = payload.pose;
    if (pose) {
      if (!this.form) this.form = new FormAnalyzer({ hand: this.formHand, frameHeight: frame.frameHeight });
      this.form.push(pose, ball);
      this.sawPoseThisShot = true;
      // Pose (MoveNet) gives a far more reliable shooter foot than the YOLO
      // person box for the 2/3-point estimate — the ankle keypoints are exactly
      // "where they're standing". Keep the latest ankle midpoint (analysis px);
      // the shooter barely moves during a shot, so the latest is a good origin.
      const foot = poseFootPx(pose);
      if (foot) this.lastPoseFootPx = foot;
    }

    let phase: ShotPhase = 'IDLE';
    let liveTrajectory: readonly BallSample[] = [];
    let resolved: ResolvedShot | null = null;

    if (this.fsm && this.lastRim) {
      const person = bestPerson(frame);
      const result = this.fsm.step({
        t: frame.t,
        ball,
        ballInBasketScore: maxScore(frame, 'ball_in_basket'),
        netMotionScore,
        personBox: person,
      });
      phase = result.phase;
      liveTrajectory = result.liveTrajectory;
      resolved = result.resolved;
    }

    // Predicted landing: fit the live arc and extrapolate to the rim plane.
    // Cheap (O(n) over ≤48 samples, only while a shot is live) and it's what
    // powers the on-screen "this is where it's coming down" ghost target.
    let predictedLanding: PipelineFrameState['predictedLanding'] = null;
    const predictedPath: number[] = [];
    if (phase === 'SHOT_LIVE' && this.lastRim && liveTrajectory.length >= 6) {
      const fit = fitArc(liveTrajectory);
      if (fit && fit.ya > 0 && fit.r2y >= 0.35) {
        const p = predictLanding(fit, this.lastRim.planeY);
        if (p) {
          predictedLanding = {
            x: p.x,
            y: p.y,
            inSpan:
              p.x >= this.lastRim.spanLeft && p.x <= this.lastRim.spanRight,
          };
          // Dashed forward path: latest sample → landing, sampled on the fit.
          const tLast = liveTrajectory[liveTrajectory.length - 1]!.t;
          if (p.t > tLast) {
            const K = 10;
            for (let i = 0; i <= K; i++) {
              const pt = evalArc(fit, tLast + ((p.t - tLast) * i) / K);
              if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) break;
              predictedPath.push(pt.x, pt.y);
            }
          }
        }
      }
    }

    const state: PipelineFrameState = {
      t: frame.t,
      ball,
      rim: this.lastRim,
      phase,
      liveTrajectory,
      frameWidth: frame.frameWidth,
      frameHeight: frame.frameHeight,
      detections: frame.detections,
      // Pre-lock countdown (null once locked) so the HUD can show 3-2-1.
      rimCountdown: this.lastRim ? null : this.rimLock.lockCountdown,
      predictedLanding,
      predictedPath,
    };
    this.events.onFrame?.(state);
    if (resolved) {
      // Automatic 2/3-point estimation: the model already marked the rim and
      // the shooter's foot (resolved.originX/Y). Attach the estimated value
      // BEFORE emitting so downstream stats/modes can score points.
      if (this.lastRim) {
        // Prefer the pose-derived foot (ankle midpoint) when a pose was tracked
        // this shot — it localizes the shooter far better than the person box.
        // Fall back to the FSM's person-box origin when no pose is available.
        let originX = resolved.originX;
        let originY = resolved.originY;
        if (this.sawPoseThisShot && this.lastPoseFootPx && frame.frameWidth > 0 && frame.frameHeight > 0) {
          originX = this.lastPoseFootPx.x / frame.frameWidth;
          originY = this.lastPoseFootPx.y / frame.frameHeight;
          resolved.originX = originX;
          resolved.originY = originY;
        }
        // METRIC estimator first (flagged): pinhole geometry off the rim's
        // real size + height gives the distance in METERS; the rim-widths
        // heuristic stays as the always-available fallback.
        let metric: ReturnType<typeof estimateShotValueMetric> = null;
        if (this.metric23 && originX != null && originY != null) {
          metric = estimateShotValueMetric({
            rimBox: this.lastRim.box,
            footX: originX * frame.frameWidth,
            footY: originY * frame.frameHeight,
            frameSize: frame.frameWidth,
            pitchDeg: this.viewPitchDeg,
          });
        }
        const est = estimateShotValue(
          this.lastRim,
          originX,
          originY,
          { width: frame.frameWidth, height: frame.frameHeight },
        );
        resolved.shotValue = metric ? metric.value : est.value;
        resolved.distanceRimWidths = est.distanceRimWidths;
        if (metric) resolved.distanceM = metric.distanceM;
      }
      // Finalize the pose-based form report (only if a pose was seen this shot).
      if (this.form && this.sawPoseThisShot) {
        try {
          const metrics = this.form.finalize({
            entryAngleDeg: resolved.entryAngleDeg,
            releaseAngleDeg: resolved.releaseAngleDeg,
          });
          const releasePose = this.form.releasePose;
          resolved.form = {
            metrics,
            tips: coachingTips(metrics),
            ...(releasePose ? { releasePose } : {}),
          };
        } catch {
          // Form analysis must never break shot emission.
        }
      }
      if (this.form) this.form.reset();
      this.sawPoseThisShot = false;
      this.lastPoseFootPx = null; // freshen per shot
      this.events.onShot?.(resolved);
    }
    return state;
  }

  reset(): void {
    this.tracker.reset();
    this.rimLock.reset();
    this.form = null;
    this.sawPoseThisShot = false;
    this.lastPoseFootPx = null;
    this.fsm = null;
    this.lastRim = null;
    this.wasDrifted = false;
  }

  private adoptRim(rim: RimGeometry, frame: { width: number; height: number }): void {
    const first = this.lastRim == null;
    this.lastRim = rim;
    if (this.fsm) {
      this.fsm.setRim(rim);
    } else {
      this.fsm = new ShotFsm(rim, frame, {
        useDepthRatioVeto: this.depthVeto,
        useReappearance: this.reappearance,
      });
      this.fsm.setBallSize(this.ballSize);
    }
    // Placement classification from the locked rim's aspect (IMU pitch not
    // wired yet -> null; the classifier is conservative without it). Only the
    // depth gate consumes the band today, so with the veto flag off this is
    // pure telemetry.
    const aspect = rim.box.height > 0 ? rim.box.width / rim.box.height : 1;
    this.fsm.setViewBand(classifyViewBand(aspect, this.viewPitchDeg).band);
    if (first) this.events.onRimLocked?.(rim);
  }
}

/**
 * Shooter foot from a pose frame: the midpoint of the two ankle keypoints
 * (analysis-frame px, already de-normalized by the pose parser). Uses whichever
 * ankle is visible; null when neither cleared the pose parser's score gate.
 * A far better "where they're standing" cue than the YOLO person-box bottom.
 */
function poseFootPx(pose: PoseFrame): { x: number; y: number } | null {
  const la = pose.keypoints.left_ankle;
  const ra = pose.keypoints.right_ankle;
  if (la && ra) return { x: (la.x + ra.x) / 2, y: (la.y + ra.y) / 2 };
  if (la) return { x: la.x, y: la.y };
  if (ra) return { x: ra.x, y: ra.y };
  return null;
}

function bestPerson(frame: FrameDetections): Box | null {
  let best: { score: number; box: Box } | null = null;
  for (const d of frame.detections) {
    // Gate on personScoreMin: a low-confidence spurious 'person' box (~0.15)
    // must not arm phantom layups or corrupt the shooter-origin 2/3 estimate.
    if (
      d.cls === 'person' &&
      d.score >= DETECTION.personScoreMin &&
      (best == null || d.score > best.score)
    ) {
      best = { score: d.score, box: d.box };
    }
  }
  return best?.box ?? null;
}

function maxScore(frame: FrameDetections, cls: 'ball_in_basket'): number {
  let m = 0;
  for (const d of frame.detections) {
    if (d.cls === cls && d.score > m) m = d.score;
  }
  return m;
}

/** Exposed so the worklet knows how often it may skip detection frames. */
export const PIPELINE_HINTS = {
  maxLiveSec: SHOT_FSM.maxLiveSec,
} as const;
