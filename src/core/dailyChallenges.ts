/**
 * Daily challenges — pure, deterministic, no I/O.
 *
 * Three challenges are drawn from a fixed pool each local calendar day. The
 * draw is seeded by hashing the day's date key ('YYYY-MM-DD'), so every
 * device shows the same set for a given day and the set never changes on
 * re-render, refocus or restart — no Math.random anywhere.
 *
 * Progress is computed from a {@link DayAggregate} of today's persisted
 * sessions (built by src/state/challengeStore.ts from src/data/db.ts rows,
 * same local-day windowing as src/core/goals.ts todayMakes). Points earned
 * land in the challenge store's lifetime ledger; this module only defines the
 * pool and the math.
 */
import type { ShotOutcome } from './types';

// ---------------------------------------------------------------------------
// Goal specs + challenge defs
// ---------------------------------------------------------------------------

/** What a challenge asks for, measured against a {@link DayAggregate}. */
export type ChallengeGoal =
  /** Total makes today ≥ target. */
  | { kind: 'makes'; target: number }
  /** Total attempts today ≥ target (volume — makes not required). */
  | { kind: 'attempts'; target: number }
  /** Made threes today ≥ target. */
  | { kind: 'threes'; target: number }
  /** Best single-session make streak today ≥ target. */
  | { kind: 'streak'; target: number }
  /**
   * Day FG% ≥ `targetPct` (0..1, over decided shots) across at least
   * `minAttempts` attempts. Progress is metered in "qualifying attempts" —
   * see {@link progressFor}.
   */
  | { kind: 'fgPct'; targetPct: number; minAttempts: number }
  /** Distinct game modes played today ≥ target. */
  | { kind: 'modes'; target: number };

export interface ChallengeDef {
  /** Stable id — persisted in the completed ledger, never re-used. */
  id: string;
  title: string;
  description: string;
  /**
   * Ionicons glyph name. Typed as string so this module stays free of UI
   * imports; every value in {@link CHALLENGE_POOL} is a valid Ionicons name.
   */
  icon: string;
  /** Points awarded into the ledger when the challenge completes. */
  points: number;
  goal: ChallengeGoal;
}

/**
 * The fixed pool the daily draw picks from. Ids are stable forever (the
 * completed ledger keys on them); tweak copy/points freely, never ids.
 */
export const CHALLENGE_POOL: readonly ChallengeDef[] = [
  {
    id: 'makes-15',
    title: 'Make 15 shots',
    description: 'Any spot, any range — see fifteen drop.',
    icon: 'basketball',
    points: 30,
    goal: { kind: 'makes', target: 15 },
  },
  {
    id: 'makes-25',
    title: 'Make 25 shots',
    description: 'A real shooting day: twenty-five buckets.',
    icon: 'basketball',
    points: 50,
    goal: { kind: 'makes', target: 25 },
  },
  {
    id: 'makes-40',
    title: 'Make 40 shots',
    description: 'Volume scorer — forty makes before midnight.',
    icon: 'basketball',
    points: 75,
    goal: { kind: 'makes', target: 40 },
  },
  {
    id: 'attempts-25',
    title: 'Shoot 25 attempts',
    description: 'Get your reps in — twenty-five shots up.',
    icon: 'repeat',
    points: 20,
    goal: { kind: 'attempts', target: 25 },
  },
  {
    id: 'attempts-50',
    title: 'Shoot 50 attempts',
    description: 'Fifty shots up. Reps win.',
    icon: 'repeat',
    points: 40,
    goal: { kind: 'attempts', target: 50 },
  },
  {
    id: 'threes-3',
    title: 'Hit 3 threes',
    description: 'Knock down three from beyond the arc.',
    icon: 'rocket',
    points: 40,
    goal: { kind: 'threes', target: 3 },
  },
  {
    id: 'threes-6',
    title: 'Hit 6 threes',
    description: 'Six from downtown — heat check.',
    icon: 'rocket',
    points: 60,
    goal: { kind: 'threes', target: 6 },
  },
  {
    id: 'streak-5',
    title: '5 makes in a row',
    description: 'Build a streak of five without a miss.',
    icon: 'flame',
    points: 50,
    goal: { kind: 'streak', target: 5 },
  },
  {
    id: 'streak-8',
    title: '8 makes in a row',
    description: 'Eight straight. Do not cool off.',
    icon: 'flame',
    points: 75,
    goal: { kind: 'streak', target: 8 },
  },
  {
    id: 'fgpct-50-10',
    title: 'Shoot 50%+',
    description: 'FG% at 50 or better across at least 10 attempts.',
    icon: 'stats-chart',
    points: 60,
    goal: { kind: 'fgPct', targetPct: 0.5, minAttempts: 10 },
  },
  {
    id: 'fgpct-60-15',
    title: 'Shoot 60%+',
    description: 'FG% at 60 or better across at least 15 attempts.',
    icon: 'stats-chart',
    points: 80,
    goal: { kind: 'fgPct', targetPct: 0.6, minAttempts: 15 },
  },
  {
    id: 'mode-any',
    title: 'Play a game mode',
    description: 'Run any game mode — Around the World, Timed, HORSE…',
    icon: 'game-controller',
    points: 30,
    goal: { kind: 'modes', target: 1 },
  },
];

