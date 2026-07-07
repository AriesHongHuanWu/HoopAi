/**
 * Shot Lab analytics engine tests — synthetic shots with real ballistic
 * trajectories (so fitArc/arcHeightRatio run the true code path).
 */
import {
  arcHeightRatio,
  coachPlan,
  makeMissReport,
  matchArchetype,
  meanArc,
  normalizedArcs,
  radarScores,
  scoreAxis,
  splitMetric,
  LAB_METRICS,
} from '../shotLab';
import { BENCHMARK_AXES } from '../nbaBenchmarks';
import type { BallSample, FormMetrics, ResolvedShot } from '../types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** Ballistic samples, +y down: launch up then fall. */
function ballistic(opts: {
  vx?: number;
  vy0?: number;
  g?: number;
  x0?: number;
  y0?: number;
  dir?: 1 | -1;
}): BallSample[] {
  const vx = (opts.vx ?? 400) * (opts.dir ?? 1);
  const vy0 = opts.vy0 ?? 420;
  const g = opts.g ?? 900;
  const x0 = opts.x0 ?? 100;
  const y0 = opts.y0 ?? 500;
  const out: BallSample[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i * 0.05;
    out.push({
      cx: x0 + vx * t,
      cy: y0 - vy0 * t + 0.5 * g * t * t,
      r: 14,
      t,
      score: 0.6,
      predicted: false,
    });
  }
  return out;
}

const NULL_METRICS: FormMetrics = {
  setPointElbowDeg: null,
  kneeFlexionDeg: null,
  releaseAngleDeg: null,
  entryAngleDeg: null,
  releaseTimeMs: null,
  followThroughHeldMs: null,
  followThroughElbowDeg: null,
  releaseHeightNorm: null,
};

let nextId = 1;
function shot(opts: {
  outcome: 'make' | 'miss' | 'unsure';
  entry?: number | null;
  release?: number | null;
  metrics?: Partial<FormMetrics>;
  traj?: BallSample[];
}): ResolvedShot {
  const s: ResolvedShot = {
    id: nextId++,
    tStart: 0,
    tResolved: 1,
    outcome: opts.outcome,
    signals: { geo: opts.outcome === 'make', net: null, cls: false },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: opts.entry ?? null,
    releaseAngleDeg: opts.release ?? null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: opts.traj ?? [],
  };
  if (opts.metrics) {
    s.form = { metrics: { ...NULL_METRICS, ...opts.metrics }, tips: [] };
  }
  return s;
}

