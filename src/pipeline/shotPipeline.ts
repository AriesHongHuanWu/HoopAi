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
import { DETECTION, FLIGHT, RIM, SHOT_FSM, scaleFrameGate } from '../core/config';
import { BallTracker } from '../core/ballTracker';
import { FlightArc } from '../core/flightArc';
import { estimateShotValue } from '../core/court';
import { FormAnalyzer, coachingTips } from '../core/formAnalysis';
import { FormSequenceBuffer } from '../core/formSequence';
import { ReleaseDetector } from '../core/releaseDetector';
import { RimLock } from '../core/rimLock';
import { estimateShotValueMetric } from '../core/courtGeometric';
import { classifyByRegistration, type CourtRegistration } from '../core/courtRegistration';
import {
  deriveFtCalibration,
  medianFootPoint,
  type FtAnchor,
  type FtCalibrationRejectReason,
  type FtCalibrationResult,
  type FtDistanceCalibration,
} from '../core/ftCalibration';
import {
  ABS_MIN_FIT_SAMPLES,
  MIN_FIT_SAMPLES,
  evalArc,
  fitArc,
  plausibleArcCurvature,
  predictLanding,
  type ArcFit,
} from '../core/trajectory';
import { classifyLight, type LightProfile } from '../core/lightProfile';
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
  /**
   * EMA'd mean scene luminance 0..1 from the camera worklet (green-channel
   * proxy, letterbox bars compensated out — see useShotEngine). 0/undefined =
   * not measured yet (demo mode, model warm-up); the pipeline then leaves the
   * light profile untouched. Drives the tracker's dark-relaxed cold gate.
   */
  light?: number;
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
  /**
   * Sampled OBSERVED full-flight arc (flattened x,y pairs, analysis px) from
   * the global FlightArc parabola, drawn regardless of FSM phase so the line
   * traces the WHOLE flight — including 3-pointers and high arcs that never arm
   * the near-rim FSM. Strictly visual; never arms a shot or feeds make/miss.
   * Empty unless full-flight tracking is on and the arc is confident + has a
   * physically-plausible curvature.
   */
  fullFlightPath: number[];
}

/** Why a captureFtAnchor() attempt did not produce a calibration. */
export type FtCaptureRejectReason =
  | FtCalibrationRejectReason
  /** No locked rim to anchor against (at start, or lost during capture). */
  | 'no-rim'
  /** Frame budget elapsed without enough confident shooter-foot samples. */
  | 'no-person'
  /** A newer captureFtAnchor() call replaced this one. */
  | 'superseded'
  /** The pipeline was reset mid-capture. */
  | 'reset';

/** Outcome of one captureFtAnchor() attempt. Failure is always quiet — the
 *  uncalibrated rim-ruler path keeps working exactly as before. */
export type FtCaptureOutcome =
  | { ok: true; calibration: FtDistanceCalibration }
  | { ok: false; reason: FtCaptureRejectReason };

/** Confident shooter-foot samples medianed into one FT anchor. */
const FT_CAPTURE_FRAMES = 8;
/** Frame budget before an anchor capture gives up (no confident person). */
const FT_CAPTURE_MAX_FRAMES = 90;

export class ShotPipeline {
  private readonly tracker = new BallTracker({});
  /**
   * Full-flight parabola accumulator (config.FLIGHT.useFlightArc). Off by
   * default and only fed/consulted while the flag is on, so it is inert — and
   * the tracker's third `step()` arg stays undefined — until validated. It
   * gives the tracker a standing score-floor relaxation along the predicted
   * flight path so a faint mid-arc ball keeps being detected between the
   * release and the hoop ROI, not only near the rim.
   */
  private readonly flightArc = new FlightArc();
  /** Live copy of config.FLIGHT.useFlightArc, toggled from Settings so the user
   *  can disable full-flight tracking without a rebuild (escape hatch). */
  private useFlight: boolean = FLIGHT.useFlightArc;
  private readonly rimLock = new RimLock({ lockHoldSec: RIM.lockHoldSec });
  private fsm: ShotFsm | null = null;
  private events: PipelineEvents;
  private lastRim: RimGeometry | null = null;
  private wasDrifted = false;

