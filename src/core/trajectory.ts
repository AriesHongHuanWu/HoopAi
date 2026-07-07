/**
 * Parabola fitting + shot-arc math over ball trajectories.
 *
 * Everything operates in analysis-frame pixel space (+y DOWN, see types.ts),
 * with time in seconds from camera timestamps. Because screen y points down,
 * gravity makes the fitted quadratic open UPWARD in screen coords (ya > 0)
 * and the parabola vertex (minimum screen y) is the real-world apex.
 *
 * All functions are pure and allocation-conscious: `fitArc` does two passes
 * over the samples with scalar accumulators and allocates only the result.
 */
import { SHOT_FSM } from './config';
import { elevationAngleDeg, interpolateXAtY } from './geometry';
import type { BallSample, Point } from './types';

/**
 * A fitted shot arc: quadratic in time for y, linear in time for x.
 *
 *   y(t) = ya*t² + yb*t + yc   (screen coords, y down ⇒ ya > 0 under gravity)
 *   x(t) = xm*t + xq
 *
 * Coefficients are in ABSOLUTE time (same `t` as the input samples), valid
 * over [tMin, tMax]. `r2y` is the weighted coefficient of determination of
 * the vertical fit (1 = perfect parabola).
 */
export interface ArcFit {
  /** Quadratic y-coefficient, px/s². ≈ g/2 for a ballistic arc. */
  ya: number;
  /** Linear y-coefficient, px/s. */
  yb: number;
  /** Constant y-coefficient, px. */
  yc: number;
  /** Horizontal velocity, px/s. */
  xm: number;
  /** Horizontal intercept at t = 0, px. */
  xq: number;
  /** Weighted R² of the vertical (quadratic) fit. */
  r2y: number;
  /** Earliest sample time covered by the fit, seconds. */
  tMin: number;
  /** Latest sample time covered by the fit, seconds. */
  tMax: number;
}

/** Least-squares weight given to Kalman-predicted samples (score is 0). */
const PREDICTED_WEIGHT = 0.25;

/** Weight floor for detected samples so a zero-score row cannot vanish. */
const MIN_DETECTED_WEIGHT = 1e-3;

/** Minimum number of samples required for a meaningful arc fit. */
const MIN_FIT_SAMPLES = 5;

/** Relative threshold below which the normal-equation system is singular. */
const SINGULAR_REL_EPS = 1e-9;

/** Weighted y-variance below which the trajectory is flat (no arc). */
const FLAT_SS_TOT_EPS = 1e-9;

/** Least-squares weight of one sample. */
function sampleWeight(s: BallSample): number {
  return s.predicted
    ? PREDICTED_WEIGHT
    : s.score > MIN_DETECTED_WEIGHT
      ? s.score
      : MIN_DETECTED_WEIGHT;
}

/**
 * Weighted least-squares fit of a shot arc over ball samples:
 * quadratic y(t), linear x(t). Samples are weighted by detector score;
 * Kalman-predicted samples get a fixed weight of 0.25 so occlusion
 * gap-filling cannot dominate real observations.
 *
 * Returns null when the fit is impossible or meaningless:
 * - fewer than 5 samples,
 * - degenerate time distribution (e.g. all timestamps equal), or
 * - no vertical extent (flat roll — R² undefined).
 */
