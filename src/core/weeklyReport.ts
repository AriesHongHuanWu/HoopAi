/**
 * Weekly report — a Monday→Sunday summary of a week of shooting, built purely
 * from a session window (stats + shots + start times). No I/O, no wall clock:
 * "now"/week boundaries are passed in, so the whole module is deterministic
 * and unit-testable.
 *
 * Products (one {@link WeeklyReport}):
 *  - headline stat (makes / FG% for the week)
 *  - WSS — a 0..100 "Week Shooting Score" blending volume, accuracy and
 *    consistency into one broadcast number
 *  - FG% vs the PRIOR week (delta in points)
 *  - best session (highest FG% over a real sample)
 *  - hottest zone (best FG% zone with enough attempts)
 *  - top-3 coach findings for the week (via {@link runCoach})
 *  - next-week focus (one line, drawn from the #1 finding or a positive note)
 */
import { runCoach, type CoachFinding, type CoachSession } from './coachEngine';
import { zoneOf } from './stats';
import type { ChartZone, ResolvedShot } from './types';

// ---------------------------------------------------------------------------
// Week boundaries
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start (Monday 00:00 LOCAL) of the ISO week containing `ms`. Monday-based so
 * "this week" matches how players think of a training week. Returns epoch ms.
 */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0 = Sun … 6 = Sat. Days since Monday: Sun→6, Mon→0 … Sat→5.
  const daysSinceMon = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - daysSinceMon);
  return d.getTime();
}

/** Exclusive end (next Monday 00:00) of the week containing `ms`. */
export function weekEnd(ms: number): number {
  return weekStart(ms) + 7 * DAY_MS;
}

/** A compact "MON D – SUN D" label for the week containing `ms`. */
export function weekLabel(ms: number): string {
  const start = new Date(weekStart(ms));
  const end = new Date(weekStart(ms) + 6 * DAY_MS);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const a = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
  const b =
    start.getMonth() === end.getMonth()
      ? `${end.getDate()}`
      : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
  return `${a} – ${b}`;
}

/** Sessions whose start falls inside [weekStart, weekEnd) of `weekOfMs`. */
export function sessionsInWeek(
  sessions: readonly CoachSession[],
  weekOfMs: number,
): CoachSession[] {
  const start = weekStart(weekOfMs);
  const end = weekEnd(weekOfMs);
  return sessions.filter((s) => s.startedAt >= start && s.startedAt < end);
}

// ---------------------------------------------------------------------------
// Report model
// ---------------------------------------------------------------------------

export interface BestSession {
  id: number;
  label?: string;
  startedAt: number;
  fgPct: number;
  makes: number;
  attempts: number;
}

export interface HottestZone {
  zone: ChartZone;
  fgPct: number;
  makes: number;
  decided: number;
}

export interface WeeklyReport {
  /** Monday 00:00 (epoch ms) this report covers. */
  weekStartMs: number;
  /** "MON D – SUN D" label. */
  label: string;
  sessions: number;
  attempts: number;
  makes: number;
  /** Week FG% over decided shots, or null when nothing was decided. */
  fgPct: number | null;
  points: number;
  /** Longest make streak within the week (streaks don't span sessions). */
  bestStreak: number;
  /** 0..100 Week Shooting Score (see {@link weekShootingScore}). */
  wss: number;
  /** FG% delta vs the prior week, in POINTS (null if either week is empty). */
  fgDeltaPtsVsPrior: number | null;
  /** Highest-FG% session of the week over a real sample (null if none qualify). */
  bestSession: BestSession | null;
  /** Best-FG% zone with enough attempts (null when no zone qualifies). */
  hottestZone: HottestZone | null;
  /** Up to three ranked coach findings for the week. */
  findings: CoachFinding[];
  /** One-line focus for next week. */
  nextWeekFocus: string;
  /** The one-line headline, e.g. "42 makes at 58% across 3 sessions." */
  headline: string;
}

// ---------------------------------------------------------------------------
// WSS — Week Shooting Score
// ---------------------------------------------------------------------------

