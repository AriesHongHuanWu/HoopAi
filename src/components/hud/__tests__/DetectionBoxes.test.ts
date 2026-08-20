/**
 * Two-tier ball rendering + breadcrumb path builders — the debug overlay must
 * depict the REAL acquisition bar (solid = tracker can start, faint = model
 * sees it but the tracker will NOT start) and draw raw-track breadcrumbs as
 * dots. These are pure worklets; we pin the band edges (inclusive floor,
 * exclusive ceiling), the acqFloor fallback that preserves pre-two-tier
 * behavior, and the analysis→view mapping of every drawn primitive.
 */
// Reanimated's worklets runtime can't load under jest without native modules.
// Stub just the surface DetectionBoxes imports — every function under test
// here is pure and never touches the animation runtime.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useDerivedValue: (fn: () => unknown) => ({ value: fn() }),
  useSharedValue: (v: unknown) => ({ value: v }),
}));

// Skia's native canvas can't load under jest. Replace the path factory with a
// recorder so tests can assert exactly which rrects/circles were added.
type FakePath = {
  rrects: Array<{ x: number; y: number; w: number; h: number; rx: number; ry: number }>;
  circles: Array<{ x: number; y: number; r: number }>;
  addRRect: (r: { x: number; y: number; w: number; h: number; rx: number; ry: number }) => void;
  addCircle: (x: number, y: number, r: number) => void;
};
jest.mock('@shopify/react-native-skia', () => ({
  __esModule: true,
  Canvas: () => null,
  Path: () => null,
  Skia: {
    Path: {
      Make: (): FakePath => {
        const p: FakePath = {
          rrects: [],
          circles: [],
          addRRect: (r) => p.rrects.push(r),
          addCircle: (x, y, r) => p.circles.push({ x, y, r }),
        };
        return p;
      },
    },
  },
  rect: (x: number, y: number, w: number, h: number) => ({ x, y, w, h }),
  rrect: (r: { x: number; y: number; w: number; h: number }, rx: number, ry: number) => ({
    ...r,
    rx,
    ry,
  }),
}));

import type { OverlayDet, OverlayState } from '../../../camera/useShotEngine';
import { DETECTION } from '../../../core/config';
import type { Mapping } from '../overlayMapping';
import { activeAcqFloor, classPath, crumbsPath } from '../DetectionBoxes';

/** Minimal but COMPLETE OverlayState (mirrors EMPTY_OVERLAY in useShotEngine). */
function makeOverlay(over: Partial<OverlayState> = {}): OverlayState {
  return {
    ball: null,
    rim: null,
    traj: [],
    phase: 'IDLE',
    frameW: 416,
    frameH: 416,
    srcW: 0,
    srcH: 0,
    dets: [],
    rimCountdown: null,
    pred: null,
    predTraj: [],
    fullArc: [],
    light: 0,
    ...over,
  };
}

/** Overlay carrying the integrator-provided acquisition fields (contract). */
function makeAcqOverlay(
  over: Partial<OverlayState> & { acqFloor?: number; crumbs?: number[] } = {},
): OverlayState {
  return { ...makeOverlay(over), ...over } as OverlayState;
}

function ballDet(score: number, over: Partial<OverlayDet> = {}): OverlayDet {
  return { cls: 'ball', x: 100, y: 100, w: 20, h: 20, score, ...over };
}

const IDENT: Mapping = { ok: true, scale: 1, ox: 0, oy: 0 };
const SHIFTED: Mapping = { ok: true, scale: 2, ox: 10, oy: 20 };
const BAD: Mapping = { ok: false, scale: 0, ox: 0, oy: 0 };

/** Scores of the boxes a classPath call drew (via each rrect's x back-map). */
function drawnScores(o: OverlayState, min: number, max?: number): number[] {
  const p = classPath(o, IDENT, 'ball', min, max) as unknown as {
    rrects: Array<{ x: number }>;
  };
  const dets = o.dets;
  return p.rrects.map((r) => {
    const hit = dets.find((d) => d.x === r.x);
    if (hit == null) throw new Error(`no det at x=${r.x}`);
    return hit.score;
  });
}

describe('activeAcqFloor', () => {
  it('falls back to the static ball gate when the engine has not published one', () => {
    expect(activeAcqFloor(makeOverlay())).toBe(DETECTION.ballScoreMin);
  });

  it('uses the published per-model floor when present', () => {
    expect(activeAcqFloor(makeAcqOverlay({ acqFloor: 0.35 }))).toBe(0.35);
    expect(activeAcqFloor(makeAcqOverlay({ acqFloor: 0.16 }))).toBe(0.16);
  });

  it('rejects non-positive / non-numeric floors (defensive)', () => {
    expect(activeAcqFloor(makeAcqOverlay({ acqFloor: 0 }))).toBe(DETECTION.ballScoreMin);
    expect(
      activeAcqFloor(makeAcqOverlay({ acqFloor: 'x' as unknown as number })),
    ).toBe(DETECTION.ballScoreMin);
  });
});

