/**
 * Session statistics reducers — pure, immutable, deterministic.
 *
 * Feed each {@link ResolvedShot} through {@link applyShot} (or the
 * {@link StatsAccumulator} API) as it resolves; after a user correction flips
 * an outcome, rebuild from scratch with {@link recomputeStats}.
 *
 * Averages / standard deviations of entry & release angles run over DECIDED
 * shots only ('make' | 'miss'); 'unsure' shots and null angles never
 * contribute. Std-dev is the POPULATION std (numpy's default, ddof = 0), so a
 * single sample yields 0.
 *
 * O(1) incremental angle stats need per-metric sample counts that the
 * SessionStats contract does not carry. Every stats object produced by this
 * module therefore has its exact Welford state registered in an internal
 * WeakMap (invisible to callers, GC-safe, no mutation of results). For a
 * foreign, hand-built stats object the state is reconstructed best-effort
 * (assuming every decided shot contributed an angle sample) — prefer
 * module-produced objects or {@link recomputeStats} when exactness matters.
 */
import { STREAKS } from './config';
import type {
  ChartZone,
  ResolvedShot,
  SessionStats,
  ShotOutcome,
  ShotValue,
  SoundEvent,
} from './types';

/**
 * Estimated point value of a shot for stats folding: the attached
 * {@link ResolvedShot.shotValue}, defaulting to 2 when 2/3 estimation didn't
 * run. Applies to makes and misses alike (a missed 3-attempt still counts as a
 * 3-point ATTEMPT).
 */
function shotPointValue(shot: ResolvedShot): ShotValue {
  return shot.shotValue === 3 ? 3 : 2;
}

// ---------------------------------------------------------------------------
// Internal: Welford running-moment state
// ---------------------------------------------------------------------------

/** Running-moment triple for Welford's online mean/variance algorithm. */
interface Welford {
  /** Number of samples pushed. */
  readonly n: number;
  /** Running mean (0 when n = 0). */
  readonly mean: number;
  /** Sum of squared deviations from the mean (M2). */
  readonly m2: number;
}

const WELFORD_ZERO: Welford = { n: 0, mean: 0, m2: 0 };

function welfordPush(w: Welford, x: number): Welford {
  const n = w.n + 1;
  const d = x - w.mean;
  const mean = w.mean + d / n;
  const m2 = w.m2 + d * (x - mean);
  return { n, mean, m2 };
}

function welfordAvg(w: Welford): number | null {
  return w.n === 0 ? null : w.mean;
}

/** Population std (ddof = 0), matching numpy's default. */
function welfordStd(w: Welford): number | null {
  return w.n === 0 ? null : Math.sqrt(w.m2 / w.n);
}

/** Rebuild a Welford triple from visible avg/std, assuming `n` samples. */
function reconstructWelford(
  avg: number | null,
  std: number | null,
  n: number,
): Welford {
  if (avg === null || n <= 0) return WELFORD_ZERO;
  const s = std ?? 0;
  return { n, mean: avg, m2: s * s * n };
}

// ---------------------------------------------------------------------------
// Internal: hidden per-stats state (exact angle moments + per-zone decided)
// ---------------------------------------------------------------------------

const ZONES: readonly ChartZone[] = ['left', 'center', 'right'];

interface HiddenState {
  readonly entry: Welford;
  readonly release: Welford;
  /** Decided (make|miss) attempts per zone — needed for zone fgPct. */
  readonly zoneDecided: Readonly<Record<ChartZone, number>>;
}

const EMPTY_HIDDEN: HiddenState = {
  entry: WELFORD_ZERO,
  release: WELFORD_ZERO,
  zoneDecided: { left: 0, center: 0, right: 0 },
};

/** Exact side-state for every stats object this module has produced. */
const hiddenStates = new WeakMap<SessionStats, HiddenState>();

/**
 * Best-effort state for a foreign stats object: assumes every decided shot
 * contributed an angle sample and derives per-zone decided counts from the
 * visible zone fgPct (falling back to zone attempts).
 *
 * This is an intentional, documented approximation (see module doc) for
 * stats objects this module didn't produce itself — but it should be RARE:
 * every object from emptyStats/applyShot/recomputeStats/pushShot carries its
 * own exact state in the WeakMap. A non-empty stats object landing here
 * usually means the WeakMap association was lost (e.g. structuredClone, a
 * JSON round-trip, or a persisted/rehydrated store), which silently degrades
 * precision — so flag it in dev builds to make that discoverable instead of
 * silent.
 */