/** n makes + n misses with per-group entry/release means (tiny jitter). */
function session(opts: {
  n: number;
  makeEntry?: number;
  missEntry?: number;
  makeRelease?: number;
  missRelease?: number;
  metricsFor?: (isMake: boolean, i: number) => Partial<FormMetrics>;
}): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (let i = 0; i < opts.n; i++) {
    const j = (i % 3) - 1; // -1, 0, +1 jitter
    out.push(
      shot({
        outcome: 'make',
        entry: opts.makeEntry != null ? opts.makeEntry + j : null,
        release: opts.makeRelease != null ? opts.makeRelease + j : null,
        metrics: opts.metricsFor?.(true, i),
      }),
      shot({
        outcome: 'miss',
        entry: opts.missEntry != null ? opts.missEntry + j : null,
        release: opts.missRelease != null ? opts.missRelease + j : null,
        metrics: opts.metricsFor?.(false, i),
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Make vs miss
// ---------------------------------------------------------------------------

describe('makeMissReport', () => {
  test('finds the metric that separates makes from misses', () => {
    const shots = session({ n: 6, makeEntry: 46, missEntry: 38 });
    const report = makeMissReport(shots);
    expect(report.makes).toBe(6);
    expect(report.misses).toBe(6);
    const top = report.differentiators[0];
    expect(top).toBeDefined();
    expect(top!.def.key).toBe('entryAngleDeg');
    expect(top!.delta).toBeCloseTo(8, 0);
    expect(Math.abs(top!.effect!)).toBeGreaterThan(0.8);
    expect(report.headline).toContain('entry angle');
    expect(report.headline).toContain('higher');
  });

  test('no differentiators when makes and misses look identical', () => {
    const shots = session({ n: 6, makeEntry: 45, missEntry: 45 });
    const report = makeMissReport(shots);
    expect(report.differentiators).toHaveLength(0);
    expect(report.headline).toBeNull();
  });

  test('small groups never produce an effect size', () => {
    const def = LAB_METRICS.find((m) => m.key === 'entryAngleDeg')!;
    const shots = [
      shot({ outcome: 'make', entry: 46 }),
      shot({ outcome: 'make', entry: 47 }),
      shot({ outcome: 'miss', entry: 30 }),
      shot({ outcome: 'miss', entry: 31 }),
    ];
    const split = splitMetric(shots, def);
    expect(split.delta).not.toBeNull(); // means still shown
    expect(split.effect).toBeNull(); // but no statistical claim
  });

  test('unsure shots are excluded entirely', () => {
    const shots = [
      ...session({ n: 4, makeEntry: 46, missEntry: 40 }),
      shot({ outcome: 'unsure', entry: 10 }),
    ];
    const def = LAB_METRICS.find((m) => m.key === 'entryAngleDeg')!;
    const split = splitMetric(shots, def);
    expect(split.points).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Radar scoring
// ---------------------------------------------------------------------------

describe('scoreAxis / radarScores', () => {
  const arcAxis = BENCHMARK_AXES.find((a) => a.key === 'releaseAngleDeg')!;
  const ftAxis = BENCHMARK_AXES.find((a) => a.key === 'followThroughHeldMs')!;

  test('inside the ideal band scores 100', () => {
    expect(scoreAxis(arcAxis, 50)).toBe(100);
  });

  test('zeroAt beyond the band edge scores 0', () => {
    expect(scoreAxis(arcAxis, 45 - arcAxis.zeroAt)).toBe(0);
  });

  test('one-sided axis never penalizes exceeding the band', () => {
    expect(scoreAxis(ftAxis, 9000)).toBe(100);
  });

  test('null value stays null', () => {
    expect(scoreAxis(arcAxis, null)).toBeNull();
  });

  test('radar consistency axis uses release-angle spread', () => {
    const tight = session({ n: 4, makeRelease: 50, missRelease: 50 });
    const scores = radarScores(tight);
    const cons = scores.find((s) => s.axis.key === 'consistencyStdDeg')!;
    expect(cons.value).not.toBeNull();
    expect(cons.value!).toBeLessThan(2);
    expect(cons.user).toBe(100);
    // Benchmarks scored through the same function are non-zero.
    expect(cons.nba).toBeGreaterThan(0);
    const arc = scores.find((s) => s.axis.key === 'releaseAngleDeg')!;
    expect(arc.user).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Archetype match
// ---------------------------------------------------------------------------

describe('matchArchetype', () => {
  test('a Curry-like profile matches Curry first', () => {
    const shots = session({
      n: 6,
      makeRelease: 52,
      missRelease: 52,
      makeEntry: 46,
      missEntry: 46,
      metricsFor: () => ({ releaseTimeMs: 400 }),
    });
    const matches = matchArchetype(shots);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]!.player.name).toBe('Stephen Curry');
    expect(matches[0]!.similarity).toBeGreaterThan(80);
    // Kawhi (slow, flat) should rank clearly below.
    const kawhi = matches.find((m) => m.player.name === 'Kawhi Leonard')!;
    expect(matches[0]!.similarity).toBeGreaterThan(kawhi.similarity);
    // Rows carry both sides for the comparison chart.
    expect(matches[0]!.rows.some((r) => r.key === 'releaseAngleDeg')).toBe(true);
  });

  test('returns [] without enough measured data', () => {
    expect(matchArchetype([shot({ outcome: 'make' })])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Coach plan
// ---------------------------------------------------------------------------

describe('coachPlan', () => {
  test('flat shooter gets the arc fix first, with data + drill', () => {
    const shots = session({ n: 6, makeRelease: 39, missRelease: 37, makeEntry: 45, missEntry: 44 });
    const plan = coachPlan(shots);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.length).toBeLessThanOrEqual(3);
    const arc = plan.find((p) => p.def.key === 'releaseAngleDeg');
    expect(arc).toBeDefined();
    expect(arc!.title).toBe('Add launch arc');
    expect(arc!.dataLine).toContain('%');
    expect(arc!.drill.length).toBeGreaterThan(10);
    expect(arc!.targetLine).toContain('45');
  });

  test('clean form yields an empty plan (nothing to fix)', () => {
    const shots = session({
      n: 6,
      makeRelease: 50,
      missRelease: 49,
      makeEntry: 45,
      missEntry: 44,
      metricsFor: () => ({ setPointElbowDeg: 82, kneeFlexionDeg: 115, releaseTimeMs: 500 }),
    });
    expect(coachPlan(shots)).toHaveLength(0);
  });

  test('needs at least 4 decided shots', () => {
    expect(coachPlan(session({ n: 1, makeRelease: 30, missRelease: 30 }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

describe('arcHeightRatio / normalizedArcs', () => {
  test('a real ballistic arc lands in the classic range', () => {
    const s = shot({ outcome: 'make', traj: ballistic({}) });
    const r = arcHeightRatio(s);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(0.1);
    expect(r!).toBeLessThan(0.6);
  });

  test('a flat roll has no arc', () => {
    const flat: BallSample[] = Array.from({ length: 10 }, (_, i) => ({
      cx: 100 + i * 30,
      cy: 500,
      r: 14,
      t: i * 0.05,
      score: 0.6,
      predicted: false,
    }));
    expect(arcHeightRatio(shot({ outcome: 'miss', traj: flat }))).toBeNull();
  });

  test('normalizes both flight directions to left-to-right, +y up', () => {
    const shots = [
      shot({ outcome: 'make', traj: ballistic({ dir: 1 }) }),
      shot({ outcome: 'make', traj: ballistic({ dir: -1, x0: 900 }) }),
      shot({ outcome: 'miss', traj: ballistic({ vy0: 250 }) }),
    ];
    const arcs = normalizedArcs(shots);
    expect(arcs).toHaveLength(3);
    for (const a of arcs) {
      expect(a.pts[0]!.x).toBeCloseTo(0, 5);
      expect(a.pts[a.pts.length - 1]!.x).toBeCloseTo(1, 5);
      // Apex above the release line in +up coordinates.
      const maxY = Math.max(...a.pts.map((p) => p.y));
      expect(maxY).toBeGreaterThan(0);
    }
    const mean = meanArc(arcs, 'make');
    expect(mean).not.toBeNull();
    expect(mean!).toHaveLength(24);
    // Single miss → no mean (needs ≥2).
    expect(meanArc(arcs, 'miss')).toBeNull();
  });
});
