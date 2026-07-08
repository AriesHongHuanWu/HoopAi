/**
 * Full-flight parabola accumulator.
 *
 * Where {@link ./ballTracker} follows the ball frame-to-frame with a Kalman
 * filter (good locally, blind globally), FlightArc keeps a rolling buffer of
 * the WHOLE shot's samples and re-fits ONE global parabola over them. That
 * global arc is what lets the pipeline predict where the ball is across the
 * entire flight — not just inside the hoop ROI — so a faint mid-arc detection
 * that the cold score floor would reject can be kept alive because it sits on
 * the predicted path (see the tracker's corridor-relax branch).
 *
 * Everything is in analysis-frame pixels (+y DOWN) with camera-timestamp
 * seconds, matching {@link ./trajectory}. Stateful but deterministic: the same
 * sequence of push()/reset() calls always yields the same fit, so a recorded
 * session replays identically.
 *
 * Gated behind config.FLIGHT.useFlightArc — the pipeline only builds/consults
 * a FlightArc when the flag is on, so this is inert until validated on clips.
 */
import { FLIGHT } from './config';
import {
  ABS_MIN_FIT_SAMPLES,
  evalArc,
  fitArc,
  predictLanding,
  type ArcFit,
} from './trajectory';
import type { BallSample, Point, TrackedBall } from './types';

/** A point on the predicted flight path plus the tube radius around it. */
export interface CorridorPoint {
  /** Predicted ball center on the global arc at the queried time. */
  p: Point;
  /** Radius (px) of the acceptance tube around `p` for score relaxation. */
  tubeR: number;
}

export class FlightArc {
  /** Rolling buffer of flight samples (chronological), capped at maxFlightSamples. */
  private samples: BallSample[] = [];
  /** Cached fit; null when dirty (recomputed lazily). */
  private cache: ArcFit | null = null;
  /** True when `samples` changed since the last fit() — forces a refit. */
  private dirty = true;
  /** minSamples the cache was computed with (a change forces a refit). */
  private cacheMinSamples = -1;
  /** Time of the most recent REAL (non-predicted) sample; -Infinity if none. */
  private lastRealT = -Infinity;

  /**
   * Clear the buffer for a new flight. `releaseT` is retained only so callers
   * can correlate a fresh arc with the release event; the fit itself is purely
   * sample-driven.
   */
  reset(_releaseT: number): void {
    this.samples.length = 0;
    this.cache = null;
    this.dirty = true;
    this.cacheMinSamples = -1;
    this.lastRealT = -Infinity;
  }

  /**
   * Append one tracked ball to the flight. Predicted (Kalman-coasted) samples
   * are kept — fitArc down-weights them — but do NOT advance the freshness
   * clock, so a long occlusion correctly ages out the corridor. The buffer is
   * capped at FLIGHT.maxFlightSamples (oldest dropped) to bound the fit cost
   * and keep the arc local to the current shot.
   */
  push(b: TrackedBall): void {
    this.samples.push({
      cx: b.cx,
      cy: b.cy,
      r: b.r,
      t: b.t,
      score: b.score,
      predicted: b.predicted,
    });
    if (this.samples.length > FLIGHT.maxFlightSamples) {
      this.samples.shift();
    }
    if (!b.predicted && b.t > this.lastRealT) this.lastRealT = b.t;
    this.dirty = true;
  }

  /** Number of samples currently buffered (reals + predictions). */
  get sampleCount(): number {
    return this.samples.length;
  }

  /** Time of the most recent real sample (-Infinity before any real push). */
  get lastReal(): number {
    return this.lastRealT;
  }

  /**
   * The current global arc fit, or null when there aren't enough samples or the
   * flight is too flat/degenerate to fit. `minSamples` is the fps-scaled floor
   * the caller wants (never below ABS_MIN_FIT_SAMPLES); the result is memoised
   * until the next push()/reset() or a change in `minSamples`.
   */
  fit(minSamples: number = ABS_MIN_FIT_SAMPLES): ArcFit | null {
    const floor = Math.max(ABS_MIN_FIT_SAMPLES, Math.round(minSamples));
    if (!this.dirty && floor === this.cacheMinSamples) return this.cache;
    this.cache = fitArc(this.samples, floor);
    this.cacheMinSamples = floor;
    this.dirty = false;
    return this.cache;
  }

  /**
   * Where the global arc predicts the ball to be at time `t`, plus the
   * acceptance tube around it — or null when the corridor can't be trusted:
   *
   *  - the last real sample is staler than FLIGHT.corridorFreshSec (the flight
   *    has gone dark; extrapolating further would invent a ghost path), or
   *  - the vertical fit quality is below FLIGHT.corridorMinR2yLoose (the path
   *    is noise, not a parabola).
   *
   * The tube radius scales with rim width (FLIGHT.corridorTubeRimWidths), so
   * the relaxation locality tracks the on-screen scale of the scene. This is a
   * SCORE-FLOOR relaxation only — a candidate inside the tube still has to be a
   * real ball detection above the tracking floor and pass every tracker gate —
   * so a loose R² here cannot mint a phantom ball.
   */
  corridorPoint(
    t: number,
    rimWidthPx: number,
    minSamples: number = ABS_MIN_FIT_SAMPLES,
  ): CorridorPoint | null {
    if (!(rimWidthPx > 0)) return null;
    if (t - this.lastRealT > FLIGHT.corridorFreshSec) return null;
    const fit = this.fit(minSamples);
    if (!fit || fit.r2y < FLIGHT.corridorMinR2yLoose) return null;
    const p = evalArc(fit, t);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    const tubeR = FLIGHT.corridorTubeRimWidths * rimWidthPx;
    if (!(tubeR > 0)) return null;
    return { p, tubeR };
  }

  /**
   * Predicted landing point where the global arc descends through `planeY`,
   * using the STRICT quality bar (FLIGHT.corridorMinR2yStrict) because a
   * crossing feeds the make/miss judgment — a loose fit must never drive an
   * outcome. Returns null when the fit is too weak or never reaches the plane.
   */
  landing(
    planeY: number,
    minSamples: number = ABS_MIN_FIT_SAMPLES,
  ): { x: number; y: number; t: number } | null {
    const fit = this.fit(minSamples);
    if (!fit || fit.r2y < FLIGHT.corridorMinR2yStrict) return null;
    return predictLanding(fit, planeY);
  }
}
