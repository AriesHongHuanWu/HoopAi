import {
  ARC_PATH_MAX_POINTS,
  arcPathPoints,
  buildArcSnapshot,
  decodeArcSnapshot,
  evalArcSnapshot,
  type ArcSnapshotFit,
} from '../arcSnapshot';
import type { Box } from '../types';

/** A plausible gravity fit (screen y down ⇒ ya > 0) over t ∈ [0, 2]. */
function makeFit(over: Partial<ArcSnapshotFit> = {}): ArcSnapshotFit {
  return {
    ya: 450,
    yb: -900,
    yc: 600,
    xm: 120,
    xq: 100,
    r2y: 0.97,
    tMin: 0,
    tMax: 2,
    ...over,
  };
}

function makeRim(over: Partial<Box> = {}): Box {
  return { x: 400, y: 180, width: 60, height: 24, ...over };
}

/** Flat [x,y,...] path with `n` points sampled off the makeFit parabola. */
function makePath(n: number): number[] {
  const fit = makeFit();
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = fit.tMin + ((fit.tMax - fit.tMin) * i) / (n - 1);
    out.push(fit.xm * t + fit.xq, (fit.ya * t + fit.yb) * t + fit.yc);
  }
  return out;
}

describe('buildArcSnapshot', () => {
  test('happy path: build → stringify → decode round-trips deep-equal', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(17), makeRim(), 640, 640);
    expect(snap).not.toBeNull();
    expect(snap!.v).toBe(1);
    const revived = decodeArcSnapshot(JSON.stringify(snap));
    expect(revived).toEqual(snap);
  });

  test('rejects an odd-length path', () => {
    const path = makePath(9);
    path.pop(); // 17 numbers — dangling x
    expect(buildArcSnapshot(makeFit(), path, makeRim(), 640, 640)).toBeNull();
  });

  test('rejects a too-short (6-entry) path', () => {
    expect(
      buildArcSnapshot(makeFit(), makePath(3), makeRim(), 640, 640),
    ).toBeNull();
  });

  test('rejects NaN / Infinity in the fit', () => {
    expect(
      buildArcSnapshot(makeFit({ yb: NaN }), makePath(10), makeRim(), 640, 640),
    ).toBeNull();
    expect(
      buildArcSnapshot(
        makeFit({ xq: Infinity }),
        makePath(10),
        makeRim(),
        640,
        640,
      ),
    ).toBeNull();
  });

  test('rejects NaN / Infinity in the path', () => {
    const nanPath = makePath(10);
    nanPath[5] = NaN;
    expect(buildArcSnapshot(makeFit(), nanPath, makeRim(), 640, 640)).toBeNull();
    const infPath = makePath(10);
    infPath[0] = -Infinity;
    expect(buildArcSnapshot(makeFit(), infPath, makeRim(), 640, 640)).toBeNull();
  });

  test('rejects ya <= 0 (no gravity signature)', () => {
    expect(
      buildArcSnapshot(makeFit({ ya: 0 }), makePath(10), makeRim(), 640, 640),
    ).toBeNull();
    expect(
      buildArcSnapshot(makeFit({ ya: -450 }), makePath(10), makeRim(), 640, 640),
    ).toBeNull();
  });

  test('rejects tMax <= tMin (empty observed window)', () => {
    expect(
      buildArcSnapshot(
        makeFit({ tMin: 2, tMax: 2 }),
        makePath(10),
        makeRim(),
        640,
        640,
      ),
    ).toBeNull();
    expect(
      buildArcSnapshot(
        makeFit({ tMin: 2, tMax: 1 }),
        makePath(10),
        makeRim(),
        640,
        640,
      ),
    ).toBeNull();
  });

  test('rejects zero frame dimensions', () => {
    expect(buildArcSnapshot(makeFit(), makePath(10), makeRim(), 0, 640)).toBeNull();
    expect(buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 0)).toBeNull();
  });

  test('rejects a zero-width rim box', () => {
    expect(
      buildArcSnapshot(makeFit(), makePath(10), makeRim({ width: 0 }), 640, 640),
    ).toBeNull();
  });

  test('downsamples a 40-point path to exactly 17 points, keeping first + last', () => {
    const path = makePath(40);
    const snap = buildArcSnapshot(makeFit(), path, makeRim(), 640, 640)!;
    expect(snap.path.length).toBe(ARC_PATH_MAX_POINTS * 2);
    // Endpoints survive (input coords are exact multiples of 0.1 within
    // rounding, so compare against the rounded originals).
    expect(snap.path[0]).toBeCloseTo(path[0]!, 1);
    expect(snap.path[1]).toBeCloseTo(path[1]!, 1);
    expect(snap.path[snap.path.length - 2]).toBeCloseTo(path[path.length - 2]!, 1);
    expect(snap.path[snap.path.length - 1]).toBeCloseTo(path[path.length - 1]!, 1);
  });

  test('a path at or under the cap is kept at full length', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(12), makeRim(), 640, 640)!;
    expect(snap.path.length).toBe(24);
  });

  test('rounds every path coordinate to one decimal', () => {
    const path = [100.123, 599.987, 150.049, 400.55, 200.5, 300.44, 250.06, 250.0];
    const snap = buildArcSnapshot(makeFit(), path, makeRim(), 640, 640)!;
    expect(snap.path).toEqual([100.1, 600, 150, 400.6, 200.5, 300.4, 250.1, 250]);
  });

  test('deep-copies fit and rimBox: mutating the inputs after build changes nothing', () => {
    const fit = makeFit();
    const rim = makeRim();
    const snap = buildArcSnapshot(fit, makePath(10), rim, 640, 640)!;
    // RimLock mutates its geometry box in place; ArcFit objects are reused.
    fit.ya = 9999;
    fit.tMax = 55;
    rim.x = -1;
    rim.width = 1;
    expect(snap.fit.ya).toBe(450);
    expect(snap.fit.tMax).toBe(2);
    expect(snap.rimBox.x).toBe(400);
    expect(snap.rimBox.width).toBe(60);
  });
});

