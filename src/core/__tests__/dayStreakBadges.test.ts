import {
  DAY_STREAK_BADGES,
  dayStreakTier,
  earnedDayStreakBadges,
  newlyEarned,
  streakStatusLine,
} from '../dayStreakBadges';

describe('DAY_STREAK_BADGES ladder', () => {
  test('is strictly ascending by days', () => {
    const days = DAY_STREAK_BADGES.map((b) => b.days);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(new Set(days).size).toBe(days.length);
  });

  test('ids and names are unique and non-empty', () => {
    const ids = DAY_STREAK_BADGES.map((b) => b.id);
    const names = DAY_STREAK_BADGES.map((b) => b.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
    for (const b of DAY_STREAK_BADGES) {
      expect(b.id.length).toBeGreaterThan(0);
      expect(b.name.length).toBeGreaterThan(0);
      expect(b.blurb.length).toBeGreaterThan(0);
      expect(b.icon.length).toBeGreaterThan(0);
      expect(b.days).toBeGreaterThan(0);
    }
  });
});

describe('earnedDayStreakBadges', () => {
  test('nothing earned below the first rung', () => {
    const s = earnedDayStreakBadges(2, 2);
    expect(s.earned).toEqual([]);
    expect(s.next?.days).toBe(3);
    expect(s.daysToNext).toBe(1);
  });

  test('boundary: exactly on a rung earns it and points at the following one', () => {
    for (let i = 0; i < DAY_STREAK_BADGES.length; i++) {
      const b = DAY_STREAK_BADGES[i]!;
      const s = earnedDayStreakBadges(b.days, b.days);
      expect(s.earned.map((x) => x.days)).toEqual(
        DAY_STREAK_BADGES.slice(0, i + 1).map((x) => x.days),
      );
      const following = DAY_STREAK_BADGES[i + 1] ?? null;
      expect(s.next?.id ?? null).toBe(following?.id ?? null);
      expect(s.daysToNext).toBe(following ? following.days - b.days : null);
    }
  });

  test('one day short of a rung does not earn it', () => {
    const s = earnedDayStreakBadges(6, 6);
    expect(s.earned.map((b) => b.days)).toEqual([3]);
    expect(s.next?.days).toBe(7);
    expect(s.daysToNext).toBe(1);
  });

  test('between rungs: daysToNext counts down from the current streak', () => {
    const s = earnedDayStreakBadges(10, 10);
    expect(s.earned.map((b) => b.days)).toEqual([3, 7]);
    expect(s.next?.days).toBe(14);
    expect(s.daysToNext).toBe(4);
  });

  test('at and past the top rung there is no next', () => {
    const top = DAY_STREAK_BADGES[DAY_STREAK_BADGES.length - 1]!;
    for (const current of [top.days, top.days + 250]) {
      const s = earnedDayStreakBadges(current, current);
      expect(s.next).toBeNull();
      expect(s.daysToNext).toBeNull();
      expect(s.earned.length).toBe(DAY_STREAK_BADGES.length);
    }
  });

  test('a broken streak keeps every badge already earned (earned tracks BEST)', () => {
    const s = earnedDayStreakBadges(0, 30);
    expect(s.earned.map((b) => b.days)).toEqual([3, 7, 14, 30]);
    // ...but the chase restarts from the current streak.
    expect(s.next?.days).toBe(3);
    expect(s.daysToNext).toBe(3);
  });

  test('earned is monotonic in best: it never shrinks as best grows', () => {
    let prev = 0;
    for (let best = 0; best <= 120; best++) {
      const n = earnedDayStreakBadges(0, best).earned.length;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
    expect(prev).toBe(DAY_STREAK_BADGES.length);
  });

  test('a stale best below current never hides a badge the current streak proves', () => {
    const s = earnedDayStreakBadges(8, 0);
    expect(s.earned.map((b) => b.days)).toEqual([3, 7]);
  });

  test('zero, negative and NaN inputs are treated as no streak', () => {
    for (const [c, b] of [[0, 0], [-5, -9], [Number.NaN, Number.NaN]] as const) {
      const s = earnedDayStreakBadges(c, b);
      expect(s.earned).toEqual([]);
      expect(s.next?.days).toBe(3);
      expect(s.daysToNext).toBe(3);
    }
  });
});

describe('dayStreakTier', () => {
  test('null before the first rung', () => {
    expect(dayStreakTier(0)).toBeNull();
    expect(dayStreakTier(2)).toBeNull();
    expect(dayStreakTier(-4)).toBeNull();
  });

  test('returns the highest rung reached', () => {
    expect(dayStreakTier(3)?.id).toBe('day-streak-3');
    expect(dayStreakTier(6)?.id).toBe('day-streak-3');
    expect(dayStreakTier(7)?.id).toBe('day-streak-7');
    expect(dayStreakTier(29)?.id).toBe('day-streak-14');
    expect(dayStreakTier(100)?.id).toBe('day-streak-100');
    expect(dayStreakTier(999)?.id).toBe('day-streak-100');
  });

  test('agrees with the last entry of earnedDayStreakBadges', () => {
    for (const best of [0, 1, 3, 5, 7, 13, 14, 30, 59, 60, 100, 400]) {
      const { earned } = earnedDayStreakBadges(0, best);
      expect(dayStreakTier(best)?.id ?? null).toBe(
        earned.length ? earned[earned.length - 1]!.id : null,
      );
    }
  });
});

describe('streakStatusLine', () => {
  test('no streak, nothing logged today: states the fact and the one small step', () => {
    expect(streakStatusLine(0, false)).toBe(
      'No streak going — one session today starts one',
    );
  });

  test('no streak but today is logged (mismatched snapshots): stays truthful', () => {
    expect(streakStatusLine(0, true)).toBe(
      'Today is banked — that starts a new streak',
    );
  });

  test('live streak, not yet shot today: invites, never scolds', () => {
    expect(streakStatusLine(3, false)).toBe(
      '3-day streak — shoot today to keep it alive',
    );
  });

  test('live streak, already shot today', () => {
    expect(streakStatusLine(4, true)).toBe('4-day streak — today is banked');
    expect(streakStatusLine(1, true)).toBe('1-day streak — today is banked');
  });

  test('negative days fall back to the no-streak copy', () => {
    expect(streakStatusLine(-3, false)).toBe(
      'No streak going — one session today starts one',
    );
  });

  test('never guilt-trips', () => {
    const banned = /you failed|you lost|broke|blew it|shame|disappoint/i;
    for (const days of [0, 1, 5, 40]) {
      for (const today of [true, false]) {
        expect(streakStatusLine(days, today)).not.toMatch(banned);
      }
    }
  });
});

describe('newlyEarned', () => {
  test('returns only the rungs crossed by this update', () => {
    expect(newlyEarned(2, 3).map((b) => b.days)).toEqual([3]);
    expect(newlyEarned(6, 7).map((b) => b.days)).toEqual([7]);
  });

  test('can cross several rungs at once (e.g. a backfilled import)', () => {
    expect(newlyEarned(0, 30).map((b) => b.days)).toEqual([3, 7, 14, 30]);
  });

  test('does not re-fire a rung already celebrated', () => {
    expect(newlyEarned(7, 7)).toEqual([]);
    expect(newlyEarned(7, 10)).toEqual([]);
    expect(newlyEarned(30, 31)).toEqual([]);
  });

  test('a shrinking or equal best fires nothing', () => {
    expect(newlyEarned(30, 0)).toEqual([]);
    expect(newlyEarned(30, 30)).toEqual([]);
  });

  test('junk inputs fire nothing rather than a phantom celebration', () => {
    expect(newlyEarned(Number.NaN, Number.NaN)).toEqual([]);
    expect(newlyEarned(-5, -1)).toEqual([]);
  });

  test('replaying day by day fires each rung exactly once', () => {
    const fired: string[] = [];
    for (let d = 1; d <= 120; d++) {
      fired.push(...newlyEarned(d - 1, d).map((b) => b.id));
    }
    expect(fired).toEqual(DAY_STREAK_BADGES.map((b) => b.id));
  });

  test('every newly earned badge is also in earnedDayStreakBadges at the new best', () => {
    const { earned } = earnedDayStreakBadges(0, 14);
    const ids = new Set(earned.map((b) => b.id));
    for (const b of newlyEarned(3, 14)) expect(ids.has(b.id)).toBe(true);
  });
});
