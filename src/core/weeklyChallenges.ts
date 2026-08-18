/**
 * Weekly challenges — pure, deterministic, no I/O, no wall clock.
 *
 * The daily set (src/core/dailyChallenges.ts) asks for what one session can
 * deliver. This module is its bigger sibling: goals a WEEK affords and a day
 * does not — hundreds of makes, several separate sessions, shooting on N
 * different days, covering the court, or beating last week's FG%. Three are
 * drawn from a fixed pool per ISO week, seeded by hashing the week key, so
 * every device shows the same set all week and it never reshuffles on
 * re-render, refocus or restart.
 *
 * WHY ISO weeks (Monday-start, ISO-8601) rather than "7 days from signup": a
 * fixed, globally agreed boundary means the card's copy ("this week") matches
 * the user's calendar, two devices in the same timezone agree, and the store
 * can key completions on one short stable string. Week keys are 'YYYY-Www'
 * and never collide with the daily 'YYYY-MM-DD' keys.
 *
 * WHY the goal union is widened instead of reusing ChallengeGoal verbatim:
 * weekly-only asks (sessions, practice days, court coverage, week-over-week
 * improvement) are not expressible in the daily kinds. The CARD shape is
 * reused exactly — see {@link WeeklyChallengeDef} extending ChallengeDef — so
 * one list row renders both.
 *
 * HONESTY: several inputs can be genuinely unavailable (no previous week to
 * beat, shots with no court placement, no 2/3 value estimate). Those cases
 * report progress 0 WITH a `note` explaining why, rather than silently
 * pretending the goal is merely unstarted — see {@link evaluateWeekly}.
 */
import { dateKeyFor, type ChallengeDef } from './dailyChallenges';
import type { ShotOutcome } from './types';

// ---------------------------------------------------------------------------
// Goal specs + challenge defs
// ---------------------------------------------------------------------------

/**
 * What a weekly challenge asks for, measured against a {@link WeekAggregate}.
 *
 * `makes` / `attempts` / `fgPct` mirror the daily kinds of the same name (same
 * field names, same meaning, week-sized targets). The rest exist only here
 * because a single day cannot express them. Every kind is evaluable from
 * session-level aggregates — nothing needs per-frame or per-trajectory data.
 */
export type WeeklyChallengeGoal =
  /** Total makes across the week ≥ target. */
  | { kind: 'makes'; target: number }
  /** Total tracked shots across the week ≥ target (volume, makes not needed). */
  | { kind: 'attempts'; target: number }
  /** Distinct tracked sessions this week ≥ target (show-up consistency). */
  | { kind: 'sessions'; target: number }
  /** Distinct local calendar days with a tracked session ≥ target. */
  | { kind: 'practiceDays'; target: number }
  /** Distinct court spots (heat-map cells) shot from ≥ target. */
  | { kind: 'spots'; target: number }
  /** Made shots carrying an ESTIMATED 3-point value ≥ target. */
  | { kind: 'longRange'; target: number }
  /**
   * Week FG% ≥ `targetPct` (0..1) across at least `minAttempts` attempts.
   * Progress is metered in "qualifying attempts", exactly like the daily
   * fgPct kind — see {@link weeklyProgress}.
   */
  | { kind: 'fgPct'; targetPct: number; minAttempts: number }
  /**
   * Week FG% strictly better than last week's, across at least `minAttempts`
   * attempts. Needs a previous-week baseline; without one it cannot complete
   * and says so (see the note contract on {@link WeeklyResult}).
   */
  | { kind: 'beatLastWeek'; minAttempts: number };

/**
 * A weekly challenge card. Deliberately the daily {@link ChallengeDef} shape
 * with only the goal widened, so Home can render daily and weekly rows with
 * one component and a ledger can key both on `id` + `points`.
 */
export interface WeeklyChallengeDef extends Omit<ChallengeDef, 'goal'> {
  goal: WeeklyChallengeGoal;
}

