/**
 * Verifies the analysis→view letterbox mapping used by the live HUD overlays.
 * Both the detector input and the preview letterbox ('contain') the same frame,
 * so a mapped point must land on the matching spot in the view for BOTH
 * orientations — this is what broke ("portrait crop in landscape") before.
 */
import { describe, expect, test } from '@jest/globals';

import type { OverlayState } from '../../../camera/useShotEngine';
import { mapAnalysisToView } from '../overlayMapping';

/** Minimal OverlayState — the mapper only reads frameW/H + srcW/H. */
function state(srcW: number, srcH: number): OverlayState {
  return { frameW: 416, frameH: 416, srcW, srcH } as OverlayState;
}

/** Map an analysis-space point through the mapping. */
function apply(m: { scale: number; ox: number; oy: number }, x: number, y: number) {
  return { x: x * m.scale + m.ox, y: y * m.scale + m.oy };
}

describe('mapAnalysisToView', () => {
  test('landscape: full-frame content maps to the view content rect', () => {
    // 16:9 landscape frame, wide landscape view (pillarboxed).
    const m = mapAnalysisToView(state(1920, 1080), { w: 800, h: 360 });
    expect(m.ok).toBe(true);
    expect(m.scale).toBeCloseTo(1.5385, 2);
    expect(m.ox).toBeCloseTo(80, 1);
    expect(m.oy).toBeCloseTo(-140, 1);
    // Analysis square center → view center.
    const c = apply(m, 208, 208);
    expect(c.x).toBeCloseTo(400, 0);
    expect(c.y).toBeCloseTo(180, 0);
    // Frame content top-left (analysis 0,91) → view content top-left (80,0).
    const tl = apply(m, 0, 91);
    expect(tl.x).toBeCloseTo(80, 0);
    expect(tl.y).toBeCloseTo(0, 0);
  });

  test('portrait: full-frame content maps to the view content rect', () => {
    const m = mapAnalysisToView(state(1080, 1920), { w: 360, h: 800 });
    expect(m.ok).toBe(true);
    expect(m.scale).toBeCloseTo(1.5385, 2);
    expect(m.ox).toBeCloseTo(-140, 1);
    expect(m.oy).toBeCloseTo(80, 1);
    const c = apply(m, 208, 208);
    expect(c.x).toBeCloseTo(180, 0);
    expect(c.y).toBeCloseTo(400, 0);
  });

  test('orientation guard: sensor-oriented dims are swapped to match the view', () => {
    // Frame reports landscape dims, but the view is portrait — must behave like
    // the portrait case above (aspect matches what is on screen).
    const sensor = mapAnalysisToView(state(1920, 1080), { w: 360, h: 800 });
    const display = mapAnalysisToView(state(1080, 1920), { w: 360, h: 800 });
    expect(sensor.scale).toBeCloseTo(display.scale, 4);
    expect(sensor.ox).toBeCloseTo(display.ox, 2);
    expect(sensor.oy).toBeCloseTo(display.oy, 2);
  });

  test('degenerate inputs return ok:false (nothing drawn)', () => {
    expect(mapAnalysisToView(state(0, 0), { w: 800, h: 360 }).ok).toBe(false);
    expect(mapAnalysisToView(state(1920, 1080), { w: 0, h: 0 }).ok).toBe(false);
  });
});
