/**
 * Lifetime achievements — pure badge logic (src/core/achievements.ts).
 */
import {
  ACHIEVEMENTS,
  emptyTotals,
  evaluate,
  type AchievementDef,
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
    expect(ACHIEVEMENTS.length).toBeGreaterThanOrEqual(14);
    const ids = ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACHIEVEMENTS) {
      expect(a.emoji.length).toBeGreaterThan(0);
      expect(a.name.length).toBeGreaterThan(0);
      expect(a.blurb.length).toBeGreaterThan(0);
    }
  });

  it('keeps progress within 0..1 for zero, mid and huge totals', () => {
    const samples: LifetimeTotals[] = [
      emptyTotals(),
      totals({ sessions: 7, attempts: 333, makes: 180, bestStreak: 8, bestSessionFgPct: 0.55, threes: 22 }),
      totals({ sessions: 9999, attempts: 1e6, makes: 1e6, bestStreak: 500, bestSessionFgPct: 1, threes: 1e5 }),
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

  it('make-count tiers unlock at 50 / 100 / 500', () => {
    expect(byId('getting-warm').check(totals({ makes: 49 }))).toBe(false);
    expect(byId('getting-warm').check(totals({ makes: 50 }))).toBe(true);
    expect(byId('century').check(totals({ makes: 99 }))).toBe(false);
    expect(byId('century').check(totals({ makes: 100 }))).toBe(true);
    expect(byId('bucket-machine').check(totals({ makes: 499 }))).toBe(false);
    expect(byId('bucket-machine').check(totals({ makes: 500 }))).toBe(true);
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

  it('three-point tiers unlock at 10 / 50 threes', () => {
    expect(byId('deep-threat').check(totals({ threes: 9 }))).toBe(false);
    expect(byId('deep-threat').check(totals({ threes: 10 }))).toBe(true);
    expect(byId('downtown').check(totals({ threes: 50 }))).toBe(true);
  });

  it('session tiers unlock at 10 / 25 sessions', () => {
    expect(byId('marathon').check(totals({ sessions: 9 }))).toBe(false);
    expect(byId('marathon').check(totals({ sessions: 10 }))).toBe(true);
    expect(byId('grinder').check(totals({ sessions: 25 }))).toBe(true);
  });

  it('volume tiers unlock at 500 / 1000 attempts', () => {
    expect(byId('volume-shooter').check(totals({ attempts: 500 }))).toBe(true);
    expect(byId('relentless').check(totals({ attempts: 999 }))).toBe(false);
    expect(byId('relentless').check(totals({ attempts: 1000 }))).toBe(true);
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
