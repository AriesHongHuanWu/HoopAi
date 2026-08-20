import { LENS, LensCheckAccumulator } from '../lensCheck';

const CELLS = LENS.grid * LENS.grid;

/** Flat grid at `base` with specific cells overridden by index. */
function cellGrid(
  base: number,
  overrides: Record<number, number> = {},
): number[] {
  const g = new Array<number>(CELLS).fill(base);
  for (const key of Object.keys(overrides)) {
    g[Number(key)] = overrides[Number(key)];
  }
  return g;
}

/**
 * Normal gym scene: base 0.4 with a ±0.15 checkerboard whose phase flips
 * every snapshot — healthy spatial contrast AND per-cell temporal variance.
 */
function gymGrid(snap: number): number[] {
  const g = new Array<number>(CELLS);
  for (let i = 0; i < CELLS; i++) {
    g[i] = 0.4 + ((i + snap) % 2 === 0 ? 0.15 : -0.15);
  }
  return g;
}

/** Pushes `count` snapshots produced by `make(snap)` at the 2 s cadence. */
function feed(
  acc: LensCheckAccumulator,
  count: number,
  make: (snap: number) => readonly number[],
): void {
  for (let s = 0; s < count; s++) {
    acc.push(make(s), s * LENS.snapshotIntervalSec);
  }
}

describe('LENS thresholds', () => {
  test('constants are internally consistent', () => {
    expect(LENS.minSnapshots).toBeLessThanOrEqual(LENS.windowSnapshots);
    expect(LENS.hazeLightMin).toBeLessThan(LENS.hazeLightMax);
    // Glare cells must be brighter than the haze mid-light ceiling, so a
    // scene can never be read as both a dark smudge and saturated flare
    // from the same global level.
    expect(LENS.glareLumaMin).toBeGreaterThan(LENS.hazeLightMax);
    expect(LENS.glareMinCells).toBeGreaterThan(1);
  });
});

describe('LensCheckAccumulator', () => {
  test('(a) normal gym scene stays ok', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, gymGrid);
    expect(acc.status).toBe('ok');
    expect(acc.snapshotCount).toBe(LENS.windowSnapshots);
  });

  test('(b) static saturated blob over a varying background reads as glare', () => {
    const acc = new LensCheckAccumulator();
    // 4 cells pinned at 0.97 in every snapshot (>= glareMinCells).
    feed(acc, LENS.windowSnapshots, (s) => {
      const g = gymGrid(s);
      g[0] = 0.97;
      g[1] = 0.97;
      g[8] = 0.97;
      g[9] = 0.97;
      return g;
    });
    expect(acc.status).toBe('glare');
  });

  test('(c) a bright region MOVING across the frame is not glare', () => {
    const acc = new LensCheckAccumulator();
    // A panned light fixture: the bright cells land on different indices
    // each snapshot, so every cell's temporal MEAN stays far below the
    // glare floor even though each snapshot contains saturated cells.
    // (Gym background keeps the spatial spread healthy — this test isolates
    // the glare arm, not haze.)
    feed(acc, LENS.windowSnapshots, (s) => {
      const g = gymGrid(s);
      g[s] = 0.97;
      g[s + 16] = 0.97;
      g[s + 32] = 0.97;
      return g;
    });
    expect(acc.status).toBe('ok');
  });

  test('(c2) flickering bright cells fail the variance gate, not just the mean gate', () => {
    const acc = new LensCheckAccumulator();
    // Cells 0..3 alternate 0.98/0.88: temporal mean 0.93 >= glareLumaMin,
    // but population variance (0.05^2 = 2.5e-3) is way above glareVarMax —
    // a strobing scoreboard is not lens flare.
    feed(acc, LENS.windowSnapshots, (s) => {
      const v = s % 2 === 0 ? 0.98 : 0.88;
      const g = gymGrid(s);
      g[0] = v;
      g[1] = v;
      g[2] = v;
      g[3] = v;
      return g;
    });
    expect(acc.status).toBe('ok');
  });

  test('(d) fewer static bright cells than glareMinCells stays ok', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, (s) => {
      const g = gymGrid(s);
      g[0] = 0.97;
      g[1] = 0.97;
      return g;
    });
    expect(acc.status).toBe('ok');
  });

  test('(e) milky low-contrast mid-light image reads as haze', () => {
    const acc = new LensCheckAccumulator();
    // Every cell in [0.45..0.506] each snapshot: spatial spread ~0.056
    // (< hazeSpreadMax) with global light ~0.48 (mid-range).
    feed(acc, LENS.windowSnapshots, (s) => {
      const g = new Array<number>(CELLS);
      for (let i = 0; i < CELLS; i++) {
        g[i] = 0.45 + 0.07 * (((i + s) % 5) / 5);
      }
      return g;
    });
    expect(acc.status).toBe('haze');
  });

  test('(f) a flat DARK scene is not haze (below hazeLightMin)', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, () => cellGrid(0.08));
    expect(acc.status).toBe('ok');
  });

  test('(g) a flat blown-out scene reads as glare, not haze', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, () => cellGrid(0.95));
    // Every cell is a static saturated "blob", so this legitimately trips
    // the glare arm — a fully blown-out frame deserves the lens/exposure
    // warning. The haze arm is correctly excluded (light > hazeLightMax).
    expect(acc.status).toBe('glare');
  });

  test('(h) never flags before minSnapshots, even on a glare pattern', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.minSnapshots - 1, () => cellGrid(0.95));
    expect(acc.status).toBe('ok');
    // The very next snapshot crosses the floor and may flag.
    acc.push(cellGrid(0.95), (LENS.minSnapshots - 1) * 2);
    expect(acc.status).toBe('glare');
  });

  test('(i) malformed grid lengths are silently ignored', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.minSnapshots, () => cellGrid(0.95));
    expect(acc.status).toBe('glare');
    expect(acc.snapshotCount).toBe(LENS.minSnapshots);

    acc.push(cellGrid(0.4).slice(0, CELLS - 1), 100); // one short
    acc.push([0.4], 102); // absurdly short
    acc.push(cellGrid(0.4).concat(0.4), 104); // one long

    expect(acc.status).toBe('glare');
    expect(acc.snapshotCount).toBe(LENS.minSnapshots);
  });

  test('(j) reset returns to the empty ok state and the instance is reusable', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, () => cellGrid(0.95));
    expect(acc.status).toBe('glare');

    acc.reset();
    expect(acc.status).toBe('ok');
    expect(acc.snapshotCount).toBe(0);

    // Refill with a clean scene: stays ok (no stale ring contents leak in).
    feed(acc, LENS.windowSnapshots, gymGrid);
    expect(acc.status).toBe('ok');
    expect(acc.snapshotCount).toBe(LENS.windowSnapshots);
  });

  test('glare recovers to ok once the flare leaves the window', () => {
    const acc = new LensCheckAccumulator();
    feed(acc, LENS.windowSnapshots, (s) => {
      const g = gymGrid(s);
      g[0] = 0.97;
      g[1] = 0.97;
      g[2] = 0.97;
      return g;
    });
    expect(acc.status).toBe('glare');
    // User shades the lens: clean snapshots displace the flared ones.
    for (let s = 0; s < LENS.windowSnapshots; s++) {
      acc.push(gymGrid(s), (LENS.windowSnapshots + s) * 2);
    }
    expect(acc.status).toBe('ok');
  });
});