describe('classPath two-tier band', () => {
  const scores = [0.1, 0.18, 0.3, 0.4];
  const dets = scores.map((s, i) => ballDet(s, { x: 100 + i * 50 }));

  it('splits solid/faint at a raised cold floor (nanoV2 0.35)', () => {
    const o = makeOverlay({ dets });
    // Solid tier: at/above the ACTIVE floor only.
    expect(drawnScores(o, 0.35)).toEqual([0.4]);
    // Faint tier: parser floor 0.15 .. active floor — "seen, not trackable".
    expect(drawnScores(o, 0.15, 0.35)).toEqual([0.18, 0.3]);
    // Below the parser floor: drawn nowhere.
    expect([...drawnScores(o, 0.35), ...drawnScores(o, 0.15, 0.35)]).not.toContain(0.1);
  });

  it('keeps prior solid behavior at the default 0.2 floor', () => {
    const o = makeOverlay({ dets });
    const floor = activeAcqFloor(o); // 0.2 fallback
    expect(drawnScores(o, floor)).toEqual([0.3, 0.4]);
    expect(drawnScores(o, 0.15, floor)).toEqual([0.18]);
  });

  it('draws a raised dark-mode band honestly (floor 0.16 shows 0.18 solid)', () => {
    const o = makeOverlay({ dets });
    expect(drawnScores(o, 0.16)).toEqual([0.18, 0.3, 0.4]);
    expect(drawnScores(o, 0.15, 0.16)).toEqual([]);
  });

  it('score exactly at the floor is SOLID, never faint (exclusive ceiling)', () => {
    const o = makeOverlay({ dets: [ballDet(0.35)] });
    expect(drawnScores(o, 0.35)).toEqual([0.35]);
    expect(drawnScores(o, 0.15, 0.35)).toEqual([]);
  });

  it('a detection is never drawn in both tiers', () => {
    const o = makeOverlay({ dets });
    const solid = drawnScores(o, 0.35);
    const faint = drawnScores(o, 0.15, 0.35);
    for (const s of solid) expect(faint).not.toContain(s);
  });

  it('filters class, zero-size boxes, and bad mappings', () => {
    const o = makeOverlay({
      dets: [
        ballDet(0.9),
        { cls: 'rim', x: 5, y: 5, w: 30, h: 30, score: 0.9 },
        ballDet(0.9, { x: 200, w: 0 }),
      ],
    });
    const p = classPath(o, IDENT, 'ball', 0.2) as unknown as FakeRec;
    expect(p.rrects).toHaveLength(1);
    const bad = classPath(o, BAD, 'ball', 0.2) as unknown as FakeRec;
    expect(bad.rrects).toHaveLength(0);
  });

  it('guards a missing dets array (defensive worklet)', () => {
    const o = { ...makeOverlay(), dets: undefined } as unknown as OverlayState;
    const p = classPath(o, IDENT, 'ball', 0.2) as unknown as FakeRec;
    expect(p.rrects).toHaveLength(0);
  });

  it('maps analysis px to view px through the Mapping', () => {
    const o = makeOverlay({ dets: [ballDet(0.9, { x: 100, y: 50, w: 20, h: 10 })] });
    const p = classPath(o, SHIFTED, 'ball', 0.2) as unknown as FakeRec;
    expect(p.rrects).toEqual([{ x: 210, y: 120, w: 40, h: 20, rx: 8, ry: 8 }]);
  });
});

type FakeRec = {
  rrects: Array<{ x: number; y: number; w: number; h: number; rx: number; ry: number }>;
  circles: Array<{ x: number; y: number; r: number }>;
};

describe('crumbsPath', () => {
  it('draws one 3px dot per x,y pair, mapped to view space', () => {
    const o = makeAcqOverlay({ crumbs: [100, 200, 150, 250] });
    const p = crumbsPath(o, SHIFTED) as unknown as FakeRec;
    expect(p.circles).toEqual([
      { x: 210, y: 420, r: 3 },
      { x: 310, y: 520, r: 3 },
    ]);
  });

  it('is empty without the crumbs field (pre-integration overlay)', () => {
    const p = crumbsPath(makeOverlay(), IDENT) as unknown as FakeRec;
    expect(p.circles).toHaveLength(0);
  });

  it('ignores a trailing unpaired coordinate', () => {
    const o = makeAcqOverlay({ crumbs: [10, 20, 30] });
    const p = crumbsPath(o, IDENT) as unknown as FakeRec;
    expect(p.circles).toEqual([{ x: 10, y: 20, r: 3 }]);
  });

  it('is empty on a bad mapping', () => {
    const o = makeAcqOverlay({ crumbs: [10, 20] });
    const p = crumbsPath(o, BAD) as unknown as FakeRec;
    expect(p.circles).toHaveLength(0);
  });

  it('guards a non-array crumbs value (defensive worklet)', () => {
    const o = makeAcqOverlay({ crumbs: 'junk' as unknown as number[] });
    const p = crumbsPath(o, IDENT) as unknown as FakeRec;
    expect(p.circles).toHaveLength(0);
  });
});
