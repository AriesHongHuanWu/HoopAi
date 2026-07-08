import {
  GRAVITY,
  RIM_WIDTH_M,
  MIN_FPS,
  PLYO_PROGRAMS,
  detectFlight,
  displacementHeightCm,
  estimateBaseline,
  estimateJump,
  hangTimeHeightCm,
  jumpHistoryStats,
  metersPerPxFromRim,
  programForLevel,
  seriesFps,
  type JumpRecord,
  type JumpSample,
} from '../jumpLab';

// ---------------------------------------------------------------------------
// Synthetic jump generator
// ---------------------------------------------------------------------------

/** Deterministic pseudo-random in [-1,1) (Park–Miller LCG). */
function makeNoise(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 48271) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

/**
 * Build a physically-honest ankle/hip series for a jump of a given TRUE height.
 *
 * The body is on the ground (ankle at `baseline`) for `preSec`, launches with
 * the exact takeoff velocity that produces `trueHeightM` (v = sqrt(2·g·h)),
 * follows a parabola for the flight, then stands again. We convert the metric
 * parabola to pixels via `pxPerM`, +y DOWN. Optionally adds pose noise (px).
 *
 * The hip sits `hipOffsetPx` above the ankle at rest and rises by the SAME
 * metric displacement (a rigid body), so the displacement estimator has a
 * clean target.
 */
function synthJump(opts: {
  fps: number;
  trueHeightM: number;
  baseline?: number;
  pxPerM?: number;
  preSec?: number;
  postSec?: number;
  noisePx?: number;
  seed?: number;
  hipOffsetPx?: number;
  /** Fraction of airborne frames whose ankle is dropped (occlusion). */
  ankleDropFrac?: number;
}): { samples: JumpSample[]; flightSec: number; pxPerM: number; baseline: number } {
  const {
    fps,
    trueHeightM,
    baseline = 500,
    pxPerM = 400,
    preSec = 0.6,
    postSec = 0.6,
    noisePx = 0,
    seed = 12345,
    hipOffsetPx = 180,
    ankleDropFrac = 0,
  } = opts;

  const v0 = Math.sqrt(2 * GRAVITY * trueHeightM); // takeoff speed, m/s
  const flightSec = (2 * v0) / GRAVITY; // time aloft
  const dt = 1 / fps;
  const noise = makeNoise(seed);
  const dropRand = makeNoise(seed + 7);

  const samples: JumpSample[] = [];
  const total = preSec + flightSec + postSec;
  let t = 0;
  let i = 0;
  while (t <= total + 1e-9) {
    // Metric height of the feet above ground at this instant.
    let hM = 0;
    let airborne = false;
    const tf = t - preSec;
    if (tf >= 0 && tf <= flightSec) {
      hM = v0 * tf - 0.5 * GRAVITY * tf * tf; // parabola, ≥ 0 within flight
      if (hM < 0) hM = 0;
      airborne = hM > 1e-6;
    }
    const risePx = hM * pxPerM;
    const ankleY = baseline - risePx; // +y down: higher = smaller y
    const hipY = baseline - hipOffsetPx - risePx;

    const drop = airborne && ankleDropFrac > 0 && (dropRand() + 1) / 2 < ankleDropFrac;
    samples.push({
      t: i * dt,
      ankleY: drop ? null : ankleY + (noisePx ? noise() * noisePx : 0),
      ankleScore: drop ? 0 : 0.9,
      hipY: hipY + (noisePx ? noise() * noisePx : 0),
    });
    i++;
    t = i * dt;
  }
  return { samples, flightSec, pxPerM, baseline };
}

// ---------------------------------------------------------------------------
// Physics primitives
// ---------------------------------------------------------------------------

