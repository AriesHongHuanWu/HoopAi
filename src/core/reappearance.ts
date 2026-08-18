/**
 * reappearance — the gap-crossing CORROBORATOR: judge a shot whose ball
 * vanished at the rim (net/rim/backboard occlusion) by what happens when it
 * REAPPEARS below.
 *
 * Adversarial verification broke the naive version of this idea three ways
 * (rim-bounce-inside-the-gap, front-parallax with dropout, putback rise), so
 * this implementation is a corroborator ONLY — it never mints a make by
 * itself; the FSM may upgrade an occluded crossing to geo=true only when the
 * net or cls signal agrees — and every reappearance must pass ALL of:
 *
 *  1. TIME-CONSISTENCY: the reappearing ball must sit on the PRE-GAP parabola
 *     extended through the gap (|y - arcFit(t)| < 40px). A rim bounce inside
 *     the dropout lands ~hundreds of px off the arc — trivially rejected.
 *  2. DESCENDING: vy > 0 (image coords) over the first 2 post-gap samples.
 *     A putback's rising ball fails here.
 *  3. WIDENED SPAN: cx within the rim span widened 15% per side (net
 *     deflection alone moves a swish ~21px at 6m — a tight x-rule would
 *     false-miss real makes).
 *  4. DEPTH CONSISTENCY: the single-sample depth check must not read the ball
 *     clearly in FRONT of / BEHIND the rim (no upper size skip — the
 *     close-front airball renders biggest).
 *  5. FREE-FALL DRAG (see {@link dragRatio}): the reappeared ball must not be
 *     falling at ~100% of the speed free fall alone would have produced over
 *     the gap. A ball that lost NO energy went through clean air, not through
 *     a net. This is the only one of the five that reads pure physics rather
 *     than geometry, and the only one that needs no detection at the rim at
 *     all — which is precisely the moment this app cannot see.
 *
 * TTL: the trap hard-clears at predictedCrossT + 0.7s regardless of interim
 * detections; while net motion stays elevated (a net-hang make) the window
 * extends to 2.0s from arming. Timeout NEVER means "miss" — the FSM resolves
 * on its remaining signals or 'unsure'.
 *
 * Pure TypeScript; unit-tested against every adversarial fixture that broke
 * the original design.
 */
import {
  COURT,
  DEPTH_GATE,
  GRAVITY_MPS2,
  REAPPEAR,
  TRACKER,
  scaleFrameGate,
} from './config';
import { depthConsistencyAtSample, type BallSizeSetting } from './depthRatioGate';
import {
  ABS_MIN_FIT_SAMPLES,
  evalArc,
  fitArc,
  predictLanding,
  type ArcFit,
} from './trajectory';
import type { BallSample, RimGeometry } from './types';

/**
 * Median forward inter-sample interval of a real-sample history (seconds), for
 * fps-scaling the pre-gap fit floor. Median (not mean) so one long occlusion
 * gap inside the history doesn't inflate the estimate. Returns null when there
 * are too few samples to measure an interval.
 */
function medianSampleDt(samples: readonly BallSample[]): number | null {
  const dts: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return null;
  dts.sort((a, b) => a - b);
  return dts[Math.floor(dts.length / 2)];
}

// ---------------------------------------------------------------------------
// Free-fall drag test
// ---------------------------------------------------------------------------

/**
 * What the drag test concluded about the occlusion gap.
 *
 *  - 'through'   — the ball came out of the gap SLOWER than free fall alone
 *                  would have left it. Something bled energy off it: the net
 *                  (and/or the rim). Consistent with having gone through.
 *  - 'untouched' — it came out at ~100% of free fall. NOTHING touched it, so
 *                  it fell through clean air: in front of / behind the hoop,
 *                  or a clean miss. This is the veto.
 *  - 'reject'    — ~0 or negative. Not the same ball (an unrelated court ball,
 *                  or a rebound already travelling upward).
 *  - 'unknown'   — the inputs cannot support ANY of the above. This is the
 *                  default answer, not a fallback: see REAPPEAR.dragMinGapSec
 *                  for how often the honest answer at 30 fps is 'unknown'.
 */
