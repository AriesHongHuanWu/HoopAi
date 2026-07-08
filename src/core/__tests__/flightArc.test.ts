/**
 * FlightArc tests.
 *
 * FlightArc is pure (no Kalman, no worklet) so it is exercised directly with
 * synthetic TrackedBall samples: a clean projectile for the happy paths, an
 * oscillating y for the poor-fit rejection, and predicted samples to prove the
 * freshness clock is driven only by REAL detections.
 *
 * Screen space is +y DOWN, so an upward launch has cy decreasing then
 * increasing (apex = minimum cy), matching src/core/trajectory.ts.
 */
import { FlightArc } from '../flightArc';
import { FLIGHT } from '../config';
import type { TrackedBall } from '../types';

const FPS = 30;
const DT = 1 / FPS;

// Projectile constants shared by the clean-arc fixtures.
const G = 900;
const X0 = 100;
const Y0 = 500;
const VX = 150;
const VY0 = 400; // upward launch speed (px/s)

/** A TrackedBall on the reference projectile at absolute time `t`. */
function arcBall(
  t: number,
  opts: { score?: number; predicted?: boolean } = {},
): TrackedBall {
  const cx = X0 + VX * t;
  const cy = Y0 - VY0 * t + 0.5 * G * t * t;
  return {
    cx,
    cy,
    r: 15,
    t,
    score: opts.score ?? 0.8,
    predicted: opts.predicted ?? false,
    vx: VX,
    vy: -VY0 + G * t,
  };
}

/** Pushes `n` clean arc samples starting at frame index `i0`. */
function pushArc(arc: FlightArc, n: number, i0 = 0): void {
  for (let i = 0; i < n; i++) arc.push(arcBall((i0 + i) * DT));
}

describe('FlightArc', () => {
  test('fit is null below the sample floor and valid on a clean arc', () => {
    const arc = new FlightArc();
    arc.push(arcBall(0));
    arc.push(arcBall(DT));
    expect(arc.fit(3)).toBeNull(); // 2 < ABS_MIN_FIT_SAMPLES

    pushArc(arc, 6, 2); // now 8 samples total
    const fit = arc.fit();
    expect(fit).not.toBeNull();
    expect(fit!.ya).toBeGreaterThan(0); // gravity opens the parabola upward (y down)
    expect(fit!.r2y).toBeGreaterThan(0.99);
  });

  test('corridorPoint returns a path point and rim-scaled tube when fresh and confident', () => {
    const arc = new FlightArc();
    pushArc(arc, 8); // lastReal = 7*DT
    const rimWidth = 40;
    const t = 8 * DT; // one frame past the last sample (the pipeline's lag)
    const cp = arc.corridorPoint(t, rimWidth);
    expect(cp).not.toBeNull();
    // Tube radius scales with rim width by the configured multiple.
    expect(cp!.tubeR).toBeCloseTo(FLIGHT.corridorTubeRimWidths * rimWidth, 6);
    // The predicted point lies on the true arc (clean data => fit ≈ truth).
    const truth = arcBall(t);
    expect(cp!.p.x).toBeCloseTo(truth.cx, 1);
    expect(cp!.p.y).toBeCloseTo(truth.cy, 1);
  });

  test('corridor goes stale past the freshness window (based on last REAL sample)', () => {
    const arc = new FlightArc();
    pushArc(arc, 8);
    const lastReal = 7 * DT;
    expect(
      arc.corridorPoint(lastReal + FLIGHT.corridorFreshSec - 0.01, 40),
    ).not.toBeNull();
    expect(
      arc.corridorPoint(lastReal + FLIGHT.corridorFreshSec + 0.01, 40),
    ).toBeNull();
  });

  test('predicted samples do not refresh the corridor freshness clock', () => {
    const arc = new FlightArc();
    pushArc(arc, 6); // reals through t = 5*DT
    const lastReal = 5 * DT;
    // Coasted predictions much later in time — must NOT advance lastReal.
    arc.push(arcBall(0.4, { predicted: true, score: 0 }));
    arc.push(arcBall(0.5, { predicted: true, score: 0 }));
    arc.push(arcBall(0.6, { predicted: true, score: 0 }));
    expect(arc.lastReal).toBeCloseTo(lastReal, 6);
    // A query the corridor would answer IF predictions had refreshed the clock
    // (0.6 + fresh) but that real-only freshness rejects as stale.
    expect(arc.corridorPoint(1.0, 40)).toBeNull();
  });

  test('no corridor for a non-positive rim width', () => {
    const arc = new FlightArc();
    pushArc(arc, 8);
    expect(arc.corridorPoint(8 * DT, 0)).toBeNull();
    expect(arc.corridorPoint(8 * DT, -5)).toBeNull();
  });

  test('a poorly-fit (non-parabolic) path yields neither a corridor nor a landing', () => {
    const arc = new FlightArc();
    // Oscillating y: real vertical variance but a terrible quadratic fit, so
    // r2y falls below both the loose corridor and strict landing thresholds.
    const ys = [500, 400, 500, 400, 500, 400];
    for (let i = 0; i < ys.length; i++) {
      arc.push({
        cx: 100 + 10 * i,
        cy: ys[i]!,
        r: 15,
        t: i * DT,
        score: 0.8,
        predicted: false,
        vx: 0,
        vy: 0,
      });
    }
    const fit = arc.fit();
    expect(fit).not.toBeNull();
    expect(fit!.r2y).toBeLessThan(FLIGHT.corridorMinR2yLoose);
    expect(arc.corridorPoint(6 * DT, 40)).toBeNull();
    expect(arc.landing(Y0)).toBeNull();
  });

  test('landing predicts the descending crossing of the rim plane on a clean arc', () => {
    const arc = new FlightArc();
    pushArc(arc, 14); // spans the apex (t_apex = VY0/G ≈ 0.444)
    const landing = arc.landing(Y0);
    expect(landing).not.toBeNull();
    expect(landing!.y).toBeCloseTo(Y0, 6);
    // Ballistic return to launch height: t = 2*VY0/G.
    expect(landing!.t).toBeCloseTo((2 * VY0) / G, 1);
    expect(Number.isFinite(landing!.x)).toBe(true);
  });

  test('reset clears samples, freshness and the fit', () => {
    const arc = new FlightArc();
    pushArc(arc, 10);
    arc.reset(0);
    expect(arc.sampleCount).toBe(0);
    expect(arc.lastReal).toBe(Number.NEGATIVE_INFINITY);
    expect(arc.fit()).toBeNull();
    expect(arc.corridorPoint(0.3, 40)).toBeNull();
  });

  test('the sample buffer is capped at FLIGHT.maxFlightSamples', () => {
    const arc = new FlightArc();
    pushArc(arc, FLIGHT.maxFlightSamples + 40);
    expect(arc.sampleCount).toBe(FLIGHT.maxFlightSamples);
  });
});