  /** Pose-based form analyzer (lazy; only alive while pose frames arrive). */
  private form: FormAnalyzer | null = null;
  /**
   * Motion-sequence recorder for Form Studio (lazy, additive alongside `form`).
   * Buffers the shot-window keypoint sequence so the studio can play the
   * shooter's motion back against a reference form. Zero cost/state when pose
   * frames never arrive; never affects detection or make/miss judgment.
   */
  private formSeq: FormSequenceBuffer | null = null;
  /** Pose-gated release detector (lazy, like `form` — zero cost, zero state
   *  when pose frames never arrive). */
  private releaseDet: ReleaseDetector | null = null;
  /** Release-event time to hand the FSM exactly once (on the firing frame). */
  private pendingReleaseT: number | null = null;
  private formHand: ShootingHand = 'right';
  /** Ball size (Settings > Player) — forwarded to the FSM's depth gate. */
  private ballSize: 7 | 6 | 5 = 7;
  /**
   * Rim height in meters (Settings > Player, P11). Feeds the metric 2/3
   * estimator + FT calibration as their vertical ruler. Default 3.05
   * (regulation) — the constant courtGeometric assumed before this was
   * configurable, so the default path is byte-identical.
   */
  private rimHeightM = 3.05;
  /** Depth-ratio parallax veto flag (Settings, experimental). Applied when
   *  the FSM is created at rim lock — i.e. per session. */
  private depthVeto = false;
  /** Metric 2/3 estimation flag (Settings, experimental). */
  private metric23 = false;
  /** Manual court-range override (Settings). 'auto' = use the 2/3 estimate. */
  private courtRange: 'auto' | '2pt' | '3pt' = 'auto';
  /**
   * Court registration (calibration ritual / auto court-line detection): an
   * image→court homography + rulebook. When present it is the TOP-priority 2/3
   * source — corner-accurate and placement-agnostic — outranking the metric and
   * heuristic estimators. Per-session (the camera moves between sessions), so
   * never persisted across a camera move. Null = the existing fallbacks.
   */
  private courtRegistration: CourtRegistration | null = null;
  /** Reappearance corroborator flag (Settings, experimental). */
  private reappearance = false;
  /** Camera pitch at/around rim lock from the IMU, degrees +up; null = no IMU. */
  private viewPitchDeg: number | null = null;
  /**
   * Scene-light profile classified from the worklet's mean-luma estimate
   * (hysteresis lives in classifyLight, keyed off this previous value).
   * Forwarded to the tracker ON CHANGE only. Environmental — survives
   * reset() on purpose: lighting doesn't change with pipeline state.
   */
  private lightProfile: LightProfile = 'bright';
  private sawPoseThisShot = false;
  /** Latest pose ankle-midpoint (analysis px) — the pose-based shooter foot for
   *  2/3 estimation. Null until a pose with a visible ankle arrives. */
  private lastPoseFootPx: { x: number; y: number } | null = null;
  /** Person nearest the ball LAST TIME the ball was away from the rim — the
   *  latched shooter box (see pickShooterBox). */
  private lastHolderBox: Box | null = null;
  private lastHolderT = -Infinity;
  /** Optional FT-line calibration for the metric 2/3 estimator. Per-session
   *  only (never persisted — the camera moves between sessions). It never
   *  gates shots, but a successfully DERIVED calibration does switch the
   *  metric estimator path on for this session even with the experimental
   *  metric23 flag off — the user performed the calibration ritual precisely
   *  to sharpen 2/3 calls, so it must not be a silent no-op (see step()). */
  private ftCalibration: FtDistanceCalibration | null = null;
  /** In-flight FT anchor capture, fed by step() frames until it resolves. */
  private ftCapture: {
    samples: { x: number; y: number }[];
    framesSeen: number;
    resolve: (outcome: FtCaptureOutcome) => void;
  } | null = null;

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

  /** Per-model cold ball-acquisition gate (the active detector sets its own —
   *  a noisier model needs a higher bar to start a track). null = default. */
  setColdBallGate(gate: number | null): void {
    this.tracker.setColdGate(gate);
  }

  /** Rim height in meters (from Settings) — the metric 2/3 estimator's
   *  vertical ruler. Applies from the next resolved shot / FT capture. */
  setRimHeight(heightM: 3.05 | 2.6): void {
    this.rimHeightM = heightM;
  }

