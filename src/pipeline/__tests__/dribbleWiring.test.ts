/**
 * Focused wiring tests for the dribble VISUAL gate seam
 * (suppressDribbleVisuals in src/pipeline/shotPipeline.ts).
 *
 * Pinned here:
 * - SHOT_LIVE is ALWAYS exempt — an armed real shot is never a dribble, so
 *   live-shot drawing is untouched no matter what the detector or apex say.
 * - Outside SHOT_LIVE, detector-active OR a failed apex test suppresses.
 * - The apex test receives the fit, the rim and the fixed 2-rim-width margin
 *   (the shared contract with src/core/dribbleGate.ts), with null fit/rim
 *   forwarded untouched (the permissive default lives in the gate module).
 *
 * src/core/dribbleGate.ts is mocked (virtual — the module lands in a parallel
 * change) so this file exercises ONLY the pipeline's wiring, not the
 * detector/apex internals: those belong to the gate's own unit tests.
 * Judgment safety (FSM untouched) is structural, not asserted here — the seam
 * runs after fsm.step and its result flows only into drawing outputs.
 */
const mockApexAboveRim = jest.fn();

jest.mock(
  '../../core/dribbleGate',
  () => ({
    __esModule: true,
    apexAboveRim: (
      fit: { ya: number; yb: number; yc: number } | null,
      rim: unknown,
      marginRimWidths: number,
    ) => mockApexAboveRim(fit, rim, marginRimWidths),
    DribbleDetector: class {
      update(): boolean {
        return false;
      }
      get active(): boolean {
        return false;
      }
      reset(): void {}
    },
  }),
  { virtual: true },
);

import {
  DRIBBLE_APEX_MARGIN_RIM_WIDTHS,
  suppressDribbleVisuals,
} from '../shotPipeline';
import type { RimGeometry } from '../../core/types';

/** Plausible gravity-shaped fit (values irrelevant — the apex is mocked). */
const FIT = { ya: 380, yb: -520, yc: 400 };

function makeRim(): RimGeometry {
  const box = { x: 100, y: 200, width: 50, height: 20 };
  const zone = { x: 90, y: 150, width: 70, height: 50 };
  return {
    box,
    cx: 125,
    cy: 210,
    planeY: 200,
    spanLeft: 105,
    spanRight: 145,
    belowY: 240,
    upZone: zone,
    hoopRoi: zone,
    netRoi: zone,
  };
}

describe('suppressDribbleVisuals — dribble visual gate seam', () => {
  beforeEach(() => {
    mockApexAboveRim.mockReset();
    mockApexAboveRim.mockReturnValue(true);
  });

  test('SHOT_LIVE never suppresses, even with detector active + failed apex', () => {
    mockApexAboveRim.mockReturnValue(false);
    expect(suppressDribbleVisuals('SHOT_LIVE', true, FIT, makeRim())).toBe(false);
  });

  test('detector-active suppresses outside SHOT_LIVE even when the apex clears', () => {
    expect(suppressDribbleVisuals('IDLE', true, FIT, makeRim())).toBe(true);
    expect(suppressDribbleVisuals('COOLDOWN', true, FIT, makeRim())).toBe(true);
  });

  test('a low apex suppresses outside SHOT_LIVE even with the detector quiet', () => {
    mockApexAboveRim.mockReturnValue(false);
    expect(suppressDribbleVisuals('IDLE', false, FIT, makeRim())).toBe(true);
  });

  test('quiet detector + clearing apex draws normally', () => {
    expect(suppressDribbleVisuals('IDLE', false, FIT, makeRim())).toBe(false);
  });

  test('apex test receives the fit, the rim and the fixed 2-rim-width margin', () => {
    const rim = makeRim();
    suppressDribbleVisuals('IDLE', false, FIT, rim);
    expect(mockApexAboveRim).toHaveBeenCalledWith(
      FIT,
      rim,
      DRIBBLE_APEX_MARGIN_RIM_WIDTHS,
    );
    // Contract pin shared with the parallel dribbleGate change.
    expect(DRIBBLE_APEX_MARGIN_RIM_WIDTHS).toBe(2);
  });

  test('null fit / null rim are forwarded untouched (permissive contract lives in the gate)', () => {
    suppressDribbleVisuals('IDLE', false, null, null);
    expect(mockApexAboveRim).toHaveBeenCalledWith(
      null,
      null,
      DRIBBLE_APEX_MARGIN_RIM_WIDTHS,
    );
  });
});
