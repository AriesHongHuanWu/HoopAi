/**
 * arcMotif — the ONE canonical shot-arc quadratic.
 *
 * The whole point of the motif module is that it REPLACES the hand-rolled
 * formulas in BootIntro and Home's HeroArc without moving a pixel, so the
 * contract pinned here is byte-identity: the path strings arcMotif emits must
 * equal the strings the two legacy formulas produced, character for
 * character, across real device widths. If someone "cleans up" the
 * arithmetic (reorders a multiplication, rounds a coordinate, changes the
 * template), these fail before any screen looks subtly different.
 */
// Reanimated's worklets runtime can't load under jest without native modules —
// stub the surface ArcReveal.tsx imports (arcMotif itself is pure).
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: () => null },
  useReducedMotion: () => true,
  useSharedValue: (v: unknown) => ({ value: v }),
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  withTiming: (v: unknown) => v,
  Easing: { out: (f: unknown) => f, cubic: (t: number) => t },
}));
// The component half draws to a Skia canvas; the mock passes children
// through so the Path/Circle props (the wiring) stay inspectable.
jest.mock('@shopify/react-native-skia', () => ({
  Canvas: ({ children }: { children?: unknown }) => children ?? null,
  Circle: () => null,
  Path: () => null,
}));

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

import { ArcReveal, arcMotif } from '../ArcReveal';

const skiaMock = jest.requireMock('@shopify/react-native-skia') as {
  Path: React.ComponentType<unknown>;
  Circle: React.ComponentType<unknown>;
};

/** Realistic layout widths: 320 SE, 361 = 393 − lg·2 content, 375, 393, 430. */
const WIDTHS = [320, 361, 375, 393, 430, 393.5];

/** The formula BootIntro.tsx hand-rolled before the migration — verbatim. */
function legacyBootIntroPath(W: number, ARC_H: number): string {
  const rimX = W - 72;
  const rimY = ARC_H * 0.42;
  const p0 = { x: -24, y: ARC_H + 24 };
  const c = { x: W * 0.36, y: -ARC_H * 0.6 };
  return `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${rimX} ${rimY}`;
}

/** The formula Home's HeroArc hand-rolls today ((tabs)/index.tsx) — verbatim. */
function legacyHeroArcPath(width: number, HERO_HEIGHT: number): string {
  const rimX = width - 44;
  const rimY = HERO_HEIGHT * 0.42;
  return `M -24 ${HERO_HEIGHT + 24} Q ${width * 0.36} ${-HERO_HEIGHT * 0.6} ${rimX} ${rimY}`;
}

describe('arcMotif path parity', () => {
  it('is byte-identical to BootIntro’s legacy formula (rimInset 72, ARC_H 240)', () => {
    for (const w of WIDTHS) {
      expect(arcMotif(w, 240, { rimInset: 72 }).path).toBe(legacyBootIntroPath(w, 240));
    }
  });

  it('is byte-identical to HeroArc’s legacy formula (default rimInset 44, HERO_HEIGHT 176)', () => {
    for (const w of WIDTHS) {
      expect(arcMotif(w, 176).path).toBe(legacyHeroArcPath(w, 176));
    }
  });

  it('scales with height too, not just width', () => {
    expect(arcMotif(375, 300, { rimInset: 72 }).path).toBe(legacyBootIntroPath(375, 300));
    expect(arcMotif(375, 120).path).toBe(legacyHeroArcPath(375, 120));
  });
});

describe('arcMotif geometry', () => {
  it('exposes the control points the path string is built from', () => {
    const m = arcMotif(393, 240, { rimInset: 72 });
    expect(m.p0).toEqual({ x: -24, y: 264 });
    expect(m.c).toEqual({ x: 393 * 0.36, y: -144 });
    expect(m.p1).toEqual({ x: 321, y: 100.8 });
  });

  it('pointAt hits the endpoints exactly and the Bézier midpoint in between', () => {
    const m = arcMotif(361, 176);
    expect(m.pointAt(0)).toEqual(m.p0);
    expect(m.pointAt(1)).toEqual(m.p1);
    // Quadratic midpoint: 0.25·P0 + 0.5·C + 0.25·P1.
    const mid = m.pointAt(0.5);
    expect(mid.x).toBeCloseTo(0.25 * m.p0.x + 0.5 * m.c.x + 0.25 * m.p1.x, 10);
    expect(mid.y).toBeCloseTo(0.25 * m.p0.y + 0.5 * m.c.y + 0.25 * m.p1.y, 10);
  });

  it('keeps the rim point above the launch point (the arc goes UP)', () => {
    const m = arcMotif(393, 240, { rimInset: 72 });
    expect(m.p1.y).toBeLessThan(m.p0.y);
    // And the control sits above the canvas — the flight peaks off-screen.
    expect(m.c.y).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Component wiring — rendered with the reduced-motion mock above, so the
// static branch is what's exercised: full arc from the first frame.

function render(el: React.ReactElement): ReactTestRenderer {
  let r!: ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(el);
  });
  return r;
}

describe('ArcReveal (static branch)', () => {
  it('feeds both strokes the canonical motif path, fully revealed', () => {
    const r = render(React.createElement(ArcReveal, { width: 361, height: 176 }));
    const paths = r.root.findAllByType(skiaMock.Path);
    expect(paths).toHaveLength(2);
    const want = arcMotif(361, 176).path;
    for (const p of paths) {
      expect((p.props as { path: string }).path).toBe(want);
      // Reduced motion = the finished frame: trim head at 1.
      expect((p.props as { end: { value: number } }).end.value).toBe(1);
    }
    // Echo under crisp stroke — HeroArc's double-stroke treatment.
    const widths = paths.map((p) => (p.props as { strokeWidth: number }).strokeWidth);
    expect(widths).toEqual([7, 3]);
    act(() => r.unmount());
  });

  it('parks the dot on the rim, and omits it when dot=false', () => {
    const r = render(React.createElement(ArcReveal, { width: 361, height: 176 }));
    const dots = r.root.findAllByType(skiaMock.Circle);
    expect(dots.length).toBeGreaterThan(0); // halo + dot
    const rim = arcMotif(361, 176).p1;
    for (const d of dots) {
      expect((d.props as { cx: { value: number } }).cx.value).toBe(rim.x);
      expect((d.props as { cy: { value: number } }).cy.value).toBe(rim.y);
    }
    act(() => r.unmount());

    const r2 = render(
      React.createElement(ArcReveal, { width: 361, height: 176, dot: false }),
    );
    expect(r2.root.findAllByType(skiaMock.Circle)).toHaveLength(0);
    act(() => r2.unmount());
  });

  it('renders nothing for a zero-width layout pass', () => {
    const r = render(React.createElement(ArcReveal, { width: 0, height: 176 }));
    expect(r.toJSON()).toBeNull();
    act(() => r.unmount());
  });
});