/**
 * The fixed pool the weekly draw picks from. Ids are stable forever (the
 * completed ledger keys on them) and carry a 'w-' prefix so a shared points
 * ledger can never confuse a weekly id with a daily one. Points run ~3-4×
 * daily values because these take a week of work.
 */
export const WEEKLY_CHALLENGE_POOL: readonly WeeklyChallengeDef[] = [
  {
    id: 'w-makes-150',
    title: 'Make 150 shots',
    description: 'A hundred and fifty buckets before the week is out.',
    icon: 'basketball',
    points: 120,
    goal: { kind: 'makes', target: 150 },
  },
  {
    id: 'w-makes-300',
    title: 'Make 300 shots',
    description: 'Three hundred makes in seven days. Gym rat week.',
    icon: 'basketball',
    points: 200,
    goal: { kind: 'makes', target: 300 },
  },
  {
    id: 'w-attempts-300',
    title: 'Put up 300 shots',
    description: 'Three hundred attempts — makes or misses, just shoot.',
    icon: 'repeat',
    points: 100,
    goal: { kind: 'attempts', target: 300 },
  },
  {
    id: 'w-attempts-600',
    title: 'Put up 600 shots',
    description: 'Six hundred up this week. Reps compound.',
    icon: 'repeat',
    points: 180,
    goal: { kind: 'attempts', target: 600 },
  },
  {
    id: 'w-sessions-3',
    title: 'Track 3 sessions',
    description: 'Three separate trips to the gym this week.',
    icon: 'barbell',
    points: 100,
    goal: { kind: 'sessions', target: 3 },
  },
  {
    id: 'w-sessions-5',
    title: 'Track 5 sessions',
    description: 'Five sessions in one week — that is a routine.',
    icon: 'barbell',
    points: 160,
    goal: { kind: 'sessions', target: 5 },
  },
  {
    id: 'w-days-4',
    title: 'Shoot on 4 days',
    description: 'Four different days with the ball in your hands.',
    icon: 'calendar',
    points: 140,
    goal: { kind: 'practiceDays', target: 4 },
  },
  {
    id: 'w-days-6',
    title: 'Shoot on 6 days',
    description: 'Six of seven days. One rest day, no more.',
    icon: 'calendar',
    points: 220,
    goal: { kind: 'practiceDays', target: 6 },
  },
  {
    id: 'w-spots-5',
    title: 'Shoot from 5 spots',
    description: 'Cover the floor — five different court zones this week.',
    icon: 'grid',
    points: 150,
    goal: { kind: 'spots', target: 5 },
  },
  {
    id: 'w-longrange-25',
    title: 'Make 25 from deep',
    description: 'Twenty-five makes the app valued as threes (estimated).',
    icon: 'rocket',
    points: 160,
    goal: { kind: 'longRange', target: 25 },
  },
  {
    id: 'w-longrange-50',
    title: 'Make 50 from deep',
    description: 'Fifty long-range makes (3-pt value is an estimate).',
    icon: 'rocket',
    points: 240,
    goal: { kind: 'longRange', target: 50 },
  },
  {
    id: 'w-fgpct-45-100',
    title: 'Shoot 45%+ for the week',
    description: 'Week FG% at 45 or better across at least 100 attempts.',
    icon: 'stats-chart',
    points: 160,
    goal: { kind: 'fgPct', targetPct: 0.45, minAttempts: 100 },
  },
  {
    id: 'w-fgpct-55-150',
    title: 'Shoot 55%+ for the week',
    description: 'Week FG% at 55 or better across at least 150 attempts.',
    icon: 'stats-chart',
    points: 240,
    goal: { kind: 'fgPct', targetPct: 0.55, minAttempts: 150 },
  },
  {
    id: 'w-beat-last-week',
    title: 'Beat last week',
    description: 'Finish above last week FG% across at least 60 attempts.',
    icon: 'trending-up',
    points: 200,
    goal: { kind: 'beatLastWeek', minAttempts: 60 },
  },
];

/** How many challenges each week serves. */
export const WEEKLY_CHALLENGE_COUNT = 3;

