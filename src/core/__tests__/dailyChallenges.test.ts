import {
  CHALLENGE_POOL,
  DAILY_CHALLENGE_COUNT,
  challengeGoalTarget,
  dateKeyFor,
  dayAggregate,
  emptyDayAggregate,
  isChallengeComplete,
  isSameLocalDay,
  pickDailyChallenges,
  progressFor,
  type ChallengeDef,
  type DayAggregate,
} from '../dailyChallenges';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Epoch ms for a local Y/M/D H:M, so tests are stable regardless of TZ. */
function localMs(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m, d, h, min).getTime();
}

/** DayAggregate with overrides — everything else zero. */
function agg(overrides: Partial<DayAggregate> = {}): DayAggregate {
  return { ...emptyDayAggregate(), ...overrides };
}

/** First pool def of a given goal kind (the pool covers every kind). */
function defOfKind(kind: ChallengeDef['goal']['kind']): ChallengeDef {
  const def = CHALLENGE_POOL.find((c) => c.goal.kind === kind);
  if (!def) throw new Error(`pool is missing kind ${kind}`);
  return def;
}

// ---------------------------------------------------------------------------
// Pool sanity
// ---------------------------------------------------------------------------

describe('CHALLENGE_POOL', () => {
  it('has ~12 defs with unique ids', () => {
    expect(CHALLENGE_POOL.length).toBeGreaterThanOrEqual(12);
    const ids = CHALLENGE_POOL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every def has positive points and a positive goal target', () => {
    for (const c of CHALLENGE_POOL) {
      expect(c.points).toBeGreaterThan(0);
      expect(challengeGoalTarget(c.goal)).toBeGreaterThan(0);
    }
  });

  it('covers every goal kind', () => {
    const kinds = new Set(CHALLENGE_POOL.map((c) => c.goal.kind));
    expect([...kinds].sort()).toEqual(
      ['attempts', 'fgPct', 'makes', 'modes', 'streak', 'threes'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Deterministic daily draw
// ---------------------------------------------------------------------------

describe('pickDailyChallenges', () => {
  it('returns the default count of picks, all from the pool, no duplicates', () => {
    const picks = pickDailyChallenges('2026-07-07');
    expect(picks).toHaveLength(DAILY_CHALLENGE_COUNT);
    const ids = picks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of picks) expect(CHALLENGE_POOL).toContain(c);
  });

  it('is deterministic: the same day yields the same picks in the same order', () => {
    for (const key of ['2026-07-07', '2026-01-01', '2030-12-31', '2026-02-29']) {
      const a = pickDailyChallenges(key).map((c) => c.id);
      const b = pickDailyChallenges(key).map((c) => c.id);
      expect(a).toEqual(b);
    }
  });

  it('varies across days: a month of draws produces several distinct sets', () => {
    const sets = new Set<string>();
    for (let day = 1; day <= 30; day++) {
      const key = `2026-06-${String(day).padStart(2, '0')}`;
      sets.add(
        pickDailyChallenges(key)
          .map((c) => c.id)
          .sort()
          .join('|'),
      );
    }
    expect(sets.size).toBeGreaterThanOrEqual(5);
  });

  it('adjacent days do not serve the identical set', () => {
    const monday = pickDailyChallenges('2026-07-06').map((c) => c.id);
    const tuesday = pickDailyChallenges('2026-07-07').map((c) => c.id);
    expect(monday).not.toEqual(tuesday);
  });

  it('never repeats a goal kind within one day (pool has enough kinds)', () => {
    for (let day = 1; day <= 28; day++) {
      const key = `2026-03-${String(day).padStart(2, '0')}`;
      const kinds = pickDailyChallenges(key).map((c) => c.goal.kind);
      expect(new Set(kinds).size).toBe(kinds.length);
    }
  });

  it('honors a custom n', () => {
    expect(pickDailyChallenges('2026-07-07', 5)).toHaveLength(5);
    expect(pickDailyChallenges('2026-07-07', 1)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe('dateKeyFor', () => {
  it('formats the local day as YYYY-MM-DD with zero padding', () => {
    expect(dateKeyFor(localMs(2026, 0, 5))).toBe('2026-01-05');
    expect(dateKeyFor(localMs(2026, 11, 31, 23, 59))).toBe('2026-12-31');
  });
});

describe('isSameLocalDay', () => {
  const noon = localMs(2026, 6, 3, 12, 0);

  it('matches instants across the same local day', () => {
    expect(isSameLocalDay(localMs(2026, 6, 3, 0, 0), noon)).toBe(true);
    expect(isSameLocalDay(localMs(2026, 6, 3, 23, 59), noon)).toBe(true);
  });

  it('rejects just before and just after midnight', () => {
    expect(isSameLocalDay(localMs(2026, 6, 2, 23, 59), noon)).toBe(false);
    expect(isSameLocalDay(localMs(2026, 6, 4, 0, 1), noon)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Day aggregate
// ---------------------------------------------------------------------------

describe('dayAggregate', () => {
  it('returns all zeros for an empty day', () => {
    expect(dayAggregate([])).toEqual(emptyDayAggregate());
  });

  it('counts makes, attempts, threes and decided-only FG%', () => {
    const day = dayAggregate([
      {
        modeId: null,
        shots: [
          { outcome: 'make', shotValue: 3 },
          { outcome: 'make', shotValue: 2 },
          { outcome: 'miss' },
          { outcome: 'unsure' },
          { outcome: 'make', shotValue: 3 },
        ],
      },
    ]);
    expect(day.makes).toBe(3);
    expect(day.attempts).toBe(5);
    expect(day.threes).toBe(2);
    // 3 makes over 4 decided — the unsure shot is excluded from FG%.
    expect(day.fgPct).toBeCloseTo(0.75);
  });

  it('does not count a missed three or a value-less make as a three', () => {
    const day = dayAggregate([
      { modeId: null, shots: [{ outcome: 'miss', shotValue: 3 }, { outcome: 'make' }] },
    ]);
    expect(day.threes).toBe(0);
  });

  it('walks the best streak per session: misses reset, unsure is skipped', () => {
    const day = dayAggregate([
      {
        modeId: null,
        shots: [
          { outcome: 'make' },
          { outcome: 'unsure' },
          { outcome: 'make' },
          { outcome: 'make' },
          { outcome: 'miss' },
          { outcome: 'make' },
        ],
      },
    ]);
    expect(day.bestStreak).toBe(3);
  });

  it('never spans a streak across sessions', () => {
    const day = dayAggregate([
      { modeId: null, shots: [{ outcome: 'miss' }, { outcome: 'make' }, { outcome: 'make' }] },
      { modeId: null, shots: [{ outcome: 'make' }, { outcome: 'make' }, { outcome: 'miss' }] },
    ]);
    expect(day.bestStreak).toBe(2);
  });

  it('counts DISTINCT non-null mode ids', () => {
    const day = dayAggregate([
      { modeId: 'timed', shots: [] },
      { modeId: 'timed', shots: [] },
      { modeId: 'horse', shots: [] },
      { modeId: null, shots: [] },
    ]);
    expect(day.modesPlayed).toBe(2);
  });

  it("excludes Free Play — 'free' must not auto-complete the game-mode challenge", () => {
    // A day of ordinary open runs is NOT "played a game mode" (matching the
    // lifetimeTotals modesPlayed exclusion in src/data/db.ts).
    const freeOnly = dayAggregate([
      { modeId: 'free', shots: [{ outcome: 'make' }] },
      { modeId: 'free', shots: [] },
      { modeId: null, shots: [] },
    ]);
    expect(freeOnly.modesPlayed).toBe(0);

    // Real modes still count alongside free sessions.
    const mixed = dayAggregate([
      { modeId: 'free', shots: [] },
      { modeId: 'timed', shots: [] },
    ]);
    expect(mixed.modesPlayed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Progress math, per goal kind
// ---------------------------------------------------------------------------

describe('progressFor', () => {
  it('makes: counts day makes, clamped at the target', () => {
    const c = defOfKind('makes');
    const target = challengeGoalTarget(c.goal);
    expect(progressFor(c, agg({ makes: 0 }))).toBe(0);
    expect(progressFor(c, agg({ makes: target - 1 }))).toBe(target - 1);
    expect(progressFor(c, agg({ makes: target + 20 }))).toBe(target);
  });

  it('attempts: counts day attempts, clamped at the target', () => {
    const c = defOfKind('attempts');
    const target = challengeGoalTarget(c.goal);
    expect(progressFor(c, agg({ attempts: 7 }))).toBe(7);
    expect(progressFor(c, agg({ attempts: target + 5 }))).toBe(target);
  });

  it('threes: counts day threes, clamped at the target', () => {
    const c = defOfKind('threes');
    const target = challengeGoalTarget(c.goal);
    expect(progressFor(c, agg({ threes: 1 }))).toBe(1);
    expect(progressFor(c, agg({ threes: target }))).toBe(target);
    expect(isChallengeComplete(c, agg({ threes: target }))).toBe(true);
  });

  it('streak: uses the day best streak, clamped at the target', () => {
    const c = defOfKind('streak');
    const target = challengeGoalTarget(c.goal);
    expect(progressFor(c, agg({ bestStreak: target - 2 }))).toBe(target - 2);
    expect(progressFor(c, agg({ bestStreak: target + 3 }))).toBe(target);
  });

  it('modes: counts distinct modes played, clamped at the target', () => {
    const c = defOfKind('modes');
    const target = challengeGoalTarget(c.goal);
    expect(progressFor(c, agg({ modesPlayed: 0 }))).toBe(0);
    expect(progressFor(c, agg({ modesPlayed: target + 1 }))).toBe(target);
    expect(isChallengeComplete(c, agg({ modesPlayed: target }))).toBe(true);
  });

  it('clamps a defensively-negative aggregate value to 0', () => {
    const c = defOfKind('makes');
    expect(progressFor(c, agg({ makes: -3 }))).toBe(0);
  });

  describe('fgPct (50%+ over 10 attempts)', () => {
    const c = CHALLENGE_POOL.find((d) => d.id === 'fgpct-50-10')!;

    it('meters early attempts 1:1 while the percentage holds', () => {
      // 4/4 shooting: progress = attempts so far.
      expect(progressFor(c, agg({ attempts: 4, fgPct: 1 }))).toBe(4);
    });

    it('stays short of the goal below the attempt floor even at 100% FG', () => {
      expect(progressFor(c, agg({ attempts: 9, fgPct: 1 }))).toBe(9);
      expect(isChallengeComplete(c, agg({ attempts: 9, fgPct: 1 }))).toBe(false);
    });

    it('scales by the FG% shortfall once volume is there', () => {
      // 20 attempts at 40% toward a 50% bar: 10 × (0.4/0.5) = 8.
      expect(progressFor(c, agg({ attempts: 20, fgPct: 0.4 }))).toBe(8);
    });

    it('completes exactly when both the floor and the percentage are met', () => {
      expect(progressFor(c, agg({ attempts: 10, fgPct: 0.5 }))).toBe(10);
      expect(isChallengeComplete(c, agg({ attempts: 10, fgPct: 0.5 }))).toBe(true);
      expect(isChallengeComplete(c, agg({ attempts: 25, fgPct: 0.72 }))).toBe(true);
    });

    it('shows zero progress on an 0% day', () => {
      expect(progressFor(c, agg({ attempts: 12, fgPct: 0 }))).toBe(0);
    });
  });
});