  /** Depth-ratio parallax veto (from Settings). Takes effect at rim lock. */
  setDepthVeto(enabled: boolean): void {
    this.depthVeto = enabled;
  }

  /** Metric 2/3 estimation (from Settings). */
  setMetric23(enabled: boolean): void {
    this.metric23 = enabled;
  }

  /** Manual court range (Settings). 'auto' uses the 2/3 estimate; '2pt'/'3pt'
   *  force every decided shot's value. Applies from the next resolved shot. */
  setCourtRange(range: 'auto' | '2pt' | '3pt'): void {
    this.courtRange = range;
  }

  /** Court registration (calibration ritual / auto court-line detection). Pass
   *  null to clear it (e.g. re-calibrating). Applies from the next resolved
   *  shot; it's the top-priority 2/3 source when a shooter foot is known. */
  setCourtRegistration(reg: CourtRegistration | null): void {
    this.courtRegistration = reg;
  }

  /** Reappearance corroborator (from Settings). Takes effect at rim lock. */
  setReappearance(enabled: boolean): void {
    this.reappearance = enabled;
  }

  /**
   * Full-flight tracking toggle (from Settings). Takes effect immediately —
   * turning it OFF stops feeding/consulting the global arc from the next frame
   * and clears any accumulated flight so a re-enable starts clean.
   */
  setUseFlightArc(enabled: boolean): void {
    if (this.useFlight === enabled) return;
    this.useFlight = enabled;
    if (!enabled) this.flightArc.reset(0);
  }

  /** IMU camera pitch, degrees +up (EMA'd by the engine). Feeds the view-band
   *  classifier at rim lock and the metric 2/3 estimator per shot. */
  setViewPitch(pitchDeg: number | null): void {
    this.viewPitchDeg = pitchDeg;
  }

  /**
   * Set (or clear) the FT-line calibration from a captured anchor. Derivation
   * runs through the pure module (src/core/ftCalibration.ts); a rejected
   * anchor CLEARS any previous calibration rather than keeping a stale one.
   * Returns the derivation result (null when clearing) for caller feedback.
   */
  setFtCalibration(anchor: FtAnchor | null): FtCalibrationResult | null {
    if (anchor == null) {
      this.ftCalibration = null;
      return null;
    }
    const result = deriveFtCalibration(anchor);
    this.ftCalibration = result.ok ? result.calibration : null;
    return result;
  }

  /**
   * Capture an FT-line anchor from the live stream: over the next
   * {@link FT_CAPTURE_FRAMES} frames with a confident shooter foot (pose
   * ankles when available, else the best-person box bottom — the same data
   * path the shooter latch uses), median the foot midpoint, build the anchor
   * against the locked rim and derive+store the calibration. Resolves with
   * the outcome; NEVER rejects the promise — a failed capture just leaves the
   * default uncalibrated path in place.
   */
  captureFtAnchor(): Promise<FtCaptureOutcome> {
    if (!this.lastRim) return Promise.resolve({ ok: false, reason: 'no-rim' });
    // One capture at a time — a newer request supersedes the old quietly.
    this.ftCapture?.resolve({ ok: false, reason: 'superseded' });
    return new Promise((resolve) => {
      this.ftCapture = { samples: [], framesSeen: 0, resolve };
    });
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
    // A re-aim means the camera is being physically re-pointed: the FT anchor
    // was captured against the OLD placement, so its correction is stale.
    // Drop it (and any in-flight capture) — the default rim ruler takes over
    // untouched, and the UI re-offers calibration after the next lock.
    this.ftCapture?.resolve({ ok: false, reason: 'no-rim' });
    this.ftCapture = null;
    this.ftCalibration = null;
  }

  get rimGeometry(): RimGeometry | null {
    return this.lastRim;
  }

