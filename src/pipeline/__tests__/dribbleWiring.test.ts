/**
 * Wiring tests for the dribble VISUAL gate seam
 * (suppressDribbleVisuals in src/pipeline/shotPipeline.ts).
 *
 * Pinned here:
 * - SHOT_LIVE is ALWAYS exempt — an armed real shot is never a dribble, so
 *   live-shot drawing is untouched no matter what the detector or apex say.
 * - Outside SHOT_LIVE, detector-active OR a failed apex test suppresses.
 * - The apex test receives the fit, the rim and the fixed 2-rim-width margin
 *   (the shared contract with src/core/dribbleGate.ts), with null fit/rim
 *   forwarded untouched (the permissive default lives in the gate module).
 * - Field repro of the stale-latch bug: a dribble→quick shot whose above-rim
 *   detections drop out clears the latch on the near-plane RISING sample and
 *   fullFlightPath resumes drawing that same frame (recall-only — nothing
 *   arms, nothing resolves).
 * - Iron-rule invariant: the FSM's per-frame inputs are byte-identical with
 *   the dribble detector live vs forced inert — the gate is DRAWING only.
 *
 * src/core/dribbleGate.ts is wrapped, not replaced: the mock delegates to the
 * REAL module (jest.requireActual) so the pipeline-level tests exercise the
 * genuine detector/apex, while apexAboveRim stays interceptable for the pure
 * seam tests and the detector gains an inert kill switch for the invariant.
 */
const mockApexAboveRim = jest.fn();
/** Forces the pipeline's DribbleDetector inert (update()/active report false
 *  while the real state still advances underneath) — the "gate off" arm of
 *  the byte-identity invariant. */
const mockDribbleCtl = { inert: false };

jest.mock('../../core/dribbleGate', () => {
  const actual = jest.requireActual<typeof import('../../core/dribbleGate')>(
    '../../core/dribbleGate',
  );
  class ControllableDribbleDetector extends actual.DribbleDetector {
    update(
      s: import('../../core/dribbleGate').DribbleSample,
      rim: import('../../core/types').RimGeometry | null,
    ): boolean {
      const out = super.update(s, rim);
      return mockDribbleCtl.inert ? false : out;
    }

    get active(): boolean {
      return mockDribbleCtl.inert ? false : super.active;
    }
  }
  return {
    __esModule: true,
    ...actual,
    DribbleDetector: ControllableDribbleDetector,
    apexAboveRim: (
      fit: { ya: number; yb: number; yc: number } | null,
      rim: unknown,
      marginRimWidths: number,
    ) => mockApexAboveRim(fit, rim, marginRimWidths),
  };
});

import {
  DRIBBLE_APEX_MARGIN_RIM_WIDTHS,
  ShotPipeline,
  suppressDribbleVisuals,
  type FramePayload,
  type PipelineFrameState,
} from '../shotPipeline';
import { ShotFsm } from '../../core/shotFsm';
import type { Box, Detection, RimGeometry } from '../../core/types';