describe('hangTimeHeightCm', () => {
  test('matches h = g·t²/8 for known flight times', () => {
    // 0.5 s aloft → g·0.25/8 m = 0.30646 m = 30.6 cm.
    expect(hangTimeHeightCm(0.5)).toBeCloseTo((GRAVITY * 0.25) / 8 * 100, 4);
    // A 0.7 s hang time is ~60 cm.
    expect(hangTimeHeightCm(0.7)).toBeCloseTo(60.09, 1);
  });

  test('scales with the square of flight time', () => {
    const a = hangTimeHeightCm(0.4);
    const b = hangTimeHeightCm(0.8);
    expect(b / a).toBeCloseTo(4, 5);
  });
});

describe('seriesFps', () => {
  test('recovers the sampling rate from even spacing', () => {
    const s = synthJump({ fps: 30, trueHeightM: 0.5 }).samples;
    expect(seriesFps(s)).toBeCloseTo(30, 5);
  });

  test('median is robust to a single dropped frame', () => {
    const s = synthJump({ fps: 24, trueHeightM: 0.5 }).samples;
    // Splice out one sample → one doubled interval, but the median dt holds.
    const gapped = [...s.slice(0, 10), ...s.slice(11)];
    expect(seriesFps(gapped)).toBeCloseTo(24, 1);
  });
});

describe('estimateBaseline', () => {
  test('finds the standing ground, ignoring the airborne dip', () => {
    const { samples, baseline } = synthJump({ fps: 30, trueHeightM: 0.6, baseline: 500 });
    const est = estimateBaseline(samples);
    expect(est).not.toBeNull();
    expect(est!).toBeCloseTo(baseline, 0);
  });
});

// ---------------------------------------------------------------------------
// Flight detection + hang-time accuracy across frame rates
// ---------------------------------------------------------------------------

describe('detectFlight', () => {
  test('recovers flight time within a frame at 30 fps', () => {
    const { samples, flightSec, baseline } = synthJump({ fps: 30, trueHeightM: 0.6 });
    const w = detectFlight(samples, baseline, 8);
    expect(w).not.toBeNull();
    expect(w!.flightSec).toBeCloseTo(flightSec, 1);
  });

  test('survives mid-air ankle occlusion (does not end flight early)', () => {
    const { samples, flightSec, baseline } = synthJump({
      fps: 30,
      trueHeightM: 0.6,
      ankleDropFrac: 0.4,
      seed: 99,
    });
    const w = detectFlight(samples, baseline, 8);
    expect(w).not.toBeNull();
    // One flight, roughly the right duration despite dropped airborne frames.
    // Heavy (40%) airborne occlusion can delay the landing crossing by up to a
    // couple of frames — a real, honest accuracy cost, bounded here.
    expect(Math.abs(w!.flightSec - flightSec)).toBeLessThan(4 / 30);
  });

  test('a standing sway produces no flight', () => {
    const samples: JumpSample[] = [];
    const noise = makeNoise(3);
    for (let i = 0; i < 60; i++) {
      samples.push({ t: i / 30, ankleY: 500 + noise() * 2, ankleScore: 0.9, hipY: 320 });
    }
    expect(detectFlight(samples, 500, 8)).toBeNull();
  });
});

describe('estimateJump — hang-time accuracy vs frame rate', () => {
  for (const fps of [15, 24, 30]) {
    for (const trueHeightM of [0.3, 0.5, 0.76]) {
      test(`${fps}fps, ${(trueHeightM * 100).toFixed(0)}cm true → within tolerance`, () => {
        const { samples } = synthJump({ fps, trueHeightM });
        const est = estimateJump(samples, {
          metersPerPx: 1 / 400, // matches synth pxPerM=400
        });
        expect(est.method).toBe('hang-time');
        const trueCm = trueHeightM * 100;
        // Tolerance scales with quantisation AND jump height: a ±1-frame error
        // on the flight time costs more centimetres on a longer hang time, so a
        // tall jump at a coarse fps has the widest honest bound.
        const tolCm = fps >= 30 ? 4 : fps >= 24 ? 7 : 10;
        expect(Math.abs(est.heightCm - trueCm)).toBeLessThan(tolCm);
        expect(est.confidence).toBeGreaterThan(0.4);
      });
    }
  }
});

