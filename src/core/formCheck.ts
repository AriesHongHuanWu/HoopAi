/**
 * Form Check — hoop-free, ball-free shooting-motion analysis.
 *
 * The Form Check screen (src/app/formcheck.tsx) points the camera at the
 * SHOOTER, not the hoop: no ball is ever tracked, so nothing here can — or
 * ever tries to — claim a make or a miss. A "rep" is a detected shooting
 * MOTION: the existing pose-only {@link ReleaseDetector} (wrist above the
 * shoulder + an upward wrist-velocity spike + elbow extension, debounced
 * RELEASE.debounceSec) fires on the wrist-snap signature, and this module
 * turns each event into pose-only {@link FormMetrics} plus a packed
 * {@link FormSequence} for the motion theater.
 *
 * WHY NOT FormAnalyzer: its stage machine is structurally ball-gated — the
 * WAIT→PICKUP transition and checkRelease() both require a TrackedBall, so
 * without a ball it never leaves WAIT and finalize() returns all-null. This
 * module reuses its PRIMITIVES instead (OneEuroFilter, angleAtDeg, the
 * "dip = max filtered wrist y" semantics, the follow-through windows) so a
 * Form Check rep and a live-session form report read the same motion the
 * same way. The deliberately mirrored constants are documented inline.
 *
 * HONESTY CONTRACT (enforced by construction, pinned by tests):
 *  - releaseAngleDeg / entryAngleDeg are ALWAYS null — they are ball-
 *    trajectory numbers this mode cannot see. Never fabricated.
 *  - releaseTimeMs is dip→release (the pickup needs the ball); the UI labels
 *    it "Dip → release", never HomeCourt's pickup→release.
 *  - Readiness refuses below MIN_POSE_FPS or without the full body + the
 *    shooting arm in frame — the same refuse-don't-guess contract Jump Lab
 *    ships (src/core/jumpLab.ts MIN_FPS).
 *  - Cross-rep consistency spreads need MIN_SPREAD_REPS measured reps; with
 *    fewer the stat is null with a reason, never a fabricated spread.
 *
 * Pure TypeScript: no I/O, no wall clock — time comes exclusively from the
 * camera timestamps on each {@link PoseFrame}.
 */
import { FORM } from './config';
import { coachingTips, OneEuroFilter } from './formAnalysis';
import {
  buildSequence,
  SEQ_WINDOW_SEC,
  type RawSeqFrame,
} from './formSequence';
import { angleAtDeg } from './geometry';
import { ReleaseDetector } from './releaseDetector';
import type {
  CoachingTip,
  FormMetrics,
  FormSequence,
  Point,
  PoseFrame,
  PoseKeypointName,
  ShootingHand,
} from './types';

// ---------------------------------------------------------------------------
// Tunables (local by design — coaching heuristics, not pipeline config)
// ---------------------------------------------------------------------------

/** Refuse to count reps below this pose rate (Jump Lab's MIN_FPS contract). */
export const MIN_POSE_FPS = 15;

/** Trailing window the readiness gates are judged over, seconds. */
export const READINESS_WINDOW_SEC = 2.0;

/**
 * Fraction of trailing frames that must pass a visibility check for its gate
 * to read OK. 80%: a couple of dropped keypoints must not flap the gate, but
 * a shooter half out of frame must fail it fast.
 */
export const VISIBILITY_MIN_FRAC = 0.8;

/**
 * Pose window captured BEFORE the release, seconds. Tied to the packer's own
 * window (formSequence.SEQ_WINDOW_SEC = 1.2 s) so a Form Check sequence spans
 * exactly what a live-session capture spans: dip → release.
 */
export const PRE_RELEASE_SEC = SEQ_WINDOW_SEC;

/** Follow-through tail captured AFTER the release, seconds. */
export const FOLLOW_TAIL_SEC = 0.5;

/**
 * Rolling raw-frame retention, seconds. Must cover PRE_RELEASE_SEC +
 * FOLLOW_TAIL_SEC (1.7 s) — the oldest frame a rep needs is that old by the
 * time its tail completes. FormSequenceBuffer is NOT reused here because its
 * 1.2 s prune would have dropped the dip by then.
 */
export const REP_BUFFER_SEC = 2.0;

/** Minimum reps that must have measured a metric before a spread is real. */
export const MIN_SPREAD_REPS = 3;

