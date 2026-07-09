/**
 * Session storytelling engine — pure derivations that turn a night's resolved
 * shots into the recap's narrative: the best make run, an honest per-zone
 * breakdown and a gallery of make trajectories.
 *
 * Pure + deterministic (no I/O, no wall clock, no React): everything derives
 * from the shots/stats passed in, so the same session always tells the same
 * story. Evidence stays measured quantities — the headline copy only ever
 * states numbers computed here, never a fabricated claim.
 */
import { zoneOf } from './stats';
import type { BallSample, ChartZone, ResolvedShot, SessionStats } from './types';

// ---------------------------------------------------------------------------
// Best make run
// ---------------------------------------------------------------------------

/** The longest run of makes in a session (see {@link bestRun}). */
export interface BestRun {
  /** 0-based index of the FIRST make of the run in the shots array. */
  startIndex: number;
  /** 0-based index of the LAST make of the run. */
  endIndex: number;
  /** Makes in the run — unsure shots inside neither count nor break it. */
  makes: number;
}

/**
 * Longest make run of the session, or null when the best run has fewer than
 * 3 makes (too short to be a story).
 *
 * Semantics MIRROR the streak fold in src/core/stats.ts: 'miss' breaks a run,
 * 'unsure' passes through (does not count, does not break), 'make' extends.
 * Indices point at the first/last MAKE of the run, so an unsure shot on
 * either edge is never included in the reported span. Ties keep the EARLIEST
 * run (strict greater-than when comparing). Single O(n) walk.
 */
export function bestRun(shots: readonly ResolvedShot[]): BestRun | null {
  let bestStart = -1;
  let bestEnd = -1;
  let bestMakes = 0;
  // Current open run: first/last make index + make count (0 = no open run).
  let start = -1;
  let end = -1;
  let makes = 0;

  for (let i = 0; i < shots.length; i++) {
    const outcome = shots[i]!.outcome;
    if (outcome === 'make') {
      if (makes === 0) start = i;
      end = i;
      makes += 1;
    } else if (outcome === 'miss') {
      // Strict > keeps the earliest run on ties.
      if (makes > bestMakes) {
        bestStart = start;
        bestEnd = end;
        bestMakes = makes;
      }
      start = -1;
      end = -1;
      makes = 0;
    }
    // 'unsure' passes through: neither counts nor breaks.
  }
  if (makes > bestMakes) {
    bestStart = start;
    bestEnd = end;
    bestMakes = makes;
  }

  if (bestMakes < 3) return null;
  return { startIndex: bestStart, endIndex: bestEnd, makes: bestMakes };
}

// ---------------------------------------------------------------------------
// Zone breakdown
// ---------------------------------------------------------------------------

/** One camera-frame-third's line in the zone breakdown card. */
export interface ZoneLine {
  zone: ChartZone;
  label: 'Left' | 'Center' | 'Right';
  /** Every attempt bucketed in the zone, INCLUDING unsure shots. */
  attempts: number;
  makes: number;
  /** Decided attempts only (make + miss). */
  decided: number;
  /** makes/decided, or null when the zone has NO decided shots (honesty: distinct from 0%). */
  fgPct: number | null;
}

const ZONE_ORDER: readonly ChartZone[] = ['left', 'center', 'right'];

const ZONE_LABELS: Record<ChartZone, ZoneLine['label']> = {
  left: 'Left',
  center: 'Center',
  right: 'Right',
};

/**
 * Per-zone attempt/make/decided tallies, always exactly 3 lines in
 * left/center/right order. Shots are bucketed via {@link zoneOf} on their
 * `originX`; shots with a null origin (no shooter tracked) are skipped
 * entirely.
 *
 * Deliberately computed from the shots rather than `stats.byZone`: the
 * SessionStats zone fgPct is a plain number that cannot distinguish an honest
 * 0% (0 decided makes) from "no decided shots at all", and the story card
 * must render those differently ('0%' vs '—').
 */
export function zoneBreakdown(shots: readonly ResolvedShot[]): ZoneLine[] {
  const acc: Record<ChartZone, { attempts: number; makes: number; decided: number }> = {
    left: { attempts: 0, makes: 0, decided: 0 },
    center: { attempts: 0, makes: 0, decided: 0 },
    right: { attempts: 0, makes: 0, decided: 0 },
  };
  for (const shot of shots) {
    const zone = zoneOf(shot.originX);
    if (zone === null) continue;
    const z = acc[zone];
    z.attempts += 1;
    if (shot.outcome === 'make') {
      z.makes += 1;
      z.decided += 1;
    } else if (shot.outcome === 'miss') {
      z.decided += 1;
    }
  }
  return ZONE_ORDER.map((zone) => {
    const z = acc[zone];
    return {
      zone,
      label: ZONE_LABELS[zone],
      attempts: z.attempts,
      makes: z.makes,
      decided: z.decided,
      fgPct: z.decided > 0 ? z.makes / z.decided : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Make arc gallery
// ---------------------------------------------------------------------------

/** A made shot's drawable trajectory for the recap's arc gallery. */
export interface MakeArc {
  /** The shot's per-session id (ResolvedShot.id). */
  id: number;
  trajectory: readonly BallSample[];
  entryAngleDeg: number | null;
}

/**
 * Makes with a drawable trajectory (>= 4 samples — fewer reads as a stub, not
 * an arc), in session order, capped at `max`.
 */
export function makeArcs(shots: readonly ResolvedShot[], max = 12): MakeArc[] {
  const arcs: MakeArc[] = [];
  for (const shot of shots) {
    if (arcs.length >= max) break;
    if (shot.outcome !== 'make') continue;
    if (shot.trajectory.length < 4) continue;
    arcs.push({
      id: shot.id,
      trajectory: shot.trajectory,
      entryAngleDeg: shot.entryAngleDeg,
    });
  }
  return arcs;
}

// ---------------------------------------------------------------------------
// Headline
// ---------------------------------------------------------------------------

/**
 * One-line story headline — a deterministic first-match copy table. Every
 * claim is a measured quantity from the inputs (run length, fgPct, attempts);
 * nothing here invents an achievement the numbers don't back.
 */
export function storyHeadline(stats: SessionStats, run: BestRun | null): string {
  if (stats.attempts === 0) return 'No shots tracked this session.';
  if (run != null && run.makes >= 5) {
    return `You caught fire — ${run.makes} straight at the peak.`;
  }
  if (run != null) return `Best stretch: ${run.makes} makes in a row.`;
  if (stats.fgPct >= 0.5 && stats.attempts >= 8) {
    return 'A steady night — over half your looks dropped.';
  }
  if (stats.attempts < 4) return 'A quick one — every rep counts.';
  return 'Grind session — volume is how you build it.';
}
