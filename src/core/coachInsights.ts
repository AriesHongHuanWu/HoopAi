/**
 * Coach insights — pure aggregates over a CoachSession window that power the
 * coach tab's timeline, form-readiness meter, season strip and arc profile.
 * No I/O, no wall clock: every timestamp is a parameter, so the module is
 * deterministic and unit-testable.
 *
 * This module deliberately reuses weeklyReport's exported week helpers
 * (weekStart / weekEnd / weekLabel / sessionsInWeek / weekShootingScore)
 * instead of calling buildWeeklyReport per week: buildWeeklyReport runs
 * runCoach for its findings, and the timeline never shows findings, so
 * building 4 full reports per render would burn the coach engine 4× for
 * nothing.
 */
// Deliberate display-layer import: arcProfile must grade with EXACTLY the
// band the live HUD grades with, and arcHudGeometry is dependency-free pure
// math (no Skia/React/Reanimated), so core stays plain-jest testable.
import {
  ARC_ENTRY_IDEAL_MAX,
  ARC_ENTRY_IDEAL_MIN,
} from '../components/hud/arcHudGeometry';
import type { CoachSession } from './coachEngine';
import type { ResolvedShot } from './types';
import {
  sessionsInWeek,
  weekEnd,
  weekLabel,
  weekShootingScore,
  weekStart,
} from './weeklyReport';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Shared tallies
// ---------------------------------------------------------------------------

/** Makes + decided (make|miss) counts across a session set's shots. */
function tallyShots(sessions: readonly CoachSession[]): {
  makes: number;
  decided: number;
} {
  let makes = 0;
  let decided = 0;
  for (const s of sessions) {
    for (const shot of s.shots) {
      if (shot.outcome === 'make') {
        makes += 1;
        decided += 1;
      } else if (shot.outcome === 'miss') {
        decided += 1;
      }
    }
  }
  return { makes, decided };
}

