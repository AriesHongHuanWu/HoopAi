/**
 * AnimatedProgressBar — the exported pure clamp (clamp01) that bounds both the
 * fill width and the accessibilityValue percentage.
 */
// Reanimated's worklets runtime can't load under jest without native modules —
// stub the surface AnimatedProgressBar.tsx imports (clamp01 itself is pure).
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: () => null },
  useReducedMotion: () => true,
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
  Easing: { out: (f: unknown) => f, cubic: (t: number) => t },
}));

import { clamp01 } from '../AnimatedProgressBar';

describe('clamp01', () => {
  it('passes through in-range values', () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.999)).toBeCloseTo(0.999, 10);
  });

  it('clamps below 0 to 0', () => {
    expect(clamp01(-0.01)).toBe(0);
    expect(clamp01(-5)).toBe(0);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('clamps above 1 to 1', () => {
    expect(clamp01(1.01)).toBe(1);
    expect(clamp01(120)).toBe(1);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('maps NaN to 0 (an unknown progress must not render a full bar)', () => {
    expect(clamp01(Number.NaN)).toBe(0);
  });

  it('yields whole accessibility percentages under Math.round', () => {
    expect(Math.round(clamp01(0.336) * 100)).toBe(34);
    expect(Math.round(clamp01(2) * 100)).toBe(100);
    expect(Math.round(clamp01(-1) * 100)).toBe(0);
  });
});
