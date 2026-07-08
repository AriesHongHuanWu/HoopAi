import { buildHeatmap, cellLabel, type HeatBand, type HeatZone } from '../heatmap';
import type { ResolvedShot } from '../types';

// Minimal shot factory — only the fields the heat map reads.
function shot(opts: {
  outcome: 'make' | 'miss' | 'unsure';
  originX?: number | null;
  dist?: number; // distanceRimWidths
  value?: 2 | 3;
}): ResolvedShot {
  return {
    id: Math.floor(Math.random() * 1e9),
    tStart: 0,
    tResolved: 1,
    outcome: opts.outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: opts.originX ?? null,
    originY: null,
    trajectory: [],
    ...(opts.value != null ? { shotValue: opts.value } : {}),
    ...(opts.dist != null ? { distanceRimWidths: opts.dist } : {}),
  } as ResolvedShot;
}

function cell(hm: ReturnType<typeof buildHeatmap>, zone: HeatZone, band: HeatBand) {
  return hm.cells.find((c) => c.zone === zone && c.band === band)!;
}

describe('buildHeatmap', () => {
  test('always returns a full 3x3 grid', () => {
    const hm = buildHeatmap([]);
    expect(hm.cells).toHaveLength(9);
    expect(hm.totalAttempts).toBe(0);
    expect(hm.best).toBeNull();
  });

  test('buckets by zone (originX thirds) and band (distance)', () => {
    const hm = buildHeatmap([
      shot({ outcome: 'make', originX: 0.1, dist: 3 }), // left / near
      shot({ outcome: 'miss', originX: 0.5, dist: 6 }), // center / mid
      shot({ outcome: 'make', originX: 0.9, dist: 10 }), // right / far
    ]);
    expect(cell(hm, 'left', 'near').makes).toBe(1);
    expect(cell(hm, 'center', 'mid').attempts).toBe(1);
    expect(cell(hm, 'center', 'mid').makes).toBe(0);
    expect(cell(hm, 'right', 'far').makes).toBe(1);
    expect(hm.totalAttempts).toBe(3);
    expect(hm.totalMakes).toBe(2);
  });

  test('unsure shots are excluded', () => {
    const hm = buildHeatmap([
      shot({ outcome: 'unsure', originX: 0.5, dist: 6 }),
      shot({ outcome: 'make', originX: 0.5, dist: 6 }),
    ]);
    expect(cell(hm, 'center', 'mid').attempts).toBe(1);
    expect(hm.totalAttempts).toBe(1);
  });

  test('shots without a placeable origin/distance are counted as unplaced', () => {
    const hm = buildHeatmap([
      shot({ outcome: 'make', originX: null, dist: 6 }), // no origin
      shot({ outcome: 'make', originX: 0.5 }), // no distance, no shotValue
    ]);
    expect(hm.unplaced).toBe(2);
    expect(hm.totalAttempts).toBe(0);
  });

  test('falls back to shotValue for the band when distance is missing', () => {
    const hm = buildHeatmap([
      shot({ outcome: 'make', originX: 0.9, value: 3 }), // right / far via 3pt value
      shot({ outcome: 'make', originX: 0.1, value: 2 }), // left / mid via 2pt value
    ]);
    expect(cell(hm, 'right', 'far').makes).toBe(1);
    expect(cell(hm, 'left', 'mid').makes).toBe(1);
    expect(hm.unplaced).toBe(0);
  });

  test('best/worst respect the minimum-attempts floor', () => {
    const shots: ResolvedShot[] = [];
    // center/mid: 4 makes of 4 (100%) — enough attempts.
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'make', originX: 0.5, dist: 6 }));
    // left/near: 4 misses of 4 (0%) — enough attempts.
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'miss', originX: 0.1, dist: 3 }));
    // right/far: a lucky 1/1 (100%) — BELOW the floor, must not win 'best'.
    shots.push(shot({ outcome: 'make', originX: 0.9, dist: 10 }));
    const hm = buildHeatmap(shots);
    expect(hm.best).toEqual(expect.objectContaining({ zone: 'center', band: 'mid', fgPct: 1 }));
    expect(hm.worst).toEqual(expect.objectContaining({ zone: 'left', band: 'near', fgPct: 0 }));
  });
});

describe('cellLabel', () => {
  test('names corners, top of the key, and the paint', () => {
    expect(cellLabel({ zone: 'left', band: 'far', makes: 0, attempts: 0, fgPct: 0 })).toBe('left corner three');
    expect(cellLabel({ zone: 'center', band: 'far', makes: 0, attempts: 0, fgPct: 0 })).toBe('top-of-key three');
    expect(cellLabel({ zone: 'center', band: 'near', makes: 0, attempts: 0, fgPct: 0 })).toBe('the paint');
  });
});
