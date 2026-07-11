/**
 * SuccessBurst — the pure spawn config (not the component; Skia can't render
 * under jest): the ≤18 hard cap (iron rule: ≤24 simultaneous particles,
 * 18 leaves headroom), and per-seed determinism of the spawned field.
 */
// Reanimated's worklets runtime and Skia's native canvas can't load under
// jest — stub just the surface SuccessBurst.tsx touches at module load.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useReducedMotion: () => true,
  useSharedValue: (v: unknown) => ({ value: v }),
  useDerivedValue: (fn: () => unknown) => ({ value: undefined as unknown }),
  withTiming: (v: unknown) => v,
  Easing: { linear: (t: number) => t },
}));
jest.mock('@shopify/react-native-skia', () => ({
  __esModule: true,
  Canvas: () => null,
  Picture: () => null,
  Skia: { Color: (c: string) => c },
}));

import { spawnConfetti } from '../../fx/particles';
import { MAX_BURST_PIECES, burstConfig, burstPieceCount } from '../SuccessBurst';

describe('burstPieceCount', () => {
  it('caps at MAX_BURST_PIECES (=18, headroom under the 24-particle iron rule)', () => {
    expect(MAX_BURST_PIECES).toBe(18);
    expect(burstPieceCount(18)).toBe(18);
    expect(burstPieceCount(19)).toBe(18);
    expect(burstPieceCount(100)).toBe(18);
    expect(burstPieceCount(Number.MAX_SAFE_INTEGER)).toBe(18);
  });

  it('passes through counts at or under the cap (floored)', () => {
    expect(burstPieceCount(16)).toBe(16);
    expect(burstPieceCount(1)).toBe(1);
    expect(burstPieceCount(7.9)).toBe(7);
  });

  it('never goes negative or non-finite', () => {
    expect(burstPieceCount(0)).toBe(0);
    expect(burstPieceCount(-5)).toBe(0);
    expect(burstPieceCount(Number.NaN)).toBe(0);
    expect(burstPieceCount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('burstConfig → spawnConfetti', () => {
  const W = 320;
  const H = 480;

  it('spawns at most 18 pieces no matter what was requested', () => {
    const field = spawnConfetti(42, burstConfig(1000, W, H));
    expect(field.length).toBeLessThanOrEqual(MAX_BURST_PIECES);
    expect(field.length).toBe(18);
  });

  it('spawns exactly the default 16 pieces for the default request', () => {
    const field = spawnConfetti(42, burstConfig(16, W, H));
    expect(field.length).toBe(16);
  });

  it('is deterministic per seed: same seed → identical field', () => {
    const a = spawnConfetti(1234, burstConfig(16, W, H));
    const b = spawnConfetti(1234, burstConfig(16, W, H));
    expect(a).toEqual(b);
  });

  it('varies with the seed: different seed → different field', () => {
    const a = spawnConfetti(1, burstConfig(16, W, H));
    const b = spawnConfetti(2, burstConfig(16, W, H));
    expect(a).not.toEqual(b);
  });

  it('keeps every colorIndex inside the burst palette', () => {
    const cfg = burstConfig(18, W, H);
    const field = spawnConfetti(7, cfg);
    for (const p of field) {
      expect(p.colorIndex).toBeGreaterThanOrEqual(0);
      expect(p.colorIndex).toBeLessThan(cfg.paletteSize!);
    }
  });

  it('launches every piece upward from a low-center emitter', () => {
    const field = spawnConfetti(9, burstConfig(18, W, H));
    for (const p of field) {
      expect(p.vy).toBeLessThan(0); // negative vy = upward (screen +y is down)
      expect(p.y0).toBeLessThanOrEqual(H * 0.7);
      expect(p.x0).toBeGreaterThanOrEqual(W / 2 - (W * 0.6) / 2);
      expect(p.x0).toBeLessThanOrEqual(W / 2 + (W * 0.6) / 2);
    }
  });
});
