import {
  WEEKLY_CHALLENGE_COUNT,
  WEEKLY_CHALLENGE_POOL,
  emptyWeekAggregate,
  evaluateWeekly,
  isSameIsoWeek,
  isoWeekKey,
  pickWeeklyChallenges,
  prevWeekStartMs,
  weekAggregate,
  weekEndMs,
  weekStartMs,
  weeklyChallenges,
  weeklyGoalTarget,
  weeklyPoints,
  weeklyProgress,
  type WeekAggregate,
  type WeeklyChallengeDef,
  type WeeklyChallengeGoal,
} from '../weeklyChallenges';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Epoch ms for a local Y/M/D H:M, so tests are stable regardless of TZ. */
function localMs(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

/** WeekAggregate with overrides — everything else zero/null. */
function agg(overrides: Partial<WeekAggregate> = {}): WeekAggregate {
  return { ...emptyWeekAggregate(), ...overrides };
}

/** First pool def of a given goal kind (the pool covers every kind). */
function defOfKind(kind: WeeklyChallengeGoal['kind']): WeeklyChallengeDef {
  const def = WEEKLY_CHALLENGE_POOL.find((c) => c.goal.kind === kind);
  if (!def) throw new Error(`weekly pool is missing kind ${kind}`);
  return def;
}

const ALL_KINDS: WeeklyChallengeGoal['kind'][] = [
  'makes',
  'attempts',
  'sessions',
  'practiceDays',
  'spots',
  'longRange',
  'fgPct',
  'beatLastWeek',
];

// ---------------------------------------------------------------------------
// Pool sanity
// ---------------------------------------------------------------------------

describe('WEEKLY_CHALLENGE_POOL', () => {
  it('has at least 12 defs with unique, weekly-namespaced ids', () => {
    expect(WEEKLY_CHALLENGE_POOL.length).toBeGreaterThanOrEqual(12);
    const ids = WEEKLY_CHALLENGE_POOL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 'w-' prefix keeps weekly ids from colliding with daily ids in a ledger.
    for (const id of ids) expect(id.startsWith('w-')).toBe(true);
  });

  it('every def has positive points and a positive goal target', () => {
    for (const c of WEEKLY_CHALLENGE_POOL) {
      expect(c.points).toBeGreaterThan(0);
      expect(weeklyGoalTarget(c.goal)).toBeGreaterThan(0);
    }
  });

  it('covers every goal kind', () => {
    const kinds = new Set(WEEKLY_CHALLENGE_POOL.map((c) => c.goal.kind));
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort());
  });

  it('is week-sized: counting goals ask for more than a single day of work', () => {
    for (const c of WEEKLY_CHALLENGE_POOL) {
      // The biggest daily counting goal is 50 attempts / 40 makes; weekly
      // goals must clear that so the card is not finishable in one session.
      if (c.goal.kind === 'makes' || c.goal.kind === 'attempts') {
        expect(c.goal.target).toBeGreaterThan(50);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// ISO-8601 week keys
// ---------------------------------------------------------------------------

describe('isoWeekKey', () => {
  /**
   * Expectations verified against GNU coreutils `date -d <date> +%G-W%V`,
   * which implements ISO-8601 week numbering.
   */
  const CASES: [y: number, m: number, d: number, key: string, note: string][] = [
    [2026, 8, 17, '2026-W34', 'Monday, mid-year'],
    [2026, 8, 23, '2026-W34', 'Sunday closes the same week'],
    [2026, 8, 24, '2026-W35', 'next Monday starts a new week'],
    // Year boundaries: a week belongs to the year of its Thursday.
    [2026, 1, 1, '2026-W01', 'Thursday Jan 1 is in W01 of its own year'],
    [2025, 12, 29, '2026-W01', 'Monday in December already belongs to 2026'],
    [2023, 1, 1, '2022-W52', 'Sunday Jan 1 still belongs to the old year'],
    [2021, 1, 1, '2020-W53', 'Friday Jan 1 belongs to 2020'],
    [2021, 1, 3, '2020-W53', 'Sunday Jan 3 closes 2020-W53'],
    [2021, 1, 4, '2021-W01', 'Monday Jan 4 opens 2021-W01'],
    [2019, 12, 30, '2020-W01', 'Monday Dec 30 opens 2020-W01'],
    [2018, 12, 31, '2019-W01', 'Monday Dec 31 opens 2019-W01'],
    [2024, 12, 30, '2025-W01', 'Monday Dec 30 opens 2025-W01'],
    [2028, 1, 1, '2027-W52', 'Saturday Jan 1 belongs to 2027-W52'],
    [2028, 1, 3, '2028-W01', 'Monday Jan 3 opens 2028-W01'],
    [2029, 12, 31, '2030-W01', 'Monday Dec 31 opens 2030-W01'],
    // 53-week years: 2020, 2026 have a W53; 2027 tops out at W52.
    [2020, 12, 31, '2020-W53', '2020 is a 53-week year'],
    [2015, 12, 28, '2015-W53', '2015 is a 53-week year'],
    [2016, 1, 3, '2015-W53', 'Sunday Jan 3 closes 2015-W53'],
    [2026, 12, 28, '2026-W53', '2026 is a 53-week year'],
    [2026, 12, 31, '2026-W53', 'Thursday Dec 31 sits in W53'],
    [2027, 1, 1, '2026-W53', 'Friday Jan 1 still in 2026-W53'],
    [2027, 1, 3, '2026-W53', 'Sunday Jan 3 closes 2026-W53'],
    [2027, 1, 4, '2027-W01', 'Monday Jan 4 opens 2027-W01'],
    [2027, 12, 31, '2027-W52', '2027 has no W53'],
  ];

  it.each(CASES)('%p-%p-%p -> %s (%s)', (y, m, d, key) => {
    expect(isoWeekKey(localMs(y, m, d))).toBe(key);
  });

  it('is zero-padded and shaped YYYY-Www', () => {
    for (const [y, m, d] of CASES) {
      expect(isoWeekKey(localMs(y, m, d))).toMatch(/^\d{4}-W\d{2}$/);
    }
    expect(isoWeekKey(localMs(2026, 1, 1))).toContain('W01');
  });

  it('is constant across every hour of a day and every day of a week', () => {
    // Monday 2026-08-17 .. Sunday 2026-08-23 all key to 2026-W34.
    for (let day = 17; day <= 23; day++) {
      for (const hour of [0, 1, 12, 23]) {
        expect(isoWeekKey(localMs(2026, 8, day, hour, hour === 23 ? 59 : 0))).toBe('2026-W34');
      }
    }
  });

  it('walks a whole year without skipping or repeating a week number', () => {
    // Every Monday of ISO-2026 in order: W01..W53, no gaps.
    const keys: string[] = [];
    let t = localMs(2025, 12, 29); // Monday of 2026-W01
    for (let i = 0; i < 53; i++) {
      keys.push(isoWeekKey(t));
      const d = new Date(t);
      t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7, 12).getTime();
    }
    expect(keys[0]).toBe('2026-W01');
    expect(keys[52]).toBe('2026-W53');
    expect(new Set(keys).size).toBe(53);
    // The week after 2026-W53 rolls into 2027-W01.
    expect(isoWeekKey(t)).toBe('2027-W01');
  });
});

// ---------------------------------------------------------------------------
// Week windows
// ---------------------------------------------------------------------------

describe('weekStartMs / weekEndMs / prevWeekStartMs', () => {
  const SAMPLES = [
    localMs(2026, 8, 18, 9, 30), // Tuesday
    localMs(2026, 8, 17, 0, 0), // Monday midnight (the boundary itself)
    localMs(2026, 8, 23, 23, 59), // Sunday night
    localMs(2027, 1, 1, 12, 0), // year boundary, belongs to 2026-W53
    localMs(2023, 1, 1, 12, 0), // Sunday Jan 1, belongs to 2022-W52
    localMs(2020, 3, 15, 12, 0), // inside a DST-transition week (US)
    localMs(2020, 10, 25, 12, 0), // inside a DST-transition week (EU)
  ];

  it('starts on local Monday midnight', () => {
    for (const t of SAMPLES) {
      const start = new Date(weekStartMs(t));
      expect(start.getDay()).toBe(1); // Monday
      expect([start.getHours(), start.getMinutes(), start.getSeconds(), start.getMilliseconds()])
        .toEqual([0, 0, 0, 0]);
    }
  });

  it('contains the instant it was derived from: start <= now < end', () => {
    for (const t of SAMPLES) {
      expect(weekStartMs(t)).toBeLessThanOrEqual(t);
      expect(weekEndMs(t)).toBeGreaterThan(t);
    }
  });

  it('spans exactly seven local days (DST-safe)', () => {
    for (const t of SAMPLES) {
      const days = Math.round((weekEndMs(t) - weekStartMs(t)) / MS_PER_DAY);
      expect(days).toBe(7);
      expect(new Date(weekEndMs(t)).getDay()).toBe(1);
    }
  });

  it('is stable for every day of the same week and tiles with the next one', () => {
    const monday = localMs(2026, 8, 17, 6);
    for (let day = 17; day <= 23; day++) {
      expect(weekStartMs(localMs(2026, 8, day, 21))).toBe(weekStartMs(monday));
    }
    // The next week starts exactly where this one ends — no gap, no overlap.
    expect(weekStartMs(weekEndMs(monday))).toBe(weekEndMs(monday));
  });

  it('handles the year boundary: 2027-01-01 lives in the week starting 2026-12-28', () => {
    expect(weekStartMs(localMs(2027, 1, 1))).toBe(localMs(2026, 12, 28, 0, 0));
    expect(weekEndMs(localMs(2027, 1, 1))).toBe(localMs(2027, 1, 4, 0, 0));
  });

  it('prevWeekStartMs is the Monday exactly one week earlier', () => {
    for (const t of SAMPLES) {
      const prev = prevWeekStartMs(t);
      expect(new Date(prev).getDay()).toBe(1);
      expect(Math.round((weekStartMs(t) - prev) / MS_PER_DAY)).toBe(7);
      // The previous window ends where the current one starts.
      expect(weekEndMs(prev)).toBe(weekStartMs(t));
      expect(isoWeekKey(prev)).not.toBe(isoWeekKey(t));
    }
  });

  it('isSameIsoWeek splits on the Monday boundary, not on 7-day distance', () => {
    const sunday = localMs(2026, 8, 23, 23, 0);
    const monday = localMs(2026, 8, 24, 1, 0);
    expect(isSameIsoWeek(sunday, monday)).toBe(false);
    expect(isSameIsoWeek(localMs(2026, 8, 17, 0), sunday)).toBe(true);
    expect(isSameIsoWeek(localMs(2027, 1, 1), localMs(2026, 12, 28))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic weekly draw
// ---------------------------------------------------------------------------

describe('weeklyChallenges', () => {
  it('returns the default count, all from the pool, no repeats in a week', () => {
    const picks = weeklyChallenges(localMs(2026, 8, 18));
    expect(picks).toHaveLength(WEEKLY_CHALLENGE_COUNT);
    const ids = picks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of picks) expect(WEEKLY_CHALLENGE_POOL).toContain(c);
  });

  it('prefers distinct goal kinds so one week never doubles up', () => {
    for (let week = 0; week < 52; week++) {
      const picks = weeklyChallenges(localMs(2026, 1, 5) + week * 7 * MS_PER_DAY);
      const kinds = picks.map((c) => c.goal.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it('is deterministic: repeated calls and any instant in the week agree', () => {
    const expected = weeklyChallenges(localMs(2026, 8, 17, 0, 0)).map((c) => c.id);
    expect(weeklyChallenges(localMs(2026, 8, 17, 0, 0)).map((c) => c.id)).toEqual(expected);
    for (let day = 17; day <= 23; day++) {
      for (const hour of [0, 8, 23]) {
        expect(weeklyChallenges(localMs(2026, 8, day, hour)).map((c) => c.id)).toEqual(expected);
      }
    }
  });

  it('keys off the ISO week, so a new-year Friday keeps the old week set', () => {
    // 2027-01-01 is still 2026-W53 — the set must not change mid-week.
    expect(weeklyChallenges(localMs(2027, 1, 1)).map((c) => c.id)).toEqual(
      weeklyChallenges(localMs(2026, 12, 28)).map((c) => c.id),
    );
  });

  it('varies week over week', () => {
    const combos: string[] = [];
    for (let week = 0; week < 52; week++) {
      combos.push(
        weeklyChallenges(localMs(2026, 1, 5) + week * 7 * MS_PER_DAY)
          .map((c) => c.id)
          .join('|'),
      );
    }
    // Not a constant set, and most consecutive weeks bring something new.
    expect(new Set(combos).size).toBeGreaterThanOrEqual(20);
    let changed = 0;
    for (let i = 1; i < combos.length; i++) if (combos[i] !== combos[i - 1]) changed++;
    expect(changed).toBeGreaterThanOrEqual(combos.length - 6);
  });

  it('pickWeeklyChallenges honours a custom count and degrades gracefully', () => {
    expect(pickWeeklyChallenges('2026-W34', 1)).toHaveLength(1);
    expect(pickWeeklyChallenges('2026-W34', 0)).toHaveLength(0);
    // Asking for more than there are kinds falls back to shuffle order and
    // still never repeats a def.
    const many = pickWeeklyChallenges('2026-W34', WEEKLY_CHALLENGE_POOL.length);
    expect(many).toHaveLength(WEEKLY_CHALLENGE_POOL.length);
    expect(new Set(many.map((c) => c.id)).size).toBe(WEEKLY_CHALLENGE_POOL.length);
  });
});

// ---------------------------------------------------------------------------
// Week aggregate fold
// ---------------------------------------------------------------------------

describe('weekAggregate', () => {
  const monday = localMs(2026, 8, 17, 10);
  const tuesday = localMs(2026, 8, 18, 10);

  it('is all zeros with a null FG% for an empty week', () => {
    expect(weekAggregate([])).toEqual({
      makes: 0,
      attempts: 0,
      sessions: 0,
      practiceDays: 0,
      distinctSpots: 0,
      longRangeMakes: 0,
      fgPct: null,
      prevWeekFgPct: null,
    });
  });

  it('counts makes, attempts, sessions, days, spots and long range', () => {
    const a = weekAggregate([
      {
        startedAt: monday,
        shots: [
          { outcome: 'make', shotValue: 3, spotKey: 'left:far' },
          { outcome: 'miss', shotValue: 3, spotKey: 'left:far' },
          { outcome: 'make', shotValue: 2, spotKey: 'center:mid' },
        ],
      },
      {
        startedAt: localMs(2026, 8, 17, 19), // same day, second session
        shots: [{ outcome: 'make', shotValue: 3, spotKey: 'right:far' }],
      },
      {
        startedAt: tuesday,
        shots: [{ outcome: 'unsure', shotValue: 2, spotKey: 'center:near' }],
      },
    ]);
    expect(a.makes).toBe(3);
    expect(a.attempts).toBe(5);
    expect(a.sessions).toBe(3);
    expect(a.practiceDays).toBe(2);
    expect(a.distinctSpots).toBe(4);
    expect(a.longRangeMakes).toBe(2);
    // 'unsure' is an attempt but never a decided shot: 3 makes / 4 decided.
    expect(a.fgPct).toBeCloseTo(0.75, 10);
  });

  it('ignores sessions with no tracked shots (opened is not practised)', () => {
    const a = weekAggregate([
      { startedAt: monday, shots: [] },
      { startedAt: tuesday, shots: [{ outcome: 'make' }] },
    ]);
    expect(a.sessions).toBe(1);
    expect(a.practiceDays).toBe(1);
  });

  it('marks unavailable inputs as unmeasured rather than zero', () => {
    const sessions = [{ startedAt: monday, shots: [{ outcome: 'make' as const }] }];
    const a = weekAggregate(sessions, { spotsMeasured: false, longRangeMeasured: false });
    expect(a.distinctSpots).toBeUndefined();
    expect(a.longRangeMakes).toBeUndefined();
    // Measured-but-empty stays 0, which is a different claim.
    const b = weekAggregate(sessions);
    expect(b.distinctSpots).toBe(0);
    expect(b.longRangeMakes).toBe(0);
  });

  it('passes the previous week baseline through untouched', () => {
    expect(weekAggregate([], { prevWeekFgPct: 0.42 }).prevWeekFgPct).toBe(0.42);
    expect(weekAggregate([]).prevWeekFgPct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Progress + evaluation
// ---------------------------------------------------------------------------

describe('evaluateWeekly', () => {
  it('evaluates every goal kind from zero to done', () => {
    const full: WeekAggregate = {
      makes: 1000,
      attempts: 2000,
      sessions: 20,
      practiceDays: 7,
      distinctSpots: 9,
      longRangeMakes: 300,
      fgPct: 0.9,
      prevWeekFgPct: 0.1,
    };
    for (const kind of ALL_KINDS) {
      const def = defOfKind(kind);
      const target = weeklyGoalTarget(def.goal);

      const [empty] = evaluateWeekly([def], agg());
      expect(empty!.target).toBe(target);
      expect(empty!.progress).toBe(0);
      expect(empty!.done).toBe(false);

      const [done] = evaluateWeekly([def], full);
      expect(done!.progress).toBe(target);
      expect(done!.done).toBe(true);
    }
  });

  it('clamps progress to 0..target for absurd aggregates', () => {
    const huge: WeekAggregate = {
      makes: 1e9,
      attempts: 1e9,
      sessions: 1e6,
      practiceDays: 999,
      distinctSpots: 999,
      longRangeMakes: 1e6,
      fgPct: 5, // impossible, but must not overflow the bar
      prevWeekFgPct: 0.01,
    };
    for (const def of WEEKLY_CHALLENGE_POOL) {
      const target = weeklyGoalTarget(def.goal);
      const p = weeklyProgress(def, huge);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(target);
    }
    // Negative/NaN inputs cannot push the bar below zero or produce NaN.
    const broken = agg({ makes: -5, attempts: -5, sessions: -1, fgPct: Number.NaN });
    for (const def of WEEKLY_CHALLENGE_POOL) {
      const p = weeklyProgress(def, broken);
      expect(Number.isFinite(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it('lands `done` exactly on the target boundary', () => {
    const def = defOfKind('makes'); // 150 makes
    const target = weeklyGoalTarget(def.goal);
    const at = (makes: number) => evaluateWeekly([def], agg({ makes }))[0]!;
    expect(at(target - 1).done).toBe(false);
    expect(at(target - 1).progress).toBe(target - 1);
    expect(at(target).done).toBe(true);
    expect(at(target + 50).progress).toBe(target);
    expect(at(target + 50).done).toBe(true);
  });

  it('meters fgPct in qualifying attempts: volume AND percentage must land', () => {
    const def = WEEKLY_CHALLENGE_POOL.find((c) => c.id === 'w-fgpct-45-100')!;
    const at = (attempts: number, fgPct: number) =>
      evaluateWeekly([def], agg({ attempts, fgPct }))[0]!;

    // Percentage met, volume short: capped by attempts.
    expect(at(20, 0.9).progress).toBe(20);
    expect(at(20, 0.9).done).toBe(false);
    // Volume met, half the percentage: half the bar.
    expect(at(100, 0.225).progress).toBe(50);
    expect(at(100, 0.225).done).toBe(false);
    // Both met.
    expect(at(100, 0.45).progress).toBe(100);
    expect(at(100, 0.45).done).toBe(true);
    // Cold week, plenty of volume: bar reflects the percentage shortfall.
    expect(at(400, 0.0).progress).toBe(0);
  });

  it('beatLastWeek needs a strict improvement, and says so with no baseline', () => {
    const def = defOfKind('beatLastWeek'); // 60-attempt floor
    const target = weeklyGoalTarget(def.goal);
    const at = (attempts: number, fgPct: number, prevWeekFgPct: number | null) =>
      evaluateWeekly([def], agg({ attempts, fgPct, prevWeekFgPct }))[0]!;

    // Strictly better across the floor: done.
    expect(at(60, 0.5, 0.4).progress).toBe(target);
    expect(at(60, 0.5, 0.4).done).toBe(true);
    // Matching last week is not beating it — held one shy of full.
    expect(at(60, 0.4, 0.4).progress).toBe(target - 1);
    expect(at(60, 0.4, 0.4).done).toBe(false);
    // Worse than last week: partial bar, never done. 0.3/0.4 is the classic
    // IEEE-754 trap (0.7499999999999999) — the readout must still be 45/60.
    expect(at(60, 0.3, 0.4).progress).toBe(45);
    expect(at(60, 0.3, 0.4).done).toBe(false);
    // Better but short of the attempt floor.
    expect(at(20, 0.9, 0.4).progress).toBe(20);
    expect(at(20, 0.9, 0.4).done).toBe(false);
    // Last week scored nothing: any made shot beats it.
    expect(at(60, 0.2, 0).done).toBe(true);
    expect(at(60, 0, 0).done).toBe(false);
    // No baseline at all: honest zero plus a note, never a silent stall.
    const none = at(200, 0.9, null);
    expect(none.progress).toBe(0);
    expect(none.done).toBe(false);
    expect(none.note).toMatch(/previous week/i);
  });

  it('notes unmeasured inputs instead of pretending the goal is just unstarted', () => {
    const spots = evaluateWeekly([defOfKind('spots')], agg({ distinctSpots: undefined }))[0]!;
    expect(spots.progress).toBe(0);
    expect(spots.note).toMatch(/court position/i);

    const deep = evaluateWeekly([defOfKind('longRange')], agg({ longRangeMakes: undefined }))[0]!;
    expect(deep.progress).toBe(0);
    expect(deep.note).toMatch(/point-value estimate/i);

    // Measured inputs carry no note, even at zero progress.
    expect(evaluateWeekly([defOfKind('spots')], agg())[0]!.note).toBeUndefined();
    expect(evaluateWeekly([defOfKind('longRange')], agg())[0]!.note).toBeUndefined();
    expect(evaluateWeekly([defOfKind('makes')], agg())[0]!.note).toBeUndefined();
  });

  it('falls back to makes/attempts when FG% was not supplied', () => {
    const def = WEEKLY_CHALLENGE_POOL.find((c) => c.id === 'w-fgpct-45-100')!;
    // No fgPct field: 45 of 100 attempts still reads as 45%.
    const r = evaluateWeekly([def], agg({ makes: 45, attempts: 100, fgPct: null }))[0]!;
    expect(r.progress).toBe(100);
    expect(r.done).toBe(true);
  });

  it('keeps `done` in lockstep with the bar for every pool def and aggregate', () => {
    const samples: WeekAggregate[] = [
      agg(),
      agg({ makes: 40, attempts: 90, sessions: 2, practiceDays: 2, distinctSpots: 3 }),
      agg({ makes: 310, attempts: 620, sessions: 6, practiceDays: 6, distinctSpots: 9 }),
      agg({ makes: 100, attempts: 200, fgPct: 0.5, prevWeekFgPct: 0.49, longRangeMakes: 60 }),
    ];
    for (const def of WEEKLY_CHALLENGE_POOL) {
      for (const sample of samples) {
        const [r] = evaluateWeekly([def], sample);
        expect(r!.done).toBe(r!.progress >= r!.target);
      }
    }
  });

  it('preserves def order and returns one result per def', () => {
    const defs = weeklyChallenges(localMs(2026, 8, 18));
    const results = evaluateWeekly(defs, agg());
    expect(results.map((r) => r.def.id)).toEqual(defs.map((d) => d.id));
  });
});

// ---------------------------------------------------------------------------
// Points
// ---------------------------------------------------------------------------

describe('weeklyPoints', () => {
  it('is zero for an untouched week', () => {
    const defs = weeklyChallenges(localMs(2026, 8, 18));
    expect(weeklyPoints(evaluateWeekly(defs, agg()))).toBe(0);
  });

  it('sums only the completed challenges', () => {
    const defs = weeklyChallenges(localMs(2026, 8, 18));
    const monster: WeekAggregate = {
      makes: 5000,
      attempts: 6000,
      sessions: 30,
      practiceDays: 7,
      distinctSpots: 9,
      longRangeMakes: 500,
      fgPct: 0.95,
      prevWeekFgPct: 0.1,
    };
    const all = evaluateWeekly(defs, monster);
    expect(all.every((r) => r.done)).toBe(true);
    expect(weeklyPoints(all)).toBe(defs.reduce((s, d) => s + d.points, 0));

    // A mixed week only banks what actually finished.
    const mixed = all.map((r, i) => (i === 0 ? { ...r, done: false } : r));
    expect(weeklyPoints(mixed)).toBe(
      defs.slice(1).reduce((s, d) => s + d.points, 0),
    );
  });
});