export type DragVerdict = 'through' | 'untouched' | 'reject' | 'unknown';

/** Inputs to {@link dragRatio}. All velocities are image coords, +y DOWN. */
export interface DragRatioInput {
  /**
   * Downward velocity at the LAST real sample before the gap, px/s. Sourced
   * from the pre-gap parabola's own derivative (2·ya·t + yb), never from the
   * tracker's Kalman velocity — the filter carries a gravity prior
   * (TRACKER.gravityPxPerSec2Fallback) and coasts on it through exactly this
   * occlusion, so its post-gap velocity is pulled toward the free-fall answer
   * this test is trying to falsify. Measuring against filter state that
   * already assumes free fall would make the verdict circular.
   */
  vyEntryPxPerSec: number;
  /** Seconds from that sample to the epoch of `vyMeasuredPxPerSec`. */
  gapSec: number;
  /** Measured downward velocity after the gap, px/s. */
  vyMeasuredPxPerSec: number;
  /** Image-plane gravity, px/s². See GRAVITY_MPS2 for how it is derived. */
  gravityPxPerSec2: number;
}

export interface DragRatioResult {
  /**
   * measured / expected. NaN when the ratio is not even computable (bad
   * inputs, or an `expected` too small to divide by). Reported even when the
   * verdict is 'unknown' so telemetry can re-fit the bands from real footage.
   */
  ratio: number;
  verdict: DragVerdict;
}

/**
 * FREE-FALL DRAG TEST — the one question about an occluded shot that needs no
 * detection at the rim at all.
 *
 *   expected = vyEntry + g·gap      (constant acceleration, +y DOWN)
 *   ratio    = measured / expected
 *
 * Pure, deterministic, total: same inputs ⇒ same output, no clock, no state.
 *
 * WHY THE COMPARISON IS TIME-ROBUST: under constant g a velocity deficit Δv
 * imparted by a net contact is PRESERVED forever (both the touched and the
 * untouched ball gain g·t thereafter), so it does not matter where inside the
 * gap the contact happened. What DOES change with time is the deficit's
 * relative size: ratio = 1 − Δv/(vyEntry + g·gap) drifts toward 1 as the gap
 * grows. A long occlusion therefore DILUTES a real 'through' into 'untouched'
 * — which is a false veto (recall cost), never a false make.
 *
 * BREAD-BALL (INVIOLABLE RULE #1 — never fabricate a make), branch by branch:
 *  - 'reject'    discards the sample. Removes evidence. Cannot mint a make.
 *  - 'untouched' is a veto at the call site. Removes evidence. Cannot mint.
 *  - 'through'   is NOT new evidence — it merely declines to veto, leaving the
 *                caller's pre-existing corroborator contract (geo null→true
 *                only, with net === true or (net === null && cls)) exactly as
 *                it was. Nothing here opens a new make path.
 *  - 'unknown'   changes nothing at all.
 * There is no input to this function for which its return value can ADD make
 * evidence. That is the whole safety argument, and it is why the weak
 * discriminating power documented on REAPPEAR.dragMinGapSec is tolerable.
 *
 * @see REAPPEAR (config.ts) for the bands, the noise arithmetic behind the
 *      minimum gap, and the standing warning that none of it is validated on
 *      this app's footage.
 */
