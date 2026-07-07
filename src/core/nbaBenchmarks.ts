/**
 * NBA / pro-shooting reference data for the Shot Lab.
 *
 * Numbers are ESTIMATES compiled from public reporting and published shooting
 * research (Noah Basketball arc studies, HomeCourt metrics, sports-science
 * coverage of player release times). They are coaching references, not claims
 * of precision — the UI labels them "est.".
 *
 * Sources of the bands (see also FORM in config.ts, already Noah-derived):
 * - Entry angle: Noah's optimal 43–47° window (45° ideal).
 * - Release time (pickup→release): ~0.54s NBA average, ~0.40s elite
 *   catch-and-shoot (widely reported for S. Curry).
 * - Release angle: 45–55° launch window for jump shots at typical ranges.
 * - Consistency: Noah reports elite shooters keep entry-angle σ under ~2–3°;
 *   4° is a good amateur target.
 */
import type { FormMetrics } from './types';

/** One radar axis the Shot Lab scores (0..100 via shotLab.scoreAxis). */
export interface BenchmarkAxis {
  key: AxisKey;
  label: string;
  /** Ideal band [lo, hi] in the metric's native unit. */
  ideal: [number, number];
  /** Offset beyond the band edge (native unit) that scores zero. */
  zeroAt: number;
  /** Higher-is-better metrics score by distance below `ideal[0]` only. */
  oneSided?: boolean;
  /** NBA-average reference value (native unit, est.). */
  nbaAvg: number;
  /** Elite reference value (native unit, est.). */
  elite: number;
}

export type AxisKey =
  | 'releaseAngleDeg'
  | 'entryAngleDeg'
  | 'releaseTimeMs'
  | 'consistencyStdDeg'
  | 'followThroughHeldMs'
  | 'kneeFlexionDeg';

export const BENCHMARK_AXES: readonly BenchmarkAxis[] = [
  {
    key: 'releaseAngleDeg',
    label: 'Arc',
    ideal: [45, 55],
    zeroAt: 20,
    nbaAvg: 48,
    elite: 50,
  },
  {
    key: 'entryAngleDeg',
    label: 'Touch',
    ideal: [43, 47],
    zeroAt: 15,
    nbaAvg: 44,
    elite: 45,
  },
  {
    // Lower is better — ideal band is "fast enough", zero far above it.
    key: 'releaseTimeMs',
    label: 'Quickness',
    ideal: [350, 650],
    zeroAt: 900,
    nbaAvg: 540,
    elite: 400,
  },
  {
    // Lower is better; σ of release angle across the session.
    key: 'consistencyStdDeg',
    label: 'Repeatability',
    ideal: [0, 4],
    zeroAt: 8,
    nbaAvg: 3,
    elite: 2,
  },
  {
    key: 'followThroughHeldMs',
    label: 'Follow-through',
    ideal: [300, 10000],
    zeroAt: 300,
    oneSided: true,
    nbaAvg: 450,
    elite: 600,
  },
  {
    key: 'kneeFlexionDeg',
    label: 'Legs',
    ideal: [100, 130],
    zeroAt: 40,
    nbaAvg: 118,
    elite: 115,
  },
] as const;

/**
 * A comparable pro-shooter profile. Values are public-reporting ESTIMATES of
 * each player's signature jump-shot characteristics, expressed in the same
 * units the app measures, so a weighted-distance match is meaningful.
 */
export interface PlayerArchetype {
  name: string;
  /** One-line signature of the style. */
  style: string;
  profile: {
    releaseAngleDeg: number;
    entryAngleDeg: number;
    releaseTimeMs: number;
    consistencyStdDeg: number;
  };
  /** Shown when this archetype is the user's best match. */
  blurb: string;
}

export const PLAYER_ARCHETYPES: readonly PlayerArchetype[] = [
  {
    name: 'Stephen Curry',
    style: 'Lightning release · high arc',
    profile: { releaseAngleDeg: 52, entryAngleDeg: 46, releaseTimeMs: 400, consistencyStdDeg: 2 },
    blurb:
      'Quickest trigger in the game with a rainbow arc — the ball is gone in ~0.4s and drops in steep, giving the rim its biggest target.',
  },
  {
    name: 'Klay Thompson',
    style: 'Catch-and-shoot metronome',
    profile: { releaseAngleDeg: 48, entryAngleDeg: 45, releaseTimeMs: 450, consistencyStdDeg: 2.5 },
    blurb:
      'Zero wasted motion: feet set early, identical mechanics every rep, ball out in under half a second.',
  },
  {
    name: 'Ray Allen',
    style: 'Textbook repeatable form',
    profile: { releaseAngleDeg: 47, entryAngleDeg: 45, releaseTimeMs: 500, consistencyStdDeg: 2 },
    blurb:
      'The classic reference jumper — balanced base, high finish, and machine-like consistency built from thousands of identical reps.',
  },
  {
    name: 'Kevin Durant',
    style: 'High release point · smooth tempo',
    profile: { releaseAngleDeg: 49, entryAngleDeg: 45, releaseTimeMs: 550, consistencyStdDeg: 3 },
    blurb:
      'Releases above the defense with an unhurried, fluid rhythm — arc and touch over raw speed.',
  },
  {
    name: 'Kawhi Leonard',
    style: 'Deliberate mid-range assassin',
    profile: { releaseAngleDeg: 45, entryAngleDeg: 43, releaseTimeMs: 700, consistencyStdDeg: 2.5 },
    blurb:
      'Slower, controlled windup with a flatter, line-drive ball — power and stability over arc.',
  },
  {
    name: 'Damian Lillard',
    style: 'Deep range · confident rhythm',
    profile: { releaseAngleDeg: 49, entryAngleDeg: 46, releaseTimeMs: 500, consistencyStdDeg: 3 },
    blurb:
      'Logo-range shooting demands extra legs and arc — a strong lower body drives a high, soft ball flight.',
  },
] as const;

/**
 * Normalization scales for the archetype match: "one unit of difference" per
 * dimension (roughly one meaningful coaching step). Distances are divided by
 * these before weighting so degrees and milliseconds are comparable.
 */
export const ARCHETYPE_SCALES: Record<keyof PlayerArchetype['profile'], number> = {
  releaseAngleDeg: 6,
  entryAngleDeg: 4,
  releaseTimeMs: 180,
  consistencyStdDeg: 2.5,
};

/** Relative importance of each dimension in the archetype match. */
export const ARCHETYPE_WEIGHTS: Record<keyof PlayerArchetype['profile'], number> = {
  releaseAngleDeg: 1,
  entryAngleDeg: 1,
  releaseTimeMs: 0.9,
  consistencyStdDeg: 0.7,
};

/** Extract the axis value from one shot's FormMetrics (null when unmeasured). */
export function axisValueFromMetrics(m: FormMetrics, key: AxisKey): number | null {
  switch (key) {
    case 'releaseAngleDeg':
      return m.releaseAngleDeg;
    case 'entryAngleDeg':
      return m.entryAngleDeg;
    case 'releaseTimeMs':
      return m.releaseTimeMs;
    case 'followThroughHeldMs':
      return m.followThroughHeldMs;
    case 'kneeFlexionDeg':
      return m.kneeFlexionDeg;
    case 'consistencyStdDeg':
      return null; // session-level, computed across shots
  }
}
