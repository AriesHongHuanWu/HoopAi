/**
 * Lifetime records + badges — pure, deterministic, no I/O.
 *
 * The persistence layer (src/data/db.ts → lifetimeTotals) aggregates every
 * stored shot into a {@link LifetimeTotals}; this module turns those totals
 * into unlocked/locked {@link AchievementDef}s for the Records screen.
 *
 * Progress is always 0..1 and clamps at 1 once unlocked, so a bar can be
 * rendered directly from {@link AchievementDef.progress}. `progressLabel`
 * gives the human caption for a locked row (e.g. "42/100").
 *
 * Also home to {@link detectNewBests} — the pure "NEW PERSONAL BEST" check the
 * post-session summary runs against career maxima captured BEFORE the session.
 */
import type { SessionStats } from './types';

// ---------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------

export interface LifetimeTotals {
  /** Sessions with at least one tracked shot. */
  sessions: number;
  /** Every tracked shot, including unsure ones. */
  attempts: number;
  /** Career makes. */
  makes: number;
  /** Longest make streak inside a single session. */
  bestStreak: number;
  /**
   * Best single-session FG% (0..1), counted only over sessions with at least
   * {@link SHARPSHOOTER_MIN_ATTEMPTS} attempts so a lucky 2-for-2 never
   * qualifies. 0 when no session has reached the attempt floor.
   */
  bestSessionFgPct: number;
  /** Career made 3-pointers (estimated shot value). */
  threes: number;
  /** Career hand-corrected calls (shots the user overturned in review). */
  correctedCalls: number;
  /** Sessions tipped off in night-owl hours (see {@link isNightOwlHour}). */
  nightSessions: number;
  /** Sessions tipped off in early-bird hours (see {@link isEarlyBirdHour}). */
  dawnSessions: number;
  /**
   * Most sessions inside any rolling 7-day window (see
   * {@link maxSessionsInWeek}). 0 with no sessions.
   */
  bestWeekSessions: number;
  /** Around the World games won (all five spots cleared). */
  atwWins: number;
  /** H-O-R-S-E games played through to the final letter. */
  horseGames: number;
  /** Distinct game modes (excluding Free Play) with at least one session. */
  modesPlayed: number;
}

/** All-zero totals — the state before the first tracked shot. */
export function emptyTotals(): LifetimeTotals {
  return {
    sessions: 0,
    attempts: 0,
    makes: 0,
    bestStreak: 0,
    bestSessionFgPct: 0,
    threes: 0,
    correctedCalls: 0,
    nightSessions: 0,
    dawnSessions: 0,
    bestWeekSessions: 0,
    atwWins: 0,
    horseGames: 0,
    modesPlayed: 0,
  };
}

// ---------------------------------------------------------------------------
// Time-of-day + weekly-cadence helpers (pure; db.ts feeds them session rows)
// ---------------------------------------------------------------------------

/** Night owl: session tips off 10pm–3:59am local time. */
export function isNightOwlHour(hour: number): boolean {
  return hour >= 22 || hour < 4;
}

/** Early bird: session tips off 4am–7:59am local time (disjoint from night). */
export function isEarlyBirdHour(hour: number): boolean {
  return hour >= 4 && hour < 8;
}

/** Rolling window length for {@link maxSessionsInWeek}. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Most sessions inside any rolling 7-day window. `startTimes` are epoch-ms
 * session starts in ANY order; duplicates count (two-a-days are real).
 */
export function maxSessionsInWeek(startTimes: readonly number[]): number {
  if (startTimes.length === 0) return 0;
  const sorted = [...startTimes].sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sorted.length; hi++) {
    while (sorted[hi] - sorted[lo] >= WEEK_MS) lo++;
    const count = hi - lo + 1;
    if (count > best) best = count;
  }
  return best;
}

/** Attempt floor for the session-FG% badges (see LifetimeTotals). */
export const SHARPSHOOTER_MIN_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

/** Badge weight class — bronze (easy), silver (earned), gold (career-defining). */
export type BadgeTier = 'bronze' | 'silver' | 'gold';