function attemptsOf(sessions: readonly CoachSession[]): number {
  return sessions.reduce((n, s) => n + s.stats.attempts, 0);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export interface TimelineWeek {
  /** Monday 00:00 local (epoch ms) of this week. */
  weekStartMs: number;
  /** "Jun 22 – 28" style label (weekLabel). */
  label: string;
  sessions: number;
  attempts: number;
  makes: number;
  /** FG% over decided shots, null when nothing decided. */
  fgPct: number | null;
  /** 0..100 Week Shooting Score (weekShootingScore); 0 for empty weeks. */
  wss: number;
}

/**
 * The `count` consecutive weeks ending with the week containing
 * `anchorWeekMs`, OLDEST-FIRST. Empty weeks are included with zeros / null
 * fgPct so the timeline always has a fixed number of columns.
 *
 * Week starts are derived by walking back with `weekStart(prevStart - 1)`
 * rather than subtracting fixed 7-day blocks: weekStart normalizes to local
 * Monday 00:00, so the walk stays DST-safe.
 */
export function coachTimeline(
  sessions: readonly CoachSession[],
  anchorWeekMs: number,
  count = 4,
): TimelineWeek[] {
  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return [];

  // Newest-first walk back, then reverse to oldest-first.
  const starts: number[] = [weekStart(anchorWeekMs)];
  for (let i = 1; i < n; i++) {
    starts.push(weekStart(starts[starts.length - 1]! - 1));
  }
  starts.reverse();

  return starts.map((start) => {
    const weekSessions = sessionsInWeek(sessions, start);
    const { makes, decided } = tallyShots(weekSessions);
    return {
      weekStartMs: start,
      label: weekLabel(start),
      sessions: weekSessions.length,
      attempts: attemptsOf(weekSessions),
      makes,
      fgPct: decided > 0 ? makes / decided : null,
      wss: weekShootingScore(weekSessions),
    };
  });
}

// ---------------------------------------------------------------------------
// Form readiness
// ---------------------------------------------------------------------------

export interface FormReadiness {
  /** Shots inspected. */
  total: number;
  /** Shots with a form report at all (form analysis produced output). */
  withBallFlight: number;
  /** Shots with any pose-derived metric (pose model actually tracked). */
  withPose: number;
  /** withPose / total, 0 when total === 0. */
  posePct: number;
  level: 'off' | 'sparse' | 'ready';
}

/**
 * How much pose-based form data the window actually carries. Ball-flight
 * metrics (releaseAngleDeg / entryAngleDeg) do NOT count as pose — they come
 * from the ball trajectory and exist even with the pose model off; only the
 * pose-derived metrics prove the pose pipeline ran.
 */
export function formReadiness(shots: readonly ResolvedShot[]): FormReadiness {
  const total = shots.length;
  let withBallFlight = 0;
  let withPose = 0;
  for (const shot of shots) {
    const m = shot.form?.metrics;
    if (m == null) continue;
    withBallFlight += 1;
    const pose =
      m.setPointElbowDeg ??
      m.kneeFlexionDeg ??
      m.releaseTimeMs ??
      m.followThroughHeldMs ??
      m.followThroughElbowDeg ??
      m.releaseHeightNorm;
    if (pose != null) withPose += 1;
  }
  const posePct = total > 0 ? withPose / total : 0;
  const level: FormReadiness['level'] =
    total === 0 || withPose === 0 ? 'off' : posePct < 0.5 ? 'sparse' : 'ready';
  return { total, withBallFlight, withPose, posePct, level };
}

// ---------------------------------------------------------------------------
// Season comparison
// ---------------------------------------------------------------------------

export interface SeasonBlock {
  sessions: number;
  attempts: number;
  makes: number;
  /** FG% over decided shots, null when nothing decided in the block. */
  fgPct: number | null;
}

export interface SeasonComparison {
  /** The 28 days ending at weekEnd(anchorWeekMs). */
  recent: SeasonBlock;
  /** The 28 days before that. */
  prior: SeasonBlock;
  /** (recent FG − prior FG) in POINTS; null unless both blocks decided shots. */
  fgDeltaPts: number | null;
  attemptsDelta: number;
  sessionsDelta: number;
}

function blockOf(sessions: readonly CoachSession[]): SeasonBlock {
  const { makes, decided } = tallyShots(sessions);
  return {
    sessions: sessions.length,
    attempts: attemptsOf(sessions),
    makes,
    fgPct: decided > 0 ? makes / decided : null,
  };
}

/**
 * Recent 28-day block vs the prior 28 days, both anchored at
 * weekEnd(anchorWeekMs) so the comparison is deterministic per selected week:
 * recent = [end − 28d, end), prior = [end − 56d, end − 28d). Fixed 28-day
 * blocks are intentionally calendar-simple (four training weeks each), not
 * ISO-month aligned — equal-length windows keep the deltas honest.
 */
export function seasonComparison(
  sessions: readonly CoachSession[],
  anchorWeekMs: number,
): SeasonComparison {
  const end = weekEnd(anchorWeekMs);
  const recentStart = end - 28 * DAY_MS;
  const priorStart = end - 56 * DAY_MS;

  const recentSessions: CoachSession[] = [];
  const priorSessions: CoachSession[] = [];
  for (const s of sessions) {
    if (s.startedAt >= recentStart && s.startedAt < end) {
      recentSessions.push(s);
    } else if (s.startedAt >= priorStart && s.startedAt < recentStart) {
      priorSessions.push(s);
    }
  }

  const recent = blockOf(recentSessions);
  const prior = blockOf(priorSessions);
  const fgDeltaPts =
    recent.fgPct != null && prior.fgPct != null
      ? (recent.fgPct - prior.fgPct) * 100
      : null;

  return {
    recent,
    prior,
    fgDeltaPts,
    attemptsDelta: recent.attempts - prior.attempts,
    sessionsDelta: recent.sessions - prior.sessions,
  };
}

// ---------------------------------------------------------------------------
// Arc profile
// ---------------------------------------------------------------------------

export interface ArcProfile {
  /** Shots that carried a DETECTED entry angle — everything else is excluded. */
  n: number;
  /** Mean detected entry angle in degrees, null when n === 0. */
  avgEntryDeg: number | null;
  /** Fraction of n inside the ideal band (inclusive edges), null when n === 0. */
  idealPct: number | null;
  /** Fraction of n below the band, null when n === 0. */
  flatPct: number | null;
  /** Fraction of n above the band, null when n === 0. */
  steepPct: number | null;
}

/**
 * Split of DETECTED entry angles into flat / ideal / steep against the same
 * band the live HUD grades with ([ARC_ENTRY_IDEAL_MIN, ARC_ENTRY_IDEAL_MAX]
 * inclusive — arcQuality in src/components/hud/arcHudGeometry.ts), so the
 * coach tab's Arc Profile card can never disagree with the on-court readout.
 * Shots without a detected entry angle (null, or a non-finite value from bad
 * persisted data) are excluded from n entirely: this is a read of what the
 * camera measured, never a claim about every shot taken. Display aggregate
 * only — nothing here feeds arming, judging, or make/miss.
 */
export function arcProfile(
  shots: readonly { entryAngleDeg: number | null }[],
): ArcProfile {
  let n = 0;
  let sum = 0;
  let flat = 0;
  let ideal = 0;
  let steep = 0;
  for (const shot of shots) {
    const deg = shot.entryAngleDeg;
    if (deg == null || !Number.isFinite(deg)) continue;
    n += 1;
    sum += deg;
    if (deg < ARC_ENTRY_IDEAL_MIN) flat += 1;
    else if (deg > ARC_ENTRY_IDEAL_MAX) steep += 1;
    else ideal += 1;
  }
  if (n === 0) {
    return { n: 0, avgEntryDeg: null, idealPct: null, flatPct: null, steepPct: null };
  }
  return {
    n,
    avgEntryDeg: sum / n,
    idealPct: ideal / n,
    flatPct: flat / n,
    steepPct: steep / n,
  };
}