  /** Feed one worklet payload. Returns the frame state (also sent to onFrame). */
  step(payload: FramePayload): PipelineFrameState {
    const { frame, netMotionScore } = payload;
    const dims = { width: frame.frameWidth, height: frame.frameHeight };

    // Light-aware detection profile: classify the worklet's luma estimate
    // (0/undefined = unmeasured → keep the current profile) and push a
    // CHANGE to the tracker, which relaxes its cold ball gate in 'dark'.
    if (payload.light !== undefined && payload.light > 0) {
      const next = classifyLight(payload.light, this.lightProfile);
      if (next !== this.lightProfile) {
        this.lightProfile = next;
        this.tracker.setLightProfile(next);
      }
    }

    const rim = this.rimLock.step(frame, frame.t) ?? this.rimLock.geometry;
    if (rim && rim !== this.lastRim) this.adoptRim(rim, dims);

    if (this.rimLock.driftDetected && !this.wasDrifted) {
      this.wasDrifted = true;
      // A detected drift means the camera physically moved (bump/knock): the
      // FT anchor was captured against the OLD framing, so its distance
      // correction is stale — the same reasoning reAim() applies when the
      // user re-points on purpose. Quietly fail any in-flight capture and
      // drop the calibration; the default rim ruler takes over untouched.
      this.ftCapture?.resolve({ ok: false, reason: 'no-rim' });
      this.ftCapture = null;
      this.ftCalibration = null;
      this.events.onRimDrift?.();
    } else if (!this.rimLock.driftDetected && this.wasDrifted) {
      // Re-locked after a camera bump — announce so the UI clears its banner.
      this.wasDrifted = false;
      if (this.lastRim) this.events.onRimLocked?.(this.lastRim);
    }

    // Flight corridor (config.FLIGHT.useFlightArc): the global arc fitted
    // THROUGH LAST FRAME predicts where the ball is NOW, giving the tracker a
    // one-frame-lagged path prior. A candidate sitting on that path earns the
    // relaxed (tracking) score floor even far from the rim — the standing
    // relaxation the near-rim ROI never provided across the whole flight. The
    // lag is harmless: a mid-air ball moves << the rim-scaled tube per frame.
    const corridor =
      this.useFlight && this.lastRim
        ? this.flightArc.corridorPoint(
            frame.t,
            this.lastRim.box.width,
            // fps-scaled fit floor: a slow XR needs the corridor sooner, so
            // require fewer samples there (never below the parabola's floor).
            scaleFrameGate(
              MIN_FIT_SAMPLES,
              this.tracker.estimatedStepDt(),
              ABS_MIN_FIT_SAMPLES,
            ),
          )
        : null;
    const ball = this.tracker.step(
      frame,
      this.lastRim?.hoopRoi ?? null,
      corridor,
    );
    // Feed the accepted ball into the global arc. A discontinuity (first ball,
    // or the flight went dark past the freshness window) starts a fresh arc so
    // one shot's samples never contaminate the next shot's fit.
    if (this.useFlight && ball) {
      if (frame.t - this.flightArc.lastReal > FLIGHT.corridorFreshSec) {
        this.flightArc.reset(frame.t);
      }
      this.flightArc.push(ball);
    }

    // Form analysis (opt-in): feed each frame's pose to the analyzer so it can
    // track the shot phases (dip → release → follow-through). Entirely skipped
    // when no pose arrives, so it never touches the normal detection path.
    // THIS frame's pose foot (fresh, not the latched lastPoseFootPx) — the FT
    // anchor capture below prefers it over the person-box bottom.
    let poseFootThisFrame: { x: number; y: number } | null = null;
    const pose = payload.pose;
    if (pose) {
      if (!this.form) this.form = new FormAnalyzer({ hand: this.formHand, frameHeight: frame.frameHeight });
      this.form.push(pose, ball);
      // Record the motion sequence for Form Studio (additive; independent of
      // the analyzer's phase/metric logic). Rolling window, downsampled on
      // finalize — never touches the detection or make/miss path.
      if (!this.formSeq) this.formSeq = new FormSequenceBuffer({ hand: this.formHand });
      this.formSeq.push(pose);
      // Pose-gated release detection (see src/core/releaseDetector.ts): runs
      // ONLY while pose frames arrive, so it costs nothing with form analysis
      // off. On fire, the wrist seed lets the tracker reacquire the faint
      // just-released ball (effective from the NEXT frame's tracker step —
      // the pose is decoded after this frame's tracking, and the 0.5 s seed
      // window dwarfs the one-frame lag), and the FSM receives the event
      // time below as its fourth, guarded arm path.
      if (!this.releaseDet) {
        this.releaseDet = new ReleaseDetector({
          hand: this.formHand,
          frameHeight: frame.frameHeight,
        });
      }
      const release = this.releaseDet.push(pose);
      if (release) {
        this.tracker.setReleaseEvent(release.wristX, release.wristY, release.t);
        this.pendingReleaseT = release.t;
        // A release is the cleanest "new flight starts here" signal: drop the
        // prior shot's samples so the global arc fits only this attempt.
        if (this.useFlight) this.flightArc.reset(release.t);
      }
      this.sawPoseThisShot = true;
      // Pose (MoveNet) gives a far more reliable shooter foot than the YOLO
      // person box for the 2/3-point estimate — the ankle keypoints are exactly
      // "where they're standing". Keep the latest ankle midpoint (analysis px);
      // the shooter barely moves during a shot, so the latest is a good origin.
      const foot = poseFootPx(pose);
      if (foot) {
        this.lastPoseFootPx = foot;
        poseFootThisFrame = foot;
      }
    }

    // FT-line anchor capture (optional calibration): pure observation of the
    // shooter's foot over a few confident frames. Runs beside — never inside —
    // the shot path: it cannot gate the FSM, delay a shot or block a session.
    if (this.ftCapture) this.stepFtCapture(frame, ball, poseFootThisFrame);

    let phase: ShotPhase = 'IDLE';
    let liveTrajectory: readonly BallSample[] = [];
    let resolved: ResolvedShot | null = null;

    if (this.fsm && this.lastRim) {
      const person = this.pickShooterBox(frame, ball);
      const result = this.fsm.step({
        t: frame.t,
        ball,
        ballInBasketScore: maxScore(frame, 'ball_in_basket'),
        netMotionScore,
        personBox: person,
        // Delivered exactly once, on the frame the detector fired (the FSM
        // latches it internally and applies its own staleness windows).
        ...(this.pendingReleaseT !== null
          ? { releaseEventT: this.pendingReleaseT }
          : {}),
      });
      phase = result.phase;
      liveTrajectory = result.liveTrajectory;
      resolved = result.resolved;
    }
    // An event with no locked rim/FSM dies here: no rim means no shots, and
    // holding it could deliver a seconds-stale event at a later rim lock.
    this.pendingReleaseT = null;

    // Predicted landing: fit the live arc and extrapolate to the rim plane.
    // Cheap (O(n) over ≤48 samples, only while a shot is live) and it's what
    // powers the on-screen "this is where it's coming down" ghost target.
    let predictedLanding: PipelineFrameState['predictedLanding'] = null;
    const predictedPath: number[] = [];
    if (phase === 'SHOT_LIVE' && this.lastRim && liveTrajectory.length >= 6) {
      const fit = fitArc(liveTrajectory);
      // Reject a physically-impossible curvature: a rim rattle fits as a
      // near-vertical parabola (huge ya) — the "90-degree arc". ya is gravity,
      // invariant across shots, so this never rejects a real arc.
      if (
        fit &&
        fit.ya > 0 &&
        fit.r2y >= 0.35 &&
        plausibleArcCurvature(fit.ya, this.lastRim.box.width, FLIGHT.maxArcYaRimWidths)
      ) {
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
    // Global-arc fallback (full-flight tracking only): when the FSM's live
    // buffer is too short to fit — early flight, an under-basket view where the
    // ball spends little time in the FSM's window, or a long occlusion — but
    // the whole-flight arc IS confident, drive the "where it's coming down"
    // ghost from it. This is exactly the "see the parabola from under the
    // basket" ask. HUD-only (never feeds make/miss) and strict-R² gated, so a
    // shaky arc shows nothing rather than a wrong marker. Off-path untouched:
    // the branch is skipped entirely when full-flight tracking is off or the
    // live fit already produced a prediction.
    if (
      predictedLanding === null &&
      this.useFlight &&
      phase === 'SHOT_LIVE' &&
      this.lastRim
    ) {
      const floor = scaleFrameGate(
        MIN_FIT_SAMPLES,
        this.tracker.estimatedStepDt(),
        ABS_MIN_FIT_SAMPLES,
      );
      const p = this.flightArc.landing(this.lastRim.planeY, floor);
      const gfit = p ? this.flightArc.fit(floor) : null;
      if (
        p &&
        gfit &&
        plausibleArcCurvature(gfit.ya, this.lastRim.box.width, FLIGHT.maxArcYaRimWidths)
      ) {
        predictedLanding = {
          x: p.x,
          y: p.y,
          inSpan: p.x >= this.lastRim.spanLeft && p.x <= this.lastRim.spanRight,
        };
        // Draw the future from NOW (frame.t) forward to the predicted landing —
        // the arc's own extrapolation covers the occluded stretch.
        if (p.t > frame.t) {
          const K = 10;
          for (let i = 0; i <= K; i++) {
            const pt = evalArc(gfit, frame.t + ((p.t - frame.t) * i) / K);
            if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) break;
            predictedPath.push(pt.x, pt.y);
          }
        }
      }
    }

    // Full-flight arc line (full-flight tracking only): the global parabola
    // sampled over its OBSERVED window, drawn REGARDLESS of FSM phase. This is
    // the fix for "the line only appears near the rim" — the FSM only arms (and
    // fills liveTrajectory) near the hoop, so a 3-pointer or high-arc ball was
    // never drawn mid-flight. The FlightArc tracks the whole flight, so we trace
    // it from the first observed sample. STRICTLY visual: it never arms a shot
    // or feeds make/miss (drawing != judging). Confidence + plausible-curvature
    // gated, so a rattle (huge ya) or a shaky fit draws nothing, not a bad line.
    // Confident, physically-plausible global arc (if any) — powers BOTH the
    // drawn full-flight line and the occlusion snap below. Computed once.
    let arcFit: ArcFit | null = null;
    if (this.useFlight && this.lastRim) {
      const floor = scaleFrameGate(
        MIN_FIT_SAMPLES,
        this.tracker.estimatedStepDt(),
        ABS_MIN_FIT_SAMPLES,
      );
      const gfit = this.flightArc.fit(floor);
      if (
        gfit &&
        gfit.ya > 0 &&
        gfit.tMax > gfit.tMin &&
        gfit.r2y >= FLIGHT.corridorMinR2yLoose &&
        plausibleArcCurvature(gfit.ya, this.lastRim.box.width, FLIGHT.maxArcYaRimWidths)
      ) {
        arcFit = gfit;
      }
    }

    const fullFlightPath: number[] = [];
    if (arcFit) {
      const span = arcFit.tMax - arcFit.tMin;
      const K = 16;
      for (let i = 0; i <= K; i++) {
        const pt = evalArc(arcFit, arcFit.tMin + (span * i) / K);
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
          fullFlightPath.length = 0;
          break;
        }
        fullFlightPath.push(pt.x, pt.y);
      }
    }

    // Occlusion snap (VISUAL ONLY): a coasted (predicted) ball drifts off on a
    // stale Kalman velocity — the "失去偵測後一直亂飄". With a confident arc, draw
    // it ON the parabola at its own time, with arc-consistent velocity so the
    // HUD glide follows the real flight instead of flying off. The FSM already
    // ran above on the RAW ball, so make/miss is completely untouched by this.
    let displayBall = ball;
    if (arcFit && ball && ball.predicted) {
      const p = evalArc(arcFit, ball.t);
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) {
        displayBall = {
          ...ball,
          cx: p.x,
          cy: p.y,
          vx: arcFit.xm,
          vy: 2 * arcFit.ya * ball.t + arcFit.yb,
        };
      }
    }

