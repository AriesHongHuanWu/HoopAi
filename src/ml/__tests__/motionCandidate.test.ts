/**
 * Frame-diff motion assist tests — the safety model matters more than the
 * detection: motion must find a lone mover, and must SHUT UP on global motion
 * or excluded regions.
 */
import { findMotionCandidate, type MotionOpts } from '../motionCandidate';
import type { Box } from '../../core/types';

const GRID = 48;
const SIZE = 640;

function opts(over: Partial<MotionOpts> = {}): MotionOpts {
  return {
    grid: GRID,
    size: SIZE,
    minCellDiff: 0.07,
    maxActiveFrac: 0.08,
    exclude: [],
    ...over,
  };
}

function flatGrid(v = 0.5): number[] {
  return new Array(GRID * GRID).fill(v);
}

/** Put a diff blob at grid cell (gx, gy). */
function withBlob(base: number[], gx: number, gy: number, delta = 0.2): number[] {
  const g = base.slice();
  g[gy * GRID + gx] = base[gy * GRID + gx]! + delta;
  g[gy * GRID + gx + 1] = base[gy * GRID + gx + 1]! + delta * 0.6;
  return g;
}

const cellPx = (g: number) => ((g + 0.5) / GRID) * SIZE;

describe('findMotionCandidate', () => {
  test('finds a lone mover and localizes its centroid', () => {
    const prev = flatGrid();
    const curr = withBlob(prev, 20, 12);
    const mc = findMotionCandidate(prev, curr, opts());
    expect(mc).not.toBeNull();
    // Centroid between cells 20 and 21 (weighted toward 20), row 12.
    expect(mc!.cx).toBeGreaterThan(cellPx(20) - 7);
    expect(mc!.cx).toBeLessThan(cellPx(21) + 7);
    expect(mc!.cy).toBeCloseTo(cellPx(12), 0);
    expect(mc!.strength).toBeCloseTo(0.2, 5);
  });

  test('silent below the diff threshold', () => {
    const prev = flatGrid();
    const curr = withBlob(prev, 20, 12, 0.05);
    expect(findMotionCandidate(prev, curr, opts())).toBeNull();
  });

  test('bails out on GLOBAL motion (camera bump / exposure hunt)', () => {
    const prev = flatGrid(0.4);
    const curr = flatGrid(0.6); // every cell +0.2
    expect(findMotionCandidate(prev, curr, opts())).toBeNull();
  });

  test('a mover inside an excluded region (player, net) is ignored', () => {
    const prev = flatGrid();
    const curr = withBlob(prev, 20, 12);
    const exclude: Box[] = [
      { x: cellPx(20) - 40, y: cellPx(12) - 40, width: 100, height: 100 },
    ];
    expect(findMotionCandidate(prev, curr, opts({ exclude }))).toBeNull();
  });

  test('an excluded stronger mover does not mask a legit one elsewhere', () => {
    const prev = flatGrid();
    let curr = withBlob(prev, 10, 10, 0.3); // player twitch (excluded)
    curr = withBlob(curr, 30, 20, 0.15); // the ball
    const exclude: Box[] = [
      { x: cellPx(10) - 40, y: cellPx(10) - 40, width: 100, height: 100 },
    ];
    const mc = findMotionCandidate(prev, curr, opts({ exclude }));
    expect(mc).not.toBeNull();
    expect(mc!.cy).toBeCloseTo(cellPx(20), 0);
  });

  test('grid size mismatch is a hard null (fresh session safety)', () => {
    expect(findMotionCandidate([], flatGrid(), opts())).toBeNull();
  });
});
