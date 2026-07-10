/**
 * Coach insights tests — 4-week timeline (order, empty weeks, DST-safe week
 * walk, arithmetic), form-readiness levels, the 28-day season comparison,
 * and the detected-entry-angle arc profile.
 */
import { arcQuality } from '../../components/hud/arcHudGeometry';
import {
  arcProfile,
  coachTimeline,
  formReadiness,
  seasonComparison,
} from '../coachInsights';
import { weekEnd, weekLabel, weekShootingScore, weekStart } from '../weeklyReport';
import { applyShot, emptyStats } from '../stats';
import type { CoachSession } from '../coachEngine';
import type { FormMetrics, ResolvedShot, SessionStats } from '../types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let nextId = 1;
function mkShot(
  outcome: 'make' | 'miss' | 'unsure',
  extra: Partial<ResolvedShot> = {},
): ResolvedShot {
  return {
    id: nextId++,
    tStart: 0,
    tResolved: 1,
    outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: null,
    releasePoint: null,
    originX: null,
    originY: null,
    trajectory: [],
    ...extra,
  };
}

function mkMetrics(overrides: Partial<FormMetrics> = {}): FormMetrics {
  return {
    setPointElbowDeg: null,
    kneeFlexionDeg: null,
    releaseAngleDeg: null,
    entryAngleDeg: null,
    releaseTimeMs: null,
    followThroughHeldMs: null,
    followThroughElbowDeg: null,
    releaseHeightNorm: null,
    ...overrides,
  };
}

function statsFor(shots: readonly ResolvedShot[]): SessionStats {
  let st = emptyStats();
  for (const s of shots) st = applyShot(st, s);
  return st;
}

function mkSession(id: number, startedAt: number, shots: ResolvedShot[]): CoachSession {
  return { id, startedAt, shots, stats: statsFor(shots) };
}

function makesAndMisses(makes: number, misses: number): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (let i = 0; i < makes; i++) out.push(mkShot('make'));
  for (let i = 0; i < misses; i++) out.push(mkShot('miss'));
  return out;
}

const DAY = 24 * 60 * 60 * 1000;
// Wed Jul 8 2026, 15:00 local — anchor week is Mon Jul 6 – Sun Jul 12.
const ANCHOR = new Date(2026, 6, 8, 15, 0, 0).getTime();

// ---------------------------------------------------------------------------

describe('coachInsights — coachTimeline', () => {
  test('returns 4 consecutive Monday-aligned weeks oldest-first, ending at the anchor week', () => {
    const t = coachTimeline([], ANCHOR);
    expect(t).toHaveLength(4);
    expect(t[3]!.weekStartMs).toBe(weekStart(ANCHOR));
    for (const w of t) {
      const d = new Date(w.weekStartMs);
      expect(d.getDay()).toBe(1); // Monday
      expect(d.getHours()).toBe(0);
      expect(w.label).toBe(weekLabel(w.weekStartMs));
    }
    // Strictly increasing (oldest-first), each exactly one week apart via
    // weekStart of the prior week (DST-safe walk).
    for (let i = 1; i < t.length; i++) {
      expect(t[i]!.weekStartMs).toBeGreaterThan(t[i - 1]!.weekStartMs);
      expect(weekStart(t[i]!.weekStartMs - 1)).toBe(t[i - 1]!.weekStartMs);
    }
  });

  test('empty middle weeks appear with zeros and null fgPct', () => {
    const anchorStart = weekStart(ANCHOR);
    const oldestStart = weekStart(anchorStart - 3 * 7 * DAY + DAY); // 3 weeks back
    const sessions = [
      mkSession(1, oldestStart + DAY, makesAndMisses(5, 5)),
      mkSession(2, anchorStart + DAY, makesAndMisses(7, 3)),
    ];
    const t = coachTimeline(sessions, ANCHOR);
    expect(t).toHaveLength(4);
    expect(t[0]!.sessions).toBe(1);
    expect(t[3]!.sessions).toBe(1);
    for (const w of [t[1]!, t[2]!]) {
      expect(w.sessions).toBe(0);
      expect(w.attempts).toBe(0);
      expect(w.makes).toBe(0);
      expect(w.fgPct).toBeNull();
      expect(w.wss).toBe(0);
    }
  });

  test('Sunday and Monday anchors within the same week produce the same week set', () => {
    const mon = new Date(2026, 6, 6, 8, 0, 0).getTime(); // Mon Jul 6
    const sun = new Date(2026, 6, 12, 20, 0, 0).getTime(); // Sun Jul 12
    const fromMon = coachTimeline([], mon).map((w) => w.weekStartMs);
    const fromSun = coachTimeline([], sun).map((w) => w.weekStartMs);
    expect(fromSun).toEqual(fromMon);
  });

  test('attempts, makes and fgPct match a hand-computed fixture; unsure counts attempts only', () => {
    const anchorStart = weekStart(ANCHOR);
    // 6/10 + 9/10 decided, plus 2 unsure: attempts 22, makes 15, decided 20.
    const a = mkSession(1, anchorStart + DAY, makesAndMisses(6, 4));
    const b = mkSession(2, anchorStart + 2 * DAY, [
      ...makesAndMisses(9, 1),
      mkShot('unsure'),
      mkShot('unsure'),
    ]);
    const t = coachTimeline([a, b], ANCHOR);
    const w = t[3]!;
    expect(w.sessions).toBe(2);
    expect(w.attempts).toBe(22);
    expect(w.makes).toBe(15);
    expect(w.fgPct).toBeCloseTo(15 / 20, 5);
    expect(w.wss).toBe(weekShootingScore([a, b]));
  });
});