const actualGate = jest.requireActual<typeof import('../../core/dribbleGate')>(
  '../../core/dribbleGate',
);

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
    mockDribbleCtl.inert = false;
  });

  test('SHOT_LIVE never suppresses, even with detector active + failed apex', () => {
    mockApexAboveRim.mockReturnValue(false);
    expect(suppressDribbleVisuals('SHOT_LIVE', true, FIT, makeRim())).toBe(false);
  });

  test('SHOT_LIVE stays exempt against the REAL apex implementation with a deep OBSERVED vertex', () => {
    mockApexAboveRim.mockImplementation(actualGate.apexAboveRim);
    const rim = makeRim(); // planeY 200, rim width 50 → margin-2 limit 300
    // Straddled window, vertex at y=320 — the apex test fails outside a live
    // shot (sanity assertion), but an armed shot draws no matter what.
    const deepObservedFit = { ya: 450, yb: 0, yc: 320, tMin: -0.5, tMax: 0.5 };
    expect(suppressDribbleVisuals('IDLE', false, deepObservedFit, rim)).toBe(true);
    expect(suppressDribbleVisuals('SHOT_LIVE', true, deepObservedFit, rim)).toBe(
      false,
    );
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
    // Contract pin shared with the dribbleGate unit tests.
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

// ---------------------------------------------------------------------------
// Pipeline-level repro: dribble → quick shot with above-rim detection dropout
// ---------------------------------------------------------------------------

const FRAME = { width: 640, height: 640 };
const DT = 1 / 30;
/** Manual rim: planeY = 200, width 40 → near-plane clear band cy ∈ (200, 240). */
const RIM_BOX: Box = { x: 300, y: 200, width: 40, height: 20 };

function ballDet(cx: number, cy: number): Detection {
  return {
    cls: 'ball',
    score: 0.8,
    box: { x: cx - 15, y: cy - 15, width: 30, height: 30 },
  };
}

function framePayload(t: number, detections: Detection[]): FramePayload {
  return {
    frame: {
      t,
      frameWidth: FRAME.width,
      frameHeight: FRAME.height,
      detections,
    },
    netMotionScore: 0,
  };
}

interface Scenario {
  payloads: FramePayload[];
  /** Last frame with a dribble ball detection. */
  lastDribbleIdx: number;
  /** First frame of the second rise — the EARLIEST frame the latching second
   *  bounce reversal could possibly be recorded at. */
  riseTwoStartIdx: number;
  /** Shot frame just before the near-plane clearing sample. */
  preClearIdx: number;
  /** Shot frame carrying the near-plane rising sample (the clear). */
  clearIdx: number;
}

/**
 * 30 fps synthetic session: two floor bounces at x=320 (waist-high dribble,
 * every sample ≥ 210 px below the rim plane), a trailing FALL segment so the
 * occlusion coast heads floor-ward (never into the up-zone → the FSM stays
 * IDLE), a >corridorFreshSec detection gap (restarts the FlightArc so the
 * shot fits clean), then a quick shot at x=100 — a true gravity parabola
 * y(τ) = 560 − 1200τ + 450τ² whose detections VANISH at cy = 210, i.e. just
 * BELOW the rim plane. The old latch clear (real sample strictly above the
 * plane) can never fire; the near-plane rule must.
 */
function dribbleThenQuickShot(): Scenario {
  const payloads: FramePayload[] = [];
  const push = (dets: Detection[]): number => {
    payloads.push(framePayload(payloads.length * DT, dets));
    return payloads.length - 1;
  };
  const X_DRIBBLE = 320;
  const fall = [450, 480, 510, 540, 570, 600];
  const rise = [570, 540, 510, 480, 450];
  for (const cy of fall) push([ballDet(X_DRIBBLE, cy)]); // 0..5
  for (const cy of rise) push([ballDet(X_DRIBBLE, cy)]); // 6..10 (reversal #1)
  for (const cy of fall.slice(1)) push([ballDet(X_DRIBBLE, cy)]); // 11..15
  let riseTwoStartIdx = -1;
  for (const cy of rise) {
    const i = push([ballDet(X_DRIBBLE, cy)]); // 16..20 (reversal #2 → latch)
    if (riseTwoStartIdx < 0) riseTwoStartIdx = i;
  }
  let lastDribbleIdx = -1;
  for (const cy of [480, 510, 540]) lastDribbleIdx = push([ballDet(X_DRIBBLE, cy)]);
  // Detection gap: > FLIGHT.corridorFreshSec (0.5 s) of real-sample silence so
  // the FlightArc restarts when the shot appears (16 frames ⇒ 0.567 s gap
  // between the last dribble detection and the first shot detection).
  for (let k = 0; k < 16; k++) push([]);
  // The quick shot: detections stop at cy = 210 (k = 10) — above-rim dropout.
  let clearIdx = -1;
  for (let k = 0; k <= 10; k++) {
    const tau = k * DT;
    const cy = 560 - 1200 * tau + 450 * tau * tau;
    clearIdx = push([ballDet(100, cy)]);
  }
  return {
    payloads,
    lastDribbleIdx,
    riseTwoStartIdx,
    preClearIdx: clearIdx - 1,
    clearIdx,
  };
}

describe('pipeline wiring — dribble→quick-shot stale-latch recall fix', () => {
  beforeEach(() => {
    mockApexAboveRim.mockReset();
    // Pipeline-level tests run against the REAL apex implementation.
    mockApexAboveRim.mockImplementation(actualGate.apexAboveRim);
    mockDribbleCtl.inert = false;
  });

  test('the near-plane rising sample clears the stale latch and fullFlightPath resumes — without arming or resolving anything', () => {
    const onShot = jest.fn();
    const pipeline = new ShotPipeline({ onShot });
    pipeline.setManualRim(RIM_BOX, FRAME);
    // Test-only introspection of the pipeline's private detector so the latch
    // transition itself is observable (the fix under test).
    const gate = (pipeline as unknown as { dribble: { active: boolean } })
      .dribble;

    const { payloads, lastDribbleIdx, riseTwoStartIdx, preClearIdx, clearIdx } =
      dribbleThenQuickShot();
    const states: PipelineFrameState[] = [];
    const activeAfter: boolean[] = [];
    for (const p of payloads) {
      states.push(pipeline.step(p));
      activeAfter.push(gate.active);
    }

    // Rim locked where the scenario assumes: planeY 200, clear band (200, 240).
    expect(states[clearIdx]!.rim?.planeY).toBe(200);
    expect(states[clearIdx]!.rim?.box.width).toBe(40);

    // The two-bounce pattern latched during the dribble…
    expect(activeAfter[lastDribbleIdx]).toBe(true);
    // …and is STILL latched one frame before the clear: the shot's real
    // samples never rise above the plane, so before this fix the whole
    // flight stayed blanked.
    expect(activeAfter[preClearIdx]).toBe(true);
    expect(states[preClearIdx]!.fullFlightPath).toHaveLength(0);

    // The clearing sample is a REAL rising ball BELOW the plane inside one
    // rim width — the exact band the old above-plane clear could never see.
    const clearing = states[clearIdx]!.ball;
    expect(clearing).not.toBeNull();
    expect(clearing!.predicted).toBe(false);
    expect(clearing!.vy).toBeLessThan(0);
    expect(clearing!.cy).toBeGreaterThan(200);
    expect(clearing!.cy).toBeLessThan(240);

    // Latch cleared and the confident shot arc draws again THIS frame.
    expect(activeAfter[clearIdx]).toBe(false);
    expect(states[clearIdx]!.fullFlightPath.length).toBeGreaterThan(0);

    // Timeout guard: the latch survived to preClearIdx, so its last reversal
    // is at/after the second rise — and even that EARLIEST possible reversal
    // frame is under the 1.2 s no-reversal timeout at the clearing frame.
    // The clear above can only be the near-plane rule.
    expect(
      payloads[clearIdx]!.frame.t - payloads[riseTwoStartIdx]!.frame.t,
    ).toBeLessThan(1.2);

    // Honesty: recall-only. The FSM never armed and nothing was resolved.
    expect(states.every((s) => s.phase !== 'SHOT_LIVE')).toBe(true);
    expect(onShot).not.toHaveBeenCalled();
  });

  test('iron-rule invariant: FSM inputs are byte-identical with the dribble detector live vs forced inert', () => {
    const { payloads, preClearIdx } = dribbleThenQuickShot();
    const stepSpy = jest.spyOn(ShotFsm.prototype, 'step');
    try {
      const run = (inert: boolean) => {
        mockDribbleCtl.inert = inert;
        stepSpy.mockClear();
        const pipeline = new ShotPipeline();
        pipeline.setManualRim(RIM_BOX, FRAME);
        const states = payloads.map((p) => pipeline.step(p));
        return {
          states,
          inputs: stepSpy.mock.calls.map((call) => JSON.stringify(call[0])),
        };
      };
      const live = run(false);
      const inert = run(true);

      // Non-vacuous: the two runs DIFFER visually — the live detector was
      // suppressing a frame the inert one drew…
      expect(live.states[preClearIdx]!.fullFlightPath).toHaveLength(0);
      expect(inert.states[preClearIdx]!.fullFlightPath.length).toBeGreaterThan(0);

      // …while the FSM consumed the exact same bytes frame-for-frame:
      // drawing != judging, with or without the gate.
      expect(live.inputs.length).toBeGreaterThan(0);
      expect(live.inputs.length).toBe(inert.inputs.length);
      expect(live.inputs).toEqual(inert.inputs);
    } finally {
      mockDribbleCtl.inert = false;
      stepSpy.mockRestore();
    }
  });
});
