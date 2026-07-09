/**
 * Coach engine — the "Coach's Corner" reasoning layer.
 *
 * Pure TypeScript over a WINDOW of recent sessions (each = stats + shots +
 * start time). No I/O, no React, no wall clock — every input is passed in, so
 * the whole thing is unit-testable and deterministic.
 *
 * Where {@link module:shotLab} answers "what separates YOUR makes from YOUR
 * misses in one session", this engine steps back to the multi-session view a
 * coach actually works from: is your entry angle chronically flat? drifting
 * off a baseline? are you streaky-but-cold? does your second half fall apart?
 * is one zone a black hole? It turns those into a ranked list of
 * {@link CoachFinding}s, each carrying REAL numbers (the evidence), a concrete
 * prescription (a drill or a change), and a trend arrow versus the earlier
 * part of the window.
 *
 * DESIGN
 * ------
 * - Every rule is a small pure function returning a finding or null. The
 *   registry {@link RULES} is ordered; `runCoach` runs them all, drops nulls,
 *   and sorts by severity then evidence strength.
 * - "Evidence" is always a measured quantity with units, never a vibe.
 * - "Trend" compares the recent half of the window to the older half so the
 *   card can say "improving" / "worsening" / "flat" honestly.
 * - Thresholds live in {@link COACH} so the benchmark clip pass can tune them.
 */
import { DEFAULT_3PT_RIMWIDTHS, FORM } from './config';
import { DRILLS, type DrillId } from './drills';
import { buildHeatmap, cellLabel, type HeatCell } from './heatmap';
import { BENCHMARK_AXES, type BenchmarkAxis } from './nbaBenchmarks';
import { metricOf, type LabMetricKey } from './shotLab';
import { zoneOf } from './stats';
import type { ChartZone, ResolvedShot, SessionStats } from './types';

// ---------------------------------------------------------------------------
// Input model
// ---------------------------------------------------------------------------

/**
 * One session as the coach sees it: the derived stats, the raw shots (for
 * angle/zone/form drilldowns), and when it was played (epoch ms — used only
 * for ordering and the weekly report, never for a live clock read).
 */
export interface CoachSession {
  /** Persisted session id, for the UI to deep-link a finding back to a session. */
  id: number;
  /** Epoch ms the session started. */
  startedAt: number;
  stats: SessionStats;
  shots: readonly ResolvedShot[];
  /** Optional human label (session title / tag), surfaced in evidence copy. */
  label?: string;
}

// ---------------------------------------------------------------------------
// Output model
// ---------------------------------------------------------------------------

/** 1 = note, 2 = worth fixing, 3 = the headline problem to attack first. */
export type Severity = 1 | 2 | 3;

/** Direction of change across the window (recent half vs older half). */
export type Trend = 'improving' | 'worsening' | 'flat' | 'n/a';

export type FindingKind =
  | 'entryAngleLow'
  | 'entryAngleVolatile'
  | 'releaseDrift'
  | 'zoneImbalance'
  | 'coldZone'
  | 'sideBias'
  | 'streaky'
  | 'fatigue'
  | 'twoVsThree'
  | 'threePtFlat'
  | 'unsureRate'
  | 'volumeTrend'
  | 'nbaBand'
  | 'formRegression'
  | 'improving';