/**
 * Consistency flag thresholds — coaching heuristics for the report's verdict
 * chips, NOT pipeline tunables (hence local, no config.ts edit). An elbow
 * set-point wobbling more than ±7° or a tempo varying more than ±150 ms
 * rep-to-rep is the classic "grooving two different shots" signature; knee
 * and release-height flags are scaled to the same spirit.
 */
export const ELBOW_SPREAD_FLAG_DEG = 7;
export const TEMPO_SPREAD_FLAG_MS = 150;
export const KNEE_SPREAD_FLAG_DEG = 8;
/** Release-height spread flag, in frame-height fractions (camera-relative). */
export const RELEASE_HEIGHT_SPREAD_FLAG = 0.04;

/**
 * MIRRORED from FormAnalyzer (private there): the wrist must rise this many
 * px past its running max before the dip is confirmed. Keeping the value in
 * lockstep keeps Form Check's dip the same dip a live session reports.
 */
const DIP_EPS_PX = 0.25;

/** MIRRORED from FormAnalyzer (private FT_AVG_WINDOW_SEC): the follow-through
 *  elbow angle is averaged over this window after the release. */
const FT_AVG_WINDOW_SEC = 0.15;

// ---------------------------------------------------------------------------
// Readiness — the refuse-don't-guess gate
// ---------------------------------------------------------------------------

/** Per-frame visibility verdicts for the two readiness gates. */
export interface FrameVisibility {
  /** Head-or-shoulders AND both hips AND at least one ankle all visible. */
  fullBody: boolean;
  /** Shooting-side shoulder + elbow + wrist all visible. */
  arm: boolean;
}

/** One trailing readiness sample (timestamp + that frame's visibility). */
export interface ReadinessSample extends FrameVisibility {
  t: number;
}

export interface FormCheckReadiness {
  /** Median-dt pose rate over the trailing window, fps (0 with <2 frames). */
  fps: number;
  /** Fraction of trailing frames whose full body was visible, 0..1. */
  fullBodyFrac: number;
  /** Fraction of trailing frames whose shooting arm was visible, 0..1. */
  armFrac: number;
  fpsOk: boolean;
  fullBodyOk: boolean;
  armOk: boolean;
  /** All three gates pass — reps may be counted. */
  ready: boolean;
}

/** Score-gated keypoint lookup (FORM.keypointScoreMin, same gate app-wide). */
function visible(pose: PoseFrame, name: PoseKeypointName): boolean {
  const kp = pose.keypoints[name];
  return kp != null && kp.score >= FORM.keypointScoreMin;
}

/**
 * Visibility of one frame for the readiness gates. Full body = head OR a
 * shoulder, AND both hips, AND at least one ankle — the same landmarks the
 * sequence normalizer needs to anchor and scale a frame. The arm gate watches
 * the SHOOTING side specifically: at a side view the far arm is routinely
 * occluded, and metrics from the wrong arm are plausible-looking garbage.
 */
export function frameVisibility(
  pose: PoseFrame,
  hand: ShootingHand,
): FrameVisibility {
  const head =
    visible(pose, 'nose') ||
    visible(pose, 'left_shoulder') ||
    visible(pose, 'right_shoulder');
  const hips = visible(pose, 'left_hip') && visible(pose, 'right_hip');
  const ankle = visible(pose, 'left_ankle') || visible(pose, 'right_ankle');
  const arm =
    visible(pose, `${hand}_shoulder` as PoseKeypointName) &&
    visible(pose, `${hand}_elbow` as PoseKeypointName) &&
    visible(pose, `${hand}_wrist` as PoseKeypointName);
  return { fullBody: head && hips && ankle, arm };
}

/**
 * Median inter-frame dt → fps (the jumpLab.seriesFps idiom — the median is
 * robust to the odd dropped frame that would wreck a mean). 0 for a series
 * too short to have an interval.
 */
function medianFps(ts: readonly number[]): number {
  const dts: number[] = [];
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i]! - ts[i - 1]!;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0;
  dts.sort((a, b) => a - b);
  const mid = Math.floor(dts.length / 2);
  const medDt =
    dts.length % 2 === 1 ? dts[mid]! : (dts[mid - 1]! + dts[mid]!) / 2;
  return medDt > 0 ? 1 / medDt : 0;
}

/**
 * Pure readiness verdict over the trailing samples (caller prunes the window
 * to READINESS_WINDOW_SEC). Exported for tests and for any future consumer
 * that wants the same refuse-don't-guess gate.
 */
