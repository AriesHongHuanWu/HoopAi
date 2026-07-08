/**
 * Month-over-month progression — the "am I actually getting better?" signal a
 * training app lives on. Aggregates session rows into this calendar month vs
 * last month (local time) so the Trends screen can show volume + conversion and
 * whether they're up or down.
 *
 * Pure + deterministic: `nowMs` is passed in (never read from the clock), so
 * the same rows always produce the same result and it is trivially testable.
 * Months are local-calendar (a user thinks "this month", not "last 30 days").
 */

/** The minimum session rows a period needs before its rate is worth comparing. */
export interface SessionLike {
  startedAt: number;
  makes: number;
  attempts: number;
}

export interface PeriodStats {
  makes: number;
  attempts: number;
  sessions: number;
  /** makes / attempts (0..1); 0 when no attempts. */
  rate: number;
}

export interface MonthlyProgress {
  thisMonth: PeriodStats;
  lastMonth: PeriodStats;
  /** thisMonth.rate − lastMonth.rate; null unless BOTH months have attempts. */
  rateDelta: number | null;
  /** thisMonth.makes − lastMonth.makes. */
  makesDelta: number;
}

function periodStats(
  rows: readonly SessionLike[],
  startMs: number,
  endMs: number,
): PeriodStats {
  let makes = 0;
  let attempts = 0;
  let sessions = 0;
  for (const r of rows) {
    if (r.startedAt >= startMs && r.startedAt < endMs) {
      makes += r.makes;
      attempts += r.attempts;
      sessions += 1;
    }
  }
  return { makes, attempts, sessions, rate: attempts > 0 ? makes / attempts : 0 };
}

export function monthlyProgress(
  rows: readonly SessionLike[],
  nowMs: number,
): MonthlyProgress {
  const d = new Date(nowMs);
  const thisStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const lastStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
  const nextStart = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();

  const thisMonth = periodStats(rows, thisStart, nextStart);
  const lastMonth = periodStats(rows, lastStart, thisStart);
  const rateDelta =
    thisMonth.attempts > 0 && lastMonth.attempts > 0
      ? thisMonth.rate - lastMonth.rate
      : null;
  return { thisMonth, lastMonth, rateDelta, makesDelta: thisMonth.makes - lastMonth.makes };
}
