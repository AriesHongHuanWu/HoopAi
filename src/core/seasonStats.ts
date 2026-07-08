/**
 * Season engine — track shooting like a real season: a rolling 30-day window
 * with total makes, conversion, volume, and the season's best day-streak and
 * best week. Powers the "Season Pass" hero + a shareable season stat card.
 *
 * Pure + deterministic (nowMs is passed in), reusing the day-streak engine.
 */
import { computeDayStreak } from './streak';
import type { SessionLike } from './progression';

const DAY_MS = 86_400_000;
/** A season is a rolling window of this many days ending now. */
export const SEASON_DAYS = 30;
/** Default season target (makes) for the progress hero; UI may override. */
export const SEASON_MAKES_GOAL = 200;

export interface SeasonStats {
  /** Window start (nowMs − SEASON_DAYS). */
  startMs: number;
  makes: number;
  /** Total attempts (incl. unsure), matching the app's session rows. */
  attempts: number;
  /** makes / attempts, 0..1; 0 when no attempts. */
  rate: number;
  sessions: number;
  /** Longest consecutive-day run WITHIN the season. */
  bestDayStreak: number;
  /** Most sessions in any rolling 7-day window within the season. */
  bestWeekSessions: number;
}

/** Most sessions falling in any rolling 7-day window over the given dates. */
function maxSessionsInWeek(dates: readonly number[]): number {
  if (dates.length === 0) return 0;
  const sorted = [...dates].sort((a, b) => a - b);
  let best = 0;
  for (let i = 0; i < sorted.length; i++) {
    let count = 0;
    for (let j = i; j < sorted.length && sorted[j]! - sorted[i]! < 7 * DAY_MS; j++) {
      count += 1;
    }
    if (count > best) best = count;
  }
  return best;
}

export function seasonStats(
  rows: readonly SessionLike[],
  nowMs: number,
): SeasonStats {
  const startMs = nowMs - SEASON_DAYS * DAY_MS;
  const inSeason = rows.filter((r) => r.startedAt >= startMs && r.startedAt <= nowMs);
  let makes = 0;
  let attempts = 0;
  for (const r of inSeason) {
    makes += r.makes;
    attempts += r.attempts;
  }
  const dates = inSeason.map((r) => r.startedAt);
  return {
    startMs,
    makes,
    attempts,
    rate: attempts > 0 ? makes / attempts : 0,
    sessions: inSeason.length,
    bestDayStreak: computeDayStreak(dates, nowMs).longest,
    bestWeekSessions: maxSessionsInWeek(dates),
  };
}

/** Fraction (0..1) of the season makes goal reached. */
export function seasonGoalProgress(
  makes: number,
  goal: number = SEASON_MAKES_GOAL,
): number {
  if (goal <= 0) return 0;
  return Math.min(1, makes / goal);
}
