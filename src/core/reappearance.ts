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
 *
 * TTL: the trap hard-clears at predictedCrossT + 0.7s regardless of interim
 * detections; while net motion stays elevated (a net-hang make) the window
 * extends to 2.0s from arming. Timeout NEVER means "miss" — the FSM resolves
 * on its remaining signals or 'unsure'.
 *
 * Pure TypeScript; unit-tested against every adversarial fixture that broke
 * the original design.
 */
import { REAPPEAR } from './config';
import { depthConsistencyAtSample, type BallSizeSetting } from './depthRatioGate';
import { evalArc, fitArc, predictLanding, type ArcFit } from './trajectory';
import type { BallSample, RimGeometry } from './types';

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
}

const IDLE: ReappearanceResult = { fired: false, corroborates: false, reason: 'idle' };

export class ReappearanceTest {
  private fit: ArcFit | null = null;
  private rim: RimGeometry | null = null;
  private predictedCrossT = 0;
  private armedT = 0;
  private descendingSeen = 0;
  private done = false;

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
    if (reals.length < REAPPEAR.minRealSamplesPreGap) return;
    const fit = fitArc(reals);
    if (!fit || fit.ya <= 0 || fit.r2y < REAPPEAR.minArcR2y) return;
    const cross = predictLanding(fit, rim.planeY);
    if (!cross || cross.t < t - 0.2) return; // crossing must be now-ish/future
    this.fit = fit;
    this.rim = rim;
    this.predictedCrossT = cross.t;
    this.armedT = t;
    this.descendingSeen = 0;
    this.done = false;
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
    if (this.descendingSeen >= REAPPEAR.vyDownSamples) {
      this.done = true;
      return { fired: true, corroborates: true, reason: 'reappeared through the rim' };
    }
    return IDLE;
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
  }
}
