import { seasonStats, seasonGoalProgress, SEASON_DAYS } from '../seasonStats';

const DAY = 86_400_000;
const NOW = new Date(2026, 6, 20, 12, 0, 0, 0).getTime();
function ago(days: number) {
  return NOW - days * DAY;
}

describe('seasonStats', () => {
  test('aggregates only the last 30 days', () => {
    const rows = [
      { startedAt: ago(2), makes: 30, attempts: 60 },
      { startedAt: ago(10), makes: 20, attempts: 50 },
      { startedAt: ago(40), makes: 99, attempts: 99 }, // outside the season
    ];
    const s = seasonStats(rows, NOW);
    expect(s.makes).toBe(50);
    expect(s.attempts).toBe(110);
    expect(s.sessions).toBe(2);
    expect(s.rate).toBeCloseTo(50 / 110, 6);
  });

  test('empty season is all zeros', () => {
    const s = seasonStats([], NOW);
    expect(s).toMatchObject({ makes: 0, attempts: 0, sessions: 0, rate: 0, bestDayStreak: 0, bestWeekSessions: 0 });
  });

  test('best day-streak counts consecutive days in the season', () => {
    const rows = [ago(0), ago(1), ago(2), ago(5)].map((t) => ({ startedAt: t, makes: 5, attempts: 10 }));
    expect(seasonStats(rows, NOW).bestDayStreak).toBe(3);
  });

  test('best week = most sessions in any rolling 7-day window', () => {
    // 4 sessions within 6 days, then a lone one 20 days back.
    const rows = [ago(0), ago(1), ago(3), ago(6), ago(20)].map((t) => ({ startedAt: t, makes: 1, attempts: 2 }));
    expect(seasonStats(rows, NOW).bestWeekSessions).toBe(4);
  });

  test('window start is 30 days before now', () => {
    expect(seasonStats([], NOW).startMs).toBe(NOW - SEASON_DAYS * DAY);
  });
});

describe('seasonGoalProgress', () => {
  test('clamps to [0,1]', () => {
    expect(seasonGoalProgress(0, 200)).toBe(0);
    expect(seasonGoalProgress(100, 200)).toBe(0.5);
    expect(seasonGoalProgress(500, 200)).toBe(1);
  });
  test('non-positive goal is 0', () => {
    expect(seasonGoalProgress(50, 0)).toBe(0);
  });
});
