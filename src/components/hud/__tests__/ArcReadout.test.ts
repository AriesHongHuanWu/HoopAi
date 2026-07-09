/**
 * ArcReadout pure derivations — the chip renders EXACTLY what readArcSample /
 * mergeArcReadoutState / arcReadoutA11yLabel return, so these tests pin the
 * honesty contract at the component boundary: numbers come straight from the
 * visual-fit geometry (never invented), a sample is only "live" during
 * SHOT_LIVE with a rim plane and a confident arc, the linger shows the LAST
 * measured values without minting new ones, and the a11y copy uses arc-shape
 * words only — no make/miss language anywhere.
 */
// Reanimated's worklets runtime can't load under jest without native modules.
// Stub just the surface ArcReadout imports — every function under test here is
// pure and never touches the animation runtime.
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  default: { View: require('react-native').View },
  FadeInUp: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
  useReducedMotion: () => true,
}));

import type { OverlayState } from '../../../camera/useShotEngine';
import {
  arcReadoutA11yLabel,
  mergeArcReadoutState,
  readArcSample,
  type ArcReadoutSample,
  type ArcReadoutState,
} from '../ArcReadout';

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

/**
 * Flat [x,y,...] samples of y = apexY + k*(x-apexX)^2 — analysis px, +y DOWN,
 * so this is a screen-space shot arc (up then down). Step 20 px, 11 points.
 */
function parabolaFlat(apexX: number, apexY: number, k: number): number[] {
  const pts: number[] = [];
  for (let x = 0; x <= 200; x += 20) pts.push(x, apexY + k * (x - apexX) * (x - apexX));
  return pts;
}

/** Rim whose top edge (rim.y) is the entry plane at y=80. */
const RIM = { x: 150, y: 80, width: 40, height: 16 };

// Entry = blended tangent at the descending crossing of y=80 (segment
// (140,59.2)→(160,83.2), u≈0.87): ≈54.0° — steep. Release = tangent at the
// first point (0,160): atan(2·0.012·100) ≈ 67.38°.
const STEEP_ARC = parabolaFlat(100, 40, 0.012);
// Crossing segment (160,68.8)→(180,91.2) at exactly u=0.5, so the tangent
// equals the chord: atan2(22.4, 20) ≈ 48.24° — ideal.
const IDEAL_ARC = parabolaFlat(100, 40, 0.008);
// Crossing segment (160,74.4)→(180,85.6) at u=0.5: atan2(11.2, 20) ≈ 29.25° — flat.
const FLAT_ARC = parabolaFlat(100, 60, 0.004);

describe('readArcSample', () => {
  it('reads measured degrees + quality during SHOT_LIVE with rim and arc', () => {
    const s = readArcSample(makeOverlay({ phase: 'SHOT_LIVE', rim: RIM, fullArc: STEEP_ARC }));
    expect(s.entry).toBeCloseTo(54.0, 1);
    expect(s.rel).toBeCloseTo(67.38, 1);
    expect(s.q).toBe('steep');
    expect(s.live).toBe(true);
  });

  it('grades the display band: ideal inside 43–52°, flat below', () => {
    const ideal = readArcSample(makeOverlay({ phase: 'SHOT_LIVE', rim: RIM, fullArc: IDEAL_ARC }));
    expect(ideal.entry).toBeCloseTo(48.24, 1);
    expect(ideal.q).toBe('ideal');
    const flat = readArcSample(makeOverlay({ phase: 'SHOT_LIVE', rim: RIM, fullArc: FLAT_ARC }));
    expect(flat.entry).toBeCloseTo(29.25, 1);
    expect(flat.q).toBe('flat');
  });

  it('never goes live without a rim plane, even mid-shot (rel may still read)', () => {
    const s = readArcSample(makeOverlay({ phase: 'SHOT_LIVE', rim: null, fullArc: STEEP_ARC }));
    expect(s.entry).toBeNull();
    expect(s.q).toBeNull();
    expect(s.live).toBe(false);
    expect(s.rel).toBeCloseTo(67.38, 1); // release needs no rim
  });

  it('gates entry on arc confidence: fewer than 5 points reads nothing', () => {
    const short = STEEP_ARC.slice(0, 8); // 4 points
    const s = readArcSample(makeOverlay({ phase: 'SHOT_LIVE', rim: RIM, fullArc: short }));
    expect(s.entry).toBeNull();
    expect(s.live).toBe(false);
  });

  it('is only live during SHOT_LIVE — a measurable arc in COOLDOWN/IDLE stays dead', () => {
    for (const phase of ['COOLDOWN', 'IDLE'] as const) {
      const s = readArcSample(makeOverlay({ phase, rim: RIM, fullArc: STEEP_ARC }));
      expect(s.entry).not.toBeNull();
      expect(s.live).toBe(false);
    }
  });
});

describe('mergeArcReadoutState', () => {
  const shown: ArcReadoutState = { entry: 46.3, rel: 54.2, q: 'ideal', visible: true };
  const liveSample = (entry: number, rel: number | null): ArcReadoutSample => ({
    entry,
    rel,
    q: 'ideal',
    live: true,
  });
  const deadSample: ArcReadoutSample = { entry: null, rel: null, q: null, live: false };

  it('bails to the SAME object when rounded values and visibility are unchanged', () => {
    // 46.3→45.7 and 54.2→53.6 both still round to 46 / 54.
    expect(mergeArcReadoutState(shown, liveSample(45.7, 53.6), true)).toBe(shown);
  });

  it('produces a fresh state when a rounded degree changes', () => {
    const next = mergeArcReadoutState(shown, liveSample(47.6, 54.2), true);
    expect(next).not.toBe(shown);
    expect(next).toEqual({ entry: 47.6, rel: 54.2, q: 'ideal', visible: true });
  });

  it('linger keeps the LAST measured values when the sample goes dead', () => {
    // Still visible → nothing the user sees changed → bail.
    expect(mergeArcReadoutState(shown, deadSample, true)).toBe(shown);
    // Linger expired → same values, visible flips off.
    expect(mergeArcReadoutState(shown, deadSample, false)).toEqual({ ...shown, visible: false });
  });

  it('a dead sample never nulls out or mints values', () => {
    const next = mergeArcReadoutState(shown, deadSample, false);
    expect(next.entry).toBe(shown.entry);
    expect(next.rel).toBe(shown.rel);
    expect(next.q).toBe(shown.q);
  });
});

describe('arcReadoutA11yLabel', () => {
  it('speaks measured degrees + shape phrase + release when present', () => {
    expect(arcReadoutA11yLabel(46.4, 'ideal', 54.2)).toBe(
      'Arc 46 degrees, ideal, release 54 degrees',
    );
  });

  it('uses coaching shape phrases, never outcome words', () => {
    expect(arcReadoutA11yLabel(38.7, 'flat', null)).toBe('Arc 39 degrees, a bit flat');
    expect(arcReadoutA11yLabel(55, 'steep', null)).toBe('Arc 55 degrees, a bit steep');
  });
});
