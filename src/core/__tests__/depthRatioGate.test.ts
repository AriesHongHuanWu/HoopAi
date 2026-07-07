/**
 * Depth-ratio parallax gate tests — every case is a scenario from the
 * adversarial verification pass, computed from real pinhole geometry:
 * px_size = f · real_size / depth. The gate must fire where the math proved
 * discriminative, and STAY SILENT everywhere else (the honest envelope).
 */
import { depthRatioGate, type DepthGateInput } from '../depthRatioGate';
import { selectDepthSamples } from '../sampleQuality';
import { classifyViewBand } from '../viewBand';
import type { BallSample, Box } from '../types';

const RIM_M = 0.45;
const BALL7_M = 0.243;

/** Apparent pixel size of an object of `sizeM` at depth `zM` with focal f. */
const px = (f: number, sizeM: number, zM: number) => (f * sizeM) / zM;

function gateInput(over: Partial<DepthGateInput>): DepthGateInput {
  return {
    ballDiaPxAvg: 30,
    nRealSamples: 5,
    rimWidthPx: 90,
    rimLockContaminated: false,
    ballSize: 7,
    viewBand: 'side_wing',
    crossingReal: true,
    rimBounce: false,
    clsStrongContext: false,
    ...over,
  };
}

/** Build the input for a ball at `zBall` crossing a rim at `zRim`. */
function scenario(f: number, zRim: number, zBall: number, over: Partial<DepthGateInput> = {}): DepthGateInput {
  return gateInput({
    rimWidthPx: px(f, RIM_M, zRim),
    ballDiaPxAvg: px(f, BALL7_M, zBall),
    ...over,
  });
}

describe('depthRatioGate — verified envelope', () => {
  test('clean make (ball at rim depth) is silent at every range/framing', () => {
    for (const f of [480, 822, 1067]) {
      for (const z of [3, 4, 6, 8]) {
        const r = depthRatioGate(scenario(f, z, z));
        expect(r.decision).toBe('silent');
        if (r.enabled) expect(r.ratio).toBeCloseTo(1.0, 1);
      }
    }
  });

  test('airball 1.0m in front @ 4m rim fires veto_front under both framings', () => {
    for (const f of [480, 822]) {
      const r = depthRatioGate(scenario(f, 4, 3));
      expect(r.enabled).toBe(true);
      expect(r.decision).toBe('veto_front');
      expect(r.ratio).toBeCloseTo(0.75, 2);
    }
  });

  test('HONEST ENVELOPE: airball 1.0m @ 6m is silent (below the ~1.2m floor)', () => {
    const r = depthRatioGate(scenario(822, 6, 5));
    expect(r.enabled).toBe(true);
    expect(r.decision).toBe('silent'); // not a bug — the math cannot prove it
  });

  test('airball 1.5m @ 6m fires; 2.0m @ 8m fires under crop framing', () => {
    expect(depthRatioGate(scenario(822, 6, 4.5)).decision).toBe('veto_front');
    const far = depthRatioGate(scenario(1067, 8, 6));
    expect(far.decision).toBe('veto_front');
  });

  test('8m FULL-FOV framing is disabled by the pixel floors (never guesses)', () => {
    const r = depthRatioGate(scenario(480, 8, 7));
    expect(r.enabled).toBe(false);
    expect(r.decision).toBe('silent');
    expect(r.disableReason).toBeDefined();
  });

  test('3-pt camera range (>=12m) is structurally blind — silent', () => {
    const r = depthRatioGate(scenario(822, 12, 10.5));
    expect(r.enabled).toBe(false);
    expect(r.decision).toBe('silent');
  });

  test('NO false veto on a blur-inflated true make (+10% measured diameter)', () => {
    const f = 822;
    const z = 4;
    const r = depthRatioGate(
      scenario(f, z, z, { ballDiaPxAvg: px(f, BALL7_M, z) * 1.1 }),
    );
    expect(r.decision).toBe('silent');
  });

  test('behind-rim pass 1.0m @ 4m fires veto_behind; @ 8m silent (blur-masked recall)', () => {
    expect(depthRatioGate(scenario(822, 4, 5)).decision).toBe('veto_behind');
    expect(depthRatioGate(scenario(822, 8, 9)).decision).toBe('silent');
  });

  test('mis-set ball size (real 5, setting 7) never false-vetoes a make', () => {
    const f = 822;
    const z = 4;
    // A size-5 ball at rim depth measures smaller than the size-7 spec expects.
    const r = depthRatioGate(
      scenario(f, z, z, { ballDiaPxAvg: px(f, 0.22, z), ballSize: 7 }),
    );
    expect(r.decision).toBe('silent');
  });

  test('contaminated rim lock widens sigma and silences a borderline veto', () => {
    const clean = depthRatioGate(scenario(480, 4, 3));
    const dirty = depthRatioGate(scenario(480, 4, 3, { rimLockContaminated: true }));
    expect(clean.decision).toBe('veto_front');
    expect(dirty.decision).toBe('silent'); // bad lock costs protection, never adds false vetoes
  });

  test('enablement floor: every precondition silences with a reason', () => {
    expect(depthRatioGate(gateInput({ viewBand: 'under_hoop' })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ rimBounce: true })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ clsStrongContext: true })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ crossingReal: false })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ nRealSamples: 2 })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ ballDiaPxAvg: null })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ ballDiaPxAvg: 12 })).enabled).toBe(false);
    expect(depthRatioGate(gateInput({ rimWidthPx: 30 })).enabled).toBe(false);
  });

  test('the gate NEVER confirms: silent and veto are the only outputs', () => {
    // Sweep a grid; assert no output other than silent/veto_front/veto_behind.
    for (const zBall of [2.5, 3, 3.5, 4, 4.5, 5]) {
      const r = depthRatioGate(scenario(822, 4, zBall));
      expect(['silent', 'veto_front', 'veto_behind']).toContain(r.decision);
    }
  });
});

