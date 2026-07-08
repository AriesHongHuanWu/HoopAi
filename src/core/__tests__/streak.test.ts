/**
 * Day-streak tests. All times are built from a fixed local-noon anchor so the
 * local-midnight bucketing is unambiguous regardless of the runner's timezone.
 */
import { computeDayStreak, streakStanding, STREAK_TIERS } from '../streak';

const DAY = 86_400_000;
/** A fixed "today" at local noon (avoids midnight/DST edge ambiguity in tests). */
const TODAY_NOON = (() => {
  const d = new Date(2026, 5, 15, 12, 0, 0, 0); // 2026-06-15 12:00 local
  return d.getTime();
})();

/** `n` days before TODAY_NOON, at local noon. */
function daysAgo(n: number): number {
  return TODAY_NOON - n * DAY;
}

describe('computeDayStreak', () => {
  test('no sessions → zero streak', () => {
    expect(computeDayStreak([], TODAY_NOON)).toEqual({
      current: 0,
      longest: 0,
      shotToday: false,
    });
  });

  test('shot today only → 1-day streak', () => {
    const r = computeDayStreak([daysAgo(0)], TODAY_NOON);
    expect(r.current).toBe(1);
    expect(r.longest).toBe(1);
    expect(r.shotToday).toBe(true);
  });

  test('three consecutive days ending today → streak 3', () => {
    const r = computeDayStreak([daysAgo(2), daysAgo(1), daysAgo(0)], TODAY_NOON);
    expect(r.current).toBe(3);
    expect(r.longest).toBe(3);
    expect(r.shotToday).toBe(true);
  });

  test('multiple sessions on the same day count once', () => {
    const r = computeDayStreak(
      [daysAgo(0), daysAgo(0) - 3 * 3_600_000, daysAgo(1)],
      TODAY_NOON,
    );
    expect(r.current).toBe(2);
  });

  test('streak stays live when today is empty but yesterday was shot', () => {
    const r = computeDayStreak([daysAgo(2), daysAgo(1)], TODAY_NOON);
    expect(r.shotToday).toBe(false);
    expect(r.current).toBe(2); // not broken yet — extendable today
  });

  test('a full missed day breaks the streak', () => {
    // Shot 2 and 3 days ago, nothing yesterday or today → broken.
    const r = computeDayStreak([daysAgo(3), daysAgo(2)], TODAY_NOON);
    expect(r.current).toBe(0);
    expect(r.longest).toBe(2);
  });

  test('longest run is independent of the current streak', () => {
    // A 4-day run last week, then a gap, then shot today.
    const r = computeDayStreak(
      [daysAgo(10), daysAgo(9), daysAgo(8), daysAgo(7), daysAgo(0)],
      TODAY_NOON,
    );
    expect(r.current).toBe(1);
    expect(r.longest).toBe(4);
  });

  test('unordered input is handled', () => {
    const r = computeDayStreak([daysAgo(0), daysAgo(2), daysAgo(1)], TODAY_NOON);
    expect(r.current).toBe(3);
    expect(r.longest).toBe(3);
  });
});

describe('streakStanding', () => {
  test('below the first tier: no medal, chasing Spark', () => {
    const s = streakStanding(0);
    expect(s.tier).toBeNull();
    expect(s.next?.label).toBe('Spark');
    expect(s.daysToNext).toBe(3);
    expect(s.progressToNext).toBe(0);
  });

  test('exactly on a tier holds it and chases the next', () => {
    const s = streakStanding(7);
    expect(s.tier?.label).toBe('Bronze');
    expect(s.next?.label).toBe('Silver');
    expect(s.daysToNext).toBe(7); // 14 - 7
  });

  test('mid-way between tiers reports fractional progress', () => {
    // current 5: floor Spark(3), next Bronze(7), span 4, (5-3)/4 = 0.5
    const s = streakStanding(5);
    expect(s.tier?.label).toBe('Spark');
    expect(s.next?.label).toBe('Bronze');
    expect(s.daysToNext).toBe(2);
    expect(s.progressToNext).toBeCloseTo(0.5, 6);
  });

  test('at or past the top tier: maxed, no next', () => {
    for (const current of [100, 250]) {
      const s = streakStanding(current);
      expect(s.tier?.label).toBe('Legend');
      expect(s.next).toBeNull();
      expect(s.daysToNext).toBe(0);
      expect(s.progressToNext).toBe(1);
    }
  });

  test('tiers are strictly ascending', () => {
    for (let i = 1; i < STREAK_TIERS.length; i++) {
      expect(STREAK_TIERS[i]!.at).toBeGreaterThan(STREAK_TIERS[i - 1]!.at);
    }
  });
});
