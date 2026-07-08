/**
 * Coach engine tests — synthetic session windows exercising each rule, plus
 * the runner's ranking/guards. Numbers in the assertions are hand-derived from
 * the fixtures so a threshold change surfaces here.
 */
import {
  buildWindow,
  runCoach,
  type CoachFinding,
  type CoachSession,
  type FindingKind,
} from '../coachEngine';
import { emptyStats, applyShot } from '../stats';
import type { BallSample, FormMetrics, ResolvedShot, SessionStats } from '../types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

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
  originX?: number | null;
  xCross?: number | null;
  r?: number;
  value?: 2 | 3;
  metrics?: Partial<FormMetrics>;
}): ResolvedShot {
  const traj: BallSample[] =
    opts.r != null
      ? [{ cx: 0, cy: 0, r: opts.r, t: 0, score: 0.6, predicted: false }]
      : [];
  const s: ResolvedShot = {
    id: nextId++,
    tStart: 0,
    tResolved: 1,
    outcome: opts.outcome,
    signals: { geo: opts.outcome === 'make', net: null, cls: null },
    rimBounce: false,
    xCross: opts.xCross ?? null,
    entryAngleDeg: opts.entry ?? null,
    releaseAngleDeg: opts.release ?? null,
    releasePoint: null,
    originX: opts.originX ?? null,
    originY: null,
    trajectory: traj,
  };
  if (opts.value != null) s.shotValue = opts.value;
  if (opts.metrics) s.form = { metrics: { ...NULL_METRICS, ...opts.metrics }, tips: [] };
  return s;
}

function statsFor(shots: readonly ResolvedShot[]): SessionStats {
  let st = emptyStats();
  for (const s of shots) st = applyShot(st, s);
  return st;
}

function session(id: number, startedAt: number, shots: ResolvedShot[], label?: string): CoachSession {
  return { id, startedAt, shots, stats: statsFor(shots), label };
}

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 6, 6, 12, 0, 0); // Mon Jul 6 2026, noon

function findingById(fs: CoachFinding[], id: FindingKind): CoachFinding | undefined {
  return fs.find((f) => f.id === id);
}

// n makes + n misses with a given entry angle on all shots.
function flatEntrySession(id: number, startedAt: number, n: number, entry: number): CoachSession {
  const shots: ResolvedShot[] = [];
  for (let i = 0; i < n; i++) {
    shots.push(shot({ outcome: 'make', entry }), shot({ outcome: 'miss', entry }));
  }
  return session(id, startedAt, shots);
}

// ---------------------------------------------------------------------------

