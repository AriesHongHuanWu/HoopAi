/**
 * Lifetime achievements — pure badge logic (src/core/achievements.ts).
 */
import {
  ACHIEVEMENTS,
  detectNewBests,
  emptyTotals,
  evaluate,
  isEarlyBirdHour,
  isNightOwlHour,
  maxSessionsInWeek,
  PB_MIN_MAKES,
  PB_MIN_STREAK,
  type AchievementDef,
  type CareerBests,
  type LifetimeTotals,
} from '../achievements';

function totals(partial: Partial<LifetimeTotals>): LifetimeTotals {
  return { ...emptyTotals(), ...partial };
}

function byId(id: string): AchievementDef {
  const def = ACHIEVEMENTS.find((a) => a.id === id);
  if (!def) throw new Error(`unknown achievement id: ${id}`);
  return def;
}

describe('ACHIEVEMENTS board', () => {
  it('has a real board of unique, fully-described badges', () => {
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(25);
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.emoji.length).toBeGreaterThan(0);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.blurb.length).toBeGreaterThan(0);
      expect(a.icon.length).toBeGreaterThan(0);
      expect(['bronze', 'silver', 'gold']).toContain(a.tier);
    }
  });

  it('still carries every pre-expansion badge id (no retroactive loss)', () => {
    const legacyIds = [
      'first-bucket', 'getting-warm', 'century', 'bucket-machine',
      'heat-check', 'flamethrower', 'cold-blooded',
      'sharpshooter', 'pure',
      'deep-threat', 'downtown',
      'marathon', 'grinder',
      'volume-shooter', 'relentless',
    ];
    const ids = new Set(ACHIEVEMENTS.map((a) => a.id));
    for (const id of legacyIds) expect(ids).toContain(id);
  });

  it('keeps progress within 0..1 for zero, mid and huge totals', () => {
    const samples: LifetimeTotals[] = [
      emptyTotals(),
      totals({ sessions: 7, attempts: 333, makes: 180, bestStreak: 8, bestSessionFgPct: 0.55, threes: 22, correctedCalls: 12, bestWeekSessions: 3 }),
      totals({
        sessions: 9999, attempts: 1e6, makes: 1e6, bestStreak: 500,
        bestSessionFgPct: 1, threes: 1e5, correctedCalls: 1e4,
        nightSessions: 400, dawnSessions: 400, bestWeekSessions: 30,
        atwWins: 50, horseGames: 50, modesPlayed: 6,
      }),
    ];
    for (const t of samples) {
      for (const a of ACHIEVEMENTS) {
        const p = a.progress(t);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('reports full progress exactly when a badge is unlocked', () => {
    const t = totals({
      sessions: 25,
      attempts: 600,
      makes: 120,
      bestStreak: 10,
      bestSessionFgPct: 0.52,
      threes: 12,
      correctedCalls: 3,
      nightSessions: 1,
      bestWeekSessions: 4,
    });
    for (const a of ACHIEVEMENTS) {
      if (a.check(t)) expect(a.progress(t)).toBe(1);
      else expect(a.progress(t)).toBeLessThan(1);
    }
  });
});

describe('individual thresholds', () => {
  it('first bucket unlocks on the very first make', () => {
    const a = byId('first-bucket');
    expect(a.check(emptyTotals())).toBe(false);
    expect(a.progress(emptyTotals())).toBe(0);
    expect(a.check(totals({ makes: 1 }))).toBe(true);
  });

  it('make-count tiers unlock at 50 / 100 / 500 / 1000', () => {
    expect(byId('getting-warm').check(totals({ makes: 49 }))).toBe(false);
    expect(byId('getting-warm').check(totals({ makes: 50 }))).toBe(true);
    expect(byId('century').check(totals({ makes: 99 }))).toBe(false);
    expect(byId('century').check(totals({ makes: 100 }))).toBe(true);
    expect(byId('bucket-machine').check(totals({ makes: 499 }))).toBe(false);
    expect(byId('bucket-machine').check(totals({ makes: 500 }))).toBe(true);
    expect(byId('millennium').check(totals({ makes: 999 }))).toBe(false);
    expect(byId('millennium').check(totals({ makes: 1000 }))).toBe(true);
  });

  it('streak tiers unlock at 5 / 10 / 20', () => {
    expect(byId('heat-check').check(totals({ bestStreak: 4 }))).toBe(false);
    expect(byId('heat-check').check(totals({ bestStreak: 5 }))).toBe(true);
    expect(byId('flamethrower').check(totals({ bestStreak: 9 }))).toBe(false);
    expect(byId('flamethrower').check(totals({ bestStreak: 10 }))).toBe(true);
    expect(byId('cold-blooded').check(totals({ bestStreak: 20 }))).toBe(true);
  });

  it('sharpshooter needs a 50%+ qualifying session', () => {
    const a = byId('sharpshooter');
    expect(a.check(totals({ bestSessionFgPct: 0.49 }))).toBe(false);
    expect(a.check(totals({ bestSessionFgPct: 0.5 }))).toBe(true);
    expect(a.progress(totals({ bestSessionFgPct: 0.25 }))).toBeCloseTo(0.5);
  });

  it('pure needs 65%+', () => {
    const a = byId('pure');
    expect(a.check(totals({ bestSessionFgPct: 0.64 }))).toBe(false);
    expect(a.check(totals({ bestSessionFgPct: 0.65 }))).toBe(true);
  });

  it('three-point tiers unlock at 10 / 50 / 100 threes', () => {
    expect(byId('deep-threat').check(totals({ threes: 9 }))).toBe(false);
    expect(byId('deep-threat').check(totals({ threes: 10 }))).toBe(true);
    expect(byId('downtown').check(totals({ threes: 50 }))).toBe(true);
    expect(byId('orbit').check(totals({ threes: 99 }))).toBe(false);
    expect(byId('orbit').check(totals({ threes: 100 }))).toBe(true);
  });

  it('session tiers unlock at 10 / 25 / 50 sessions', () => {
    expect(byId('marathon').check(totals({ sessions: 9 }))).toBe(false);
    expect(byId('marathon').check(totals({ sessions: 10 }))).toBe(true);
    expect(byId('grinder').check(totals({ sessions: 25 }))).toBe(true);
    expect(byId('fifty-club').check(totals({ sessions: 49 }))).toBe(false);
    expect(byId('fifty-club').check(totals({ sessions: 50 }))).toBe(true);
  });

  it('volume tiers unlock at 500 / 1000 / 2500 attempts', () => {
    expect(byId('volume-shooter').check(totals({ attempts: 500 }))).toBe(true);
    expect(byId('relentless').check(totals({ attempts: 999 }))).toBe(false);
    expect(byId('relentless').check(totals({ attempts: 1000 }))).toBe(true);
    expect(byId('gym-rat').check(totals({ attempts: 2499 }))).toBe(false);
    expect(byId('gym-rat').check(totals({ attempts: 2500 }))).toBe(true);
  });

  it('week warrior needs 5 sessions inside a rolling week', () => {
    expect(byId('week-warrior').check(totals({ bestWeekSessions: 4 }))).toBe(false);
    expect(byId('week-warrior').check(totals({ bestWeekSessions: 5 }))).toBe(true);
    expect(byId('week-warrior').progressLabel(totals({ bestWeekSessions: 3 }))).toBe('3/5');
  });

  it('night owl / early bird unlock on the first qualifying tip-off', () => {
    expect(byId('night-owl').check(emptyTotals())).toBe(false);
    expect(byId('night-owl').check(totals({ nightSessions: 1 }))).toBe(true);
    expect(byId('early-bird').check(emptyTotals())).toBe(false);
    expect(byId('early-bird').check(totals({ dawnSessions: 1 }))).toBe(true);
  });

  it('film judge unlocks at 50 corrected calls', () => {
    expect(byId('film-judge').check(totals({ correctedCalls: 49 }))).toBe(false);
    expect(byId('film-judge').check(totals({ correctedCalls: 50 }))).toBe(true);
  });

  it('game-mode badges unlock on wins / completions / variety', () => {
    expect(byId('globetrotter').check(emptyTotals())).toBe(false);
    expect(byId('globetrotter').check(totals({ atwWins: 1 }))).toBe(true);
    expect(byId('full-spell').check(emptyTotals())).toBe(false);
    expect(byId('full-spell').check(totals({ horseGames: 1 }))).toBe(true);
    expect(byId('mode-hopper').check(totals({ modesPlayed: 2 }))).toBe(false);
    expect(byId('mode-hopper').check(totals({ modesPlayed: 3 }))).toBe(true);
  });
});

describe('time-of-day + weekly-cadence helpers', () => {
  it('classifies night-owl hours as 22:00–03:59', () => {
    expect(isNightOwlHour(22)).toBe(true);
    expect(isNightOwlHour(23)).toBe(true);
    expect(isNightOwlHour(0)).toBe(true);
    expect(isNightOwlHour(3)).toBe(true);
    expect(isNightOwlHour(4)).toBe(false);
    expect(isNightOwlHour(21)).toBe(false);
    expect(isNightOwlHour(12)).toBe(false);
  });

  it('classifies early-bird hours as 04:00–07:59, disjoint from night', () => {
    expect(isEarlyBirdHour(4)).toBe(true);
    expect(isEarlyBirdHour(7)).toBe(true);
    expect(isEarlyBirdHour(8)).toBe(false);
    expect(isEarlyBirdHour(3)).toBe(false);
    for (let h = 0; h < 24; h++) {
      expect(isNightOwlHour(h) && isEarlyBirdHour(h)).toBe(false);
    }
  });

  it('maxSessionsInWeek finds the densest rolling 7-day window', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(maxSessionsInWeek([])).toBe(0);
    expect(maxSessionsInWeek([0])).toBe(1);
    // 5 sessions across 6 days → all inside one window.
    expect(maxSessionsInWeek([0, day, 2 * day, 4 * day, 6 * day])).toBe(5);
    // Exactly 7 days apart is OUTSIDE the window (half-open).
    expect(maxSessionsInWeek([0, 7 * day])).toBe(1);
    expect(maxSessionsInWeek([0, 7 * day - 1])).toBe(2);
    // Unsorted input with a dense cluster late in the list.
    const cluster = [30 * day, 0, 31 * day, 32 * day, 33 * day, 34 * day, 10 * day];
    expect(maxSessionsInWeek(cluster)).toBe(5);
    // Two-a-days count twice.
    expect(maxSessionsInWeek([0, 0, day, day, 2 * day])).toBe(5);
  });
});

describe('detectNewBests', () => {
  const before: CareerBests = { bestStreak: 6, bestFgPct: 0.5, mostMakes: 20 };

  function session(partial: Partial<{ attempts: number; makes: number; fgPct: number; bestStreak: number }>) {
    return { attempts: 0, makes: 0, fgPct: 0, bestStreak: 0, ...partial };
  }

  it('returns nothing when the session beats no career record', () => {
    expect(
      detectNewBests(session({ attempts: 20, makes: 10, fgPct: 0.5, bestStreak: 4 }), before),
    ).toEqual([]);
  });

  it('detects each record independently, in fixed makes → streak → FG% order', () => {
    const out = detectNewBests(
      session({ attempts: 40, makes: 25, fgPct: 0.7, bestStreak: 9 }),
      before,
    );
    expect(out).toEqual([
      { kind: 'mostMakes', value: 25 },
      { kind: 'bestStreak', value: 9 },
      { kind: 'bestFgPct', value: 0.7 },
    ]);
  });

  it('ties never fire — records must be strictly beaten', () => {
    expect(
      detectNewBests(session({ attempts: 40, makes: 20, fgPct: 0.5, bestStreak: 6 }), before),
    ).toEqual([]);
  });

  it('applies meaningful floors so trivial firsts stay quiet', () => {
    const zero: CareerBests = { bestStreak: 0, bestFgPct: 0, mostMakes: 0 };
    // 2/2 first session: below every floor.
    expect(
      detectNewBests(session({ attempts: 2, makes: 2, fgPct: 1, bestStreak: 2 }), zero),
    ).toEqual([]);
    // At the floors, it fires.
    expect(
      detectNewBests(
        session({ attempts: PB_MIN_MAKES, makes: PB_MIN_MAKES, fgPct: 1, bestStreak: PB_MIN_STREAK }),
        zero,
      ),
    ).toEqual([
      { kind: 'mostMakes', value: PB_MIN_MAKES },
      { kind: 'bestStreak', value: PB_MIN_STREAK },
    ]);
  });

  it('FG% record needs the qualifying attempt floor and a non-zero percentage', () => {
    const zero: CareerBests = { bestStreak: 99, bestFgPct: 0, mostMakes: 99 };
    // 9 attempts — one short of the Sharpshooter floor.
    expect(
      detectNewBests(session({ attempts: 9, makes: 8, fgPct: 0.89, bestStreak: 2 }), zero),
    ).toEqual([]);
    expect(
      detectNewBests(session({ attempts: 10, makes: 8, fgPct: 0.8, bestStreak: 2 }), zero),
    ).toEqual([{ kind: 'bestFgPct', value: 0.8 }]);
    // All-unsure 10-attempt session: fgPct 0 never beats a 0 baseline.
    expect(
      detectNewBests(session({ attempts: 10, makes: 0, fgPct: 0, bestStreak: 0 }), zero),
    ).toEqual([]);
  });
});

describe('progressLabel', () => {
  it('formats counting badges as current/target, capped at the target', () => {
    expect(byId('century').progressLabel(totals({ makes: 42 }))).toBe('42/100');
    expect(byId('century').progressLabel(totals({ makes: 250 }))).toBe('100/100');
    expect(byId('deep-threat').progressLabel(emptyTotals())).toBe('0/10');
  });

  it('formats FG badges as a best-percentage caption', () => {
    expect(byId('sharpshooter').progressLabel(totals({ bestSessionFgPct: 0.42 }))).toBe('42% best');
    expect(byId('sharpshooter').progressLabel(emptyTotals())).toBe('0% best');
  });
});

describe('evaluate', () => {
  it('locks everything for empty totals', () => {
    const { unlocked, locked } = evaluate(emptyTotals());
    expect(unlocked).toHaveLength(0);
    expect(locked).toHaveLength(ACHIEVEMENTS.length);
  });

  it('unlocks everything for maxed totals', () => {
    const t = totals({
      sessions: 100,
      attempts: 5000,
      makes: 2500,
      bestStreak: 30,
      bestSessionFgPct: 0.8,
      threes: 200,
      correctedCalls: 100,
      nightSessions: 5,
      dawnSessions: 5,
      bestWeekSessions: 7,
      atwWins: 3,
      horseGames: 2,
      modesPlayed: 6,
    });
    const { unlocked, locked } = evaluate(t);
    expect(locked).toHaveLength(0);
    expect(unlocked).toHaveLength(ACHIEVEMENTS.length);
  });

  it('partitions the board exactly, preserving order', () => {
    const t = totals({
      sessions: 12,
      attempts: 240,
      makes: 110,
      bestStreak: 6,
      bestSessionFgPct: 0.46,
      threes: 4,
    });
    const { unlocked, locked } = evaluate(t);
    expect(unlocked.length + locked.length).toBe(ACHIEVEMENTS.length);
    const overlap = unlocked.filter((a) => locked.includes(a));
    expect(overlap).toHaveLength(0);
    for (const a of unlocked) expect(a.check(t)).toBe(true);
    for (const a of locked) expect(a.check(t)).toBe(false);
    // Order within each list matches board order.
    const order = (list: AchievementDef[]) =>
      list.map((a) => ACHIEVEMENTS.indexOf(a));
    expect(order(unlocked)).toEqual([...order(unlocked)].sort((x, y) => x - y));
    expect(order(locked)).toEqual([...order(locked)].sort((x, y) => x - y));
  });
});