describe('estimateJump — noisy series', () => {
  test('30 fps with 4px pose noise still lands within 6 cm', () => {
    const trueCm = 55;
    const { samples } = synthJump({
      fps: 30,
      trueHeightM: trueCm / 100,
      noisePx: 4,
      seed: 2024,
    });
    const est = estimateJump(samples, { metersPerPx: 1 / 400 });
    expect(est.method).toBe('hang-time');
    expect(Math.abs(est.heightCm - trueCm)).toBeLessThan(6);
  });

  test('24 fps noisy series with occlusion is still measured', () => {
    const { samples } = synthJump({
      fps: 24,
      trueHeightM: 0.5,
      noisePx: 3,
      ankleDropFrac: 0.25,
      seed: 555,
    });
    const est = estimateJump(samples, { metersPerPx: 1 / 400 });
    expect(est.method).toBe('hang-time');
    expect(Math.abs(est.heightCm - 50)).toBeLessThan(9);
  });
});

// ---------------------------------------------------------------------------
// Displacement estimator + cross-check
// ---------------------------------------------------------------------------

describe('displacement estimator', () => {
  test('hip-rise × mpp recovers the true height', () => {
    const trueCm = 50;
    const pxPerM = 400;
    const { samples, baseline } = synthJump({
      fps: 30,
      trueHeightM: trueCm / 100,
      pxPerM,
    });
    const w = detectFlight(samples, baseline, 8)!;
    const cm = displacementHeightCm(samples, w, baseline, 1 / pxPerM);
    expect(cm).not.toBeNull();
    expect(Math.abs(cm! - trueCm)).toBeLessThan(4);
  });

  test('both estimators agree → high confidence, displacement reported', () => {
    const pxPerM = 400;
    const { samples } = synthJump({ fps: 30, trueHeightM: 0.6, pxPerM });
    const est = estimateJump(samples, { metersPerPx: 1 / pxPerM });
    expect(est.displacementCm).not.toBeNull();
    const ratio =
      Math.min(est.hangTimeCm!, est.displacementCm!) /
      Math.max(est.hangTimeCm!, est.displacementCm!);
    expect(ratio).toBeGreaterThan(0.75);
    expect(est.confidence).toBeGreaterThan(0.7);
  });

  test('no scale → hang-time only, displacement null, honest note', () => {
    const { samples } = synthJump({ fps: 30, trueHeightM: 0.5 });
    const est = estimateJump(samples); // no metersPerPx
    expect(est.method).toBe('hang-time');
    expect(est.displacementCm).toBeNull();
    expect(est.note).toMatch(/cross-check/i);
  });
});

// ---------------------------------------------------------------------------
// Refusal / graceful-degradation paths
// ---------------------------------------------------------------------------

describe('estimateJump — refusals', () => {
  test(`refuses below ${MIN_FPS} fps with a Speed-mode hint`, () => {
    const { samples } = synthJump({ fps: 12, trueHeightM: 0.5 });
    const est = estimateJump(samples, { metersPerPx: 1 / 400 });
    expect(est.method).toBe('none');
    expect(est.heightCm).toBe(0);
    expect(est.note).toMatch(/too slow|Speed mode/i);
  });

  test('too few frames refuses cleanly', () => {
    const samples: JumpSample[] = Array.from({ length: 5 }, (_, i) => ({
      t: i / 30,
      ankleY: 500,
      ankleScore: 0.9,
      hipY: 320,
    }));
    const est = estimateJump(samples);
    expect(est.method).toBe('none');
    expect(est.note).toMatch(/pose frames|full body/i);
  });

  test('no feet visible refuses with a framing hint', () => {
    const samples: JumpSample[] = Array.from({ length: 40 }, (_, i) => ({
      t: i / 30,
      ankleY: null,
      ankleScore: 0,
      hipY: 320,
    }));
    const est = estimateJump(samples);
    expect(est.method).toBe('none');
    expect(est.note).toMatch(/feet|body/i);
  });

  test('standing still (no jump) reports none', () => {
    const noise = makeNoise(1);
    const samples: JumpSample[] = Array.from({ length: 60 }, (_, i) => ({
      t: i / 30,
      ankleY: 500 + noise() * 1.5,
      ankleScore: 0.9,
      hipY: 320,
    }));
    const est = estimateJump(samples, { metersPerPx: 1 / 400 });
    expect(est.method).toBe('none');
    expect(est.note).toMatch(/no clean jump/i);
  });
});