/** How many challenges each day serves. */
export const DAILY_CHALLENGE_COUNT = 3;

/** Bonus points for finishing all of a day's challenges. */
export const PERFECT_DAY_BONUS = 50;
/** Pseudo-challenge id the perfect-day bonus is ledgered under. */
export const PERFECT_DAY_ID = 'perfect-day';

// ---------------------------------------------------------------------------
// Deterministic daily draw
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash of the date key — the daily seed. */
function hashDateKey(dateKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dateKey.length; i++) {
    h ^= dateKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — tiny deterministic PRNG over the day seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The day's challenge set: a seeded Fisher–Yates shuffle of the pool, then a
 * greedy pass that prefers distinct goal kinds (so one day never serves
 * "make 15" next to "make 25"), topped up from the shuffle order if fewer
 * than `n` kinds exist. Pure and deterministic: same `dateKey` ⇒ same picks,
 * in the same order, forever.
 */
export function pickDailyChallenges(dateKey: string, n = DAILY_CHALLENGE_COUNT): ChallengeDef[] {
  const rand = mulberry32(hashDateKey(dateKey));
  const order = [...CHALLENGE_POOL];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }

  const picks: ChallengeDef[] = [];
  const kinds = new Set<ChallengeGoal['kind']>();
  for (const def of order) {
    if (picks.length >= n) break;
    if (kinds.has(def.goal.kind)) continue;
    kinds.add(def.goal.kind);
    picks.push(def);
  }
  // Fewer kinds than n (defensive — the pool has 6): fill from shuffle order.
  for (const def of order) {
    if (picks.length >= n) break;
    if (!picks.includes(def)) picks.push(def);
  }
  return picks;
}