export function fitArc(samples: readonly BallSample[]): ArcFit | null {
  const n = samples.length;
  if (n < MIN_FIT_SAMPLES) return null;

  // Time bounds; fit in τ = t - tMin for numerical conditioning.
  let tMin = samples[0].t;
  let tMax = samples[0].t;
  for (let i = 1; i < n; i++) {
    const t = samples[i].t;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const t0 = tMin;

  // Weighted moment sums.
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let ty0 = 0;
  let ty1 = 0;
  let ty2 = 0;
  let tx0 = 0;
  let tx1 = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const w = sampleWeight(s);
    const tau = s.t - t0;
    const wt = w * tau;
    const wt2 = wt * tau;
    s0 += w;
    s1 += wt;
    s2 += wt2;
    s3 += wt2 * tau;
    s4 += wt2 * tau * tau;
    ty0 += w * s.cy;
    ty1 += wt * s.cy;
    ty2 += wt2 * s.cy;
    tx0 += w * s.cx;
    tx1 += wt * s.cx;
  }

  // Solve the symmetric 3×3 normal equations
  //   [s4 s3 s2] [A]   [ty2]
  //   [s3 s2 s1] [B] = [ty1]
  //   [s2 s1 s0] [C]   [ty0]
  // for y(τ) = A τ² + B τ + C via Cramer's rule.
  const det =
    s4 * (s2 * s0 - s1 * s1) -
    s3 * (s3 * s0 - s1 * s2) +
    s2 * (s3 * s1 - s2 * s2);
  const detScale = Math.max(Math.abs(s4 * s2 * s0), 1e-12);
  if (!Number.isFinite(det) || Math.abs(det) < SINGULAR_REL_EPS * detScale) {
    return null;
  }
  const detA =
    ty2 * (s2 * s0 - s1 * s1) -
    s3 * (ty1 * s0 - s1 * ty0) +
    s2 * (ty1 * s1 - s2 * ty0);
  const detB =
    s4 * (ty1 * s0 - s1 * ty0) -
    ty2 * (s3 * s0 - s1 * s2) +
    s2 * (s3 * ty0 - ty1 * s2);
  const detC =
    s4 * (s2 * ty0 - ty1 * s1) -
    s3 * (s3 * ty0 - ty1 * s2) +
    ty2 * (s3 * s1 - s2 * s2);
  const qa = detA / det;
  const qb = detB / det;
  const qc = detC / det;

  // Weighted linear fit x(τ) = m τ + q.
  const xDen = s0 * s2 - s1 * s1;
  if (!Number.isFinite(xDen) || Math.abs(xDen) < SINGULAR_REL_EPS * Math.max(Math.abs(s0 * s2), 1e-12)) {
    return null;
  }
  const xm = (s0 * tx1 - s1 * tx0) / xDen;
  const xqTau = (tx0 - xm * s1) / s0;

  // Weighted R² of the vertical fit.
  const yMean = ty0 / s0;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    const w = sampleWeight(s);
    const tau = s.t - t0;
    const dMean = s.cy - yMean;
    const dFit = s.cy - ((qa * tau + qb) * tau + qc);
    ssTot += w * dMean * dMean;
    ssRes += w * dFit * dFit;
  }
  if (ssTot <= FLAT_SS_TOT_EPS) return null; // flat roll: no arc to speak of
  const r2y = 1 - ssRes / ssTot;

  // Convert τ-space coefficients back to absolute time t = τ + t0.
  return {
    ya: qa,
    yb: qb - 2 * qa * t0,
    yc: (qa * t0 - qb) * t0 + qc,
    xm,
    xq: xqTau - xm * t0,
    r2y,
    tMin,
    tMax,
  };
}

/**
 * Evaluate a fitted arc at absolute time `t` (seconds), returning the
 * predicted ball center in analysis-frame pixels. `t` is not clamped to
 * [tMin, tMax]; extrapolation is the caller's choice.
 */
export function evalArc(fit: ArcFit, t: number): Point {
  return {
    x: fit.xm * t + fit.xq,
    y: (fit.ya * t + fit.yb) * t + fit.yc,
  };
}

/**
 * Sample `n` points evenly spaced in time across [tMin, tMax] for drawing
 * the fitted arc. Endpoints are included when n ≥ 2; n = 1 yields the point
 * at tMin; n ≤ 0 yields an empty array.
 */
export function sampleArc(fit: ArcFit, n: number): Point[] {
  const count = Math.floor(n);
  if (count <= 0) return [];
  const pts: Point[] = new Array(count);
  if (count === 1) {
    pts[0] = evalArc(fit, fit.tMin);
    return pts;
  }
  const step = (fit.tMax - fit.tMin) / (count - 1);
  for (let i = 0; i < count; i++) {
    pts[i] = evalArc(fit, fit.tMin + step * i);
  }
  return pts;
}

/**
 * Release angle: elevation angle (degrees above horizontal, real-world
 * orientation) of the net displacement across the first `n` NON-predicted
 * samples (default SHOT_FSM.releaseAngleSamples). Positive = upward.
 *
 * Returns null when fewer than 2 usable (non-predicted) samples exist.
 * Samples are assumed chronological.
 */
