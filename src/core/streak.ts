/**
 * Consecutive-day shooting streak — the "don't break the chain" retention loop.
 *
 * Distinct from SessionStats.currentStreak (consecutive MADE shots): this is
 * consecutive CALENDAR DAYS on which the user logged at least one session. The
 * streak stays alive on a day you haven't shot YET — it only breaks once a full
 * day passes with no session — so opening the app mid-morning still shows your
 * live streak and nudges you to keep it.
 *
 * Pure + deterministic: `nowMs` is passed in (never read from the clock here),
 * so the same inputs always yield the same result and it is trivially testable.
 * Days are bucketed by LOCAL midnight, matching how a user thinks about "today".
 */

const DAY_MS = 86_400_000;

/** Local-midnight day index for a timestamp (days since the epoch, local tz). */
function localDayIndex(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return Math.round(d.getTime() / DAY_MS);
}

export interface StreakResult {
  /** Consecutive days up to today (counts back from today, or yesterday when
   *  today has no session yet — so the streak is still "live" and extendable). */
  current: number;
  /** Longest consecutive-day run ever. */
  longest: number;
  /** Whether a session was logged today (local). */
  shotToday: boolean;
}

/**
 * Compute the day streak from session start times.
 *
 * `current` counts consecutive days ending at today if a session was logged
 * today, otherwise ending at yesterday (the streak has not broken until a whole
 * day is missed). It is 0 only when neither today nor yesterday has a session.
 */
export function computeDayStreak(
  startedAtMs: readonly number[],
  nowMs: number,
): StreakResult {
  const days = new Set<number>();
  for (const ms of startedAtMs) days.add(localDayIndex(ms));
  if (days.size === 0) return { current: 0, longest: 0, shotToday: false };

  const today = localDayIndex(nowMs);
  const shotToday = days.has(today);

  // Longest run of consecutive day indices.
  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]! + 1) {
      run += 1;
      if (run > longest) longest = run;
    } else {
      run = 1;
    }
  }

  // Current streak: walk back from today (or yesterday if today is still empty)
  // while each earlier day has a session.
  let anchor = shotToday ? today : today - 1;
  let current = 0;
  while (days.has(anchor)) {
    current += 1;
    anchor -= 1;
  }

  return { current, longest, shotToday };
}

// ---------------------------------------------------------------------------
// Streak tiers — turn the raw day count into a "chase the next medal" ladder
// ---------------------------------------------------------------------------

export interface StreakTier {
  /** Day count at which this tier unlocks. */
  at: number;
  /** Display name. */
  label: string;
}

/**
 * Reward tiers in ascending order. Chosen so the first is reachable in a few
 * days (early momentum) and the top is a genuine season-long badge of honor.
 */
export const STREAK_TIERS: readonly StreakTier[] = [
  { at: 3, label: 'Spark' },
  { at: 7, label: 'Bronze' },
  { at: 14, label: 'Silver' },
  { at: 30, label: 'Gold' },
  { at: 100, label: 'Legend' },
];

export interface StreakStanding {
  /** The highest tier reached, or null before the first tier. */
  tier: StreakTier | null;
  /** The next tier to chase, or null once the top tier is held. */
  next: StreakTier | null;
  /** Days remaining to reach `next` (0 when there is no next). */
  daysToNext: number;
  /** Progress 0..1 from the current tier's floor toward `next` (1 when maxed). */
  progressToNext: number;
}

/**
 * Place a current day-streak on the tier ladder: which medal it holds, which
 * it's chasing, and how close. Pure; drives the Home streak card.
 */
export function streakStanding(current: number): StreakStanding {
  let tier: StreakTier | null = null;
  let next: StreakTier | null = null;
  for (const t of STREAK_TIERS) {
    if (current >= t.at) {
      tier = t;
    } else {
      next = t;
      break;
    }
  }
  const floor = tier ? tier.at : 0;
  const daysToNext = next ? Math.max(0, next.at - current) : 0;
  const span = next ? next.at - floor : 1;
  const progressToNext = next ? Math.max(0, Math.min(1, (current - floor) / span)) : 1;
  return { tier, next, daysToNext, progressToNext };
}
