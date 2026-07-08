/**
 * Weekly report tests — week-boundary math, WSS blend, and the assembled
 * report (headline, delta vs prior week, best session, hottest zone, focus).
 */
import {
  buildWeeklyReport,
  sessionsInWeek,
  weekEnd,
  weekLabel,
  weekShootingScore,
  weekStart,
} from '../weeklyReport';
import { emptyStats, applyShot } from '../stats';
import type { CoachSession } from '../coachEngine';
import type { ResolvedShot, SessionStats } from '../types';

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let nextId = 1;
function shot(opts: {
  outcome: 'make' | 'miss' | 'unsure';
  originX?: number | null;
  release?: number | null;
  value?: 2 | 3;
}): ResolvedShot {
  const s: ResolvedShot = {
    id: nextId++,
    tStart: 0,
    tResolved: 1,
    outcome: opts.outcome,
    signals: { geo: null, net: null, cls: null },
    rimBounce: false,
    xCross: null,
    entryAngleDeg: null,
    releaseAngleDeg: opts.release ?? null,
    releasePoint: null,
    originX: opts.originX ?? null,
    originY: null,
    trajectory: [],
  };
  if (opts.value != null) s.shotValue = opts.value;
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

function makesAndMisses(makes: number, misses: number, extra: Partial<Parameters<typeof shot>[0]> = {}): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (let i = 0; i < makes; i++) out.push(shot({ outcome: 'make', ...extra }));
  for (let i = 0; i < misses; i++) out.push(shot({ outcome: 'miss', ...extra }));
  return out;
}

const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------

describe('weeklyReport — week boundaries', () => {
  test('weekStart snaps to Monday 00:00 local; weekEnd is the next Monday', () => {
    // Wed Jul 8 2026, 15:30 local.
    const wed = new Date(2026, 6, 8, 15, 30, 0).getTime();
    const start = new Date(weekStart(wed));
    expect(start.getDay()).toBe(1); // Monday
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    // The Monday of that week is Jul 6.
    expect(start.getDate()).toBe(6);
    expect(weekEnd(wed) - weekStart(wed)).toBe(7 * DAY);
  });

  test('Sunday belongs to the week that started the previous Monday', () => {
    const sun = new Date(2026, 6, 12, 20, 0, 0).getTime(); // Sun Jul 12
    expect(new Date(weekStart(sun)).getDate()).toBe(6); // Mon Jul 6
  });

  test('weekLabel reads as a Mon–Sun range', () => {
    const wed = new Date(2026, 6, 8, 12, 0, 0).getTime();
    expect(weekLabel(wed)).toBe('Jul 6 – 12');
  });

  test('sessionsInWeek includes the target week and excludes neighbours', () => {
    const monThis = new Date(2026, 6, 6, 12, 0, 0).getTime();
    const priorWeek = monThis - 3 * DAY; // Fri before
    const nextWeek = monThis + 8 * DAY; // next-next Tuesday
    const all = [
      session(1, priorWeek, makesAndMisses(3, 2)),
      session(2, monThis, makesAndMisses(4, 1)),
      session(3, nextWeek, makesAndMisses(2, 2)),
    ];
    const inWeek = sessionsInWeek(all, monThis);
    expect(inWeek.map((s) => s.id)).toEqual([2]);
  });
});

describe('weeklyReport — WSS', () => {
  test('empty week scores 0', () => {
    expect(weekShootingScore([])).toBe(0);
  });

  test('WSS rewards accuracy, volume and consistency and stays in 0..100', () => {
    const t = new Date(2026, 6, 6, 12, 0, 0).getTime();
    // Strong week: 70% FG on 150 shots (accuracy + volume maxed).
    const strong = session(1, t, makesAndMisses(105, 45, { release: 50 }));
    const weak = session(2, t, makesAndMisses(3, 12)); // 20% FG, low volume
    const sStrong = weekShootingScore([strong]);
    const sWeak = weekShootingScore([weak]);
    expect(sStrong).toBeGreaterThan(sWeak);
    expect(sStrong).toBeLessThanOrEqual(100);
    expect(sWeak).toBeGreaterThanOrEqual(0);
  });
});

describe('weeklyReport — buildWeeklyReport', () => {
  const mon = new Date(2026, 6, 6, 12, 0, 0).getTime(); // Mon Jul 6

  test('empty week yields a graceful shell', () => {
    const r = buildWeeklyReport([], mon);
    expect(r.sessions).toBe(0);
    expect(r.fgPct).toBeNull();
    expect(r.headline).toBe('No sessions logged this week.');
    expect(r.findings).toEqual([]);
    expect(r.wss).toBe(0);
  });

  test('assembles headline, best session, hottest zone and week totals', () => {
    const early = session(1, mon + 1 * DAY, makesAndMisses(6, 4, { originX: 0.1 }), 'Morning run'); // 60%, left
    const later = session(2, mon + 2 * DAY, makesAndMisses(9, 1, { originX: 0.5 }), 'Evening'); // 90%, center
    const r = buildWeeklyReport([early, later], mon);
    expect(r.sessions).toBe(2);
    expect(r.makes).toBe(15);
    expect(r.attempts).toBe(20);
    expect(r.fgPct).toBeCloseTo(15 / 20, 5);
    expect(r.headline).toBe('15 makes at 75% across 2 sessions.');
    // Best session is the 90% one.
    expect(r.bestSession?.id).toBe(2);
    // Hottest zone: center (90%) beats left (60%).
    expect(r.hottestZone?.zone).toBe('center');
  });

  test('fgDeltaPtsVsPrior compares against the previous week', () => {
    const priorMon = mon - 7 * DAY;
    const prior = session(1, priorMon + DAY, makesAndMisses(5, 5)); // 50%
    const thisWk = session(2, mon + DAY, makesAndMisses(7, 3)); // 70%
    const r = buildWeeklyReport([prior, thisWk], mon);
    expect(r.fgDeltaPtsVsPrior).toBeCloseTo(20, 5);
  });

  test('nextWeekFocus surfaces the top real problem when one exists', () => {
    // A flat-entry week (severity-3 finding) should drive the focus line.
    const shots: ResolvedShot[] = [];
    for (let i = 0; i < 6; i++) {
      shots.push(
        { ...shot({ outcome: 'make' }), entryAngleDeg: 32 },
        { ...shot({ outcome: 'miss' }), entryAngleDeg: 32 },
      );
    }
    const r = buildWeeklyReport([session(1, mon + DAY, shots)], mon);
    expect(r.findings[0]?.id).toBe('entryAngleLow');
    expect(r.nextWeekFocus).toBe(r.findings[0]!.title);
  });

  test('best streak is captured and does not span sessions', () => {
    // Session A ends on a 3-make run; session B opens with a 2-make run. The
    // week best streak must be 3, not 5.
    const a = session(1, mon + DAY, [
      shot({ outcome: 'miss' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
    ]);
    const b = session(2, mon + 2 * DAY, [
      shot({ outcome: 'make' }),
      shot({ outcome: 'make' }),
      shot({ outcome: 'miss' }),
    ]);
    const r = buildWeeklyReport([a, b], mon);
    expect(r.bestStreak).toBe(3);
  });
});