export function readinessOf(
  samples: readonly ReadinessSample[],
): FormCheckReadiness {
  const n = samples.length;
  const fps = medianFps(samples.map((s) => s.t));
  let fullBody = 0;
  let arm = 0;
  for (const s of samples) {
    if (s.fullBody) fullBody++;
    if (s.arm) arm++;
  }
  const fullBodyFrac = n > 0 ? fullBody / n : 0;
  const armFrac = n > 0 ? arm / n : 0;
  const fpsOk = fps >= MIN_POSE_FPS;
  const fullBodyOk = n > 0 && fullBodyFrac >= VISIBILITY_MIN_FRAC;
  const armOk = n > 0 && armFrac >= VISIBILITY_MIN_FRAC;
  return {
    fps,
    fullBodyFrac,
    armFrac,
    fpsOk,
    fullBodyOk,
    armOk,
    ready: fpsOk && fullBodyOk && armOk,
  };
}

// ---------------------------------------------------------------------------
// Per-rep metrics (pure)
// ---------------------------------------------------------------------------

/** The six shooting-side landmarks the metrics are computed from. */
function sideNames(hand: ShootingHand): PoseKeypointName[] {
  return [
    `${hand}_shoulder`,
    `${hand}_elbow`,
    `${hand}_wrist`,
    `${hand}_hip`,
    `${hand}_knee`,
    `${hand}_ankle`,
  ] as PoseKeypointName[];
}

/**
 * Pose-only {@link FormMetrics} for one rep window (frames spanning
 * [releaseT − PRE_RELEASE_SEC, releaseT + FOLLOW_TAIL_SEC]).
 *
 * Mirrors FormAnalyzer's semantics wherever both can measure:
 *  - the six shooting-side landmarks are One-Euro filtered (FORM.oneEuro);
 *  - the DIP is the max filtered wrist y before the release, confirmed only
 *    when the wrist later rises more than DIP_EPS_PX past it;
 *  - set-point elbow / knee flexion are angleAtDeg at the dip frame;
 *  - follow-through elbow is averaged over FT_AVG_WINDOW_SEC after release,
 *    and the hold is the unbroken ≥ FORM.followThrough.elbowMinDeg streak
 *    capped at FORM.followThrough.holdSec.
 *
 * DIVERGES where the ball is required, honestly:
 *  - releaseTimeMs is dip→release (no ball, no pickup) — the UI relabels it;
 *  - releaseAngleDeg / entryAngleDeg are null BY CONSTRUCTION.
 *
 * Anything unmeasurable (missing landmarks, no dip, empty tail) is null —
 * never NaN.
 */