// ---------------------------------------------------------------------------
// ISO-8601 week keys and windows (local calendar, like dateKeyFor)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

/** Local midnight of the day containing `nowMs`. */
function startOfLocalDay(nowMs: number): Date {
  const d = new Date(nowMs);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday-indexed weekday: Mon=0 … Sun=6 (JS getDay is Sun=0). */
function isoWeekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

/**
 * Whole local days from `a` to `b`, both local midnights. Rounds because a DST
 * transition inside the span makes a "day" 23h or 25h of wall-clock ms.
 */
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/**
 * ISO-8601 week-numbering year + week for an instant, in LOCAL time.
 *
 * The rule that makes year boundaries work: a week belongs to the year of its
 * THURSDAY, and week 1 is the week containing Jan 4 (equivalently the year's
 * first Thursday). So 2027-01-01 (a Friday) is 2026-W53, 2025-12-29 (a
 * Monday) is already 2026-W01, and 2023-01-01 (a Sunday) is 2022-W52.
 */
function isoWeekParts(nowMs: number): { year: number; week: number } {
  const day = startOfLocalDay(nowMs);
  const thursday = new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate() - isoWeekday(day) + 3,
  );
  const year = thursday.getFullYear();
  const jan4 = new Date(year, 0, 4);
  const week1Monday = new Date(year, 0, 4 - isoWeekday(jan4));
  return { year, week: 1 + Math.floor(daysBetween(week1Monday, thursday) / 7) };
}

/**
 * ISO week key ('YYYY-Www', Monday-start) for an epoch-ms instant — the weekly
 * analogue of {@link dateKeyFor}. The year is the ISO week-numbering year, NOT
 * the calendar year of the date: 2027-01-01 keys as '2026-W53'.
 */
export function isoWeekKey(nowMs: number): string {
  const { year, week } = isoWeekParts(nowMs);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Local Monday 00:00 of the ISO week containing `nowMs`. */
export function weekStartMs(nowMs: number): number {
  const day = startOfLocalDay(nowMs);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() - isoWeekday(day)).getTime();
}

/**
 * EXCLUSIVE end of the week window: local Monday 00:00 of the NEXT week. The
 * aggregation window is `weekStartMs(now) <= startedAt < weekEndMs(now)`, so
 * consecutive weeks tile without double-counting a session.
 */
export function weekEndMs(nowMs: number): number {
  const start = new Date(weekStartMs(nowMs));
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7).getTime();
}

/**
 * Local Monday 00:00 of the PREVIOUS ISO week — the baseline window for the
 * 'beatLastWeek' goal (`prevWeekStartMs(now) <= startedAt < weekStartMs(now)`).
 * Uses calendar arithmetic, not `now - 7 * MS_PER_DAY`, which lands an hour off
 * across a DST change and can fall into the wrong week near Monday midnight.
 */
export function prevWeekStartMs(nowMs: number): number {
  const start = new Date(weekStartMs(nowMs));
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7).getTime();
}

/** Do two instants fall in the same local ISO week? (weekly `isSameLocalDay`) */
export function isSameIsoWeek(aMs: number, bMs: number): boolean {
  return weekStartMs(aMs) === weekStartMs(bMs);
}

// ---------------------------------------------------------------------------
// Deterministic weekly draw
// ---------------------------------------------------------------------------

/**
 * FNV-1a 32-bit hash of the week key — the weekly seed. Deliberately the same
 * algorithm dailyChallenges.ts uses on day keys, re-declared rather than
 * imported because that module keeps its hash/PRNG private; the daily and
 * weekly draws must be able to evolve independently.
 */