export function dragRatio(input: DragRatioInput): DragRatioResult {
  const { vyEntryPxPerSec, gapSec, vyMeasuredPxPerSec, gravityPxPerSec2 } = input;

  // Unusable inputs ⇒ 'unknown'. Never a guess: a NaN velocity or a
  // nonsense gravity has no honest verdict, and every caller of this test is
  // in the business of deciding whether a shot went in.
  if (
    !Number.isFinite(vyEntryPxPerSec) ||
    !Number.isFinite(gapSec) ||
    !Number.isFinite(vyMeasuredPxPerSec) ||
    !Number.isFinite(gravityPxPerSec2) ||
    gravityPxPerSec2 <= 0 ||
    gapSec <= 0
  ) {
    return { ratio: NaN, verdict: 'unknown' };
  }

  const expected = vyEntryPxPerSec + gravityPxPerSec2 * gapSec;
  // Expected speed near zero: the ratio's denominator collapses and pixel
  // noise swamps it. Floor expressed in units of g (scale-free — see
  // REAPPEAR.dragMinExpectedFreeFallSec) so it holds at any framing.
  if (expected < gravityPxPerSec2 * REAPPEAR.dragMinExpectedFreeFallSec) {
    return { ratio: NaN, verdict: 'unknown' };
  }

  const ratio = vyMeasuredPxPerSec / expected;

  // Gap too short for the free-fall increment to stand clear of measurement
  // noise — the bands are meaningless here, so report the number and refuse
  // to label it. (This is the branch that fires on most 30 fps rim
  // occlusions; see the arithmetic on REAPPEAR.dragMinGapSec.)
  if (gapSec < REAPPEAR.dragMinGapSec) return { ratio, verdict: 'unknown' };

  // Faster than free fall is physically impossible, so this is a broken
  // measurement, not evidence of clean air. Refuse rather than veto — an
  // 'untouched' here would be a confident label on garbage.
  if (ratio >= REAPPEAR.dragImpossibleMin) return { ratio, verdict: 'unknown' };

  // ~0 or negative: barely moving, or moving UP. Not the ball we lost.
  if (ratio < REAPPEAR.dragRejectMax) return { ratio, verdict: 'reject' };

  // Braked: the net and/or rim took energy out of it.
  if (ratio <= REAPPEAR.dragThroughMax) return { ratio, verdict: 'through' };

  // Between dragThroughMax and dragImpossibleMin: free fall, undisturbed.
  return { ratio, verdict: 'untouched' };
}

/** A drag verdict plus every number that produced it, for telemetry. */
export interface DragReading extends DragRatioResult {
  /** Seconds from the last pre-gap sample to the measurement epoch. */
  gapSec: number;
  vyEntryPxPerSec: number;
  vyMeasuredPxPerSec: number;
  /** vyEntry + g·gap, px/s. */
  expectedPxPerSec: number;
  gravityPxPerSec2: number;
  /**
   * Why no verdict was possible, when the refusal happened OUTSIDE
   * {@link dragRatio} (too small a rim to measure, no second post-gap sample,
   * the rim-derived gravity disagreeing with the flight's own curvature).
   * Present only alongside verdict 'unknown'.
   */
  refusal?: string;
}

export interface ReappearanceSample {
  cx: number;
  cy: number;
  /** Image-coords vertical velocity, +down. */
  vy: number;
  /** Apparent diameter px (2·r), for the depth check. 0/NaN → skipped. */
  diaPx: number;
}

export interface ReappearanceResult {
  /** A terminal decision happened this sample (corroborated OR disarmed). */
  fired: boolean;
  corroborates: boolean;
  reason: string;
  /**
   * Free-fall drag reading for THIS reappearance, present on the terminal
   * sample once the trap had a velocity pair to measure. Carried out so the
   * call can be audited from a real session instead of being invisible — the
   * bands it uses are unvalidated guesses and this is the only way they get
   * re-fit. Absent on samples that disarmed before the measurement existed
   * (y-residual, span, depth, TTL) and on idle samples.
   */
  drag?: DragReading;
}

const IDLE: ReappearanceResult = { fired: false, corroborates: false, reason: 'idle' };

export class ReappearanceTest {
  /**
   * Live kill-switch for the free-fall drag VETO, injectable so a caller (and
   * a test) can exercise the mechanism without depending on the shipped
   * default. Mirrors how the FSM's other guards are wired: a constructor opt
   * that falls back to the config value. Defaults to REAPPEAR.dragVetoEnabled,
   * which ships FALSE — see the long WHY there.
   */
  private readonly dragVeto: boolean;

  constructor(opts: { dragVetoEnabled?: boolean } = {}) {
    this.dragVeto = opts.dragVetoEnabled ?? REAPPEAR.dragVetoEnabled;
  }