export function computeRepMetrics(
  frames: readonly RawSeqFrame[],
  opts: { hand: ShootingHand; frameHeight: number; releaseT: number },
): FormMetrics {
  const { hand, frameHeight, releaseT } = opts;
  const names = sideNames(hand);

  // One-Euro filter each present landmark across the window (missing frames
  // simply do not feed the filter — same as FormAnalyzer's landmark()).
  const filters = new Map<
    PoseKeypointName,
    { fx: OneEuroFilter; fy: OneEuroFilter }
  >();
  for (const name of names) {
    filters.set(name, {
      fx: new OneEuroFilter(FORM.oneEuro),
      fy: new OneEuroFilter(FORM.oneEuro),
    });
  }
  const series: Map<PoseKeypointName, Point>[] = [];
  for (const f of frames) {
    const out = new Map<PoseKeypointName, Point>();
    for (const name of names) {
      const p = f.pts.get(name);
      if (!p) continue;
      const ch = filters.get(name)!;
      out.set(name, { x: ch.fx.filter(p.x, f.t), y: ch.fy.filter(p.y, f.t) });
    }
    series.push(out);
  }

  const wristName = `${hand}_wrist` as PoseKeypointName;
  const elbowName = `${hand}_elbow` as PoseKeypointName;
  const shoulderName = `${hand}_shoulder` as PoseKeypointName;
  const hipName = `${hand}_hip` as PoseKeypointName;
  const kneeName = `${hand}_knee` as PoseKeypointName;
  const ankleName = `${hand}_ankle` as PoseKeypointName;

  // ── Dip: max filtered wrist y at/before the release (>= keeps the LAST
  // frame of a held set point, matching FormAnalyzer's running-max update).
  let dipIdx = -1;
  let dipMaxY = -Infinity;
  for (let i = 0; i < frames.length; i++) {
    if (frames[i]!.t > releaseT + 1e-9) break;
    const w = series[i]!.get(wristName);
    if (w && w.y >= dipMaxY) {
      dipMaxY = w.y;
      dipIdx = i;
    }
  }
  let dipConfirmed = false;
  if (dipIdx >= 0) {
    for (let i = dipIdx + 1; i < frames.length; i++) {
      if (frames[i]!.t > releaseT + 1e-9) break;
      const w = series[i]!.get(wristName);
      if (w && dipMaxY - w.y > DIP_EPS_PX) {
        dipConfirmed = true;
        break;
      }
    }
  }

  let setPointElbowDeg: number | null = null;
  let kneeFlexionDeg: number | null = null;
  let releaseTimeMs: number | null = null;
  if (dipConfirmed && dipIdx >= 0) {
    const dip = series[dipIdx]!;
    const s = dip.get(shoulderName);
    const e = dip.get(elbowName);
    const w = dip.get(wristName);
    if (s && e && w) setPointElbowDeg = angleAtDeg(s, e, w);
    const hp = dip.get(hipName);
    const kn = dip.get(kneeName);
    const an = dip.get(ankleName);
    if (hp && kn && an) kneeFlexionDeg = angleAtDeg(hp, kn, an);
    releaseTimeMs = (releaseT - frames[dipIdx]!.t) * 1000;
  }

  // ── Release height: filtered wrist at the frame nearest releaseT. The
  // event timestamp IS a frame timestamp, so the nearest frame is normally
  // exact; a stale match (beyond the packer's own slack) yields null.
  let releaseHeightNorm: number | null = null;
  {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = 0; i < frames.length; i++) {
      const d = Math.abs(frames[i]!.t - releaseT);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    if (bestI >= 0 && bestD <= 0.2) {
      const w = series[bestI]!.get(wristName);
      if (w && frameHeight > 0) releaseHeightNorm = 1 - w.y / frameHeight;
    }
  }

  // ── Follow-through over the post-release tail (FormAnalyzer's windows).
  const holdMs = FORM.followThrough.holdSec * 1000;
  const ftT: number[] = [];
  const ftDeg: number[] = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i]!.t;
    if (t < releaseT - 1e-9) continue;
    if (t - releaseT > FORM.followThrough.holdSec + 1e-9) break;
    const s = series[i]!.get(shoulderName);
    const e = series[i]!.get(elbowName);
    const w = series[i]!.get(wristName);
    if (!s || !e || !w) continue;
    const deg = angleAtDeg(s, e, w);
    if (deg != null) {
      ftT.push(t);
      ftDeg.push(deg);
    }
  }
  let followThroughElbowDeg: number | null = null;
  let followThroughHeldMs: number | null = null;
  if (ftT.length > 0) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < ftT.length; i++) {
      if (ftT[i]! - releaseT <= FT_AVG_WINDOW_SEC + 1e-9) {
        sum += ftDeg[i]!;
        n++;
      }
    }
    if (n > 0) followThroughElbowDeg = sum / n;
    let heldEnd: number | null = null;
    for (let i = 0; i < ftT.length; i++) {
      if (ftDeg[i]! >= FORM.followThrough.elbowMinDeg) heldEnd = ftT[i]!;
      else break;
    }
    followThroughHeldMs =
      heldEnd == null ? 0 : Math.min((heldEnd - releaseT) * 1000, holdMs);
  }

  return {
    setPointElbowDeg,
    kneeFlexionDeg,
    // Ball-derived, ALWAYS null in Form Check — the mode cannot see the ball
    // and never fabricates a trajectory number. The UI renders "not measured".
    releaseAngleDeg: null,
    entryAngleDeg: null,
    releaseTimeMs,
    followThroughHeldMs,
    followThroughElbowDeg,
    releaseHeightNorm,
  };
}

// ---------------------------------------------------------------------------
// Cross-rep consistency
// ---------------------------------------------------------------------------

/** One consistency spread: a sample std, or an honest reason it is absent. */
export interface SpreadStat {
  /** Sample standard deviation across measured reps, or null. */
  value: number | null;
  /** How many reps actually measured this metric. */
  measured: number;
  /** Why value is null; null when a value is present. */
  reason: string | null;
}

export interface FormCheckSpreads {
  setPointElbowSpreadDeg: SpreadStat;
  /** Frame-height fractions — camera-relative, NOT centimetres. */
  releaseHeightSpread: SpreadStat;
  tempoSpreadMs: SpreadStat;
  kneeSpreadDeg: SpreadStat;
}