function hashWeekKey(weekKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < weekKey.length; i++) {
    h ^= weekKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Mulberry32 — tiny deterministic PRNG over the week seed. */
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
 * The week's challenge set: a seeded Fisher–Yates shuffle of the pool, then a
 * greedy pass preferring distinct goal kinds (so a week never serves "make
 * 150" next to "make 300"), topped up from shuffle order if fewer than `n`
 * kinds exist. Pure: same `weekKey` ⇒ same picks in the same order, forever.
 */
export function pickWeeklyChallenges(
  weekKey: string,
  n = WEEKLY_CHALLENGE_COUNT,
): WeeklyChallengeDef[] {
  const rand = mulberry32(hashWeekKey(weekKey));
  const order = [...WEEKLY_CHALLENGE_POOL];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = order[i]!;
    order[i] = order[j]!;
    order[j] = tmp;
  }

  const picks: WeeklyChallengeDef[] = [];
  const kinds = new Set<WeeklyChallengeGoal['kind']>();
  for (const def of order) {
    if (picks.length >= n) break;
    if (kinds.has(def.goal.kind)) continue;
    kinds.add(def.goal.kind);
    picks.push(def);
  }
  // Fewer kinds than n (defensive — the pool has 8): fill from shuffle order.
  for (const def of order) {
    if (picks.length >= n) break;
    if (!picks.includes(def)) picks.push(def);
  }
  return picks;
}

/** This week's challenges for an epoch-ms instant. Same week ⇒ same picks. */
export function weeklyChallenges(
  nowMs: number,
  n = WEEKLY_CHALLENGE_COUNT,
): WeeklyChallengeDef[] {
  return pickWeeklyChallenges(isoWeekKey(nowMs), n);
}

// ---------------------------------------------------------------------------
// Week aggregate
// ---------------------------------------------------------------------------

/**
 * Everything weekly progress needs about the current week, in one flat bundle.
 *
 * The optional fields distinguish "measured as zero" from "not measured at
 * all": leave them undefined/null when the caller could not source them (rows
 * with no court placement, no previous week yet) and the evaluator explains
 * that on the card instead of showing a goal that silently cannot move.
 */
export interface WeekAggregate {
  /** Makes across the week's sessions. */
  makes: number;
  /** All tracked shots this week (makes + misses + unsure). */
  attempts: number;
  /** Sessions with at least one tracked shot this week. */
  sessions: number;
  /** Distinct local calendar days with at least one such session. */
  practiceDays: number;
  /** Distinct court spots shot from; undefined when placement is unavailable. */
  distinctSpots?: number;
  /** Makes with an ESTIMATED 3-pt value; undefined when values are unavailable. */
  longRangeMakes?: number;
  /** makes / decided (make+miss) this week, 0..1; null when nothing decided. */
  fgPct?: number | null;
  /** Same for the previous ISO week; null when there is no baseline yet. */
  prevWeekFgPct?: number | null;
}

export function emptyWeekAggregate(): WeekAggregate {
  return {
    makes: 0,
    attempts: 0,
    sessions: 0,
    practiceDays: 0,
    distinctSpots: 0,
    longRangeMakes: 0,
    fgPct: null,
    prevWeekFgPct: null,
  };
}

/** The per-shot slice {@link weekAggregate} needs. */
export interface WeekShotFacts {
  outcome: ShotOutcome;
  /** Estimated point value (2 or 3) when the app could value the shot. */
  shotValue?: number | null;
  /**
   * Court spot key, e.g. a heat-map cell id like 'left:far' (src/core/heatmap.ts
   * zone × band). Null/absent when the shot had no usable origin — those shots
   * simply do not contribute to court coverage.
   */
  spotKey?: string | null;
}

/** The per-session slice {@link weekAggregate} needs (shape of db.ts rows). */
export interface WeekSessionFacts {
  /** Session start, epoch ms — the instant the week window is tested against. */
  startedAt: number;
  shots: readonly WeekShotFacts[];
}

export interface WeekFoldOptions {
  /** Previous ISO week's FG% (0..1), or null when there is no baseline. */
  prevWeekFgPct?: number | null;
  /**
   * Set false when the caller's shot rows carry no court placement at all (a
   * narrow read that does not select an origin). `distinctSpots` is then left
   * undefined — "not measured" — instead of a misleading 0.
   */
  spotsMeasured?: boolean;
  /** Same, for the 2/3 point-value estimate behind `longRangeMakes`. */
  longRangeMeasured?: boolean;
}

/**
 * Folds one week's sessions into a {@link WeekAggregate}. Pure — the caller
 * filters to the window first (`weekStartMs <= startedAt < weekEndMs`).
 *
 * A session with no tracked shots counts as neither a session nor a practice
 * day: an app opened and closed is not practice. A session is filed under the
 * local day it STARTED on, so a run across midnight counts once.
 */
export function weekAggregate(
  sessions: readonly WeekSessionFacts[],
  opts: WeekFoldOptions = {},
): WeekAggregate {
  let makes = 0;
  let attempts = 0;
  let decided = 0;
  let longRangeMakes = 0;
  let sessionCount = 0;
  const days = new Set<string>();
  const spots = new Set<string>();

  for (const session of sessions) {
    if (session.shots.length === 0) continue;
    sessionCount += 1;
    days.add(dateKeyFor(session.startedAt));
    for (const shot of session.shots) {
      attempts += 1;
      if (shot.spotKey) spots.add(shot.spotKey);
      if (shot.outcome === 'make') {
        makes += 1;
        decided += 1;
        if (shot.shotValue === 3) longRangeMakes += 1;
      } else if (shot.outcome === 'miss') {
        decided += 1;
      }
      // 'unsure' counts as an attempt only — it never moves FG% (src/core/stats.ts).
    }
  }

  return {
    makes,
    attempts,
    sessions: sessionCount,
    practiceDays: days.size,
    distinctSpots: opts.spotsMeasured === false ? undefined : spots.size,
    longRangeMakes: opts.longRangeMeasured === false ? undefined : longRangeMakes,
    fgPct: decided > 0 ? makes / decided : null,
    prevWeekFgPct: opts.prevWeekFgPct ?? null,
  };
}

// ---------------------------------------------------------------------------
// Progress math
// ---------------------------------------------------------------------------

/**
 * The integer denominator a weekly goal runs to (the "goal" in the card's
 * n/goal readout). Percentage goals meter progress in qualifying attempts, so
 * their denominator is the attempt floor.
 */
export function weeklyGoalTarget(goal: WeeklyChallengeGoal): number {
  return goal.kind === 'fgPct' || goal.kind === 'beatLastWeek' ? goal.minAttempts : goal.target;
}

/**
 * The week's FG% and whether it is directly measured. `fgPct` is the honest
 * number (decided shots only). The fallback divides by ALL attempts because
 * that is the only denominator left — it treats 'unsure' shots as misses and
 * therefore UNDER-states FG%, so it is flagged as not directly measured.
 */
function weekFgPct(agg: WeekAggregate): { pct: number; measured: boolean } {
  if (agg.fgPct != null && Number.isFinite(agg.fgPct)) return { pct: agg.fgPct, measured: true };
  if (agg.attempts > 0) return { pct: agg.makes / agg.attempts, measured: false };
  return { pct: 0, measured: false };
}

/**
 * Floor a qualifying-attempt count with a hair of tolerance. Straight
 * Math.floor turns IEEE-754 noise into a visibly wrong readout: 0.3/0.4 is
 * 0.7499999999999999, so a 30%-vs-40% week would show 44/60 instead of 45/60.
 * The epsilon is far below one attempt, so it can never fill a bar early.
 */
function floorAttempts(value: number): number {
  return Math.floor(value + 1e-9);
}

/** Why a goal cannot move, when the reason is missing input rather than effort. */
function weeklyNote(goal: WeeklyChallengeGoal, agg: WeekAggregate): string | undefined {
  if (goal.kind === 'spots' && agg.distinctSpots == null) {
    return 'Court position was not recorded for these sessions, so spots cannot be counted.';
  }
  if (goal.kind === 'longRange' && agg.longRangeMakes == null) {
    return 'These shots carry no 2/3 point-value estimate, so long-range makes cannot be counted.';
  }
  if (goal.kind === 'beatLastWeek' && agg.prevWeekFgPct == null) {
    return 'No previous week on record yet — this one unlocks after a full week of tracking.';
  }
  return undefined;
}

/**
 * Progress toward a weekly goal, clamped to 0..{@link weeklyGoalTarget}.
 *
 * Counting kinds read straight off the aggregate (an unmeasured optional
 * counts as 0 — the note says why). The two percentage kinds meter progress in
 * "qualifying attempts", the same trick the daily fgPct kind uses: the smaller
 * of (a) attempts taken, capped at the floor, and (b) the floor scaled by how
 * much of the required percentage is actually being shot. The bar therefore
 * only tops out when BOTH the volume floor and the percentage are met, and
 * 'beatLastWeek' is held one shy of full while you are merely MATCHING last
 * week — matching is not beating.
 */
export function weeklyProgress(def: WeeklyChallengeDef, agg: WeekAggregate): number {
  const goal = def.goal;
  const target = weeklyGoalTarget(goal);
  if (target <= 0) return 0;

  let raw: number;
  switch (goal.kind) {
    case 'makes':
      raw = agg.makes;
      break;
    case 'attempts':
      raw = agg.attempts;
      break;
    case 'sessions':
      raw = agg.sessions;
      break;
    case 'practiceDays':
      raw = agg.practiceDays;
      break;
    case 'spots':
      raw = agg.distinctSpots ?? 0;
      break;
    case 'longRange':
      raw = agg.longRangeMakes ?? 0;
      break;
    case 'fgPct': {
      const { pct } = weekFgPct(agg);
      const ratio = goal.targetPct > 0 ? pct / goal.targetPct : 1;
      raw = Math.min(agg.attempts, floorAttempts(goal.minAttempts * Math.min(1, ratio)));
      break;
    }
    case 'beatLastWeek': {
      const prev = agg.prevWeekFgPct;
      if (prev == null || !Number.isFinite(prev)) {
        raw = 0;
        break;
      }
      const { pct } = weekFgPct(agg);
      const ratio = prev > 0 ? pct / prev : pct > 0 ? 1 : 0;
      raw = Math.min(agg.attempts, floorAttempts(goal.minAttempts * Math.min(1, ratio)));
      // Equal is not better: hold the bar one shy of full so the check can only
      // land on a strict improvement, while still showing the reps logged.
      if (pct <= prev) raw = Math.min(raw, target - 1);
      break;
    }
  }
  return Math.max(0, Math.min(target, raw));
}

/** One evaluated weekly challenge — what a card renders. */
export interface WeeklyResult {
  def: WeeklyChallengeDef;
  /** 0..target. */
  progress: number;
  target: number;
  done: boolean;
  /**
   * Present only when the goal is blocked by MISSING INPUT (no baseline week,
   * no court placement, no point-value estimate) rather than by effort. Show
   * it on the card so a stuck bar is never mistaken for a lazy week.
   */
  note?: string;
}

/**
 * Evaluate a week's challenges against the week aggregate. Pure and total:
 * every kind returns a finite, clamped progress, and `done` is exactly
 * `progress >= target` so the bar and the check can never disagree.
 */
export function evaluateWeekly(
  defs: readonly WeeklyChallengeDef[],
  agg: WeekAggregate,
): WeeklyResult[] {
  return defs.map((def) => {
    const target = weeklyGoalTarget(def.goal);
    const progress = weeklyProgress(def, agg);
    const note = weeklyNote(def.goal, agg);
    const result: WeeklyResult = { def, progress, target, done: progress >= target };
    if (note !== undefined) result.note = note;
    return result;
  });
}

/**
 * Points earned by the completed challenges in an evaluation. A pure sum — the
 * store owns idempotence (an id already awarded this week is a no-op there),
 * so recomputing this on every focus is safe.
 */
export function weeklyPoints(results: readonly WeeklyResult[]): number {
  return results.reduce((sum, r) => (r.done ? sum + Math.max(0, r.def.points) : sum), 0);
}