  private fit: ArcFit | null = null;
  private rim: RimGeometry | null = null;
  private predictedCrossT = 0;
  private armedT = 0;
  private descendingSeen = 0;
  private done = false;
  // --- free-fall drag test state (all captured at arm time) ---------------
  /** Time of the last REAL pre-gap sample — the epoch vyEntry belongs to. */
  private entryT = 0;
  /** Descending velocity there, from the fitted parabola's own derivative. */
  private entryVyPxPerSec = 0;
  /** Image-plane gravity from the locked rim's width (see GRAVITY_MPS2). */
  private gravityPxPerSec2: number = TRACKER.gravityPxPerSec2Fallback;
  /** Set when the rim is too few pixels across for velocity to be measurable. */
  private dragRefusal: string | null = null;
  /** First post-gap sample that passed every gate — the velocity baseline. */
  private firstBelow: { t: number; cy: number } | null = null;

  get armed(): boolean {
    return this.fit != null && !this.done;
  }

  /**
   * Arm when the ball is lost mid-shot. Requires a trustworthy pre-gap arc:
   * ≥5 REAL samples, gravity signature, r²y ≥ 0.5, and a predictable future
   * crossing of the rim plane. Silently refuses otherwise.
   */
  armOnBallLost(history: readonly BallSample[], rim: RimGeometry, t: number): void {
    if (this.armed) return;
    const reals = history.filter((s) => !s.predicted);
    // fps-scaled pre-gap sample floor: at 8 fps the pre-occlusion flight
    // carries far fewer than the 30 fps count of 5, so scale the nominal to the
    // history's own measured cadence (never below 3) — otherwise a slow-phone
    // occluded shot can never arm the corroborator. At 30 fps this is 5,
    // unchanged. dt unknown (too few samples) ⇒ the nominal floor.
    const dt = medianSampleDt(reals);
    const minReal =
      dt === null
        ? REAPPEAR.minRealSamplesPreGap
        : scaleFrameGate(REAPPEAR.minRealSamplesPreGap, dt, ABS_MIN_FIT_SAMPLES);
    if (reals.length < minReal) return;
    const fit = fitArc(reals, minReal);
    if (!fit || fit.ya <= 0 || fit.r2y < REAPPEAR.minArcR2y) return;
    const cross = predictLanding(fit, rim.planeY);
    if (!cross || cross.t < t - 0.2) return; // crossing must be now-ish/future
    this.fit = fit;
    this.rim = rim;
    this.predictedCrossT = cross.t;
    this.armedT = t;
    this.descendingSeen = 0;
    this.done = false;
    this.firstBelow = null;
    this.captureDragBaseline(fit, rim);
  }

  /**
   * Freeze everything the free-fall drag test needs about the PRE-gap side of
   * the occlusion, at the instant the trap arms.
   *
   * vyEntry comes from the fitted parabola's own derivative at its last real
   * sample (d/dt of ya·t² + yb·t + yc = 2·ya·t + yb) rather than from any
   * tracker velocity — see DragRatioInput.vyEntryPxPerSec for why using
   * Kalman state would make the test circular.
   *
   * Two independent refusals are decided here rather than at measurement time,
   * because both are properties of the setup, not of the reappearance:
   *  - RIM TOO SMALL: a far-framed rim means a small ball whose centre jitters
   *    by a comparable number of pixels every frame, so the velocity estimate
   *    that feeds the ratio is noise. DEPTH_GATE.minRimWidthPx (40 px) is
   *    reused as the proxy — it exists for exactly the "pixel measurements are
   *    too coarse to be believed at this framing" question.
   *  - GRAVITY DISAGREEMENT: the rim-derived g and the flight's own fitted
   *    curvature (2·ya) are independent estimates of one quantity. When they
   *    disagree by more than REAPPEAR.dragGravityAgreeFrac the geometry is not
   *    what one of them assumed (camera pitch foreshortening vertical motion,
   *    a contaminated rim lock, a poor fit) and no ratio built on either is
   *    worth a verdict.
   */
  private captureDragBaseline(fit: ArcFit, rim: RimGeometry): void {
    this.entryT = fit.tMax;
    this.entryVyPxPerSec = 2 * fit.ya * fit.tMax + fit.yb;
    const rimW = rim.box.width;
    this.gravityPxPerSec2 =
      Number.isFinite(rimW) && rimW > 0
        ? GRAVITY_MPS2 * (rimW / COURT.rimDiameterM)
        : TRACKER.gravityPxPerSec2Fallback;
    this.dragRefusal = null;
    if (!(rimW >= DEPTH_GATE.minRimWidthPx)) {
      this.dragRefusal = `rim ${rimW.toFixed(0)}px too small to measure velocity`;
      return;
    }
    const gFit = 2 * fit.ya;
    const disagree = Math.abs(gFit - this.gravityPxPerSec2) / this.gravityPxPerSec2;
    if (disagree > REAPPEAR.dragGravityAgreeFrac) {
      this.dragRefusal =
        `gravity disagreement ${(disagree * 100).toFixed(0)}% ` +
        `(rim ${this.gravityPxPerSec2.toFixed(0)} vs arc ${gFit.toFixed(0)} px/s²)`;
    }
  }

