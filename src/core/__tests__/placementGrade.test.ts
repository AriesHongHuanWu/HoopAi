import { DETECTION } from '../config';
import {
  GRADE_POLL_MS,
  LOW_FPS_MIN,
  NO_RIM_TIMEOUT_MS,
  PLACEMENT_REASON,
  RIM_FRACTION_IDEAL_MAX,
  RIM_FRACTION_IDEAL_MIN,
  RIM_FRACTION_MAX,
  RIM_FRACTION_MIN,
  bestRimWidth,
  gradePlacement,
  type PlacementInputs,
} from '../placementGrade';

/** Analysis-square side used throughout (the 640 detector input). */
const SIDE = 640;

/** Healthy baseline: rim mid-band, just seen, smooth fps. */
function inputs(over: Partial<PlacementInputs> = {}): PlacementInputs {
  return {
    rimWidthPx: 0.1 * SIDE,
    frameSide: SIDE,
    msSinceRimSeen: 0,
    fps: 30,
    ...over,
  };
}

describe('placement thresholds', () => {
  test('bands are ordered and the poll matches the 5 Hz countdown cadence', () => {
    // Sanity-pin the shape of the config this module's UX is tuned around.
    expect(RIM_FRACTION_MIN).toBeLessThan(RIM_FRACTION_IDEAL_MIN);
    expect(RIM_FRACTION_IDEAL_MIN).toBeLessThan(RIM_FRACTION_IDEAL_MAX);
    expect(RIM_FRACTION_IDEAL_MAX).toBeLessThan(RIM_FRACTION_MAX);
    expect(NO_RIM_TIMEOUT_MS).toBe(2000);
    expect(GRADE_POLL_MS).toBe(200); // 5 Hz
    expect(LOW_FPS_MIN).toBe(10);
  });
});

describe('gradePlacement', () => {
  test('good inside the ideal band', () => {
    expect(gradePlacement(inputs())).toEqual({
      grade: 'good',
      reason: PLACEMENT_REASON.good,
    });
  });

  test('ideal-band boundaries are inclusive (good at both edges)', () => {
    expect(
      gradePlacement(inputs({ rimWidthPx: RIM_FRACTION_IDEAL_MIN * SIDE })).grade,
    ).toBe('good');
    expect(
      gradePlacement(inputs({ rimWidthPx: RIM_FRACTION_IDEAL_MAX * SIDE })).grade,
    ).toBe('good');
  });

  test('slightly small → ok with a step-closer nudge', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.05 * SIDE }))).toEqual({
      grade: 'ok',
      reason: PLACEMENT_REASON.slightlySmall,
    });
    // Exactly at the hard floor is still the soft nudge, not the hard failure.
    expect(
      gradePlacement(inputs({ rimWidthPx: RIM_FRACTION_MIN * SIDE })).reason,
    ).toBe(PLACEMENT_REASON.slightlySmall);
  });

  test('slightly large → ok with a step-back nudge', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.2 * SIDE }))).toEqual({
      grade: 'ok',
      reason: PLACEMENT_REASON.slightlyLarge,
    });
    expect(
      gradePlacement(inputs({ rimWidthPx: RIM_FRACTION_MAX * SIDE })).reason,
    ).toBe(PLACEMENT_REASON.slightlyLarge);
  });

  test('far below the floor → poor, move closer', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.02 * SIDE }))).toEqual({
      grade: 'poor',
      reason: PLACEMENT_REASON.tooSmall,
    });
  });

  test('above the ceiling → poor, step back', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.3 * SIDE }))).toEqual({
      grade: 'poor',
      reason: PLACEMENT_REASON.tooLarge,
    });
  });

  test('no rim yet, inside the grace window → calm searching', () => {
    expect(
      gradePlacement(inputs({ rimWidthPx: null, msSinceRimSeen: 500 })),
    ).toEqual({ grade: 'ok', reason: PLACEMENT_REASON.searching });
  });

  test('no frames yet (frameSide 0) → searching, never a division blowup', () => {
    expect(gradePlacement(inputs({ frameSide: 0 }))).toEqual({
      grade: 'ok',
      reason: PLACEMENT_REASON.searching,
    });
  });

  test('rim unseen past the timeout → poor, even with a stale good width', () => {
    expect(
      gradePlacement(inputs({ msSinceRimSeen: NO_RIM_TIMEOUT_MS + 500 })),
    ).toEqual({ grade: 'poor', reason: PLACEMENT_REASON.noRim });
  });

  test('low fps with ideal framing → ok, phone is struggling', () => {
    expect(gradePlacement(inputs({ fps: 6 }))).toEqual({
      grade: 'ok',
      reason: PLACEMENT_REASON.lowFps,
    });
  });

  test('fps 0 means unknown, not struggling (demo mode / model warm-up)', () => {
    expect(gradePlacement(inputs({ fps: 0 })).grade).toBe('good');
  });

  test('hard size failures outrank the low-fps warning', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.02 * SIDE, fps: 6 })).reason).toBe(
      PLACEMENT_REASON.tooSmall,
    );
  });

  test('low fps outranks the soft size nudges', () => {
    expect(gradePlacement(inputs({ rimWidthPx: 0.05 * SIDE, fps: 6 })).reason).toBe(
      PLACEMENT_REASON.lowFps,
    );
  });
});

describe('bestRimWidth', () => {
  test('picks the highest-score rim detection', () => {
    expect(
      bestRimWidth([
        { cls: 'rim', w: 40, score: 0.5 },
        { cls: 'rim', w: 64, score: 0.9 },
        { cls: 'rim', w: 30, score: 0.7 },
      ]),
    ).toBe(64);
  });

  test('ignores other classes, sub-gate scores and degenerate widths', () => {
    expect(
      bestRimWidth([
        { cls: 'ball', w: 80, score: 0.99 },
        { cls: 'rim', w: 50, score: 0.1 },
        { cls: 'rim', w: 0, score: 0.9 },
      ]),
    ).toBeNull();
    expect(bestRimWidth([])).toBeNull();
  });

  test('default gate is the pipeline rim confidence floor', () => {
    const just = DETECTION.rimScoreMin;
    expect(bestRimWidth([{ cls: 'rim', w: 44, score: just - 0.01 }])).toBeNull();
    expect(bestRimWidth([{ cls: 'rim', w: 44, score: just }])).toBe(44);
  });
});