export interface AchievementDef {
  id: string;
  emoji: string;
  name: string;
  blurb: string;
  /**
   * Ionicons glyph name (e.g. 'trophy'). Typed as string so this core module
   * stays free of UI imports; the row component casts it for the Ionicons
   * `name` prop.
   */
  icon: string;
  tier: BadgeTier;
  /** True when the badge is unlocked for these totals. */
  check(t: LifetimeTotals): boolean;
  /** Progress toward unlocking, clamped to 0..1 (1 once unlocked). */
  progress(t: LifetimeTotals): number;
  /** Short caption for a locked row, e.g. "42/100" or "48% best". */
  progressLabel(t: LifetimeTotals): string;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Counting badge: unlocks when a numeric total reaches `target`. Every
 * LifetimeTotals field is a number, so any of them can drive a count badge
 * (bestSessionFgPct is the one field that instead uses {@link fgBadge}).
 */
function countBadge(
  id: string,
  emoji: string,
  icon: string,
  tier: BadgeTier,
  name: string,
  blurb: string,
  field: keyof LifetimeTotals,
  target: number,
): AchievementDef {
  return {
    id,
    emoji,
    name,
    blurb,
    icon,
    tier,
    check: (t) => t[field] >= target,
    progress: (t) => clamp01(t[field] / target),
    progressLabel: (t) => `${Math.min(t[field], target)}/${target}`,
  };
}

/** Session-FG% badge: best qualifying session must reach `pct` (0..1). */
function fgBadge(
  id: string,
  emoji: string,
  icon: string,
  tier: BadgeTier,
  name: string,
  blurb: string,
  pct: number,
): AchievementDef {
  return {
    id,
    emoji,
    name,
    blurb,
    icon,
    tier,
    check: (t) => t.bestSessionFgPct >= pct,
    progress: (t) => clamp01(t.bestSessionFgPct / pct),
    progressLabel: (t) => `${Math.round(clamp01(t.bestSessionFgPct) * 100)}% best`,
  };
}

/**
 * The badge board, easiest first within each theme. Order here is the display
 * order on the Records screen.
 */
export const ACHIEVEMENTS: readonly AchievementDef[] = [
  // Makes
  countBadge(
    'first-bucket', '🏀', 'basketball', 'bronze', 'First bucket',
    'Your first make is in the books.', 'makes', 1,
  ),
  countBadge(
    'getting-warm', '🔥', 'thermometer', 'bronze', 'Getting warm',
    'Sink 50 career makes.', 'makes', 50,
  ),
  countBadge(
    'century', '💯', 'medal', 'silver', 'Century',
    'Sink 100 career makes.', 'makes', 100,
  ),
  countBadge(
    'bucket-machine', '🪣', 'basket', 'gold', 'Bucket machine',
    'Sink 500 career makes.', 'makes', 500,
  ),
  countBadge(
    'millennium', '🏆', 'trophy', 'gold', 'Millennium',
    'Sink 1,000 career makes. The rim knows you by name.', 'makes', 1000,
  ),
  // Streaks
  countBadge(
    'heat-check', '⚡', 'flame', 'bronze', 'Heat check',
    'Make 5 in a row in one session.', 'bestStreak', 5,
  ),
  countBadge(
    'flamethrower', '🧨', 'flash', 'silver', 'Flamethrower',
    'Make 10 in a row in one session.', 'bestStreak', 10,
  ),
  countBadge(
    'cold-blooded', '🥶', 'snow', 'gold', 'Cold blooded',
    'Make 20 in a row in one session.', 'bestStreak', 20,
  ),
  // Accuracy
  fgBadge(
    'sharpshooter', '🎯', 'locate', 'silver', 'Sharpshooter',
    'Shoot 50%+ in a session of 10 or more attempts.', 0.5,
  ),
  fgBadge(
    'pure', '💦', 'water', 'gold', 'Pure',
    'Shoot 65%+ in a session of 10 or more attempts.', 0.65,
  ),
  // Range
  countBadge(
    'deep-threat', '🏹', 'rocket', 'bronze', 'Deep threat',
    'Knock down 10 career threes.', 'threes', 10,
  ),
  countBadge(
    'downtown', '🌆', 'business', 'silver', 'Downtown',
    'Knock down 50 career threes.', 'threes', 50,
  ),
  countBadge(
    'orbit', '🪐', 'planet', 'gold', 'Orbit',
    'Knock down 100 career threes. Permanent residence beyond the arc.',
    'threes', 100,
  ),
  // Dedication
  countBadge(
    'marathon', '🏃', 'fitness', 'bronze', 'Marathon',
    'Finish 10 shooting sessions.', 'sessions', 10,
  ),
  countBadge(
    'grinder', '💪', 'barbell', 'silver', 'Grinder',
    'Finish 25 shooting sessions.', 'sessions', 25,
  ),
  countBadge(
    'fifty-club', '🎖️', 'ribbon', 'gold', 'Fifty club',
    'Finish 50 shooting sessions. This is a lifestyle now.', 'sessions', 50,
  ),
  // Volume
  countBadge(
    'volume-shooter', '📈', 'stats-chart', 'silver', 'Volume shooter',
    'Put up 500 career attempts.', 'attempts', 500,
  ),
  countBadge(
    'relentless', '🤖', 'repeat', 'gold', 'Relentless',
    'Put up 1000 career attempts.', 'attempts', 1000,
  ),
  countBadge(
    'gym-rat', '🏋️', 'hammer', 'gold', 'Gym rat',
    'Put up 2,500 career attempts. The gym should charge you rent.',
    'attempts', 2500,
  ),
  // Rhythm — when and how often you show up
  countBadge(
    'week-warrior', '🗓️', 'calendar', 'silver', 'Week warrior',
    'Track 5 sessions inside one week. No days off — okay, two.',
    'bestWeekSessions', 5,
  ),
  countBadge(
    'night-owl', '🦉', 'moon', 'bronze', 'Night owl',
    'Tip off a session after 10pm. Buckets don’t sleep.',
    'nightSessions', 1,
  ),
  countBadge(
    'early-bird', '🌅', 'sunny', 'bronze', 'Early bird',
    'Tip off a session before 8am. First one in the gym.',
    'dawnSessions', 1,
  ),
  // Film room
  countBadge(
    'film-judge', '🎬', 'film', 'silver', 'Film judge',
    'Overturn 50 calls in review. The tape never lies.',
    'correctedCalls', 50,
  ),
  // Game modes
  countBadge(
    'globetrotter', '🌍', 'earth', 'silver', 'Globetrotter',
    'Win Around the World — clear all five spots.', 'atwWins', 1,
  ),
  countBadge(
    'full-spell', '🐴', 'paw', 'bronze', 'Full spell',
    'Play a game of H-O-R-S-E to the final letter.', 'horseGames', 1,
  ),
  countBadge(
    'mode-hopper', '🎲', 'apps', 'bronze', 'Mode hopper',
    'Play 3 different game modes. Variety is a skill.', 'modesPlayed', 3,
  ),
];

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Split the badge board into unlocked and locked lists for the given totals.
 * Both lists preserve {@link ACHIEVEMENTS} order; together they contain every
 * definition exactly once.
 */
export function evaluate(t: LifetimeTotals): {
  unlocked: AchievementDef[];
  locked: AchievementDef[];
} {
  const unlocked: AchievementDef[] = [];
  const locked: AchievementDef[] = [];
  for (const def of ACHIEVEMENTS) {
    (def.check(t) ? unlocked : locked).push(def);
  }
  return { unlocked, locked };
}

// ---------------------------------------------------------------------------
// New personal bests (post-session summary banner)
// ---------------------------------------------------------------------------

/**
 * Career maxima captured BEFORE a session, the honest baseline for
 * {@link detectNewBests}. db.ts derives it by excluding the just-ended
 * session's rows from the aggregates (careerBests).
 */
export interface CareerBests {
  /** Longest single-session make streak across all prior sessions. */
  bestStreak: number;
  /**
   * Best prior single-session FG% (0..1) over sessions with at least
   * {@link SHARPSHOOTER_MIN_ATTEMPTS} attempts. 0 when none qualified.
   */
  bestFgPct: number;
  /** Most makes in any prior single session. */
  mostMakes: number;
}

export type PersonalBestKind = 'bestStreak' | 'bestFgPct' | 'mostMakes';

export interface PersonalBest {
  kind: PersonalBestKind;
  /** The new record: streak length, makes count, or FG% as 0..1. */
  value: number;
}

/**
 * Meaningful-record floors, so a first-ever 1/1 session doesn't shower the
 * player in hollow "records". A streak PB must be a real run; a makes PB a
 * real haul; an FG% PB needs the same qualifying sample as the FG badges.
 */
export const PB_MIN_STREAK = 3;
export const PB_MIN_MAKES = 5;

/**
 * Which career records did a just-ended session set? Pure — compare the
 * session's stats against {@link CareerBests} from BEFORE the session.
 * Strictly-greater comparisons mean tying a record never re-fires it, and
 * the floors above keep trivial firsts quiet. Result order is fixed
 * (makes, streak, FG%) for a stable banner layout.
 */
export function detectNewBests(
  session: Pick<SessionStats, 'attempts' | 'makes' | 'fgPct' | 'bestStreak'>,
  careerBefore: CareerBests,
): PersonalBest[] {
  const bests: PersonalBest[] = [];
  if (session.makes >= PB_MIN_MAKES && session.makes > careerBefore.mostMakes) {
    bests.push({ kind: 'mostMakes', value: session.makes });
  }
  if (
    session.bestStreak >= PB_MIN_STREAK &&
    session.bestStreak > careerBefore.bestStreak
  ) {
    bests.push({ kind: 'bestStreak', value: session.bestStreak });
  }
  if (
    session.attempts >= SHARPSHOOTER_MIN_ATTEMPTS &&
    session.fgPct > 0 &&
    session.fgPct > careerBefore.bestFgPct
  ) {
    bests.push({ kind: 'bestFgPct', value: session.fgPct });
  }
  return bests;
}