  /**
   * Measure the post-gap descent and run the free-fall drag test.
   *
   * The velocity is a plain finite difference between the FIRST gated post-gap
   * sample and the current one — deliberately NOT the tracker's vy, which is
   * Kalman state carrying a gravity prior through this very occlusion. For a
   * constant-acceleration flight the secant (y₂−y₁)/(t₂−t₁) is EXACTLY the
   * instantaneous velocity at the midpoint time, so the comparison epoch is
   * that midpoint and the arithmetic carries no approximation of its own.
   */
  private readDrag(t: number, cy: number): DragReading {
    const g = this.gravityPxPerSec2;
    const refuse = (refusal: string): DragReading => ({
      ratio: NaN,
      verdict: 'unknown',
      gapSec: NaN,
      vyEntryPxPerSec: this.entryVyPxPerSec,
      vyMeasuredPxPerSec: NaN,
      expectedPxPerSec: NaN,
      gravityPxPerSec2: g,
      refusal,
    });
    if (this.dragRefusal !== null) return refuse(this.dragRefusal);
    const first = this.firstBelow;
    if (first === null) return refuse('no post-gap velocity baseline');
    const dt = t - first.t;
    if (!(dt > 0)) return refuse('zero-length velocity baseline');

    const vyMeasuredPxPerSec = (cy - first.cy) / dt;
    // Midpoint epoch: exact for a parabola, so `expected` needs no correction.
    const gapSec = (first.t + t) / 2 - this.entryT;
    const { ratio, verdict } = dragRatio({
      vyEntryPxPerSec: this.entryVyPxPerSec,
      gapSec,
      vyMeasuredPxPerSec,
      gravityPxPerSec2: g,
    });
    return {
      ratio,
      verdict,
      gapSec,
      vyEntryPxPerSec: this.entryVyPxPerSec,
      vyMeasuredPxPerSec,
      expectedPxPerSec: this.entryVyPxPerSec + g * gapSec,
      gravityPxPerSec2: g,
    };
  }