describe('decodeArcSnapshot', () => {
  test('never throws and returns null on garbage strings', () => {
    for (const raw of ['{', '[]', 'null', '', '42', '"arc"']) {
      expect(() => decodeArcSnapshot(raw)).not.toThrow();
      expect(decodeArcSnapshot(raw)).toBeNull();
    }
  });

  test('rejects a wrong schema version', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    expect(decodeArcSnapshot({ ...snap, v: 2 })).toBeNull();
  });

  test('rejects an odd (35-entry) path', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(17), makeRim(), 640, 640)!;
    const corrupt = { ...snap, path: [...snap.path, 12.5] }; // 35 numbers
    expect(decodeArcSnapshot(JSON.stringify(corrupt))).toBeNull();
  });

  test('rejects a path longer than the cap', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(17), makeRim(), 640, 640)!;
    const corrupt = { ...snap, path: [...snap.path, 12.5, 13.5] }; // 36 numbers
    expect(decodeArcSnapshot(corrupt)).toBeNull();
  });

  test('rejects a path containing a non-number', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    const corrupt = { ...snap, path: [...snap.path.slice(0, -1), 'x'] };
    expect(decodeArcSnapshot(JSON.stringify(corrupt))).toBeNull();
  });

  test('rejects a rimBox missing height', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    const { height: _height, ...rimNoHeight } = snap.rimBox;
    expect(decodeArcSnapshot({ ...snap, rimBox: rimNoHeight })).toBeNull();
  });

  test('decoding an object equals decoding its JSON string', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(15), makeRim(), 640, 640)!;
    const parsed = JSON.parse(JSON.stringify(snap)) as unknown;
    expect(decodeArcSnapshot(parsed)).toEqual(decodeArcSnapshot(JSON.stringify(snap)));
  });

  test('returns fresh copies — mutating the decode source leaves the result intact', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    const source = JSON.parse(JSON.stringify(snap)) as {
      rimBox: Box;
      path: number[];
    };
    const decoded = decodeArcSnapshot(source)!;
    source.rimBox.x = -777;
    source.path[0] = -777;
    expect(decoded.rimBox.x).toBe(snap.rimBox.x);
    expect(decoded.path[0]).toBe(snap.path[0]);
  });
});

describe('evalArcSnapshot', () => {
  test('matches hand-computed parabola points at tMin, midpoint, tMax', () => {
    // y(t) = 450t² − 900t + 600, x(t) = 120t + 100 over t ∈ [0, 2].
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    const p0 = evalArcSnapshot(snap, 0);
    expect(p0.x).toBeCloseTo(100, 6);
    expect(p0.y).toBeCloseTo(600, 6);
    const pMid = evalArcSnapshot(snap, 1); // apex: 450 − 900 + 600 = 150
    expect(pMid.x).toBeCloseTo(220, 6);
    expect(pMid.y).toBeCloseTo(150, 6);
    const p2 = evalArcSnapshot(snap, 2); // 1800 − 1800 + 600 = 600
    expect(p2.x).toBeCloseTo(340, 6);
    expect(p2.y).toBeCloseTo(600, 6);
  });

  test('does not clamp: extrapolation past tMax is the caller\'s choice', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(10), makeRim(), 640, 640)!;
    const p = evalArcSnapshot(snap, 3); // 4050 − 2700 + 600 = 1950
    expect(p.x).toBeCloseTo(460, 6);
    expect(p.y).toBeCloseTo(1950, 6);
  });
});

describe('arcPathPoints', () => {
  test('unpacks flat pairs, length === path.length / 2', () => {
    const snap = buildArcSnapshot(makeFit(), makePath(13), makeRim(), 640, 640)!;
    const pts = arcPathPoints(snap);
    expect(pts.length).toBe(snap.path.length / 2);
    expect(pts[0]).toEqual({ x: snap.path[0], y: snap.path[1] });
    expect(pts[pts.length - 1]).toEqual({
      x: snap.path[snap.path.length - 2],
      y: snap.path[snap.path.length - 1],
    });
  });
});