// ---------------------------------------------------------------------------
// Scale helpers
// ---------------------------------------------------------------------------

describe('scale helpers', () => {
  test('metersPerPxFromRim uses the 0.45 m rim width', () => {
    expect(metersPerPxFromRim(90)).toBeCloseTo(RIM_WIDTH_M / 90, 8);
    expect(metersPerPxFromRim(0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// History aggregates
// ---------------------------------------------------------------------------

describe('jumpHistoryStats', () => {
  const rows = (heights: number[]): JumpRecord[] =>
    heights.map((h, i) => ({
      id: i + 1,
      ts: 1000 + i * 1000,
      heightCm: h,
      method: 'hang-time',
      confidence: 0.8,
    }));

  test('empty history is all zeros', () => {
    const s = jumpHistoryStats([]);
    expect(s).toEqual({ bestCm: 0, avgCm: 0, count: 0, latestCm: 0, sparkline: [] });
  });

  test('best, average, latest and sparkline order', () => {
    const s = jumpHistoryStats(rows([40, 55, 48, 60, 52]));
    expect(s.bestCm).toBe(60);
    expect(s.count).toBe(5);
    expect(s.latestCm).toBe(52); // newest by ts
    expect(s.avgCm).toBeCloseTo((40 + 55 + 48 + 60 + 52) / 5, 1);
    expect(s.sparkline).toEqual([40, 55, 48, 60, 52]);
  });

  test('unordered input is sorted by timestamp for latest + sparkline', () => {
    const unordered: JumpRecord[] = [
      { id: 3, ts: 3000, heightCm: 30, method: 'hang-time', confidence: 0.8 },
      { id: 1, ts: 1000, heightCm: 10, method: 'hang-time', confidence: 0.8 },
      { id: 2, ts: 2000, heightCm: 20, method: 'hang-time', confidence: 0.8 },
    ];
    const s = jumpHistoryStats(unordered);
    expect(s.sparkline).toEqual([10, 20, 30]);
    expect(s.latestCm).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Training programs
// ---------------------------------------------------------------------------

describe('plyometric programs', () => {
  test('three levels, each internally consistent', () => {
    expect(PLYO_PROGRAMS).toHaveLength(3);
    const levels = PLYO_PROGRAMS.map((p) => p.level);
    expect(levels).toEqual(['beginner', 'intermediate', 'advanced']);
    for (const p of PLYO_PROGRAMS) {
      expect(p.exercises.length).toBeGreaterThanOrEqual(4);
      expect(p.daysPerWeek).toBeGreaterThanOrEqual(2);
      expect(p.schedule.length).toBeGreaterThan(0);
      expect(p.principle.length).toBeGreaterThan(20);
      for (const e of p.exercises) {
        expect(e.sets).toBeGreaterThan(0);
        expect(e.reps).toBeGreaterThan(0);
        expect(e.restSec).toBeGreaterThan(0);
        expect(['reps', 'sec']).toContain(e.unit);
      }
    }
  });

  test('advanced rests longer between explosive sets than beginner', () => {
    const restAvg = (level: 'beginner' | 'advanced') =>
      programForLevel(level).exercises.reduce((a, e) => a + e.restSec, 0) /
      programForLevel(level).exercises.length;
    expect(restAvg('advanced')).toBeGreaterThan(restAvg('beginner'));
  });

  test('programForLevel returns the matching program', () => {
    expect(programForLevel('intermediate').level).toBe('intermediate');
  });
});