// ---------------------------------------------------------------------------
// sampleQuality
// ---------------------------------------------------------------------------

describe('selectDepthSamples', () => {
  const rim: Box = { x: 300, y: 100, width: 90, height: 45 };

  function sample(cx: number, cy: number, r: number, t: number, predicted = false): BallSample {
    return { cx, cy, r, t, score: predicted ? 0 : 0.6, predicted };
  }

  test('averages only real, pre-rim-overlap samples (newest first)', () => {
    const history = [
      sample(100, 400, 15, 0.0),
      sample(150, 350, 15, 0.05),
      sample(200, 300, 16, 0.1),
      sample(250, 250, 16, 0.15),
      sample(345, 120, 17, 0.2), // overlaps the rim box — cutoff here
      sample(346, 118, 17, 0.25),
    ];
    const sel = selectDepthSamples(history, rim);
    expect(sel.nReal).toBe(4);
    expect(sel.avgDiaPx).toBeCloseTo(((15 + 15 + 16 + 16) * 2) / 4, 5);
  });

  test('predicted samples never contribute', () => {
    const history = [
      sample(100, 400, 15, 0.0),
      sample(150, 350, 15, 0.05, true),
      sample(200, 300, 15, 0.1, true),
    ];
    const sel = selectDepthSamples(history, rim);
    expect(sel.nReal).toBe(1);
  });

  test('a blur-inflated radius jump is rejected', () => {
    const history = [
      sample(100, 400, 15, 0.0),
      sample(150, 350, 15, 0.05),
      sample(200, 300, 19, 0.1), // +27% jump over neighbor — blur
    ];
    const sel = selectDepthSamples(history, rim);
    expect(sel.rejectedBlur).toBe(1);
    expect(sel.avgDiaPx).toBeCloseTo(30, 5);
  });

  test('empty/near-rim-only history yields null', () => {
    expect(selectDepthSamples([], rim).avgDiaPx).toBeNull();
    expect(selectDepthSamples([sample(345, 120, 17, 0)], rim).avgDiaPx).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// viewBand
// ---------------------------------------------------------------------------

describe('classifyViewBand', () => {
  test('chest-height tripod side view (aspect 4, pitch ~0) is geo-primary with the gate ON', () => {
    const r = classifyViewBand(4.0, 0);
    expect(r.band).toBe('side_wing');
    expect(r.enable.planeYGeo).toBe(true);
    expect(r.enable.depthGate).toBe(true);
    expect(r.enable.metric23).toBe(true);
  });

  test('under-hoop (aspect 1.11, pitch +40) disables planeY geo and the gate', () => {
    const r = classifyViewBand(1.11, 40);
    expect(r.band).toBe('under_hoop');
    expect(r.enable.planeYGeo).toBe(false);
    expect(r.enable.depthGate).toBe(false);
    expect(r.enable.ellipsePrimary).toBe(true);
    expect(r.enable.clsMinPersistFrames).toBeGreaterThanOrEqual(2);
  });

  test('overhead balcony (aspect 1.2, pitch -30) keeps geo + 2/3, gate off', () => {
    const r = classifyViewBand(1.2, -30);
    expect(r.band).toBe('overhead');
    expect(r.enable.planeYGeo).toBe(true);
    expect(r.enable.depthGate).toBe(false);
    expect(r.enable.metric23).toBe(true);
  });

  test('no IMU: low aspect classifies conservatively (fragile mechanisms off)', () => {
    const r = classifyViewBand(1.2, null);
    expect(r.enable.planeYGeo).toBe(false);
    expect(r.enable.depthGate).toBe(false);
  });

  test('elevated bleachers (aspect 4.19, pitch -25): gate off, metric23 on', () => {
    const r = classifyViewBand(4.19, -25);
    expect(r.band).toBe('elevated_far');
    expect(r.enable.depthGate).toBe(false);
    expect(r.enable.metric23).toBe(true);
  });

  test('extreme aspect (>6.5) degrades to net/cls-only with a warning band', () => {
    const r = classifyViewBand(7.0, 0);
    expect(r.band).toBe('degraded');
    expect(r.enable.planeYGeo).toBe(false);
    expect(r.enable.metric23).toBe(false);
  });
});