    const state: PipelineFrameState = {
      t: frame.t,
      ball: displayBall,
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
      fullFlightPath,
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
        // METRIC estimator first: pinhole geometry off the rim's real size +
        // height gives the distance in METERS; the rim-widths heuristic stays
        // as the always-available fallback. Runs when the experimental
        // metric23 flag is on, and ALSO whenever an FT-line calibration was
        // derived this session — the calibration only exists because the user
        // performed the stand-at-the-line ritual, and feeding it into a path
        // that's off by default would make that ritual a no-op for everyone
        // running stock settings. Safe either way: the estimator keeps its
        // own confidence gates and returns null → heuristic fallback.
        let metric: ReturnType<typeof estimateShotValueMetric> = null;
        if (
          (this.metric23 || this.ftCalibration != null) &&
          originX != null &&
          originY != null
        ) {
          metric = estimateShotValueMetric({
            rimBox: this.lastRim.box,
            footX: originX * frame.frameWidth,
            footY: originY * frame.frameHeight,
            frameSize: frame.frameWidth,
            pitchDeg: this.viewPitchDeg,
            rimHeightM: this.rimHeightM,
            // Optional FT-line refinement (null = default path, untouched).
            calibration: this.ftCalibration,
          });
        }
        const est = estimateShotValue(
          this.lastRim,
          originX,
          originY,
          { width: frame.frameWidth, height: frame.frameHeight },
        );
        // COURT REGISTRATION first: a calibrated homography maps the foot to a
        // true court position and classifies against the REAL 3-point line
        // (corner-accurate, any camera placement). Only when a shooter foot is
        // known and the mapping is plausible; otherwise fall through to the
        // metric estimator, then the always-available rim-widths heuristic.
        const reg =
          this.courtRegistration != null && originX != null && originY != null
            ? classifyByRegistration(
                this.courtRegistration,
                originX * frame.frameWidth,
                originY * frame.frameHeight,
              )
            : null;
        resolved.shotValue = reg ? reg.value : metric ? metric.value : est.value;
        resolved.distanceRimWidths = est.distanceRimWidths;
        if (reg) resolved.distanceM = reg.distanceM;
        else if (metric) resolved.distanceM = metric.distanceM;
        // Record which estimator won + its confidence + the mapped court point,
        // so the detection receipt can SHOW ITS WORK (auditable, not a guess).
        if (reg) {
          resolved.valueSource = 'court';
          resolved.valueConfidence = reg.confidence;
          resolved.courtPos = { x: reg.courtX, y: reg.courtY };
        } else if (metric) {
          resolved.valueSource = 'metric';
        } else if (est.confidence > 0) {
          resolved.valueSource = 'heuristic';
          resolved.valueConfidence = est.confidence;
        }
        // Manual court-range override (Settings > Court range): when the user
        // pins the range, every decided shot takes that value regardless of the
        // auto 2/3 estimate — the calibration-free way to score a 3-point (or
        // pure 2-point) session accurately. 'auto' leaves the estimate intact.
        if (this.courtRange === '2pt') resolved.shotValue = 2;
        else if (this.courtRange === '3pt') resolved.shotValue = 3;
        if (this.courtRange !== 'auto') resolved.valueSource = 'manual';
      }
      // Finalize the pose-based form report (only if a pose was seen this shot).
      if (this.form && this.sawPoseThisShot) {
        try {
          const metrics = this.form.finalize({
            entryAngleDeg: resolved.entryAngleDeg,
            releaseAngleDeg: resolved.releaseAngleDeg,
          });
          const releasePose = this.form.releasePose;
          // Motion sequence for Form Studio — best-effort, additive; a null
          // build (too little captured) simply omits the field.
          const sequence = this.formSeq?.finalize() ?? null;
          resolved.form = {
            metrics,
            tips: coachingTips(metrics),
            ...(releasePose ? { releasePose } : {}),
            ...(sequence ? { sequence } : {}),
          };
        } catch {
          // Form analysis must never break shot emission.
        }
      }
      if (this.form) this.form.reset();
      if (this.formSeq) this.formSeq.reset();
      this.sawPoseThisShot = false;
      this.lastPoseFootPx = null; // freshen per shot
      this.events.onShot?.(resolved);
    }
    return state;
  }

  reset(): void {
    this.tracker.reset();
    this.flightArc.reset(0);
    this.rimLock.reset();
    this.form = null;
    this.formSeq = null;
    this.releaseDet = null;
    this.pendingReleaseT = null;
    this.sawPoseThisShot = false;
    this.lastPoseFootPx = null;
    this.fsm = null;
    this.lastRim = null;
    this.wasDrifted = false;
    this.ftCapture?.resolve({ ok: false, reason: 'reset' });
    this.ftCapture = null;
    this.ftCalibration = null;
  }

  /**
   * One frame of an in-flight FT anchor capture. Sample source mirrors the
   * shot-origin priority: THIS frame's pose ankle midpoint when available,
   * else the confident best-person box's bottom midpoint (the shooter-latch
   * data path). Completes with a median anchor after FT_CAPTURE_FRAMES
   * samples, or gives up quietly after FT_CAPTURE_MAX_FRAMES frames.
   */
  private stepFtCapture(
    frame: FrameDetections,
    ball: TrackedBall | null,
    poseFoot: { x: number; y: number } | null,
  ): void {
    const cap = this.ftCapture!;
    cap.framesSeen += 1;
    let foot = poseFoot;
    if (!foot) {
      const p = bestPerson(frame, ball);
      if (p) foot = { x: p.x + p.width / 2, y: p.y + p.height };
    }
    if (foot) cap.samples.push(foot);
    if (cap.samples.length >= FT_CAPTURE_FRAMES) {
      this.ftCapture = null;
      const rim = this.lastRim;
      const footPx = medianFootPoint(cap.samples);
      if (!rim || !footPx) {
        cap.resolve({ ok: false, reason: rim ? 'no-person' : 'no-rim' });
        return;
      }
      const anchor: FtAnchor = {
        footPx,
        rim,
        // Same square side the per-shot metric estimator is fed.
        frameSize: frame.frameWidth,
        pitchDeg: this.viewPitchDeg,
        rimHeightM: this.rimHeightM,
      };
      const result = deriveFtCalibration(anchor);
      if (result.ok) this.ftCalibration = result.calibration;
      cap.resolve(result);
    } else if (cap.framesSeen >= FT_CAPTURE_MAX_FRAMES) {
      this.ftCapture = null;
      cap.resolve({ ok: false, reason: 'no-person' });
    }
  }

  /**
   * The person box handed to the FSM (origin / 2-3pt annotation ONLY — person
   * boxes no longer gate arming). The FSM samples it at ARM time, when the
   * ball is by construction AT the rim — so "person nearest the ball right
   * now" would systematically pick whoever stands under the basket, not the
   * shooter. Instead, LATCH the person nearest the ball while the ball is
   * still away from the hoop (i.e. in the shooter's hands / just released)
   * and serve the latched box while it's fresh; a layup finisher is
   * re-latched naturally since their ball only reaches the rim area moments
   * after they carried it there.
   */
  private pickShooterBox(frame: FrameDetections, ball: TrackedBall | null): Box | null {
    const rim = this.lastRim;
    if (ball && rim) {
      const nearRim =
        inBox(rim.upZone, ball.cx, ball.cy) || inBox(rim.hoopRoi, ball.cx, ball.cy);
      if (!nearRim) {
        const p = bestPerson(frame, ball);
        if (p) {
          this.lastHolderBox = p;
          this.lastHolderT = frame.t;
        }
      }
    }
    if (this.lastHolderBox && frame.t - this.lastHolderT <= HOLDER_TTL_SEC) {
      return this.lastHolderBox;
    }
    return bestPerson(frame, ball);
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

/** How long a latched shooter box stays valid without re-confirmation. Long
 *  enough to cover release → arm → resolve of one attempt; short enough that
 *  a player who left the frame doesn't haunt the next shot's origin. */
const HOLDER_TTL_SEC = 3;

function inBox(b: Box, x: number, y: number): boolean {
  return x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
}

/**
 * The person box most likely to be holding/nearest the ball THIS frame. On a
 * court with several people, "highest score" routinely picked a bystander;
 * distance to the ball is the useful key — but only while the ball is away
 * from the rim, which is why callers latch via pickShooterBox instead of
 * calling this at arm time. Falls back to highest score when no ball is
 * tracked. Origin/annotation use ONLY — person boxes no longer gate arming.
 */
function bestPerson(
  frame: FrameDetections,
  ball: { cx: number; cy: number } | null,
): Box | null {
  let best: { key: number; box: Box } | null = null;
  for (const d of frame.detections) {
    // Gate on personScoreMin: a low-confidence spurious 'person' box (~0.15)
    // must not corrupt the shooter-origin 2/3 estimate.
    if (d.cls !== 'person' || d.score < DETECTION.personScoreMin) continue;
    // Lower key wins. With a ball: squared distance from box center to the
    // ball. Without: negative score (so the highest score wins).
    let key: number;
    if (ball) {
      const dx = d.box.x + d.box.width / 2 - ball.cx;
      const dy = d.box.y + d.box.height / 2 - ball.cy;
      key = dx * dx + dy * dy;
    } else {
      key = -d.score;
    }
    if (best == null || key < best.key) best = { key, box: d.box };
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