  /**
   * Feed a REAL detection while armed. Returns a terminal result exactly once
   * (corroborated or disarmed); idle otherwise. Per the hardened spec, any
   * real sample FAILING a match test disarms the trap — a mismatched ball is
   * evidence of a bounce/other ball, not noise to wait out.
   */
  onSample(
    s: ReappearanceSample,
    t: number,
    netScoreEma: number,
    ballSize: BallSizeSetting,
  ): ReappearanceResult {
    if (!this.armed || this.fit == null || this.rim == null) return IDLE;

    // TTL / net-hang window (checked first — a stale trap must never fire).
    if (this.expired(t, netScoreEma)) {
      this.done = true;
      return { fired: true, corroborates: false, reason: 'ttl' };
    }

    // Only samples BELOW the rim plane count as "reappeared under the rim";
    // above-plane detections during the gap are other objects/noise — but a
    // clearly-mismatched above-plane ball still disarms via time-consistency.
    const pred = evalArc(this.fit, t);
    const yResidual = Math.abs(s.cy - pred.y);
    if (yResidual > REAPPEAR.yResidualMaxPx) {
      this.done = true;
      return { fired: true, corroborates: false, reason: `y-residual ${yResidual.toFixed(0)}px` };
    }
    if (s.cy <= this.rim.planeY) return IDLE; // consistent but not below yet

    if (!(s.vy > 0)) {
      this.done = true;
      return { fired: true, corroborates: false, reason: 'not descending (putback rise?)' };
    }

    const widen = (this.rim.spanRight - this.rim.spanLeft) * REAPPEAR.spanWidenFrac;
    if (s.cx < this.rim.spanLeft - widen || s.cx > this.rim.spanRight + widen) {
      this.done = true;
      return { fired: true, corroborates: false, reason: 'outside widened span' };
    }

    if (Number.isFinite(s.diaPx) && s.diaPx > 0) {
      const depth = depthConsistencyAtSample(s.diaPx, this.rim.box.width, ballSize);
      if (depth === 'front' || depth === 'behind') {
        this.done = true;
        return { fired: true, corroborates: false, reason: `depth ${depth}` };
      }
    }

    this.descendingSeen++;
    // Latch the first gated post-gap sample as the velocity baseline. Every
    // later gated sample measures against it, so a vyDownSamples above 2
    // widens the baseline (and cuts the velocity noise) for free.
    if (this.firstBelow === null) this.firstBelow = { t, cy: s.cy };
    if (this.descendingSeen < REAPPEAR.vyDownSamples) return IDLE;

    // --- free-fall drag test (the last gate) ---------------------------------
    const drag = this.readDrag(t, s.cy);
    this.done = true;

    // 'reject' — the thing we are looking at is not the ball we lost: it is
    // barely moving, or moving upward, when the gap says it should be falling
    // hard. Discard it as not-the-same-ball, which in this trap means DISARM:
    // the whole premise of the corroborator is that the reappeared object IS
    // the tracked ball, and the hardened spec already treats any failed match
    // test as evidence of a different object rather than noise to wait out.
    // BREAD-BALL: removes a make term. Cannot fabricate anything.
    if (drag.verdict === 'reject') {
      return {
        fired: true,
        corroborates: false,
        reason: `drag reject (ratio ${drag.ratio.toFixed(2)} — not the same ball)`,
        drag,
      };
    }

    // 'untouched' — it came out of the gap at ~100% of free fall, so NOTHING
    // bled energy off it: no net, no rim. It fell through clean air, in front
    // of or behind the hoop, or it simply missed. VETO the corroboration.
    // BREAD-BALL: this branch only ever SUBTRACTS a make term, so it needs no
    // agreement from any other signal to be safe — the worst it can do is
    // leave a genuine make as 'unsure' (notably on a netless hoop, where a
    // true swish really does touch nothing; see REAPPEAR.dragVetoEnabled).
    // A suppression that costs recall is the correct failure direction.
    if (drag.verdict === 'untouched' && this.dragVeto) {
      return {
        fired: true,
        corroborates: false,
        reason: `drag untouched (ratio ${drag.ratio.toFixed(2)} ≈ free fall, nothing touched it)`,
        drag,
      };
    }

    // 'through' or 'unknown' — the pre-existing verdict stands UNCHANGED.
    // BREAD-BALL: 'through' is deliberately NOT promoted into new evidence.
    // It does not create a make path, raise a confidence, or relax any other
    // gate; it merely declines to veto, leaving the caller's corroborator
    // contract (upgrade geo null→true only, and only with net === true or
    // (net === null && cls)) exactly as strict as it was before this test
    // existed. 'unknown' is the same no-op, reached whenever the physics
    // cannot discriminate — which at 30 fps is most of the time.
    return { fired: true, corroborates: true, reason: 'reappeared through the rim', drag };
  }

  /** True when the trap has timed out at time `t` (net-hang extends it). */
  expired(t: number, netScoreEma: number): boolean {
    if (!this.armed) return false;
    const netHang = netScoreEma > 0.15;
    if (netHang) return t > this.armedT + REAPPEAR.maxGapNetHangSec;
    return (
      t > this.predictedCrossT + REAPPEAR.ttlAfterPredictedCrossSec ||
      t > this.armedT + REAPPEAR.maxGapSec
    );
  }

  clear(): void {
    this.fit = null;
    this.rim = null;
    this.done = false;
    this.descendingSeen = 0;
    this.firstBelow = null;
    this.dragRefusal = null;
  }
}
