import { goalProgress, todayMakes } from '../goals';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Epoch ms for a local Y/M/D H:M, so tests are stable regardless of TZ. */
function localMs(y: number, m: number, d: number, h = 12, min = 0): number {
  return new Date(y, m, d, h, min).getTime();
}

describe('todayMakes', () => {
  const now = localMs(2026, 6, 3, 15, 0); // 2026-07-03 15:00 local

  it('sums makes from sessions started today only', () => {
    const rows = [
      { startedAt: localMs(2026, 6, 3, 9, 0), makes: 5 },
      { startedAt: localMs(2026, 6, 3, 11, 30), makes: 3 },
      { startedAt: localMs(2026, 6, 2, 20, 0), makes: 100 }, // yesterday
    ];
    expect(todayMakes(rows, now)).toBe(8);
  });

  it('returns 0 for an empty list', () => {
    expect(todayMakes([], now)).toBe(0);
  });

  it('returns 0 when no session falls on today', () => {
    const rows = [
      { startedAt: localMs(2026, 6, 1, 9, 0), makes: 10 },
      { startedAt: localMs(2026, 5, 30, 9, 0), makes: 4 },
    ];
    expect(todayMakes(rows, now)).toBe(0);
  });

  it('includes sessions right at the start and end of the local day', () => {
    const rows = [
      { startedAt: localMs(2026, 6, 3, 0, 0), makes: 2 },
      { startedAt: localMs(2026, 6, 3, 23, 59), makes: 4 },
    ];
    expect(todayMakes(rows, now)).toBe(6);
  });

  it('excludes a session just before midnight the prior day and just after midnight the next day', () => {
    const rows = [
      { startedAt: localMs(2026, 6, 2, 23, 59), makes: 7 },
      { startedAt: localMs(2026, 6, 4, 0, 1), makes: 9 },
    ];
    expect(todayMakes(rows, now)).toBe(0);
  });

  it('treats a missing makes value as 0', () => {
    const rows = [{ startedAt: localMs(2026, 6, 3, 9, 0), makes: undefined }];
    expect(todayMakes(rows, now)).toBe(0);
  });
});

describe('goalProgress', () => {
  it('computes a 0..1 fraction of makes over goal', () => {
    expect(goalProgress(5, 10)).toBe(0.5);
    expect(goalProgress(0, 10)).toBe(0);
    expect(goalProgress(10, 10)).toBe(1);
  });

  it('clamps at 1 once the goal is exceeded', () => {
    expect(goalProgress(15, 10)).toBe(1);
  });

  it('returns 0 when the goal is 0 or negative (off / defensive)', () => {
    expect(goalProgress(5, 0)).toBe(0);
    expect(goalProgress(5, -3)).toBe(0);
  });

  it('clamps a defensively-negative made value to 0', () => {
    expect(goalProgress(-4, 10)).toBe(0);
  });
});