export function releaseAngleDeg(
  samples: readonly BallSample[],
  n: number = SHOT_FSM.releaseAngleSamples,
): number | null {
  let first: BallSample | null = null;
  let last: BallSample | null = null;
  let used = 0;
  for (let i = 0; i < samples.length && used < n; i++) {
    const s = samples[i];
    if (s.predicted) continue;
    if (first === null) first = s;
    last = s;
    used++;
  }
  if (first === null || last === null || used < 2) return null;
  return elevationAngleDeg(last.cx - first.cx, last.cy - first.cy);
}

/**
 * Index `i` of the first DESCENDING crossing of `planeY`: samples[i] is the
 * last sample above (cy ≤ planeY, screen y down) and samples[i+1] the first
 * below (cy > planeY). Returns -1 when the trajectory never descends through
 * the plane. Samples are assumed chronological.
 */
function findDescendingCrossing(
  samples: readonly BallSample[],
  planeY: number,
): number {
  for (let i = 0; i + 1 < samples.length; i++) {
    if (samples[i].cy <= planeY && samples[i + 1].cy > planeY) return i;
  }
  return -1;
}

/**
 * Entry angle at a horizontal plane (typically the rim plane): the ABSOLUTE
 * elevation angle (degrees from horizontal) of the ball's velocity where the
 * trajectory first descends through `planeY`. Velocity direction is taken
 * from a local secant spanning ±2 samples around the crossing (clamped to
 * the array), which is robust to single-frame jitter.
 *
 * Returns null when there is no descending crossing, or the secant is
 * degenerate (zero displacement).
 */
export function entryAngleDegAtPlane(
  samples: readonly BallSample[],
  planeY: number,
): number | null {
  const i = findDescendingCrossing(samples, planeY);
  if (i < 0) return null;
  const j0 = Math.max(0, i - 1);
  const j1 = Math.min(samples.length - 1, i + 2);
  const a = samples[j0];
  const b = samples[j1];
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  if (dx === 0 && dy === 0) return null;
  return Math.abs(elevationAngleDeg(dx, dy));
}

/**
 * Apex of a fitted arc: the parabola vertex — minimum screen y, i.e. the
 * real-world HIGHEST point. Returns null when the fit has no upward apex
 * (ya ≤ 0) or the vertex time falls outside [tMin, tMax] (the arc was only
 * ever ascending or only descending within the observed window).
 */
export function apexPoint(fit: ArcFit): Point | null {
  if (fit.ya <= 0) return null;
  const tv = -fit.yb / (2 * fit.ya);
  if (!Number.isFinite(tv) || tv < fit.tMin || tv > fit.tMax) return null;
  return evalArc(fit, tv);
}

/**
 * PREDICTED landing: where the fitted arc will descend through `planeY`,
 * extrapolated into the FUTURE — the "where is this ball coming down" marker,
 * available mid-flight long before the ball actually gets there.
 *
 * Solves ya·t² + yb·t + yc = planeY and takes the DESCENDING root (dy/dt > 0,
 * +y down; for a gravity fit ya > 0 that is the larger root). Returns null
 * when the fit has no gravity signature (ya ≤ 0), the arc's apex never
 * reaches the plane (a flight that can't get up to rim height), or the
 * crossing would precede the fit's own start (backward extrapolation).
 */
export function predictLanding(
  fit: ArcFit,
  planeY: number,
): { x: number; y: number; t: number } | null {
  if (fit.ya <= 0) return null;
  const a = fit.ya;
  const b = fit.yb;
  const c = fit.yc - planeY;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null; // apex never reaches the plane
  const t = (-b + Math.sqrt(disc)) / (2 * a); // larger root = descending
  if (!Number.isFinite(t) || t < fit.tMin) return null;
  const x = fit.xm * t + fit.xq;
  if (!Number.isFinite(x)) return null;
  return { x, y: planeY, t };
}

/**
 * Interpolated x (analysis px) where the trajectory first descends through
 * `planeY`, from linear interpolation over the bracketing sample pair.
 * Returns null when the trajectory never descends through the plane.
 */
export function xAtPlaneY(
  samples: readonly BallSample[],
  planeY: number,
): number | null {
  const i = findDescendingCrossing(samples, planeY);
  if (i < 0) return null;
  const a = samples[i];
  const b = samples[i + 1];
  return interpolateXAtY(
    { x: a.cx, y: a.cy },
    { x: b.cx, y: b.cy },
    planeY,
  );
}