export interface CoachFinding {
  /** Stable id for React keys + analytics. */
  id: FindingKind;
  severity: Severity;
  /** Short imperative headline, e.g. "Your arc is flat". */
  title: string;
  /** One line of the user's OWN numbers that proves the finding. */
  evidence: string;
  /** What to do about it — a drill or a concrete change. */
  prescription: string;
  /** Recent-vs-older direction, so the card can show an arrow. */
  trend: Trend;
  /**
   * Normalized strength of the finding (0..~2), used only to break severity
   * ties in the ranking. Bigger = more clearly outside its band.
   */
  strength: number;
  /** Drill this finding prescribes, overriding FINDING_DRILL when set. */
  drillId?: DrillId;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const COACH = {
  /** Entry angle below this (session-avg mean) reads as chronically flat. */
  entryAngleLowDeg: 40,
  /** Entry-angle σ above this over the window flags an inconsistent touch. */
  entryAngleVolatileStdDeg: 8,
  /** Release-angle mean drift (recent vs baseline) beyond this flags drift. */
  releaseDriftDeg: 5,
  /** Release angle dropping this many degrees on 3s vs 2s = arc flattening. */
  threePtFlatDeg: 4,
  /** Best-zone minus worst-zone FG% gap (points) above this = imbalance. */
  zoneGapPts: 25,
  /** Median make-vs-miss horizontal-cross offset (rim widths) for side bias. */
  sideBiasRimWidths: 0.6,
  /** "Streaky": a best run this long or longer while FG% stays under coldFg. */
  streakyBestRun: 4,
  streakyColdFg: 0.4,
  /** Fatigue: second-half FG% must fall this many points below the first. */
  fatigueDropPts: 12,
  /** 2pt-vs-3pt efficiency gap (points) above this is worth a note. */
  twoThreeGapPts: 25,
  /** Unsure share of attempts above this hurts the data quality. */
  unsureRateFrac: 0.25,
  /** Week-over-week volume change beyond this fraction is a real swing. */
  volumeTrendFrac: 0.4,
  /** A 3-week improvement worth celebrating: FG% up at least this (points). */
  celebrateFgGainPts: 8,
  /** A heat-map cell needs this many decided attempts to rank as a cold zone. */
  coldZoneMinCellAttempts: 5,
  /** Window FG% minus worst-cell FG% (points) at/above which coldZone fires. */
  coldZoneGapPts: 20,
  /** Min form-metric samples per window half before regression can compare. */
  formRegressionMinPerHalf: 6,
  /** Per-metric deadband on the deviation-from-band increase (metric's unit). */
  formRegressionDeadband: { setPointElbowDeg: 6, kneeFlexionDeg: 8, releaseTimeMs: 90, followThroughHeldMs: 80 },
  /** Minimum decided shots before most rules will speak at all. */
  minDecided: 8,
  /** Minimum sessions before window-level trend rules engage. */
  minSessions: 2,
} as const;

// ---------------------------------------------------------------------------
// Small stats helpers (kept local — coach-specific, tiny)
// ---------------------------------------------------------------------------

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Population σ (ddof = 0), matching src/core/stats.ts. Null for empty. */
function std(xs: readonly number[]): number | null {
  const m = mean(xs);
  if (m == null) return null;
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

function pct(frac: number): string {
  return `${Math.round(frac * 100)}%`;
}

/** Decided (make|miss) shots — corrections respected via the outcome field. */
function decided(shots: readonly ResolvedShot[]): ResolvedShot[] {
  return shots.filter((s) => s.outcome === 'make' || s.outcome === 'miss');
}

/** Collect a lab metric across shots (nulls dropped). */
function collect(shots: readonly ResolvedShot[], key: LabMetricKey): number[] {
  const out: number[] = [];
  for (const s of shots) {
    const v = metricOf(s, key);
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return out;
}

/**
 * Split the window into an OLDER half and a RECENT half by session order
 * (input is assumed newest-first; we sort defensively). Used by trend rules.
 */
function halves<T>(items: readonly T[]): { older: T[]; recent: T[] } {
  const n = items.length;
  if (n < 2) return { older: [], recent: [...items] };
  const cut = Math.ceil(n / 2);
  // Caller passes newest-first, so the FRONT is recent, the BACK is older.
  return { recent: items.slice(0, cut), older: items.slice(cut) };
}

/** Trend label from an older→recent delta where LOWER is better (e.g. σ). */
function trendLowerBetter(older: number | null, recent: number | null, eps: number): Trend {
  if (older == null || recent == null) return 'n/a';
  if (recent < older - eps) return 'improving';
  if (recent > older + eps) return 'worsening';
  return 'flat';
}

/** Trend label from an older→recent delta where HIGHER is better (e.g. FG%). */
function trendHigherBetter(older: number | null, recent: number | null, eps: number): Trend {
  if (older == null || recent == null) return 'n/a';
  if (recent > older + eps) return 'improving';
  if (recent < older - eps) return 'worsening';
  return 'flat';
}

// ---------------------------------------------------------------------------
// Window aggregate — computed once, shared by every rule
// ---------------------------------------------------------------------------

/**
 * Everything the rules read, derived once from the window so no rule re-walks
 * the shot list. `sessions` stay newest-first (the order `runCoach` enforces).
 */
export interface CoachWindow {
  sessions: readonly CoachSession[];
  /** All shots across the window, session order preserved. */
  allShots: readonly ResolvedShot[];
  /** Decided shots across the window. */
  decidedShots: readonly ResolvedShot[];
  makes: number;
  misses: number;
  fgPct: number | null;
}

export function buildWindow(sessions: readonly CoachSession[]): CoachWindow {
  // Newest-first — trend halves depend on it.
  const ordered = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  const allShots: ResolvedShot[] = [];
  for (const s of ordered) allShots.push(...s.shots);
  const decidedShots = decided(allShots);
  const makes = decidedShots.filter((s) => s.outcome === 'make').length;
  const misses = decidedShots.length - makes;
  return {
    sessions: ordered,
    allShots,
    decidedShots,
    makes,
    misses,
    fgPct: decidedShots.length > 0 ? makes / decidedShots.length : null,
  };
}

// ---------------------------------------------------------------------------
// Rules — each: (window) => CoachFinding | null
// ---------------------------------------------------------------------------

type Rule = (w: CoachWindow) => CoachFinding | null;

/**
 * RULE 1 — Entry angle low. A chronically flat entry (mean < 40°) gives the
 * ball a tiny target at the rim. Evidence = the window mean entry; trend
 * compares recent vs older sessions.
 */
const ruleEntryAngleLow: Rule = (w) => {
  const entries = collect(w.decidedShots, 'entryAngleDeg');
  if (entries.length < COACH.minDecided) return null;
  const m = mean(entries)!;
  if (m >= COACH.entryAngleLowDeg) return null;
  const { older, recent } = halves(w.sessions);
  const olderMean = mean(collect(older.flatMap((s) => s.shots), 'entryAngleDeg'));
  const recentMean = mean(collect(recent.flatMap((s) => s.shots), 'entryAngleDeg'));
  const trend = trendHigherBetter(olderMean, recentMean, 1);
  const strength = (COACH.entryAngleLowDeg - m) / 10;
  return {
    id: 'entryAngleLow',
    severity: m < COACH.entryAngleLowDeg - 5 ? 3 : 2,
    title: 'Your arc is flat',
    evidence: `Your ball enters the rim at ${m.toFixed(1)}° on average — the ideal window is ${FORM.entryAngle.min}–${FORM.entryAngle.max}°. A flat entry leaves almost no margin.`,
    prescription:
      'Arc drill: shoot over a broomstick (or a partner\'s outstretched arm) held a metre in front of you so the ball has to climb before it drops. Finish with your hand "in the rim".',
    trend,
    strength,
  };
};

/**
 * RULE 2 — Entry angle volatile. Even with a fine average, a wide spread
 * (σ > 8°) means the touch isn't repeatable. Evidence = the σ; trend on σ
 * (lower is better).
 */
const ruleEntryAngleVolatile: Rule = (w) => {
  const entries = collect(w.decidedShots, 'entryAngleDeg');
  if (entries.length < COACH.minDecided) return null;
  const sd = std(entries)!;
  if (sd <= COACH.entryAngleVolatileStdDeg) return null;
  const { older, recent } = halves(w.sessions);
  const olderSd = std(collect(older.flatMap((s) => s.shots), 'entryAngleDeg'));
  const recentSd = std(collect(recent.flatMap((s) => s.shots), 'entryAngleDeg'));
  const trend = trendLowerBetter(olderSd, recentSd, 1);
  return {
    id: 'entryAngleVolatile',
    severity: 2,
    title: 'Inconsistent touch',
    evidence: `Your entry angle swings ±${sd.toFixed(1)}° shot to shot (over ${entries.length} tracked shots). A repeatable jumper lives inside ~±4°.`,
    prescription:
      'Groove one motion before adding range: 3×15 makes from a single spot, same rhythm every rep, before you move. Consistency first, distance second.',
    trend,
    strength: (sd - COACH.entryAngleVolatileStdDeg) / COACH.entryAngleVolatileStdDeg,
  };
};

/**
 * RULE 3 — Release-angle drift vs baseline. The window's OLDER sessions set a
 * baseline; if the RECENT release-angle mean has moved off it by more than
 * ~5°, the motion is quietly changing. Evidence = the two means + the delta.
 */
const ruleReleaseDrift: Rule = (w) => {
  if (w.sessions.length < COACH.minSessions) return null;
  const { older, recent } = halves(w.sessions);
  if (older.length === 0 || recent.length === 0) return null;
  const baseVals = collect(older.flatMap((s) => s.shots), 'releaseAngleDeg');
  const recentVals = collect(recent.flatMap((s) => s.shots), 'releaseAngleDeg');
  if (baseVals.length < 4 || recentVals.length < 4) return null;
  const base = mean(baseVals)!;
  const now = mean(recentVals)!;
  const delta = now - base;
  if (Math.abs(delta) < COACH.releaseDriftDeg) return null;
  const dir = delta > 0 ? 'steeper' : 'flatter';
  return {
    id: 'releaseDrift',
    severity: 2,
    // A drift back TOWARD the ideal band is still a change worth naming, but
    // it reads as improvement; away from it, as a warning.
    title: delta < 0 ? 'Your release is flattening' : 'Your release is steepening',
    evidence: `Your release angle has moved ${Math.abs(delta).toFixed(1)}° ${dir} lately — from ${base.toFixed(1)}° across your earlier sessions to ${now.toFixed(1)}° in your recent ones.`,
    prescription:
      'Film one set in the Shot Lab and compare it to last week\'s. If the change wasn\'t deliberate, reset to your baseline finish height before it grooves in.',
    trend: 'n/a',
    strength: Math.abs(delta) / COACH.releaseDriftDeg,
  };
};

/**
 * RULE 3b — Arc flattens from three. Reaching for range, most shooters push a
 * flatter, harder shot instead of adding legs — the release angle drops on 3s
 * vs 2s. Uses release angle (always available from the arc, no pose) split by
 * the estimated shot value. Additive coaching only; never touches make/miss.
 */
const ruleThreePtFlat: Rule = (w) => {
  const threes = w.decidedShots.filter((s) => s.shotValue === 3);
  const twos = w.decidedShots.filter((s) => s.shotValue !== 3);
  const threeAng = collect(threes, 'releaseAngleDeg');
  const twoAng = collect(twos, 'releaseAngleDeg');
  if (threeAng.length < 4 || twoAng.length < 4) return null;
  const a3 = mean(threeAng)!;
  const a2 = mean(twoAng)!;
  const delta = a2 - a3; // positive = 3s are flatter than 2s
  if (delta < COACH.threePtFlatDeg) return null;
  return {
    id: 'threePtFlat',
    severity: 2,
    title: 'Your arc flattens from three',
    evidence: `Your release angle drops ${delta.toFixed(1)}° on 3-pointers (${a3.toFixed(1)}°) vs 2s (${a2.toFixed(1)}°) — you're reaching for range instead of using your legs.`,
    prescription:
      'Keep the SAME high release from three and add legs, not a flatter push. Groove it shooting over an imagined bar so the arc stays up as the distance grows.',
    trend: 'n/a',
    strength: delta / COACH.threePtFlatDeg,
  };
};

/**
 * RULE 4 — Zone imbalance. A large best-minus-worst FG% gap across the
 * left/center/right zones says one spot is a black hole. Evidence = the two
 * zone percentages + attempts.
 */
const ruleZoneImbalance: Rule = (w) => {
  // Aggregate zone tallies across the window from the shots directly (stats are
  // per-session; we want the whole window's zone picture).
  const tally: Record<ChartZone, { makes: number; decided: number }> = {
    left: { makes: 0, decided: 0 },
    center: { makes: 0, decided: 0 },
    right: { makes: 0, decided: 0 },
  };
  for (const s of w.decidedShots) {
    const z = zoneOf(s.originX);
    if (z == null) continue;
    tally[z].decided += 1;
    if (s.outcome === 'make') tally[z].makes += 1;
  }
  const zones = (Object.keys(tally) as ChartZone[])
    .map((z) => ({ z, ...tally[z], fg: tally[z].decided > 0 ? tally[z].makes / tally[z].decided : null }))
    // Only zones with a fair sample can be "best" or "worst".
    .filter((x) => x.decided >= 3 && x.fg != null);
  if (zones.length < 2) return null;
  zones.sort((a, b) => b.fg! - a.fg!);
  const best = zones[0]!;
  const worst = zones[zones.length - 1]!;
  const gapPts = (best.fg! - worst.fg!) * 100;
  if (gapPts < COACH.zoneGapPts) return null;
  const name: Record<ChartZone, string> = { left: 'left', center: 'the middle', right: 'right' };
  return {
    id: 'zoneImbalance',
    severity: 2,
    title: 'One zone is dragging you down',
    evidence: `You shoot ${pct(best.fg!)} from ${name[best.z]} but only ${pct(worst.fg!)} from ${name[worst.z]} (${worst.makes}/${worst.decided}) — a ${Math.round(gapPts)}-point gap.`,
    prescription: `Spend your next warm-up entirely from ${name[worst.z]}: 25 shots there before you take one from anywhere else. Balance the map.`,
    trend: 'n/a',
    strength: gapPts / COACH.zoneGapPts,
  };
};

/** Catalog title for a drill id — used in prescription copy. */
const drillTitle = (id: DrillId) => DRILLS.find((d) => d.id === id)!.title;

/**
 * Distance band a shot falls in — mirrors heatmap.ts's private bandOfShot
 * (near < 4.5 rim widths, far at/past the 3-point line, shotValue fallback)
 * so the trend split places shots exactly like the heat map did.
 */
function bandOfShotLocal(s: ResolvedShot): HeatCell['band'] | null {
  const d = s.distanceRimWidths;
  if (d != null && Number.isFinite(d)) {
    if (d < 4.5) return 'near';
    if (d < DEFAULT_3PT_RIMWIDTHS) return 'mid';
    return 'far';
  }
  if (s.shotValue === 3) return 'far';
  if (s.shotValue === 2) return 'mid';
  return null;
}

/** The drill that best trains a given heat-map cell. */
function drillForCell(cell: HeatCell): DrillId {
  if (cell.band === 'far') return cell.zone === 'center' ? 'catchShoot10' : 'corners3';
  if (cell.band === 'mid') return 'midClock';
  return 'aroundKey';
}

/**
 * RULE 4b — Cold zone (cell-level). Where {@link ruleZoneImbalance} compares
 * horizontal thirds, this drills into the 3×3 heat-map grid and names the ONE
 * cell clearly under the window's overall FG%. Shots without a distance band
 * land in the heatmap's `unplaced` bucket, so netless-of-distance users simply
 * never trigger it — honest silence. Carries its own drill via `drillId`.
 */
const ruleColdZone: Rule = (w) => {
  if (w.fgPct == null) return null;
  const hm = buildHeatmap(w.decidedShots, COACH.coldZoneMinCellAttempts);
  if (hm.worst == null) return null;
  const worst = hm.worst;
  const gapPts = (w.fgPct - worst.fgPct) * 100;
  if (gapPts < COACH.coldZoneGapPts) return null;
  const drillId = drillForCell(worst);
  // Trend: FG% inside the cold cell, recent half vs older half of the window.
  const cellShots = w.decidedShots.filter(
    (s) => zoneOf(s.originX ?? null) === worst.zone && bandOfShotLocal(s) === worst.band,
  );
  const { older, recent } = halves(cellShots);
  let trend: Trend = 'n/a';
  if (older.length >= 3 && recent.length >= 3) {
    const olderFg = older.filter((s) => s.outcome === 'make').length / older.length;
    const recentFg = recent.filter((s) => s.outcome === 'make').length / recent.length;
    trend = trendHigherBetter(olderFg, recentFg, 0.05);
  }
  return {
    id: 'coldZone',
    severity: 2,
    title: `Cold spot: the ${cellLabel(worst)}`,
    evidence: `You're ${worst.makes}/${worst.attempts} (${pct(worst.fgPct)}) from the ${cellLabel(worst)} — ${Math.round(gapPts)} points under your ${pct(w.fgPct)} overall.`,
    prescription: `Give the ${cellLabel(worst)} its own block this week — short sets, full reset between reps. ${drillTitle(drillId)} trains exactly that spot.`,
    trend,
    strength: gapPts / COACH.coldZoneGapPts,
    drillId,
  };
};

/**
 * RULE 5 — Left/right miss bias. Compares where MADE shots cross the rim
 * plane (near the rim center, by definition of a make) with where MISSES
 * cross. A consistent horizontal offset on misses means you pull/push one way.
 * Uses xCross normalized by the shot's ball radius→rim scale isn't available,
 * so we work in the makes' own reference: median make-cross vs median
 * miss-cross, expressed in ball radii from the trajectory.
 */
const ruleSideBias: Rule = (w) => {
  const makeCross: number[] = [];
  const missCross: number[] = [];
  const radii: number[] = [];
  for (const s of w.decidedShots) {
    if (s.xCross == null) continue;
    (s.outcome === 'make' ? makeCross : missCross).push(s.xCross);
    const r = s.trajectory.find((t) => !t.predicted)?.r;
    if (r != null && r > 0) radii.push(r);
  }
  if (makeCross.length < 4 || missCross.length < 4) return null;
  const center = median(makeCross); // makes define the rim center in x
  const missMed = median(missCross);
  const r = median(radii);
  if (center == null || missMed == null || r == null || r <= 0) return null;
  const offsetRadii = (missMed - center) / r;
  if (Math.abs(offsetRadii) < COACH.sideBiasRimWidths) return null;
  const side = offsetRadii > 0 ? 'right' : 'left';
  return {
    id: 'sideBias',
    severity: 2,
    title: `You miss ${side}`,
    evidence: `Your misses cross the rim about ${Math.abs(offsetRadii).toFixed(1)} ball-widths to the ${side} of where your makes go through — a directional bias, not random scatter.`,
    prescription:
      side === 'right'
        ? 'Check your guide hand and elbow alignment — a thumb flick or a flared shooting elbow pushes the ball right. Shoot a set one-handed to feel a straight line.'
        : 'Check your base and follow-through direction — dragging left usually starts in the feet or a guide-hand pull. Square your toes to the rim and finish straight at it.',
    trend: 'n/a',
    strength: Math.abs(offsetRadii) / COACH.sideBiasRimWidths,
  };
};

/**
 * RULE 6 — Streaky. A long best run sitting on top of a cold overall FG%
 * means the talent is there but the floor is leaky: hot stretches, cold
 * stretches, little middle. Evidence = best run + FG%.
 */
const ruleStreaky: Rule = (w) => {
  if (w.fgPct == null || w.decidedShots.length < COACH.minDecided) return null;
  let bestRun = 0;
  let run = 0;
  for (const s of w.allShots) {
    if (s.outcome === 'make') {
      run += 1;
      if (run > bestRun) bestRun = run;
    } else if (s.outcome === 'miss') {
      run = 0;
    }
  }
  if (bestRun < COACH.streakyBestRun || w.fgPct >= COACH.streakyColdFg) return null;
  return {
    id: 'streaky',
    severity: 2,
    title: 'Streaky — raise your floor',
    evidence: `You strung together ${bestRun} straight makes but sit at ${pct(w.fgPct)} overall. The ceiling is there; the cold stretches are the leak.`,
    prescription:
      'Chart your misses for one session — same miss twice in a row is a mechanical tell, not bad luck. Fix the repeated miss and the floor comes up.',
    trend: 'n/a',
    strength: (COACH.streakyColdFg - w.fgPct) / COACH.streakyColdFg + bestRun / 20,
  };
};

/**
 * RULE 7 — Fatigue. Splits every session's shots at its own midpoint and
 * compares aggregate first-half FG% to second-half FG% across the window. A
 * real second-half drop is conditioning or focus. Evidence = the two halves.
 */
const ruleFatigue: Rule = (w) => {
  let firstMakes = 0;
  let firstDecided = 0;
  let secondMakes = 0;
  let secondDecided = 0;
  for (const session of w.sessions) {
    const d = decided(session.shots);
    if (d.length < 6) continue; // need a meaningful split
    const cut = Math.floor(d.length / 2);
    for (let i = 0; i < d.length; i++) {
      const isMake = d[i]!.outcome === 'make';
      if (i < cut) {
        firstDecided += 1;
        if (isMake) firstMakes += 1;
      } else {
        secondDecided += 1;
        if (isMake) secondMakes += 1;
      }
    }
  }
  if (firstDecided < 4 || secondDecided < 4) return null;
  const first = firstMakes / firstDecided;
  const second = secondMakes / secondDecided;
  const dropPts = (first - second) * 100;
  if (dropPts < COACH.fatigueDropPts) return null;
  return {
    id: 'fatigue',
    severity: 2,
    title: 'You fade late',
    evidence: `You shoot ${pct(first)} in the first half of your sessions but drop to ${pct(second)} in the second — a ${Math.round(dropPts)}-point fall as you tire.`,
    prescription:
      'Bank your important reps early, and add a short conditioning finisher so game-fatigue form is trained, not avoided. Or simply cut the session before the form goes.',
    trend: 'n/a',
    strength: dropPts / COACH.fatigueDropPts,
  };
};

/**
 * RULE 8 — 2pt vs 3pt efficiency gap. A big split between inside and outside
 * efficiency tells you where the practice time belongs. Evidence = both
 * percentages with attempt counts.
 */
const ruleTwoVsThree: Rule = (w) => {
  let twoM = 0;
  let twoA = 0;
  let threeM = 0;
  let threeA = 0;
  for (const s of w.decidedShots) {
    const is3 = s.shotValue === 3;
    if (is3) {
      threeA += 1;
      if (s.outcome === 'make') threeM += 1;
    } else {
      twoA += 1;
      if (s.outcome === 'make') twoM += 1;
    }
  }
  if (twoA < 4 || threeA < 4) return null;
  const two = twoM / twoA;
  const three = threeM / threeA;
  const gapPts = Math.abs(two - three) * 100;
  if (gapPts < COACH.twoThreeGapPts) return null;
  const weaker = two < three ? '2' : '3';
  const weakPct = two < three ? two : three;
  const strongPct = two < three ? three : two;
  const weakLine =
    weaker === '2'
      ? `2-pointers (${twoM}/${twoA}, ${pct(two)})`
      : `3-pointers (${threeM}/${threeA}, ${pct(three)})`;
  return {
    id: 'twoVsThree',
    severity: 1,
    title: `Your ${weaker}-point shot needs work`,
    evidence: `You hit ${pct(strongPct)} on one range but only ${pct(weakPct)} on your ${weakLine} — a ${Math.round(gapPts)}-point efficiency gap.`,
    prescription:
      weaker === '3'
        ? 'Move the three in until you\'re making 8/10, then back up one step at a time. Range is earned, not forced.'
        : 'Your inside shot is leaking easy points — dedicate a block to floaters and short pull-ups where volume actually lives.',
    trend: 'n/a',
    strength: gapPts / COACH.twoThreeGapPts,
  };
};

/**
 * RULE 9 — High unsure rate. When a big share of attempts resolve 'unsure',
 * the DATA is compromised (and usually the framing). Evidence = the rate.
 * This is a data-quality nudge, not a shooting flaw — kept at severity 1.
 */
const ruleUnsureRate: Rule = (w) => {
  const attempts = w.allShots.length;
  if (attempts < COACH.minDecided) return null;
  const unsure = w.allShots.filter((s) => s.outcome === 'unsure').length;
  const frac = unsure / attempts;
  if (frac < COACH.unsureRateFrac) return null;
  return {
    id: 'unsureRate',
    severity: 1,
    title: 'Tighten your camera setup',
    evidence: `${pct(frac)} of your shots (${unsure}/${attempts}) came back "unsure" — the app couldn\'t call them. That\'s framing, not shooting.`,
    prescription:
      'Prop the phone side-on to the rim, waist-to-chest height, with the whole rim and your release both in frame. A clean angle turns unsure calls into real data.',
    trend: 'n/a',
    strength: frac / COACH.unsureRateFrac,
  };
};

/**
 * RULE 10 — Volume trend (week over week within the window). Compares the
 * attempt COUNT of the recent half to the older half. A big drop is a
 * consistency warning; a big jump earns a nod. Evidence = both counts.
 */
const ruleVolumeTrend: Rule = (w) => {
  if (w.sessions.length < COACH.minSessions) return null;
  const { older, recent } = halves(w.sessions);
  if (older.length === 0 || recent.length === 0) return null;
  const olderCount = older.reduce((n, s) => n + s.stats.attempts, 0);
  const recentCount = recent.reduce((n, s) => n + s.stats.attempts, 0);
  if (olderCount < 5) return null; // no baseline to compare against
  const change = (recentCount - olderCount) / olderCount;
  if (Math.abs(change) < COACH.volumeTrendFrac) return null;
  const up = change > 0;
  return {
    id: 'volumeTrend',
    severity: 1,
    title: up ? 'Volume is climbing' : 'Your volume dropped off',
    evidence: `You put up ${recentCount} shots in your recent sessions vs ${olderCount} earlier — ${up ? 'up' : 'down'} ${pct(Math.abs(change))}.`,
    prescription: up
      ? 'Reps are the engine — keep the streak alive. Guard the form as fatigue rises (see any "fade late" note above).'
      : 'Shooting is a use-it-or-lose-it skill. Even a 50-shot maintenance session twice a week holds your touch far better than one big burst.',
    trend: up ? 'improving' : 'worsening',
    strength: Math.abs(change) / COACH.volumeTrendFrac,
  };
};

/** Axis lookup for the NBA-band rule. */
function axisByKey(key: BenchmarkAxis['key']): BenchmarkAxis | undefined {
  return BENCHMARK_AXES.find((a) => a.key === key);
}

/**
 * RULE 11 — Form vs NBA band (when form data exists). Picks the shooting axis
 * furthest OUTSIDE its ideal band (release angle, entry, release time, knee
 * flexion, follow-through) and names it against the NBA reference. Evidence =
 * the user's mean vs the band. Only fires when the pose model contributed data
 * for that axis; ball-flight axes (release/entry angle) always qualify.
 */
const ruleNbaBand: Rule = (w) => {
  const anyForm = w.decidedShots.some((s) => s.form != null);
  type Cand = { axis: BenchmarkAxis; value: number; over: number };
  const cands: Cand[] = [];
  const axisKeyToMetric: Partial<Record<BenchmarkAxis['key'], LabMetricKey>> = {
    releaseAngleDeg: 'releaseAngleDeg',
    entryAngleDeg: 'entryAngleDeg',
    releaseTimeMs: 'releaseTimeMs',
    followThroughHeldMs: 'followThroughHeldMs',
    kneeFlexionDeg: 'kneeFlexionDeg',
  };
  for (const key of Object.keys(axisKeyToMetric) as BenchmarkAxis['key'][]) {
    const axis = axisByKey(key);
    const metricKey = axisKeyToMetric[key];
    if (!axis || !metricKey) continue;
    const vals = collect(w.decidedShots, metricKey);
    if (vals.length < COACH.minDecided) continue;
    const m = mean(vals)!;
    const [lo, hi] = axis.ideal;
    let over = 0;
    if (m < lo) over = lo - m;
    else if (m > hi) over = axis.oneSided ? 0 : m - hi;
    if (over <= 0) continue;
    // Normalize the overshoot by the fall-to-zero distance so axes compare.
    cands.push({ axis, value: m, over: over / axis.zeroAt });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.over - a.over);
  const top = cands[0]!;
  const [lo, hi] = top.axis.ideal;
  const unit = top.axis.key === 'releaseTimeMs' || top.axis.key === 'followThroughHeldMs' ? 'ms' : '°';
  const dir = top.value < lo ? 'below' : 'above';
  return {
    id: 'nbaBand',
    severity: anyForm ? 2 : 1,
    title: `${top.axis.label}: off the pro band`,
    evidence: `Your ${top.axis.label.toLowerCase()} averages ${Math.round(top.value)}${unit}, ${dir} the ${lo}–${hi}${unit} range good shooters live in (NBA avg ≈ ${top.axis.nbaAvg}${unit}).`,
    prescription: `Make ${top.axis.label.toLowerCase()} your one focus this week — a single cue at a time. Re-check it in the Shot Lab after a few sessions to confirm it moved.`,
    trend: 'n/a',
    strength: 1 + top.over,
  };
};

/** Metrics the form-regression rule watches (releaseAngleDeg is excluded — {@link ruleReleaseDrift} owns it). */
const REGRESSION_METRICS: readonly {
  key: keyof typeof COACH.formRegressionDeadband;
  label: string;
  unit: string;
  band: readonly [number, number];
}[] = [
  { key: 'setPointElbowDeg', label: 'set-point elbow', unit: '°', band: [FORM.elbowSetPoint.min, FORM.elbowSetPoint.max] },
  { key: 'kneeFlexionDeg', label: 'knee flexion', unit: '°', band: [FORM.kneeFlexion.min, FORM.kneeFlexion.max] },
  // FORM.releaseTime is in seconds; the metric is ms.
  { key: 'releaseTimeMs', label: 'release time', unit: 'ms', band: [0, FORM.releaseTime.typical * 1000] },
  { key: 'followThroughHeldMs', label: 'follow-through hold', unit: 'ms', band: [FORM.followThrough.holdSec * 1000, Number.POSITIVE_INFINITY] },
];

/** Distance of x OUTSIDE the [lo, hi] band; 0 when inside. */
function bandDev(x: number, band: readonly [number, number]): number {
  const [lo, hi] = band;
  return x < lo ? lo - x : x > hi ? x - hi : 0;
}

/**
 * RULE 11b — Form regression vs the window's own baseline. The OLDER half of
 * the window sets a per-metric baseline (mean deviation from its FORM band);
 * if the RECENT half's deviation has grown past a per-metric deadband, the
 * form is quietly slipping. Uses only the pose metrics already persisted per
 * shot (formJson via metricOf) — min samples per half keep it honest.
 */
const ruleFormRegression: Rule = (w) => {
  if (w.sessions.length < COACH.minSessions) return null;
  const { older, recent } = halves(w.sessions);
  const olderShots = decided(older.flatMap((s) => s.shots));
  const recentShots = decided(recent.flatMap((s) => s.shots));
  type Cand = {
    m: (typeof REGRESSION_METRICS)[number];
    olderMean: number;
    recentMean: number;
    score: number;
  };
  let top: Cand | null = null;
  for (const m of REGRESSION_METRICS) {
    const olderVals = collect(olderShots, m.key);
    const recentVals = collect(recentShots, m.key);
    if (
      olderVals.length < COACH.formRegressionMinPerHalf ||
      recentVals.length < COACH.formRegressionMinPerHalf
    ) {
      continue;
    }
    const olderMean = mean(olderVals)!;
    const recentMean = mean(recentVals)!;
    const regression = bandDev(recentMean, m.band) - bandDev(olderMean, m.band);
    if (regression <= COACH.formRegressionDeadband[m.key]) continue;
    const score = regression / COACH.formRegressionDeadband[m.key];
    if (top == null || score > top.score) top = { m, olderMean, recentMean, score };
  }
  if (top == null) return null;
  const { m, olderMean, recentMean, score } = top;
  const [lo, hi] = m.band;
  const bandText = !Number.isFinite(hi)
    ? `${lo}${m.unit}+`
    : lo === 0
      ? `under ${hi}${m.unit}`
      : `${lo}–${hi}${m.unit}`;
  return {
    id: 'formRegression',
    severity: 2,
    title: `Form slip: ${m.label}`,
    evidence: `Your ${m.label} averaged ${Math.round(olderMean)}${m.unit} earlier in this window; lately it's ${Math.round(recentMean)}${m.unit} — drifting outside the ${bandText} band you held before.`,
    prescription: `Open Form Studio and play an early make next to a recent one — watch the ${m.label} frame by frame, one cue at a time. Groove the fix with slow ${drillTitle('catchShoot10')} reps.`,
    trend: 'worsening',
    strength: score,
  };
};

/**
 * RULE 12 — Improvement celebration. When the window spans enough sessions
 * and the RECENT half's FG% clearly beats the OLDER half's, say so — coaching
 * is reinforcement too. Evidence = the two FG%s + the gain. Always severity 1
 * (a celebration never outranks a real problem in the list, but the report
 * headline may promote it).
 */
const ruleImproving: Rule = (w) => {
  if (w.sessions.length < 3) return null;
  const { older, recent } = halves(w.sessions);
  const olderFg = windowFg(older);
  const recentFg = windowFg(recent);
  if (olderFg == null || recentFg == null) return null;
  const gainPts = (recentFg - olderFg) * 100;
  if (gainPts < COACH.celebrateFgGainPts) return null;
  return {
    id: 'improving',
    severity: 1,
    title: 'You\'re trending up',
    evidence: `Your FG% has climbed from ${pct(olderFg)} in your earlier sessions to ${pct(recentFg)} lately — up ${Math.round(gainPts)} points. Whatever you changed, it\'s working.`,
    prescription:
      'Don\'t touch a thing mechanically — bank the reps while it\'s clicking. Note what felt different so you can find it again on a cold day.',
    trend: 'improving',
    strength: gainPts / COACH.celebrateFgGainPts,
  };
};

/** FG% over an arbitrary set of sessions (decided only). */
function windowFg(sessions: readonly CoachSession[]): number | null {
  let makes = 0;
  let dec = 0;
  for (const s of sessions) {
    for (const shot of s.shots) {
      if (shot.outcome === 'make') {
        makes += 1;
        dec += 1;
      } else if (shot.outcome === 'miss') {
        dec += 1;
      }
    }
  }
  return dec > 0 ? makes / dec : null;
}

/** Ordered rule registry — the coach runs these top to bottom. */
export const RULES: readonly Rule[] = [
  ruleEntryAngleLow,
  ruleEntryAngleVolatile,
  ruleReleaseDrift,
  ruleThreePtFlat,
  ruleZoneImbalance,
  ruleColdZone,
  ruleSideBias,
  ruleStreaky,
  ruleFatigue,
  ruleTwoVsThree,
  ruleUnsureRate,
  ruleVolumeTrend,
  ruleNbaBand,
  ruleFormRegression,
  ruleImproving,
];

// ---------------------------------------------------------------------------
// Personalization — the coach talks to WHO you are, not just what you shot
// ---------------------------------------------------------------------------

/**
 * The slice of the player's profile the coach personalizes to. Structural +
 * all-optional so core stays decoupled from the profile store; the Coach
 * screen maps its persisted profile onto this shape. With no profile the
 * coach behaves exactly as before (see {@link runCoach}).
 */
export interface CoachProfile {
  experience?: 'rookie' | 'casual' | 'club' | 'veteran' | null;
  goal?: 'fun' | 'improve' | 'team' | 'pro' | null;
  position?: 'guard' | 'wing' | 'big' | null;
}

/**
 * "Discipline" findings are about training HABITS (load, fatigue, data
 * hygiene) rather than the shot itself — the ones a for-fun player doesn't
 * want shouted at them.
 */
const DISCIPLINE_FINDINGS: ReadonlySet<FindingKind> = new Set([
  'volumeTrend',
  'fatigue',
  'unsureRate',
]);

function clampSeverity(s: number): Severity {
  return (s < 1 ? 1 : s > 3 ? 3 : s) as Severity;
}

/** A short, level-appropriate coaching line for the ONE top finding. */
function experienceFraming(exp: CoachProfile['experience']): string | null {
  switch (exp) {
    case 'rookie':
      return 'New to this? Lock in this one fix before layering on anything else — fundamentals compound.';
    case 'club':
      return "You've got the base — sharpen this and it'll show up in games.";
    case 'veteran':
      return "Nothing new to a shooter at your level — it's reps and discipline now, not information.";
    default:
      // casual / unset: keep the tone light, no extra sermon.
      return null;
  }
}

/**
 * Re-tune a raw finding list to the player's profile. Honest, not hidden: it
 * only shifts EMPHASIS (severity) and adds level-appropriate framing — no
 * finding is fabricated or deleted, and the underlying evidence is untouched.
 *
 * - goal 'fun': training-load nags become gentle notes, never headlines.
 * - goal 'pro'/'team': being off the pro band is a priority, not a footnote.
 * - experience: the top finding gets a line pitched at your level.
 *
 * Returns a new array; inputs are not mutated.
 */
export function personalizeFindings(
  findings: readonly CoachFinding[],
  profile: CoachProfile,
): CoachFinding[] {
  const out = findings.map((f) => ({ ...f }));
  const { goal, experience } = profile;

  for (const f of out) {
    if (goal === 'fun' && DISCIPLINE_FINDINGS.has(f.id) && f.severity > 1) {
      f.severity = 1;
    }
    if ((goal === 'pro' || goal === 'team') && f.id === 'nbaBand') {
      f.severity = clampSeverity(f.severity + 1);
    }
  }

  // Frame the CURRENT top finding (after the severity re-tune above) so the
  // level-appropriate line lands on whatever now matters most.
  const framing = experienceFraming(experience);
  if (framing != null && out.length > 0) {
    const top = [...out].sort((a, b) => b.severity - a.severity || b.strength - a.strength)[0]!;
    top.prescription = `${top.prescription} ${framing}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run every rule over the session window and return the findings, ranked:
 * severity descending, then strength descending. At most one finding per
 * rule (rules are single-shot). Empty window ⇒ [].
 *
 * Pass a {@link CoachProfile} to personalize emphasis + framing to the player;
 * omit it for the raw, profile-agnostic findings (identical to before).
 */
export function runCoach(
  sessions: readonly CoachSession[],
  profile?: CoachProfile,
): CoachFinding[] {
  if (sessions.length === 0) return [];
  const w = buildWindow(sessions);
  if (w.decidedShots.length === 0) return [];
  let out: CoachFinding[] = [];
  for (const rule of RULES) {
    const f = rule(w);
    if (f) out.push(f);
  }
  if (profile) out = personalizeFindings(out, profile);
  out.sort((a, b) => b.severity - a.severity || b.strength - a.strength);
  return out;
}

/**
 * Maps a coachable finding to the drill that best trains its fix. Findings not
 * present here (a positive 'improving', the detection-side 'unsureRate', or a
 * pure 'volumeTrend' note) have no drill assignment.
 */
const FINDING_DRILL: Partial<Record<FindingKind, DrillId>> = {
  entryAngleLow: 'catchShoot10',
  entryAngleVolatile: 'catchShoot10',
  releaseDrift: 'catchShoot10',
  streaky: 'catchShoot10',
  nbaBand: 'catchShoot10',
  zoneImbalance: 'midClock',
  sideBias: 'midClock',
  twoVsThree: 'corners3',
  threePtFlat: 'corners3',
  fatigue: 'ftLadder',
  // coldZone is deliberately absent — it carries its own cell-specific drillId.
  formRegression: 'catchShoot10',
};

export interface WeeklyAssignment {
  finding: CoachFinding;
  drillId: DrillId;
}

/**
 * The ONE thing to work on this week: the top-ranked finding that maps to a
 * practice drill, paired with that drill. Turns the diagnosis into a plan.
 * Returns null when no ranked finding has a drill (nothing systematic to drill,
 * or only detection/volume notes). `findings` is assumed already ranked
 * (runCoach output), so it honours the same severity order.
 */
export function weeklyAssignment(
  findings: readonly CoachFinding[],
): WeeklyAssignment | null {
  for (const f of findings) {
    const drillId = f.drillId ?? FINDING_DRILL[f.id];
    if (drillId) return { finding: f, drillId };
  }
  return null;
}

/**
 * The full weekly PLAN: the top (up to `max`) drillable findings, each paired
 * with its drill — the coach as a training partner, not just a diagnostician.
 * A superset of {@link weeklyAssignment} (which is item 0). Honours the ranked
 * severity order and never repeats a finding.
 */
export function weeklyPlan(
  findings: readonly CoachFinding[],
  max = 3,
): WeeklyAssignment[] {
  const out: WeeklyAssignment[] = [];
  for (const f of findings) {
    const drillId = f.drillId ?? FINDING_DRILL[f.id];
    if (drillId) {
      out.push({ finding: f, drillId });
      if (out.length >= max) break;
    }
  }
  return out;
}