/** Decided shots of a session set. */
function decidedOf(sessions: readonly CoachSession[]): ResolvedShot[] {
  const out: ResolvedShot[] = [];
  for (const s of sessions) {
    for (const shot of s.shots) {
      if (shot.outcome === 'make' || shot.outcome === 'miss') out.push(shot);
    }
  }
  return out;
}

function releaseAnglesOf(shots: readonly ResolvedShot[]): number[] {
  const out: number[] = [];
  for (const s of shots) {
    const v = s.releaseAngleDeg ?? s.form?.metrics.releaseAngleDeg ?? null;
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function stdOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/** Clamp helper. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Week Shooting Score (0..100): a single broadcast number blending three
 * things a week of shooting should reward —
 *  - ACCURACY (60%): FG% mapped so 30%→0, 70%→100 (the amateur working band).
 *  - VOLUME (25%): attempts toward a 150-shot week, saturating (reps matter,
 *    but you can't out-volume a broken shot).
 *  - CONSISTENCY (15%): release-angle σ, 8°→0, 2°→full credit; neutral 0.5
 *    credit when there aren't enough angle samples to judge.
 *
 * Empty week ⇒ 0. Pure; exported for its own unit test.
 */
export function weekShootingScore(sessions: readonly CoachSession[]): number {
  const decided = decidedOf(sessions);
  if (decided.length === 0) return 0;
  const makes = decided.filter((s) => s.outcome === 'make').length;
  const fg = makes / decided.length;

  const accuracy = clamp((fg - 0.3) / 0.4, 0, 1);

  const attempts = sessions.reduce((n, s) => n + s.stats.attempts, 0);
  const volume = clamp(attempts / 150, 0, 1);

  const angles = releaseAnglesOf(decided);
  let consistency = 0.5;
  if (angles.length >= 5) {
    const sd = stdOf(angles)!;
    consistency = clamp((8 - sd) / 6, 0, 1);
  }

  const score = 100 * (0.6 * accuracy + 0.25 * volume + 0.15 * consistency);
  return Math.round(clamp(score, 0, 100));
}

// ---------------------------------------------------------------------------
// Zone + best-session helpers
// ---------------------------------------------------------------------------

const ZONE_MIN_ATTEMPTS = 4;
const BEST_SESSION_MIN_ATTEMPTS = 6;

function hottestZoneOf(shots: readonly ResolvedShot[]): HottestZone | null {
  const tally: Record<ChartZone, { makes: number; decided: number }> = {
    left: { makes: 0, decided: 0 },
    center: { makes: 0, decided: 0 },
    right: { makes: 0, decided: 0 },
  };
  for (const s of shots) {
    const z = zoneOf(s.originX);
    if (z == null) continue;
    tally[z].decided += 1;
    if (s.outcome === 'make') tally[z].makes += 1;
  }
  let best: HottestZone | null = null;
  for (const zone of Object.keys(tally) as ChartZone[]) {
    const { makes, decided } = tally[zone];
    if (decided < ZONE_MIN_ATTEMPTS) continue;
    const fgPct = makes / decided;
    if (best == null || fgPct > best.fgPct) {
      best = { zone, fgPct, makes, decided };
    }
  }
  return best;
}

function bestSessionOf(sessions: readonly CoachSession[]): BestSession | null {
  let best: BestSession | null = null;
  for (const s of sessions) {
    const decided = s.stats.makes + s.stats.misses;
    if (s.stats.attempts < BEST_SESSION_MIN_ATTEMPTS || decided === 0) continue;
    const fgPct = s.stats.fgPct;
    if (best == null || fgPct > best.fgPct) {
      best = {
        id: s.id,
        label: s.label,
        startedAt: s.startedAt,
        fgPct,
        makes: s.stats.makes,
        attempts: s.stats.attempts,
      };
    }
  }
  return best;
}

/** Longest make streak within a week (streaks never span sessions). */
function bestStreakOf(sessions: readonly CoachSession[]): number {
  let best = 0;
  for (const s of sessions) {
    let run = 0;
    for (const shot of s.shots) {
      if (shot.outcome === 'make') {
        run += 1;
        if (run > best) best = run;
      } else if (shot.outcome === 'miss') {
        run = 0;
      }
      // 'unsure' leaves the streak untouched (matches src/core/stats.ts).
    }
  }
  return best;
}

function fgOf(sessions: readonly CoachSession[]): number | null {
  const decided = decidedOf(sessions);
  if (decided.length === 0) return null;
  const makes = decided.filter((s) => s.outcome === 'make').length;
  return makes / decided.length;
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build the weekly report for the week containing `weekOfMs` (defaults to the
 * most recent session's week, or the empty-week shell when there are none).
 *
 * `sessions` is the full available window; this function slices out the target
 * week and the prior week for the delta itself. Deterministic — no clock read.
 */
export function buildWeeklyReport(
  sessions: readonly CoachSession[],
  weekOfMs: number,
): WeeklyReport {
  const weekStartMs = weekStart(weekOfMs);
  const label = weekLabel(weekOfMs);
  const thisWeek = sessionsInWeek(sessions, weekOfMs);
  const priorWeek = sessionsInWeek(sessions, weekStartMs - DAY_MS);

  const decided = decidedOf(thisWeek);
  const makes = decided.filter((s) => s.outcome === 'make').length;
  const attempts = thisWeek.reduce((n, s) => n + s.stats.attempts, 0);
  const points = thisWeek.reduce((n, s) => n + s.stats.points, 0);
  const fgPct = decided.length > 0 ? makes / decided.length : null;

  const priorFg = fgOf(priorWeek);
  const fgDeltaPtsVsPrior =
    fgPct != null && priorFg != null ? (fgPct - priorFg) * 100 : null;

  const findings = runCoach(thisWeek).slice(0, 3);
  const bestSession = bestSessionOf(thisWeek);
  const hottestZone = hottestZoneOf(decided);
  const wss = weekShootingScore(thisWeek);
  const bestStreak = bestStreakOf(thisWeek);

  const headline =
    thisWeek.length === 0
      ? 'No sessions logged this week.'
      : fgPct != null
        ? `${makes} makes at ${Math.round(fgPct * 100)}% across ${thisWeek.length} ${thisWeek.length === 1 ? 'session' : 'sessions'}.`
        : `${attempts} shots logged across ${thisWeek.length} ${thisWeek.length === 1 ? 'session' : 'sessions'}.`;

  const nextWeekFocus = deriveFocus(findings, fgDeltaPtsVsPrior, hottestZone);

  return {
    weekStartMs,
    label,
    sessions: thisWeek.length,
    attempts,
    makes,
    fgPct,
    points,
    bestStreak,
    wss,
    fgDeltaPtsVsPrior,
    bestSession,
    hottestZone,
    findings,
    nextWeekFocus,
    headline,
  };
}

/**
 * One-line focus for next week. Prefers the top actionable finding's
 * prescription-in-brief; falls back to a positive maintenance note when the
 * week was clean (or improving).
 */
function deriveFocus(
  findings: readonly CoachFinding[],
  fgDeltaPtsVsPrior: number | null,
  hottestZone: HottestZone | null,
): string {
  // A real problem to attack takes priority (severity ≥ 2, and not the
  // "improving" celebration).
  const problem = findings.find((f) => f.severity >= 2 && f.id !== 'improving');
  if (problem) return problem.title;
  if (fgDeltaPtsVsPrior != null && fgDeltaPtsVsPrior >= 5) {
    return 'Keep the reps coming — you\'re trending up.';
  }
  if (hottestZone) {
    const name: Record<ChartZone, string> = {
      left: 'the left',
      center: 'the middle',
      right: 'the right',
    };
    return `Ride your hot zone (${name[hottestZone.zone]}) and stretch your range from there.`;
  }
  return 'Log a few sessions this week — the coach needs data to work with.';
}