describe('coachEngine', () => {
  // -------------------------------------------------------------------------
  // Guards
  // -------------------------------------------------------------------------

  test('empty window and no-decided window return no findings', () => {
    expect(runCoach([])).toEqual([]);
    const allUnsure = session(1, T0, [
      shot({ outcome: 'unsure' }),
      shot({ outcome: 'unsure' }),
    ]);
    expect(runCoach([allUnsure])).toEqual([]);
  });

  test('buildWindow orders sessions newest-first and aggregates decided shots', () => {
    const a = session(1, T0, [shot({ outcome: 'make' }), shot({ outcome: 'miss' })]);
    const b = session(2, T0 + DAY, [shot({ outcome: 'make' }), shot({ outcome: 'unsure' })]);
    const w = buildWindow([a, b]);
    expect(w.sessions[0]!.id).toBe(2); // newer first
    expect(w.makes).toBe(2);
    expect(w.misses).toBe(1);
    expect(w.decidedShots.length).toBe(3);
    expect(w.fgPct).toBeCloseTo(2 / 3, 5);
  });

  // -------------------------------------------------------------------------
  // Rule 1 — entry angle low
  // -------------------------------------------------------------------------

  test('entryAngleLow fires on a chronically flat entry with severity 3', () => {
    // mean entry 34° (< 40), well below 40-5=35 ⇒ severity 3.
    const s = flatEntrySession(1, T0, 6, 34);
    const f = findingById(runCoach([s]), 'entryAngleLow');
    expect(f).toBeDefined();
    expect(f!.severity).toBe(3);
    expect(f!.evidence).toContain('34.0°');
  });

  test('entryAngleLow stays quiet when entry sits in the ideal band', () => {
    const s = flatEntrySession(1, T0, 6, 45);
    expect(findingById(runCoach([s]), 'entryAngleLow')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rule 2 — entry angle volatile
  // -------------------------------------------------------------------------

  test('entryAngleVolatile fires when spread is wide even if mean is fine', () => {
    // Alternate 30/60 → mean 45 (band-fine, so low rule quiet), σ = 15 (> 8).
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 6; i++) {
      shots.push(shot({ outcome: 'make', entry: 30 }), shot({ outcome: 'miss', entry: 60 }));
    }
    const fs = runCoach([session(1, T0, shots)]);
    expect(findingById(fs, 'entryAngleLow')).toBeUndefined();
    const v = findingById(fs, 'entryAngleVolatile');
    expect(v).toBeDefined();
    expect(v!.evidence).toContain('±15.0°');
  });

  // -------------------------------------------------------------------------
  // Rule 3 — release drift
  // -------------------------------------------------------------------------

  test('releaseDrift fires when the recent release mean moved off the baseline', () => {
    const older = session(
      1,
      T0,
      Array.from({ length: 4 }, () => shot({ outcome: 'make', release: 50 })),
    );
    const recent = session(
      2,
      T0 + DAY,
      Array.from({ length: 4 }, () => shot({ outcome: 'make', release: 42 })),
    );
    const f = findingById(runCoach([older, recent]), 'releaseDrift');
    expect(f).toBeDefined();
    // 50 → 42 is flattening.
    expect(f!.title.toLowerCase()).toContain('flatten');
    expect(f!.evidence).toContain('8.0°');
  });

  test('releaseDrift stays quiet with a single session (no baseline)', () => {
    const only = session(
      1,
      T0,
      Array.from({ length: 6 }, () => shot({ outcome: 'make', release: 50 })),
    );
    expect(findingById(runCoach([only]), 'releaseDrift')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rule 4 — zone imbalance
  // -------------------------------------------------------------------------

  test('zoneImbalance fires on a big best-vs-worst zone gap', () => {
    const shots: ResolvedShot[] = [];
    // Left: 4/4 = 100%. Right: 0/4 = 0%. Gap 100 pts.
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'make', originX: 0.1 }));
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'miss', originX: 0.9 }));
    const f = findingById(runCoach([session(1, T0, shots)]), 'zoneImbalance');
    expect(f).toBeDefined();
    expect(f!.evidence).toContain('100%');
    expect(f!.evidence).toContain('0%');
  });

  // -------------------------------------------------------------------------
  // Rule 5 — side bias
  // -------------------------------------------------------------------------

  test('sideBias fires when misses cross consistently to one side of makes', () => {
    const shots: ResolvedShot[] = [];
    // Makes cross at x≈100 (rim center). Misses cross at x≈130 → +30px = +3 r
    // with r=10 (> 0.6 radii). Should read "right".
    for (let i = 0; i < 5; i++) {
      shots.push(shot({ outcome: 'make', xCross: 100 + (i - 2), r: 10 }));
      shots.push(shot({ outcome: 'miss', xCross: 130 + (i - 2), r: 10 }));
    }
    const f = findingById(runCoach([session(1, T0, shots)]), 'sideBias');
    expect(f).toBeDefined();
    expect(f!.title).toBe('You miss right');
  });

  test('sideBias stays quiet when misses scatter symmetrically', () => {
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 6; i++) {
      shots.push(shot({ outcome: 'make', xCross: 100, r: 10 }));
      // symmetric misses: half left, half right, median ≈ center.
      shots.push(shot({ outcome: 'miss', xCross: i % 2 === 0 ? 80 : 120, r: 10 }));
    }
    expect(findingById(runCoach([session(1, T0, shots)]), 'sideBias')).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Rule 6 — streaky
  // -------------------------------------------------------------------------

  test('streaky fires on a long run atop a cold overall FG%', () => {
    // 5 straight makes then 10 misses → bestRun 5, FG 5/15 = 33% (< 40).
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 5; i++) shots.push(shot({ outcome: 'make' }));
    for (let i = 0; i < 10; i++) shots.push(shot({ outcome: 'miss' }));
    const f = findingById(runCoach([session(1, T0, shots)]), 'streaky');
    expect(f).toBeDefined();
    expect(f!.evidence).toContain('5 straight');
  });

  // -------------------------------------------------------------------------
  // Rule 7 — fatigue
  // -------------------------------------------------------------------------

  test('fatigue fires when the second half of sessions falls off', () => {
    // 10 decided: first 5 all makes, last 5 all misses. first 100%, second 0%.
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 5; i++) shots.push(shot({ outcome: 'make' }));
    for (let i = 0; i < 5; i++) shots.push(shot({ outcome: 'miss' }));
    const f = findingById(runCoach([session(1, T0, shots)]), 'fatigue');
    expect(f).toBeDefined();
    expect(f!.evidence).toContain('100%');
    expect(f!.evidence).toContain('0%');
  });

  // -------------------------------------------------------------------------
  // Rule 8 — 2pt vs 3pt
  // -------------------------------------------------------------------------

  test('twoVsThree fires on a big inside/outside efficiency gap', () => {
    const shots: ResolvedShot[] = [];
    // 2pt: 4/4 = 100%. 3pt: 1/5 = 20%. Gap 80 pts. Weaker = 3.
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'make', value: 2 }));
    shots.push(shot({ outcome: 'make', value: 3 }));
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'miss', value: 3 }));
    const f = findingById(runCoach([session(1, T0, shots)]), 'twoVsThree');
    expect(f).toBeDefined();
    expect(f!.title).toContain('3-point');
  });

  // -------------------------------------------------------------------------
  // Rule 9 — unsure rate
  // -------------------------------------------------------------------------

  test('unsureRate fires when too many shots come back unsure', () => {
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 6; i++) shots.push(shot({ outcome: 'make' }));
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'unsure' })); // 4/10 = 40%
    const f = findingById(runCoach([session(1, T0, shots)]), 'unsureRate');
    expect(f).toBeDefined();
    expect(f!.evidence).toContain('40%');
  });

  // -------------------------------------------------------------------------
  // Rule 10 — volume trend
  // -------------------------------------------------------------------------

  test('volumeTrend flags a big drop in recent volume', () => {
    const older = session(
      1,
      T0,
      Array.from({ length: 20 }, () => shot({ outcome: 'make' })),
    );
    const recent = session(
      2,
      T0 + DAY,
      Array.from({ length: 6 }, () => shot({ outcome: 'make' })),
    );
    const f = findingById(runCoach([older, recent]), 'volumeTrend');
    expect(f).toBeDefined();
    expect(f!.title.toLowerCase()).toContain('dropped');
    expect(f!.trend).toBe('worsening');
  });

  // -------------------------------------------------------------------------
  // Rule 11 — NBA band
  // -------------------------------------------------------------------------

  test('nbaBand names the axis furthest outside its ideal band', () => {
    // Release angle 30° (band 45–55): far below. entry 44 (in band). Only
    // release should be flagged, and pose data lifts severity to 2.
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 10; i++) {
      shots.push(
        shot({ outcome: i % 2 === 0 ? 'make' : 'miss', release: 30, entry: 44, metrics: { kneeFlexionDeg: 115 } }),
      );
    }
    const f = findingById(runCoach([session(1, T0, shots)]), 'nbaBand');
    expect(f).toBeDefined();
    expect(f!.title).toContain('Arc'); // releaseAngle axis label
    expect(f!.severity).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Rule 12 — improving celebration
  // -------------------------------------------------------------------------

  test('improving celebrates a clear FG% climb across the window', () => {
    // 3 sessions oldest→newest FG 20% then 70%. Recent half beats older half.
    const s1 = session(
      1,
      T0,
      [...Array(1).fill(0).map(() => shot({ outcome: 'make' })), ...Array(4).fill(0).map(() => shot({ outcome: 'miss' }))],
    );
    const s2 = session(
      2,
      T0 + DAY,
      [...Array(3).fill(0).map(() => shot({ outcome: 'make' })), ...Array(2).fill(0).map(() => shot({ outcome: 'miss' }))],
    );
    const s3 = session(
      3,
      T0 + 2 * DAY,
      [...Array(4).fill(0).map(() => shot({ outcome: 'make' })), ...Array(1).fill(0).map(() => shot({ outcome: 'miss' }))],
    );
    const f = findingById(runCoach([s1, s2, s3]), 'improving');
    expect(f).toBeDefined();
    expect(f!.trend).toBe('improving');
  });

  // -------------------------------------------------------------------------
  // Runner ranking
  // -------------------------------------------------------------------------

  test('runCoach ranks by severity then strength', () => {
    // A flat entry (sev 3) must outrank an unsure-rate note (sev 1).
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 6; i++) {
      shots.push(shot({ outcome: 'make', entry: 32 }), shot({ outcome: 'miss', entry: 32 }));
    }
    for (let i = 0; i < 4; i++) shots.push(shot({ outcome: 'unsure' }));
    const fs = runCoach([session(1, T0, shots)]);
    expect(fs.length).toBeGreaterThanOrEqual(2);
    expect(fs[0]!.severity).toBe(3);
    // Descending severity throughout.
    for (let i = 1; i < fs.length; i++) {
      expect(fs[i]!.severity).toBeLessThanOrEqual(fs[i - 1]!.severity);
    }
  });
});
