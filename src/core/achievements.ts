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
 */

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
  };
}

/** Attempt floor for the session-FG% badges (see LifetimeTotals). */
export const SHARPSHOOTER_MIN_ATTEMPTS = 10;

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

export interface AchievementDef {
  id: string;
  emoji: string;
  name: string;
  blurb: string;
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

/** Counting badge: unlocks when a numeric total reaches `target`. */
function countBadge(
  id: string,
  emoji: string,
  name: string,
  blurb: string,
  field: 'sessions' | 'attempts' | 'makes' | 'bestStreak' | 'threes',
  target: number,
): AchievementDef {
  return {
    id,
    emoji,
    name,
    blurb,
    check: (t) => t[field] >= target,
    progress: (t) => clamp01(t[field] / target),
    progressLabel: (t) => `${Math.min(t[field], target)}/${target}`,
  };
}

/** Session-FG% badge: best qualifying session must reach `pct` (0..1). */
function fgBadge(
  id: string,
  emoji: string,
  name: string,
  blurb: string,
  pct: number,
): AchievementDef {
  return {
    id,
    emoji,
    name,
    blurb,
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
    'first-bucket', '🏀', 'First bucket',
    'Your first make is in the books.', 'makes', 1,
  ),
  countBadge(
    'getting-warm', '🔥', 'Getting warm',
    'Sink 50 career makes.', 'makes', 50,
  ),
  countBadge(
    'century', '💯', 'Century',
    'Sink 100 career makes.', 'makes', 100,
  ),
  countBadge(
    'bucket-machine', '🪣', 'Bucket machine',
    'Sink 500 career makes.', 'makes', 500,
  ),
  // Streaks
  countBadge(
    'heat-check', '⚡', 'Heat check',
    'Make 5 in a row in one session.', 'bestStreak', 5,
  ),
  countBadge(
    'flamethrower', '🧨', 'Flamethrower',
    'Make 10 in a row in one session.', 'bestStreak', 10,
  ),
  countBadge(
    'cold-blooded', '🥶', 'Cold blooded',
    'Make 20 in a row in one session.', 'bestStreak', 20,
  ),
  // Accuracy
  fgBadge(
    'sharpshooter', '🎯', 'Sharpshooter',
    'Shoot 50%+ in a session of 10 or more attempts.', 0.5,
  ),
  fgBadge(
    'pure', '💦', 'Pure',
    'Shoot 65%+ in a session of 10 or more attempts.', 0.65,
  ),
  // Range
  countBadge(
    'deep-threat', '🏹', 'Deep threat',
    'Knock down 10 career threes.', 'threes', 10,
  ),
  countBadge(
    'downtown', '🌆', 'Downtown',
    'Knock down 50 career threes.', 'threes', 50,
  ),
  // Dedication
  countBadge(
    'marathon', '🏃', 'Marathon',
    'Finish 10 shooting sessions.', 'sessions', 10,
  ),
  countBadge(
    'grinder', '💪', 'Grinder',
    'Finish 25 shooting sessions.', 'sessions', 25,
  ),
  // Volume
  countBadge(
    'volume-shooter', '📈', 'Volume shooter',
    'Put up 500 career attempts.', 'attempts', 500,
  ),
  countBadge(
    'relentless', '🤖', 'Relentless',
    'Put up 1000 career attempts.', 'attempts', 1000,
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