/** Sample standard deviation (n−1 denominator). */
function sampleStd(values: readonly number[]): number {
  const n = values.length;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let ss = 0;
  for (const v of values) ss += (v - mean) * (v - mean);
  return Math.sqrt(ss / (n - 1));
}

/**
 * Cross-rep spreads, gated at {@link MIN_SPREAD_REPS} measured reps PER
 * METRIC (a rep can measure the elbow but miss the knee, so the gates are
 * independent). Exported pure so the report math is testable without a
 * session.
 */
export function sessionSpreads(
  reps: readonly FormCheckRep[],
): FormCheckSpreads {
  const stat = (pick: (m: FormMetrics) => number | null): SpreadStat => {
    const vals: number[] = [];
    for (const r of reps) {
      const v = pick(r.metrics);
      if (v != null) vals.push(v);
    }
    if (vals.length < MIN_SPREAD_REPS) {
      return {
        value: null,
        measured: vals.length,
        reason: `measured on ${vals.length} of ${reps.length} reps — needs at least ${MIN_SPREAD_REPS}`,
      };
    }
    return { value: sampleStd(vals), measured: vals.length, reason: null };
  };
  return {
    setPointElbowSpreadDeg: stat((m) => m.setPointElbowDeg),
    releaseHeightSpread: stat((m) => m.releaseHeightNorm),
    tempoSpreadMs: stat((m) => m.releaseTimeMs),
    kneeSpreadDeg: stat((m) => m.kneeFlexionDeg),
  };
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

/** One detected rep: the motion window's sequence, metrics and coaching. */
export interface FormCheckRep {
  /** 1-based rep number in this session. */
  index: number;
  /** Camera time of the pose-gated release event, seconds. */
  releaseT: number;
  /** Packed motion sequence (dip → follow-through), or null when too thin. */
  sequence: FormSequence | null;
  /** Pose-only metrics — releaseAngleDeg/entryAngleDeg are always null. */
  metrics: FormMetrics;
  tips: CoachingTip[];
  /** Median pose rate across this rep's window, fps. */
  poseFps: number;
}

export interface FormCheckSessionReport {
  repCount: number;
  /** Median of the reps' window pose rates, fps (0 with no reps). */
  medianPoseFps: number;
  spreads: FormCheckSpreads;
}

/**
 * Streaming Form Check session. Feed every analysed pose frame (timestamp
 * order) via {@link push}; it returns a {@link FormCheckRep} exactly when a
 * rep's follow-through tail completes, else null. Call
 * {@link finalizeSession} once at the end for the cross-rep report.
 */
export class FormCheckSession {
  private handSide: ShootingHand;
  private readonly frameHeight: number;
  private detector: ReleaseDetector;

  private readonly readySamples: ReadinessSample[] = [];
  private cachedReadiness: FormCheckReadiness = readinessOf([]);

  /** Rolling raw window (REP_BUFFER_SEC) the rep capture slices from. */
  private buffer: RawSeqFrame[] = [];

  /** Release event awaiting its FOLLOW_TAIL_SEC of further frames. */
  private pendingReleaseT: number | null = null;

  private readonly repsList: FormCheckRep[] = [];

  // Only the frame HEIGHT matters here (the detector's vertical-velocity and
  // release-height math is height-normalized); a width option would be dead
  // weight, so there deliberately isn't one.
  constructor(opts: { hand: ShootingHand; frameHeight?: number }) {
    this.handSide = opts.hand;
    this.frameHeight = opts.frameHeight ?? 192;
    this.detector = new ReleaseDetector({
      hand: opts.hand,
      frameHeight: this.frameHeight,
    });
  }

  get hand(): ShootingHand {
    return this.handSide;
  }

  get readiness(): FormCheckReadiness {
    return this.cachedReadiness;
  }

  get reps(): readonly FormCheckRep[] {
    return this.repsList;
  }

  /**
   * Switch the watched shooting arm mid-session (the live screen's tap-to-
   * flip chip). Resets the detector and any pending rep — a half-captured
   * rep from the other arm would be garbage — but keeps completed reps
   * (each rep's sequence already recorded the hand it was captured with).
   */
  setHand(hand: ShootingHand): void {
    if (hand === this.handSide) return;
    this.handSide = hand;
    this.detector = new ReleaseDetector({
      hand,
      frameHeight: this.frameHeight,
    });
    this.pendingReleaseT = null;
  }

  /**
   * Feed one pose frame (camera-timestamp order). Returns the finalized rep
   * exactly on the frame that completes its follow-through tail, else null.
   */
  push(pose: PoseFrame): FormCheckRep | null {
    const t = pose.t;

    // 1. Readiness over the trailing window (always tracked, ready or not —
    // the strip must know when the gates recover).
    const vis = frameVisibility(pose, this.handSide);
    this.readySamples.push({ t, fullBody: vis.fullBody, arm: vis.arm });
    const rCut = t - READINESS_WINDOW_SEC;
    while (this.readySamples.length > 0 && this.readySamples[0]!.t < rCut) {
      this.readySamples.shift();
    }
    this.cachedReadiness = readinessOf(this.readySamples);

    // 2. Raw window (always buffered — capture gating lives on the trigger).
    const raw = toRawSeqFrame(pose);
    if (raw != null) {
      this.buffer.push(raw);
      const bCut = t - REP_BUFFER_SEC;
      let drop = 0;
      while (drop < this.buffer.length && this.buffer[drop]!.t < bCut) drop++;
      if (drop > 0) this.buffer = this.buffer.slice(drop);
    }

    // 3. A pending rep finalizes once its follow-through tail is on record.
    let rep: FormCheckRep | null = null;
    if (
      this.pendingReleaseT != null &&
      t - this.pendingReleaseT >= FOLLOW_TAIL_SEC - 1e-9
    ) {
      rep = this.finalizeRep(this.pendingReleaseT);
      this.pendingReleaseT = null;
    }

    // 4. The rep TRIGGER — only while every readiness gate passes (paused
    // capture means paused, the strip says why). The detector's debounce
    // (RELEASE.debounceSec 1.5 s) exceeds the tail, so a pending rep always
    // completes before the next event can fire.
    if (this.cachedReadiness.ready) {
      const ev = this.detector.push(pose);
      if (ev != null && this.pendingReleaseT == null) {
        this.pendingReleaseT = ev.t;
      }
    }

    return rep;
  }

  /**
   * End the session: flush a still-pending rep with whatever tail exists
   * (its follow-through metrics only claim what was observed), then compute
   * the cross-rep report.
   */
  finalizeSession(): FormCheckSessionReport {
    if (this.pendingReleaseT != null) {
      this.finalizeRep(this.pendingReleaseT);
      this.pendingReleaseT = null;
    }
    const fpsList = this.repsList.map((r) => r.poseFps).sort((a, b) => a - b);
    let medianPoseFps = 0;
    if (fpsList.length > 0) {
      const mid = Math.floor(fpsList.length / 2);
      medianPoseFps =
        fpsList.length % 2 === 1
          ? fpsList[mid]!
          : (fpsList[mid - 1]! + fpsList[mid]!) / 2;
    }
    return {
      repCount: this.repsList.length,
      medianPoseFps,
      spreads: sessionSpreads(this.repsList),
    };
  }

  private finalizeRep(releaseT: number): FormCheckRep {
    const lo = releaseT - PRE_RELEASE_SEC - 1e-9;
    const hi = releaseT + FOLLOW_TAIL_SEC + 1e-9;
    const window = this.buffer.filter((f) => f.t >= lo && f.t <= hi);
    const rep: FormCheckRep = {
      index: this.repsList.length + 1,
      releaseT,
      sequence: buildSequence(window, this.handSide, releaseT),
      metrics: computeRepMetrics(window, {
        hand: this.handSide,
        frameHeight: this.frameHeight,
        releaseT,
      }),
      tips: [],
      poseFps: medianFps(window.map((f) => f.t)),
    };
    // coachingTips already skips null metrics, so the ball-derived nulls
    // simply produce no ball tips — never a fabricated one.
    rep.tips = coachingTips(rep.metrics);
    this.repsList.push(rep);
    return rep;
  }
}

/**
 * Score-gated {@link RawSeqFrame} for the rolling window (mirrors
 * FormSequenceBuffer.push, which is private to its class). Returns null for
 * a frame with no usable landmarks at all.
 */
function toRawSeqFrame(pose: PoseFrame): RawSeqFrame | null {
  const pts = new Map<PoseKeypointName, { x: number; y: number }>();
  for (const [name, kp] of Object.entries(pose.keypoints) as [
    PoseKeypointName,
    { x: number; y: number; score: number },
  ][]) {
    if (
      kp &&
      kp.score >= FORM.keypointScoreMin &&
      Number.isFinite(kp.x) &&
      Number.isFinite(kp.y)
    ) {
      pts.set(name, { x: kp.x, y: kp.y });
    }
  }
  if (pts.size === 0) return null;
  return { t: pose.t, pts };
}
