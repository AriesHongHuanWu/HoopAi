/**
 * Iron-rule invariant pins.
 *
 * If this file goes red, a product-safety constant changed. Do NOT silence
 * the test — either revert the constant or update the pin in the same commit
 * with a rationale line, and re-read docs/QUALITY-GATES.md §1. Every value
 * here is load-bearing for the bread-ball guarantee, the 30fps byte-identity
 * contract, or the "noise can continue a track, never start one" defense.
 */
import { DETECTION, FLIGHT, NOMINAL_FPS, scaleFrameGate, SHOT_FSM } from '../config';
import { ABS_MIN_FIT_SAMPLES, MIN_FIT_SAMPLES } from '../trajectory';
import { CLASS_ORDER } from '../../ml/yoloParser';

describe('iron-rule invariants — FSM baseline', () => {
  // These are the conservative constructor baseline the pinned fuse truth
  // table and the unit suites run against. They must stay false; the LIVE app
  // opts in per-instance via settingsStore -> adoptRim.
  //
  // The offline recheck now passes opts EXPLICITLY rather than inheriting
  // these (recheck.ts RECHECK_FSM_OPTS), so this test no longer describes it.
  // Which guards the replay may run is pinned in recheck.test.ts instead --
  // by behaviour, not by flags, because a flags-only assertion is exactly what
  // let the replay convict shots on an assumed camera placement.
  test('FSM constructor-default flags stay false (recheck + unit baseline)', () => {
    expect(SHOT_FSM.useDepthRatioVeto).toBe(false);
    expect(SHOT_FSM.useReappearance).toBe(false);
    expect(SHOT_FSM.useViewBandRouting).toBe(false);
  });
});

describe('iron-rule invariants — detection score ladder', () => {
  // The documented ladder: hoopRoi (0.1) <= tracking (0.12) < motion (0.13)
  // < dark cold (0.16) < cold (0.2) < nano-v2 cold (0.35). Reordering any
  // rung silently changes WHICH evidence can start vs continue a track.
  test('detection score ladder ordering', () => {
    expect(DETECTION.ballScoreMinHoopRoi).toBeLessThanOrEqual(DETECTION.ballScoreMinTracking);
    expect(DETECTION.ballScoreMinTracking).toBeLessThan(DETECTION.motionCandidate.score);
    expect(DETECTION.motionCandidate.score).toBeLessThan(DETECTION.ballScoreMinDark);
    expect(DETECTION.ballScoreMinDark).toBeLessThan(DETECTION.ballScoreMin);
    expect(DETECTION.ballScoreMin).toBeLessThan(DETECTION.ballScoreMinNanoV2);
    // The cls gate the FSM reads at resolve — the 'ball_in_basket' half of the
    // net/cls corroboration pair. Loosening it widens the fake-make surface.
    expect(DETECTION.ballInBasketScoreMin).toBe(0.35);
  });

  // Motion assist injects SYNTHETIC candidates: its score must clear the
  // tracking-continuation floor (so it can keep a fresh, jump-gate-vetted
  // track alive) but stay below cold acquisition (so a mover can never START
  // a track). Both inequalities together ARE the safety property.
  test('motion assist can continue but never start a track', () => {
    expect(DETECTION.motionCandidate.score).toBeGreaterThan(DETECTION.ballScoreMinTracking);
    expect(DETECTION.motionCandidate.score).toBeLessThan(DETECTION.ballScoreMin);
  });
});

describe('iron-rule invariants — frame-gate time scaling', () => {
  // The low-fps contract: at exactly NOMINAL_FPS every scaled gate reproduces
  // its authored integer, so 30fps behaviour is byte-identical to the
  // pre-scaling code and only slower devices see the fix.
  test('30fps byte-identity of scaleFrameGate', () => {
    expect(NOMINAL_FPS).toBe(30);
    for (const n of [3, 5, 8, 20]) {
      expect(scaleFrameGate(n, 1 / NOMINAL_FPS, 3)).toBe(n);
    }
  });

  test('scaleFrameGate only loosens, floored', () => {
    // Slow device (8fps): fewer samples required, never below the floor.
    const g = scaleFrameGate(5, 1 / 8, 3);
    expect(g).toBeLessThanOrEqual(5);
    expect(g).toBeGreaterThanOrEqual(3);
    // No interval measured yet -> nominal count unchanged.
    expect(scaleFrameGate(5, 0, 3)).toBe(5);
    // Fast device (240fps): clamped AT the nominal count — a flagship must
    // never be asked for MORE samples than the 30fps code ever required.
    expect(scaleFrameGate(5, 1 / 240, 3)).toBe(5);
  });
});

describe('iron-rule invariants — flight corridor', () => {
  test('corridor R² gates ordered', () => {
    expect(FLIGHT.corridorMinR2yStrict).toBeGreaterThan(FLIGHT.corridorMinR2yLoose);
    // Strict gate guards outcome-adjacent landing UI (crossing/landing use);
    // the loose gate only relaxes a score floor for already-vetted samples.
    expect(FLIGHT.corridorMinR2yStrict).toBe(0.9);
  });
});

describe('iron-rule invariants — parser and trajectory', () => {
  // The trained model's channel order. Shuffling this silently relabels every
  // detection (a 'ball' becomes a 'rim'), which no downstream gate can catch.
  test('class order is the trained model order', () => {
    expect([...CLASS_ORDER]).toEqual(['ball', 'rim', 'ball_in_basket', 'person']);
  });

  // 3 samples uniquely determine a quadratic — the hard mathematical floor
  // low-fps callers may scale DOWN to; 5 is the nominal statistical floor.
  test('quadratic fit floors', () => {
    expect(ABS_MIN_FIT_SAMPLES).toBe(3);
    expect(MIN_FIT_SAMPLES).toBe(5);
  });
});
