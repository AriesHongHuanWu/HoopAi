/**
 * Consecutive-practice-DAY badges — the "don't break the chain" reward shelf.
 *
 * WHY a separate module: the badges in achievements.ts named 'streak'
 * (heat-check / flamethrower / cold-blooded) key off LifetimeTotals.bestStreak,
 * which is consecutive MADE SHOTS inside one session — a different thing from
 * consecutive practice DAYS. Those ids are already persisted in a seen-store,
 * so they must not be re-pointed at a new meaning. This module is therefore
 * self-contained, but deliberately mirrors achievements.ts vocabulary
 * (id / name / blurb / Ionicons `icon` as a plain string) so the Records screen
 * can render a day-streak badge with the same row component.
 *
 * Pure + deterministic: it takes day COUNTS, never timestamps and never the
 * clock. Callers derive those counts with computeDayStreak() from
 * src/core/streak.ts (`current`, `longest`, `shotToday`).
 *
 * Honesty note: a badge here asserts only that the app recorded sessions on N
 * consecutive local days. It says nothing about how long or how well the user
 * shot on those days.
 */

export interface DayStreakBadge {
  /** Stable id, safe to persist in a "already celebrated" store. */
  id: string;
  name: string;
  /** Consecutive practice days required to earn it. */
  days: number;
  blurb: string;
  /**
   * Ionicons glyph name. Typed as string so this core module stays free of UI
   * imports; the row component casts it for the Ionicons `name` prop. All six
   * names below were checked against the installed Ionicons glyph map.
   */
  icon: string;
}

/**
 * The ladder, ascending. The first rung is reachable in a long weekend so the
 * loop can actually start, and the rungs then stretch out (roughly doubling) so
 * the top one stays a real commitment rather than an inevitability.
 */
export const DAY_STREAK_BADGES: readonly DayStreakBadge[] = [
  {
    id: 'day-streak-3',
    name: 'Three straight',
    days: 3,
    blurb: 'Practiced 3 days in a row. The chain has started.',
    icon: 'flame',
  },
  {
    id: 'day-streak-7',
    name: 'Full week',
    days: 7,
    blurb: 'Practiced 7 days in a row. A whole week without a gap.',
    icon: 'bonfire',
  },
  {
    id: 'day-streak-14',
    name: 'Fortnight',
    days: 14,
    blurb: 'Practiced 14 days in a row. This is a routine now, not a mood.',
    icon: 'ribbon',
  },
  {
    id: 'day-streak-30',
    name: 'Month strong',
    days: 30,
    blurb: 'Practiced 30 days in a row. A full month of showing up.',
    icon: 'medal',
  },
  {
    id: 'day-streak-60',
    name: 'Iron habit',
    days: 60,
    blurb: 'Practiced 60 days in a row. Weather, exams, whatever — you shot.',
    icon: 'trophy',
  },
  {
    id: 'day-streak-100',
    name: 'Hundred days',
    days: 100,
    blurb: 'Practiced 100 days in a row. One hundred separate decisions to go.',
    icon: 'planet',
  },
];

/** Days are counts: clamp junk (negative, NaN, fractional) to a whole >= 0. */
function cleanDays(v: number): number {
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface DayStreakStanding {
  /** Every badge earned so far, ascending. Earned by the BEST streak ever. */
  earned: DayStreakBadge[];
  /** The rung being chased from the CURRENT streak; null once the top is held. */
  next: DayStreakBadge | null;
  /** Consecutive days still needed for `next`; null when there is no next. */
  daysToNext: number | null;
}

/**
 * Place a user on the ladder.
 *
 * WHY two different inputs: `earned` uses the BEST (longest-ever) streak so a
 * badge is never taken away when a streak breaks — a thing you did stays done.
 * `next` / `daysToNext` use the CURRENT streak, because that is the number the
 * user can actually move today.
 *
 * `best` is raised to at least `current` defensively: a caller passing a stale
 * `longest` should never hide a badge the live streak already proves.
 */
export function earnedDayStreakBadges(
  currentStreakDays: number,
  bestStreakDays: number,
): DayStreakStanding {
  const current = cleanDays(currentStreakDays);
  const best = Math.max(cleanDays(bestStreakDays), current);

  const earned = DAY_STREAK_BADGES.filter((b) => best >= b.days);
  const next = DAY_STREAK_BADGES.find((b) => b.days > current) ?? null;
  return {
    earned,
    next,
    daysToNext: next ? next.days - current : null,
  };
}

/**
 * The highest badge earned, i.e. the one to show as "your rank". Null before
 * the first rung. Uses the best-ever streak, matching earnedDayStreakBadges.
 */
export function dayStreakTier(bestStreakDays: number): DayStreakBadge | null {
  const best = cleanDays(bestStreakDays);
  let held: DayStreakBadge | null = null;
  for (const b of DAY_STREAK_BADGES) {
    if (best >= b.days) held = b;
    else break;
  }
  return held;
}

/**
 * One honest line for the streak card.
 *
 * Deliberately never guilt-trips: with no streak it states the fact and the
 * (single, small) way to start one; with a live streak it says whether today is
 * already banked. `practicedToday` is StreakResult.shotToday — the streak stays
 * alive all day, so "not yet today" is an invitation, not a failure.
 */
export function streakStatusLine(
  currentStreakDays: number,
  practicedToday: boolean,
): string {
  const days = cleanDays(currentStreakDays);
  if (days === 0) {
    // Defensive: shotToday implies current >= 1, so this pairing only shows up
    // if the two inputs came from different snapshots. Say the true thing.
    return practicedToday
      ? 'Today is banked — that starts a new streak'
      : 'No streak going — one session today starts one';
  }
  return practicedToday
    ? `${days}-day streak — today is banked`
    : `${days}-day streak — shoot today to keep it alive`;
}

/**
 * Rungs crossed between two best-streak snapshots, for a one-time celebration.
 *
 * The UI persists the highest celebrated day count and passes it as
 * `prevBestDays`; anything returned here has not been shown before. Strictly
 * greater than `prevBestDays`, so re-running with the same numbers fires
 * nothing, and a shrinking/equal `newBestDays` returns an empty list.
 */
export function newlyEarned(
  prevBestDays: number,
  newBestDays: number,
): DayStreakBadge[] {
  const prev = cleanDays(prevBestDays);
  const next = cleanDays(newBestDays);
  if (next <= prev) return [];
  return DAY_STREAK_BADGES.filter((b) => b.days > prev && b.days <= next);
}
