import {
  DRAG,
  GRAVITY,
  escalationTier,
  lifeAlpha,
  mulberry32,
  particleState,
  smoothstep,
  spawnConfetti,
  spawnFlames,
  type Particle,
} from '../particles';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    expect(a()).not.toBeCloseTo(b(), 6);
  });

  it('stays within [0, 1)', () => {
    const rnd = mulberry32(99);
    for (let i = 0; i < 1000; i++) {
      const v = rnd();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('smoothstep', () => {
  it('clamps and hits the expected anchors', () => {
    expect(smoothstep(-5)).toBe(0);
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 6);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(5)).toBe(1);
  });

  it('is monotonically non-decreasing', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const v = smoothstep(i / 20);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe('lifeAlpha', () => {
  it('is 0 outside the [0, life) window', () => {
    expect(lifeAlpha(0, 1, 0.1, 0.4)).toBe(0);
    expect(lifeAlpha(1, 1, 0.1, 0.4)).toBe(0);
    expect(lifeAlpha(1.5, 1, 0.1, 0.4)).toBe(0);
    expect(lifeAlpha(-0.2, 1, 0.1, 0.4)).toBe(0);
  });

  it('rises from ~0 at birth to full during the plateau', () => {
    const early = lifeAlpha(0.02, 1, 0.1, 0.4);
    const mid = lifeAlpha(0.5, 1, 0.1, 0.4);
    expect(early).toBeLessThan(mid);
    expect(mid).toBeCloseTo(1, 3);
  });

  it('fades back toward 0 near end of life', () => {
    const mid = lifeAlpha(0.5, 1, 0.1, 0.4);
    const late = lifeAlpha(0.95, 1, 0.1, 0.4);
    expect(late).toBeLessThan(mid);
    expect(late).toBeGreaterThanOrEqual(0);
  });

  it('treats zero fade fractions as no ramp', () => {
    // No fade-in, no fade-out → full alpha across the whole interior.
    expect(lifeAlpha(0.5, 1, 0, 0)).toBeCloseTo(1, 6);
  });
});

describe('spawnConfetti', () => {
  it('is deterministic: same seed → identical field', () => {
    const a = spawnConfetti(7);
    const b = spawnConfetti(7);
    expect(a).toEqual(b);
  });

  it('respects the requested count and palette range', () => {
    const field = spawnConfetti(3, { count: 40, paletteSize: 4 });
    expect(field).toHaveLength(40);
    for (const p of field) {
      expect(p.colorIndex).toBeGreaterThanOrEqual(0);
      expect(p.colorIndex).toBeLessThan(4);
      expect(Number.isInteger(p.colorIndex)).toBe(true);
    }
  });

  it('launches every piece upward (negative vy) and staggers within the window', () => {
    const field = spawnConfetti(11, { spawnWindow: 0.18 });
    for (const p of field) {
      expect(p.vy).toBeLessThan(0);
      expect(p.delay).toBeGreaterThanOrEqual(0);
      expect(p.delay).toBeLessThanOrEqual(0.18);
    }
  });

  it('centers the fan on cx and spreads within +/- width/2', () => {
    const field = spawnConfetti(5, { cx: 100, width: 200 });
    for (const p of field) {
      expect(p.x0).toBeGreaterThanOrEqual(0);
      expect(p.x0).toBeLessThanOrEqual(200);
    }
  });
});

describe('spawnFlames', () => {
  it('is deterministic and capped small', () => {
    const a = spawnFlames(2, { count: 14 });
    const b = spawnFlames(2, { count: 14 });
    expect(a).toEqual(b);
    expect(a).toHaveLength(14);
  });

  it('rises (negative vy) from the baseline with a narrow mouth', () => {
    const field = spawnFlames(9, { cx: 50, spread: 60, cy: 300 });
    for (const p of field) {
      expect(p.vy).toBeLessThan(0);
      expect(p.y0).toBe(300);
      expect(Math.abs(p.x0 - 50)).toBeLessThanOrEqual(60);
    }
  });

  it('biases color toward the cooler base (index 0 most common)', () => {
    const field = spawnFlames(4, { count: 200, paletteSize: 3 });
    const zeros = field.filter((p) => p.colorIndex === 0).length;
    const tips = field.filter((p) => p.colorIndex === 2).length;
    expect(zeros).toBeGreaterThan(tips);
  });
});

describe('particleState (closed-form motion)', () => {
  const p: Particle = {
    x0: 0,
    y0: 0,
    vx: 100,
    vy: -200,
    size: 6,
    rot: 0,
    spin: 2,
    colorIndex: 0,
    delay: 0,
  };

  it('sits invisibly at the origin before birth (delay not elapsed)', () => {
    const delayed: Particle = { ...p, delay: 0.2 };
    const s = particleState(delayed, 0.1, 1.2);
    expect(s.alpha).toBe(0);
    expect(s.x).toBe(delayed.x0);
    expect(s.y).toBe(delayed.y0);
  });

  it('matches the drag+gravity closed form at a sample age', () => {
    const age = 0.3;
    const s = particleState(p, age, 1.2, { fadeIn: 0.08, fadeOut: 0.45 });
    const decay = (1 - Math.exp(-DRAG * age)) / DRAG;
    const expX = p.x0 + p.vx * decay;
    const expY = p.y0 + p.vy * decay + 0.5 * GRAVITY * age * age;
    expect(s.x).toBeCloseTo(expX, 6);
    expect(s.y).toBeCloseTo(expY, 6);
    expect(s.rot).toBeCloseTo(p.rot + p.spin * age, 6);
  });

  it('eventually falls below the origin under gravity', () => {
    // Late in life the gravity term dominates the initial upward launch.
    const s = particleState(p, 1.0, 1.2);
    expect(s.y).toBeGreaterThan(0);
  });

  it('floats (no fall) when gravityMul is 0', () => {
    const s = particleState(p, 1.0, 1.2, { gravityMul: 0 });
    // With no gravity and an upward launch, y stays above the origin.
    expect(s.y).toBeLessThan(0);
  });

  it('shrinks over age when shrink > 0', () => {
    const young = particleState(p, 0.1, 1.2, { shrink: 1.5 });
    const old = particleState(p, 0.8, 1.2, { shrink: 1.5 });
    expect(old.size).toBeLessThan(young.size);
  });

  it('keeps alpha within [0, 1] across the whole life', () => {
    for (let i = 0; i <= 30; i++) {
      const t = (i / 30) * 1.2;
      const s = particleState(p, t, 1.2);
      expect(s.alpha).toBeGreaterThanOrEqual(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });
});

describe('escalationTier', () => {
  it('maps streak thresholds to additive tiers', () => {
    expect(escalationTier(0)).toBe(0);
    expect(escalationTier(2)).toBe(0);
    expect(escalationTier(3)).toBe(1);
    expect(escalationTier(4)).toBe(1);
    expect(escalationTier(5)).toBe(2);
    expect(escalationTier(6)).toBe(2);
    expect(escalationTier(7)).toBe(3);
    expect(escalationTier(25)).toBe(3);
  });

  it('is monotonic non-decreasing in streak', () => {
    let prev = 0;
    for (let s = 0; s <= 20; s++) {
      const tier = escalationTier(s);
      expect(tier).toBeGreaterThanOrEqual(prev);
      prev = tier;
    }
  });
});