function reconstructHidden(stats: SessionStats): HiddenState {
  if (process.env.NODE_ENV !== 'production' && stats.attempts > 0) {
    console.warn(
      '[stats] reconstructHidden: rebuilding approximate angle/zone state ' +
        'for a stats object this module did not produce (WeakMap association ' +
        'lost?). Prefer objects from emptyStats/applyShot/recomputeStats/pushShot.',
    );
  }
  const decided = stats.makes + stats.misses;
  const zoneDecided: Record<ChartZone, number> = {
    left: 0,
    center: 0,
    right: 0,
  };
  for (const z of ZONES) {
    const zs = stats.byZone[z];
    zoneDecided[z] =
      zs.fgPct > 0 && zs.makes > 0
        ? Math.round(zs.makes / zs.fgPct)
        : zs.attempts;
  }
  return {
    entry: reconstructWelford(
      stats.avgEntryAngleDeg,
      stats.entryAngleStdDeg,
      decided,
    ),
    release: reconstructWelford(
      stats.avgReleaseAngleDeg,
      stats.releaseAngleStdDeg,
      decided,
    ),
    zoneDecided,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A fresh, all-zero {@link SessionStats}. Angle averages/stds are null until
 * the first decided shot with a non-null angle arrives.
 */
export function emptyStats(): SessionStats {
  const stats: SessionStats = {
    attempts: 0,
    makes: 0,
    misses: 0,
    unsure: 0,
    fgPct: 0,
    currentStreak: 0,
    bestStreak: 0,
    avgEntryAngleDeg: null,
    entryAngleStdDeg: null,
    avgReleaseAngleDeg: null,
    releaseAngleStdDeg: null,
    byZone: {
      left: { attempts: 0, makes: 0, fgPct: 0 },
      center: { attempts: 0, makes: 0, fgPct: 0 },
      right: { attempts: 0, makes: 0, fgPct: 0 },
    },
    points: 0,
    twoPtMakes: 0,
    twoPtAttempts: 0,
    threePtMakes: 0,
    threePtAttempts: 0,
    twoPtPct: 0,
    threePtPct: 0,
  };
  hiddenStates.set(stats, EMPTY_HIDDEN);
  return stats;
}

/**
 * Shot-chart zone for a normalized shooter x (0..1, from
 * {@link ResolvedShot.originX}): thirds of the frame — x < 1/3 ⇒ 'left',
 * x < 2/3 ⇒ 'center', else 'right'. Null passes through (no person tracked).
 */
export function zoneOf(originX: number | null): ChartZone | null {
  if (originX === null) return null;
  if (originX < 1 / 3) return 'left';
  if (originX < 2 / 3) return 'center';
  return 'right';
}

/**
 * Fold one resolved shot into the stats. Returns a NEW object; the input is
 * never mutated.
 *
 * Semantics:
 * - 'unsure' shots increment `attempts` and `unsure` only — they are excluded
 *   from fgPct, angle stats, and leave both streaks untouched.
 * - 'make' extends `currentStreak` and, when it exceeds it, `bestStreak`.
 * - 'miss' zeroes `currentStreak`; `bestStreak` is retained.
 * - Angle avg/std run over decided shots whose angle is non-null (population
 *   std, numpy ddof = 0).
 * - Zone buckets: `byZone[zone].attempts` counts every attempt (incl. unsure)
 *   whose origin falls in the zone; the zone `fgPct` — like the top-level one
 *   — excludes unsure shots. Shots with a null `originX` are not bucketed.
 *
 * O(1) per shot. Exact when `stats` was produced by this module (emptyStats /
 * applyShot / recomputeStats / pushShot); for foreign objects the angle
 * moments are reconstructed best-effort (see module doc).
 */
export function applyShot(stats: SessionStats, shot: ResolvedShot): SessionStats {
  const prev = hiddenStates.get(stats) ?? reconstructHidden(stats);
  const isMake = shot.outcome === 'make';
  const isMiss = shot.outcome === 'miss';
  const isDecided = isMake || isMiss;

  const makes = stats.makes + (isMake ? 1 : 0);
  const misses = stats.misses + (isMiss ? 1 : 0);
  const decidedCount = makes + misses;

  let currentStreak = stats.currentStreak;
  let bestStreak = stats.bestStreak;
  if (isMake) {
    currentStreak += 1;
    if (currentStreak > bestStreak) bestStreak = currentStreak;
  } else if (isMiss) {
    currentStreak = 0;
  }

  let entry = prev.entry;
  let release = prev.release;
  if (isDecided) {
    if (shot.entryAngleDeg !== null) entry = welfordPush(entry, shot.entryAngleDeg);
    if (shot.releaseAngleDeg !== null) {
      release = welfordPush(release, shot.releaseAngleDeg);
    }
  }

  const byZone: SessionStats['byZone'] = {
    left: { ...stats.byZone.left },
    center: { ...stats.byZone.center },
    right: { ...stats.byZone.right },
  };
  let zoneDecided = prev.zoneDecided;
  const zone = zoneOf(shot.originX);
  if (zone !== null) {
    const z = byZone[zone];
    z.attempts += 1;
    if (isMake) z.makes += 1;
    if (isDecided) {
      zoneDecided = { ...zoneDecided, [zone]: zoneDecided[zone] + 1 };
    }
    z.fgPct = zoneDecided[zone] > 0 ? z.makes / zoneDecided[zone] : 0;
  }

  // --- 2/3-point tallies (estimated shotValue; make w/o value ⇒ 2) ---------
  // Only DECIDED shots contribute to attempts; only makes to makes/points.
  const value = shotPointValue(shot);
  const is3 = value === 3;
  const twoPtMakes = stats.twoPtMakes + (isMake && !is3 ? 1 : 0);
  const twoPtAttempts = stats.twoPtAttempts + (isDecided && !is3 ? 1 : 0);
  const threePtMakes = stats.threePtMakes + (isMake && is3 ? 1 : 0);
  const threePtAttempts = stats.threePtAttempts + (isDecided && is3 ? 1 : 0);
  const points = stats.points + (isMake ? value : 0);

  const next: SessionStats = {
    attempts: stats.attempts + 1,
    makes,
    misses,
    unsure: stats.unsure + (isDecided ? 0 : 1),
    fgPct: decidedCount > 0 ? makes / decidedCount : 0,
    currentStreak,
    bestStreak,
    avgEntryAngleDeg: welfordAvg(entry),
    entryAngleStdDeg: welfordStd(entry),
    avgReleaseAngleDeg: welfordAvg(release),
    releaseAngleStdDeg: welfordStd(release),
    byZone,
    points,
    twoPtMakes,
    twoPtAttempts,
    threePtMakes,
    threePtAttempts,
    twoPtPct: twoPtAttempts > 0 ? twoPtMakes / twoPtAttempts : 0,
    threePtPct: threePtAttempts > 0 ? threePtMakes / threePtAttempts : 0,
  };
  hiddenStates.set(next, { entry, release, zoneDecided });
  return next;
}

/**
 * Rebuild stats from the full shot list. Use after a user correction flips a
 * shot's outcome — equivalent to folding {@link applyShot} over the list from
 * {@link emptyStats}, and exact regardless of any prior stats object.
 */
export function recomputeStats(shots: readonly ResolvedShot[]): SessionStats {
  let stats = emptyStats();
  for (const shot of shots) stats = applyShot(stats, shot);
  return stats;
}

// ---------------------------------------------------------------------------
// Accumulator API — stats plus the raw decided-angle samples
// ---------------------------------------------------------------------------

/**
 * Stats bundled with the raw angle samples of decided shots — for consumers
 * that need the underlying distributions (histograms, consistency charts)
 * rather than just avg/std. Treat as immutable; produce new values with
 * {@link pushShot}.
 */
export interface StatsAccumulator {
  /** The derived session stats (identical to the applyShot fold). */
  stats: SessionStats;
  /** Angle samples of decided shots with non-null angles, in shot order. */
  angles: { entry: number[]; release: number[] };
}

/** A fresh accumulator with empty stats and no angle samples. */
export function createAccumulator(): StatsAccumulator {
  return { stats: emptyStats(), angles: { entry: [], release: [] } };
}

/**
 * Fold one resolved shot into an accumulator. Returns a NEW accumulator; the
 * input (including its arrays) is never mutated. Unchanged angle arrays are
 * shared between the old and new accumulator, so do not mutate them.
 */
export function pushShot(
  acc: StatsAccumulator,
  shot: ResolvedShot,
): StatsAccumulator {
  const isDecided = shot.outcome === 'make' || shot.outcome === 'miss';
  const entry =
    isDecided && shot.entryAngleDeg !== null
      ? [...acc.angles.entry, shot.entryAngleDeg]
      : acc.angles.entry;
  const release =
    isDecided && shot.releaseAngleDeg !== null
      ? [...acc.angles.release, shot.releaseAngleDeg]
      : acc.angles.release;
  return { stats: applyShot(acc.stats, shot), angles: { entry, release } };
}

// ---------------------------------------------------------------------------
// Feedback sounds
// ---------------------------------------------------------------------------

/**
 * Known celebration stingers. Streak values in STREAKS.celebrateAt without an
 * entry here (a config/SoundEvent contract gap) fall back to plain 'make'.
 */
const STREAK_SOUNDS: Readonly<Partial<Record<number, SoundEvent>>> = {
  3: 'streak3',
  5: 'streak5',
  10: 'streak10',
};

/**
 * Which sound to play for a just-resolved shot, given the ALREADY-UPDATED
 * `currentStreak` (i.e. from the stats returned by {@link applyShot}).
 * 'make' normally, a celebration stinger exactly when the streak equals one
 * of STREAKS.celebrateAt (3/5/10), 'miss' for misses, and null (silence) for
 * unsure shots.
 */
export function streakSoundFor(
  currentStreak: number,
  outcome: ShotOutcome,
): SoundEvent | null {
  if (outcome === 'miss') return 'miss';
  if (outcome !== 'make') return null;
  if (STREAKS.celebrateAt.includes(currentStreak)) {
    const stinger = STREAK_SOUNDS[currentStreak];
    if (stinger !== undefined) return stinger;
  }
  return 'make';
}
