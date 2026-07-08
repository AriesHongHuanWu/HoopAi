import { monthlyProgress } from '../progression';

// Fixed anchor: 2026-06-15 12:00 local (mid-June), so "this month" = June,
// "last month" = May, both unambiguous regardless of the runner's timezone.
const NOW = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();
function at(year: number, month0: number, day: number): number {
  return new Date(year, month0, day, 12, 0, 0, 0).getTime();
}

describe('monthlyProgress', () => {
  test('aggregates this month vs last month by local calendar', () => {
    const rows = [
      { startedAt: at(2026, 5, 3), makes: 20, attempts: 40 }, // June
      { startedAt: at(2026, 5, 10), makes: 30, attempts: 50 }, // June
      { startedAt: at(2026, 4, 20), makes: 10, attempts: 40 }, // May
      { startedAt: at(2026, 3, 5), makes: 99, attempts: 99 }, // April (ignored)
    ];
    const p = monthlyProgress(rows, NOW);
    expect(p.thisMonth).toEqual({ makes: 50, attempts: 90, sessions: 2, rate: 50 / 90 });
    expect(p.lastMonth).toEqual({ makes: 10, attempts: 40, sessions: 1, rate: 0.25 });
    expect(p.makesDelta).toBe(40);
    expect(p.rateDelta).toBeCloseTo(50 / 90 - 0.25, 6);
  });

  test('rateDelta is null when a month has no attempts', () => {
    const rows = [{ startedAt: at(2026, 5, 3), makes: 20, attempts: 40 }]; // June only
    const p = monthlyProgress(rows, NOW);
    expect(p.lastMonth.attempts).toBe(0);
    expect(p.rateDelta).toBeNull();
    expect(p.makesDelta).toBe(20);
  });

  test('empty input yields zeroed periods and a null delta', () => {
    const p = monthlyProgress([], NOW);
    expect(p.thisMonth.makes).toBe(0);
    expect(p.lastMonth.sessions).toBe(0);
    expect(p.rateDelta).toBeNull();
  });

  test('a session on the last day of last month lands in last month', () => {
    const p = monthlyProgress([{ startedAt: at(2026, 4, 31), makes: 5, attempts: 10 }], NOW);
    expect(p.lastMonth.sessions).toBe(1);
    expect(p.thisMonth.sessions).toBe(0);
  });

  test('January anchor rolls last month back to December of the prior year', () => {
    const jan = new Date(2026, 0, 15, 12).getTime();
    const rows = [{ startedAt: new Date(2025, 11, 20, 12).getTime(), makes: 8, attempts: 16 }];
    const p = monthlyProgress(rows, jan);
    expect(p.lastMonth.sessions).toBe(1);
    expect(p.lastMonth.makes).toBe(8);
  });
});