describe('coachInsights — formReadiness', () => {
  test('form present but no pose metric is "off" (ball-flight metrics do not count)', () => {
    const shots = Array.from({ length: 10 }, () =>
      mkShot('make', {
        form: {
          metrics: mkMetrics({ releaseAngleDeg: 48, entryAngleDeg: 42 }),
          tips: [],
        },
      }),
    );
    const r = formReadiness(shots);
    expect(r.total).toBe(10);
    expect(r.withBallFlight).toBe(10);
    expect(r.withPose).toBe(0);
    expect(r.posePct).toBe(0);
    expect(r.level).toBe('off');
  });

  test('3 pose shots of 10 is "sparse" at posePct 0.3', () => {
    const shots = [
      ...Array.from({ length: 3 }, () =>
        mkShot('make', {
          form: { metrics: mkMetrics({ setPointElbowDeg: 85 }), tips: [] },
        }),
      ),
      ...Array.from({ length: 7 }, () => mkShot('miss')),
    ];
    const r = formReadiness(shots);
    expect(r.total).toBe(10);
    expect(r.withBallFlight).toBe(3);
    expect(r.withPose).toBe(3);
    expect(r.posePct).toBeCloseTo(0.3, 5);
    expect(r.level).toBe('sparse');
  });

  test('6 pose shots of 10 is "ready"', () => {
    const shots = [
      ...Array.from({ length: 6 }, () =>
        mkShot('make', {
          form: { metrics: mkMetrics({ followThroughHeldMs: 320 }), tips: [] },
        }),
      ),
      ...Array.from({ length: 4 }, () => mkShot('miss')),
    ];
    const r = formReadiness(shots);
    expect(r.posePct).toBeCloseTo(0.6, 5);
    expect(r.level).toBe('ready');
  });

  test('empty array is total 0, "off"', () => {
    const r = formReadiness([]);
    expect(r.total).toBe(0);
    expect(r.withBallFlight).toBe(0);
    expect(r.withPose).toBe(0);
    expect(r.posePct).toBe(0);
    expect(r.level).toBe('off');
  });
});