/** Local-calendar date key ('YYYY-MM-DD') for an epoch-ms instant. */
export function dateKeyFor(nowMs: number): string {
  const d = new Date(nowMs);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Do two epoch-ms instants fall on the same LOCAL calendar day? */
export function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// ---------------------------------------------------------------------------
// Day aggregate + progress math
// ---------------------------------------------------------------------------

/** Everything challenge progress needs about today, in one flat bundle. */
export interface DayAggregate {
  /** Makes across today's sessions. */
  makes: number;
  /** All tracked shots today (makes + misses + unsure). */
  attempts: number;
  /** Made shots persisted with an estimated 3-point value. */
  threes: number;
  /**
   * Best make streak inside a single session today. Misses reset, unsure
   * shots are skipped, streaks never span sessions — the same semantics as
   * src/data/db.ts lifetimeTotals / src/core/stats.ts.
   */
  bestStreak: number;
  /** makes / decided (make+miss) today, 0..1; 0 when nothing is decided. */
  fgPct: number;
  /** Distinct game modes played today (sessions with a non-null, non-'free'
   *  modeId — Free Play is an open run, not a game mode). */
  modesPlayed: number;
}

export function emptyDayAggregate(): DayAggregate {
  return { makes: 0, attempts: 0, threes: 0, bestStreak: 0, fgPct: 0, modesPlayed: 0 };
}

/** The per-session slice {@link dayAggregate} needs (shape of db.ts rows). */
export interface DaySessionFacts {
  /** GameModeId string or null for a plain (no-mode) session. */
  modeId: string | null;
  shots: readonly { outcome: ShotOutcome; shotValue?: number | null }[];
}

/**
 * Folds today's sessions into a {@link DayAggregate}. Pure — callers filter
 * to the local day first (see {@link isSameLocalDay}).
 */
export function dayAggregate(sessions: readonly DaySessionFacts[]): DayAggregate {
  let makes = 0;
  let attempts = 0;
  let threes = 0;
  let decided = 0;
  let bestStreak = 0;
  const modes = new Set<string>();

  for (const session of sessions) {
    // 'free' is Free Play, not a game MODE: the "Play a game mode" challenge
    // must not auto-complete from an ordinary open run. Same exclusion
    // lifetimeTotals (src/data/db.ts) applies to its modesPlayed count.
    if (session.modeId != null && session.modeId !== 'free') modes.add(session.modeId);
    let streak = 0; // Streaks never span sessions.
    for (const shot of session.shots) {
      attempts += 1;
      if (shot.outcome === 'make') {
        makes += 1;
        decided += 1;
        if (shot.shotValue === 3) threes += 1;
        streak += 1;
        if (streak > bestStreak) bestStreak = streak;
      } else if (shot.outcome === 'miss') {
        decided += 1;
        streak = 0;
      }
      // 'unsure' leaves the streak untouched (see src/core/stats.ts).
    }
  }

  return {
    makes,
    attempts,
    threes,
    bestStreak,
    fgPct: decided > 0 ? makes / decided : 0,
    modesPlayed: modes.size,
  };
}

/**
 * The integer denominator a challenge's progress runs to (the "goal" in the
 * card's n/goal readout). For fgPct challenges this is the attempt floor —
 * progress is metered in qualifying attempts, see {@link progressFor}.
 */
export function challengeGoalTarget(goal: ChallengeGoal): number {
  return goal.kind === 'fgPct' ? goal.minAttempts : goal.target;
}

/**
 * Progress toward a challenge, clamped to 0..{@link challengeGoalTarget}.
 *
 * Counting kinds map straight onto the aggregate. The fgPct kind meters
 * progress in "qualifying attempts": the smaller of (a) attempts taken,
 * capped at the floor, and (b) the floor scaled by how much of the target
 * FG% is being shot — so 20 attempts at 40% toward "50% over 10" reads 8/10,
 * and the bar only tops out when BOTH the attempt floor and the percentage
 * are met. Monotone in day volume for the counting kinds; deterministic and
 * NaN-free for all of them.
 */
export function progressFor(challenge: ChallengeDef, day: DayAggregate): number {
  const goal = challenge.goal;
  const target = challengeGoalTarget(goal);
  if (target <= 0) return 0;

  let raw: number;
  switch (goal.kind) {
    case 'makes':
      raw = day.makes;
      break;
    case 'attempts':
      raw = day.attempts;
      break;
    case 'threes':
      raw = day.threes;
      break;
    case 'streak':
      raw = day.bestStreak;
      break;
    case 'modes':
      raw = day.modesPlayed;
      break;
    case 'fgPct': {
      const ratio = goal.targetPct > 0 ? day.fgPct / goal.targetPct : 1;
      raw = Math.min(day.attempts, Math.floor(goal.minAttempts * Math.min(1, ratio)));
      break;
    }
  }
  return Math.max(0, Math.min(target, raw));
}

/** True once a challenge's progress has filled its goal. */
export function isChallengeComplete(challenge: ChallengeDef, day: DayAggregate): boolean {
  return progressFor(challenge, day) >= challengeGoalTarget(challenge.goal);
}
