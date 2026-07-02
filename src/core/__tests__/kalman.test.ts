import { describe, expect, test } from '@jest/globals';

import { TRACKER } from '../config';
import { BallKalman } from '../kalman';

const G = TRACKER.gravityPxPerSec2Fallback; // px/s², +y down
const FPS = 30;
const DT = 1 / FPS;

/** Ground-truth projectile in screen space (+y DOWN, upward vy < 0). */
function projectile(
  t: number,
  x0: number,
  y0: number,
  vx0: number,
  vy0: number,
  g: number,
) {
  return {
    x: x0 + vx0 * t,
    y: y0 + vy0 * t + 0.5 * g * t * t,
    vx: vx0,
    vy: vy0 + g * t,
  };
}

/** Deterministic PRNG (mulberry32) so noise tests are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard-normal via Box–Muller on the seeded PRNG. */
function gaussian(rand: () => number): () => number {
  return () => {
    let u = 0;
    while (u === 0) u = rand();
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

function rmse(errors: number[]): number {
  const sum = errors.reduce((acc, e) => acc + e * e, 0);
  return Math.sqrt(sum / errors.length);
}

describe('BallKalman', () => {
  const shot = { x0: 100, y0: 500, vx0: 220, vy0: -650 };

  test('uninitialized: state is null, initialized is false, predict throws', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    expect(kf.initialized).toBe(false);
    expect(kf.state).toBeNull();
    expect(() => kf.predict(0.1)).toThrow();
  });

  test('init seeds position with zero velocity and flips initialized', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    kf.init(120, 480, 1.5);
    expect(kf.initialized).toBe(true);
    expect(kf.state).toEqual({ x: 120, y: 480, vx: 0, vy: 0 });
  });

  test('first update on a fresh filter seeds the track', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    const s = kf.update(50, 60, 0.2);
    expect(kf.initialized).toBe(true);
    expect(s.x).toBe(50);
    expect(s.y).toBe(60);
  });

  test('tracks a clean 30fps projectile within 2px RMSE after settling', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    const { x0, y0, vx0, vy0 } = shot;
    const errors: number[] = [];
    for (let i = 0; i <= 60; i++) {
      const t = i * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      const est = kf.update(gt.x, gt.y, t);
      if (i >= 10) {
        errors.push(Math.hypot(est.x - gt.x, est.y - gt.y));
      }
    }
    expect(rmse(errors)).toBeLessThan(2);
  });

  test('with gaussian noise σ=4px, filtered RMSE beats raw measurement RMSE', () => {
    const sigma = 4;
    const kf = new BallKalman({ gravityPxPerSec2: G, measurementNoise: sigma });
    const noise = gaussian(mulberry32(42));
    const { x0, y0, vx0, vy0 } = shot;
    const rawErrors: number[] = [];
    const filteredErrors: number[] = [];
    for (let i = 0; i <= 90; i++) {
      const t = i * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      const zx = gt.x + noise() * sigma;
      const zy = gt.y + noise() * sigma;
      const est = kf.update(zx, zy, t);
      if (i >= 10) {
        rawErrors.push(Math.hypot(zx - gt.x, zy - gt.y));
        filteredErrors.push(Math.hypot(est.x - gt.x, est.y - gt.y));
      }
    }
    const rawRmse = rmse(rawErrors);
    const filteredRmse = rmse(filteredErrors);
    expect(filteredRmse).toBeLessThan(rawRmse);
    // Should smooth substantially, not just barely win.
    expect(filteredRmse).toBeLessThan(rawRmse * 0.75);
  });

  test('predict-only through a 10-frame occlusion stays within 15px of truth', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    const { x0, y0, vx0, vy0 } = shot;
    // 20 clean frames to converge.
    for (let i = 0; i < 20; i++) {
      const t = i * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      kf.update(gt.x, gt.y, t);
    }
    // 10 occluded frames: predict only.
    for (let i = 20; i < 30; i++) {
      const t = i * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      const est = kf.predict(t);
      expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(15);
    }
    // Reacquire after occlusion: filter accepts the measurement cleanly.
    const t = 30 * DT;
    const gt = projectile(t, x0, y0, vx0, vy0, G);
    const est = kf.update(gt.x, gt.y, t);
    expect(Math.hypot(est.x - gt.x, est.y - gt.y)).toBeLessThan(5);
  });

  test('velocity estimates converge to truth within 15% after 10 frames', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    const { x0, y0, vx0, vy0 } = shot;
    let est = { x: 0, y: 0, vx: 0, vy: 0 };
    let gt = projectile(0, x0, y0, vx0, vy0, G);
    for (let i = 0; i <= 10; i++) {
      const t = i * DT;
      gt = projectile(t, x0, y0, vx0, vy0, G);
      est = kf.update(gt.x, gt.y, t);
    }
    const speed = Math.hypot(gt.vx, gt.vy);
    expect(Math.abs(est.vx - gt.vx)).toBeLessThan(0.15 * speed);
    expect(Math.abs(est.vy - gt.vy)).toBeLessThan(0.15 * speed);
  });

  test('gravity prior bends predictions downward (vy grows during coasting)', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    kf.init(100, 300, 0);
    const before = kf.predict(0.1);
    const after = kf.predict(0.5);
    // Started at rest: after coasting, vy = g * t (down is positive).
    expect(after.vy).toBeCloseTo(G * 0.5, 6);
    expect(after.vy).toBeGreaterThan(before.vy);
    // y falls by 0.5 * g * t².
    expect(after.y).toBeCloseTo(300 + 0.5 * G * 0.25, 6);
  });

  test('dt <= 0 is skipped gracefully (no NaN, state unchanged by predict)', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    kf.init(100, 200, 1.0);
    kf.update(105, 195, 1.0 + DT);
    const before = kf.state!;

    // Duplicate timestamp predict: exact same state back.
    const same = kf.predict(1.0 + DT);
    expect(same).toEqual(before);

    // Out-of-order predict: also a no-op.
    const past = kf.predict(0.5);
    expect(past).toEqual(before);

    // Duplicate-timestamp update must not corrupt the filter.
    const dup = kf.update(106, 194, 1.0 + DT);
    expect(Number.isFinite(dup.x)).toBe(true);
    expect(Number.isFinite(dup.y)).toBe(true);
    expect(Number.isFinite(dup.vx)).toBe(true);
    expect(Number.isFinite(dup.vy)).toBe(true);

    // Filter still tracks properly afterwards.
    const next = kf.update(110, 190, 1.0 + 2 * DT);
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.vy)).toBe(true);
  });

  test('measurementNoiseScale > 1 makes a sample pull the state less', () => {
    const { x0, y0, vx0, vy0 } = shot;

    const run = (scale: number) => {
      const kf = new BallKalman({ gravityPxPerSec2: G });
      for (let i = 0; i < 20; i++) {
        const t = i * DT;
        const gt = projectile(t, x0, y0, vx0, vy0, G);
        kf.update(gt.x, gt.y, t);
      }
      const t = 20 * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      // Outlier measurement 40px off the parabola.
      return { est: kf.update(gt.x + 40, gt.y, t, scale), gtX: gt.x };
    };

    const trusted = run(1);
    const distrusted = run(8);
    const trustedPull = Math.abs(trusted.est.x - trusted.gtX);
    const distrustedPull = Math.abs(distrusted.est.x - distrusted.gtX);
    expect(distrustedPull).toBeLessThan(trustedPull);
  });

  test('init resets a converged filter completely', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G });
    const { x0, y0, vx0, vy0 } = shot;
    for (let i = 0; i < 15; i++) {
      const t = i * DT;
      const gt = projectile(t, x0, y0, vx0, vy0, G);
      kf.update(gt.x, gt.y, t);
    }
    kf.init(400, 100, 10);
    expect(kf.state).toEqual({ x: 400, y: 100, vx: 0, vy: 0 });
    // New track converges as if fresh.
    let est = { x: 0, y: 0, vx: 0, vy: 0 };
    let gt = projectile(0, 400, 100, -150, 200, G);
    for (let i = 1; i <= 10; i++) {
      const t = i * DT;
      gt = projectile(t, 400, 100, -150, 200, G);
      est = kf.update(gt.x, gt.y, 10 + t);
    }
    const speed = Math.hypot(gt.vx, gt.vy);
    expect(Math.abs(est.vx - gt.vx)).toBeLessThan(0.15 * speed);
    expect(Math.abs(est.vy - gt.vy)).toBeLessThan(0.15 * speed);
  });

  test('long noisy run stays numerically stable (300 frames)', () => {
    const kf = new BallKalman({ gravityPxPerSec2: G, measurementNoise: 3 });
    const noise = gaussian(mulberry32(7));
    // Repeated bounces: re-launch the parabola every 60 frames via init.
    let est = { x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 300; i++) {
      const t = i * DT;
      const seg = Math.floor(i / 60);
      const tSeg = t - seg * 2;
      const gt = projectile(tSeg, 100 + seg * 50, 500, 200, -600, G);
      est = kf.update(gt.x + noise() * 3, gt.y + noise() * 3, t);
      expect(Number.isFinite(est.x)).toBe(true);
      expect(Number.isFinite(est.y)).toBe(true);
      expect(Number.isFinite(est.vx)).toBe(true);
      expect(Number.isFinite(est.vy)).toBe(true);
    }
  });
});