describe('coachInsights — seasonComparison', () => {
  test('buckets sessions into recent / prior / neither and signs the deltas', () => {
    const end = weekEnd(ANCHOR);
    const recent = mkSession(1, end - 1 * DAY, makesAndMisses(5, 5)); // 50%
    const prior = mkSession(2, end - 30 * DAY, makesAndMisses(7, 3)); // 70%
    const ancient = mkSession(3, end - 60 * DAY, makesAndMisses(9, 1)); // ignored
    const c = seasonComparison([recent, prior, ancient], ANCHOR);
    expect(c.recent.sessions).toBe(1);
    expect(c.recent.attempts).toBe(10);
    expect(c.recent.makes).toBe(5);
    expect(c.recent.fgPct).toBeCloseTo(0.5, 5);
    expect(c.prior.sessions).toBe(1);
    expect(c.prior.makes).toBe(7);
    expect(c.prior.fgPct).toBeCloseTo(0.7, 5);
    // Recent is worse: delta must come out negative.
    expect(c.fgDeltaPts).toBeCloseTo(-20, 5);
    expect(c.attemptsDelta).toBe(0);
    expect(c.sessionsDelta).toBe(0);
  });

  test('window edges: exactly end−28d is recent, exactly end is excluded', () => {
    const end = weekEnd(ANCHOR);
    const onEdge = mkSession(1, end - 28 * DAY, makesAndMisses(2, 2));
    const atEnd = mkSession(2, end, makesAndMisses(3, 1));
    const c = seasonComparison([onEdge, atEnd], ANCHOR);
    expect(c.recent.sessions).toBe(1);
    expect(c.recent.attempts).toBe(4);
    expect(c.prior.sessions).toBe(0);
  });

  test('fgDeltaPts is null when the prior block has no decided shots; count deltas still signed', () => {
    const end = weekEnd(ANCHOR);
    const recent = mkSession(1, end - 2 * DAY, makesAndMisses(6, 4));
    const priorUnsure = mkSession(2, end - 35 * DAY, [
      mkShot('unsure'),
      mkShot('unsure'),
    ]);
    const c = seasonComparison([recent, priorUnsure], ANCHOR);
    expect(c.prior.fgPct).toBeNull();
    expect(c.fgDeltaPts).toBeNull();
    expect(c.attemptsDelta).toBe(8); // 10 − 2
    expect(c.sessionsDelta).toBe(0);
  });

  test('empty input yields empty blocks and zero deltas', () => {
    const c = seasonComparison([], ANCHOR);
    expect(c.recent).toEqual({ sessions: 0, attempts: 0, makes: 0, fgPct: null });
    expect(c.prior).toEqual({ sessions: 0, attempts: 0, makes: 0, fgPct: null });
    expect(c.fgDeltaPts).toBeNull();
    expect(c.attemptsDelta).toBe(0);
    expect(c.sessionsDelta).toBe(0);
  });
});

describe('coachInsights — arcProfile', () => {
  const EMPTY = {
    n: 0,
    avgEntryDeg: null,
    idealPct: null,
    flatPct: null,
    steepPct: null,
  };

  test('empty input yields n 0 and all-null aggregates', () => {
    expect(arcProfile([])).toEqual(EMPTY);
  });

  test('shots without a detected entry angle contribute nothing', () => {
    expect(
      arcProfile([{ entryAngleDeg: null }, { entryAngleDeg: null }]),
    ).toEqual(EMPTY);
  });

  test('mixed angles: nulls and non-finite values excluded, average and split hand-computed', () => {
    const p = arcProfile([
      { entryAngleDeg: 38 }, // flat
      { entryAngleDeg: 45 }, // ideal
      { entryAngleDeg: 50 }, // ideal
      { entryAngleDeg: 61 }, // steep
      { entryAngleDeg: null }, // excluded
      { entryAngleDeg: Number.NaN }, // excluded (defensive: bad persisted data)
    ]);
    expect(p.n).toBe(4);
    expect(p.avgEntryDeg).toBeCloseTo((38 + 45 + 50 + 61) / 4, 5);
    expect(p.flatPct).toBeCloseTo(1 / 4, 5);
    expect(p.idealPct).toBeCloseTo(2 / 4, 5);
    expect(p.steepPct).toBeCloseTo(1 / 4, 5);
  });

  test('band edges 43 and 52 are ideal (inclusive); just outside grades flat / steep', () => {
    const edges = arcProfile([{ entryAngleDeg: 43 }, { entryAngleDeg: 52 }]);
    expect(edges.n).toBe(2);
    expect(edges.idealPct).toBe(1);
    expect(edges.flatPct).toBe(0);
    expect(edges.steepPct).toBe(0);

    const outside = arcProfile([{ entryAngleDeg: 42.9 }, { entryAngleDeg: 52.1 }]);
    expect(outside.idealPct).toBe(0);
    expect(outside.flatPct).toBeCloseTo(0.5, 5);
    expect(outside.steepPct).toBeCloseTo(0.5, 5);
  });

  test('grading agrees with the HUD arcQuality band for every category', () => {
    for (const deg of [30, 42.99, 43, 47.5, 52, 52.01, 70]) {
      const p = arcProfile([{ entryAngleDeg: deg }]);
      const q = arcQuality(deg);
      expect(p.flatPct).toBe(q === 'flat' ? 1 : 0);
      expect(p.idealPct).toBe(q === 'ideal' ? 1 : 0);
      expect(p.steepPct).toBe(q === 'steep' ? 1 : 0);
    }
  });

  test('accepts ResolvedShot directly (structural param)', () => {
    const p = arcProfile([mkShot('make', { entryAngleDeg: 45 }), mkShot('miss')]);
    expect(p.n).toBe(1);
    expect(p.avgEntryDeg).toBe(45);
    expect(p.idealPct).toBe(1);
  });
});
