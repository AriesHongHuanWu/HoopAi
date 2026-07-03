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
import { DETECTION, SHOT_FSM } from '../core/config';
import { BallTracker } from '../core/ballTracker';
import { estimateShotValue } from '../core/court';
import { FormAnalyzer, coachingTips } from '../core/formAnalysis';
import { RimLock } from '../core/rimLock';
import { ShotFsm } from '../core/shotFsm';
import type {
  Box,
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
}

export class ShotPipeline {
  private readonly tracker = new BallTracker({});
  private readonly rimLock = new RimLock();
  private fsm: ShotFsm | null = null;
  private events: PipelineEvents;
  private lastRim: RimGeometry | null = null;
  private wasDrifted = false;

  /** Pose-based form analyzer (lazy; only alive while pose frames arrive). */
  private form: FormAnalyzer | null = null;
  private formHand: ShootingHand = 'right';
  private sawPoseThisShot = false;

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

  /** Manual rim override from the setup screen's tap-to-adjust. */
  setManualRim(box: Box, frame: { width: number; height: number }): void {
    this.rimLock.setManual(box);
    const rim = this.rimLock.geometry;
    if (rim) this.adoptRim(rim, frame);
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
    }

    let phase: ShotPhase = 'IDLE';
    let liveTrajectory: readonly { cx: number; cy: number }[] = [];
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

    const state: PipelineFrameState = {
      t: frame.t,
      ball,
      rim: this.lastRim,
      phase,
      liveTrajectory,
      frameWidth: frame.frameWidth,
      frameHeight: frame.frameHeight,
    };
    this.events.onFrame?.(state);
    if (resolved) {
      // Automatic 2/3-point estimation: the model already marked the rim and
      // the shooter's foot (resolved.originX/Y). Attach the estimated value
      // BEFORE emitting so downstream stats/modes can score points.
      if (this.lastRim) {
        const est = estimateShotValue(
          this.lastRim,
          resolved.originX,
          resolved.originY,
          { width: frame.frameWidth, height: frame.frameHeight },
        );
        resolved.shotValue = est.value;
        resolved.distanceRimWidths = est.distanceRimWidths;
      }
      // Finalize the pose-based form report (only if a pose was seen this shot).
      if (this.form && this.sawPoseThisShot) {
        try {
          const metrics = this.form.finalize({
            entryAngleDeg: resolved.entryAngleDeg,
            releaseAngleDeg: resolved.releaseAngleDeg,
          });
          resolved.form = { metrics, tips: coachingTips(metrics) };
        } catch {
          // Form analysis must never break shot emission.
        }
      }
      if (this.form) this.form.reset();
      this.sawPoseThisShot = false;
      this.events.onShot?.(resolved);
    }
    return state;
  }

  reset(): void {
    this.tracker.reset();
    this.rimLock.reset();
    this.form = null;
    this.sawPoseThisShot = false;
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
      this.fsm = new ShotFsm(rim, frame);
    }
    if (first) this.events.onRimLocked?.(rim);
  }
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
