/**
 * Shot Lab — the deep-analysis engine behind the Shot Lab screen.
 *
 * Pure TypeScript over an array of {@link ResolvedShot}: no I/O, no React —
 * fully unit-testable. Four products:
 *
 *  1. {@link makeMissReport}   — which measurable habits separate the user's
 *     MAKES from their MISSES (per-metric means + Cohen's d effect size).
 *  2. {@link radarScores}      — 0..100 scores per shooting dimension, with
 *     NBA-average and elite reference values pushed through the SAME scorer
 *     so the radar comparison is honest.
 *  3. {@link matchArchetype}   — which pro shooting profile the user's jumper
 *     most resembles (weighted normalized distance).
 *  4. {@link coachPlan}        — the top-3 prioritized fixes, each backed by
 *     the user's own data plus a concrete drill.
 *
 * Plus {@link normalizedArcs} — trajectories normalized to a unit flight for
 * the make-vs-miss arc overlay chart.
 */
import { FORM } from './config';
import {
  ARCHETYPE_SCALES,
  ARCHETYPE_WEIGHTS,
  BENCHMARK_AXES,
  PLAYER_ARCHETYPES,
  axisValueFromMetrics,
  type AxisKey,
  type BenchmarkAxis,
  type PlayerArchetype,
} from './nbaBenchmarks';
import { fitArc, sampleArc } from './trajectory';
import type { ResolvedShot } from './types';

// ---------------------------------------------------------------------------
// Metric extraction
// ---------------------------------------------------------------------------

/** Metrics the make-vs-miss comparison understands. */
export type LabMetricKey =
  | 'releaseAngleDeg'
  | 'entryAngleDeg'
  | 'releaseTimeMs'
  | 'setPointElbowDeg'
  | 'kneeFlexionDeg'
  | 'followThroughHeldMs'
  | 'releaseHeightNorm'
  | 'arcHeightRatio'
  | 'releaseToRimSec';

export interface LabMetricDef {
  key: LabMetricKey;
  label: string;
  unit: string;
  /** Ideal band [lo, hi] when one exists (drives band shading + coach plan). */
  ideal?: [number, number];
  /** Decimal places for display. */
  digits: number;
  /** True when the metric needs the pose model (form analysis ON). */
  needsPose: boolean;
}

export const LAB_METRICS: readonly LabMetricDef[] = [
  { key: 'releaseAngleDeg', label: 'Release angle', unit: '°', ideal: [FORM.releaseAngle.min, FORM.releaseAngle.max], digits: 1, needsPose: false },
  { key: 'entryAngleDeg', label: 'Entry angle', unit: '°', ideal: [FORM.entryAngle.min, FORM.entryAngle.max], digits: 1, needsPose: false },
  { key: 'arcHeightRatio', label: 'Arc height', unit: '×', ideal: [0.18, 0.42], digits: 2, needsPose: false },
  { key: 'releaseTimeMs', label: 'Release time', unit: 'ms', ideal: [0, 700], digits: 0, needsPose: true },
  { key: 'setPointElbowDeg', label: 'Set-point elbow', unit: '°', ideal: [FORM.elbowSetPoint.min, FORM.elbowSetPoint.max], digits: 0, needsPose: true },
  { key: 'kneeFlexionDeg', label: 'Knee flexion', unit: '°', ideal: [FORM.kneeFlexion.min, FORM.kneeFlexion.max], digits: 0, needsPose: true },
  { key: 'followThroughHeldMs', label: 'Follow-through hold', unit: 'ms', ideal: [FORM.followThrough.holdSec * 1000, 10000], digits: 0, needsPose: true },
  // Release-to-rim: no ideal band on purpose — flight time scales with shot
  // distance, so a universal target would mislead (a 2 m floater and a deep
  // three differ by ~0.5 s while both being perfect). It still earns its
  // make-vs-miss split: at a fixed spot, longer flight = higher arc. NOT in
  // BENCHMARK_AXES either — the radar needs NBA/elite reference values the
  // published literature doesn't give for this camera-derived quantity.
  { key: 'releaseToRimSec', label: 'Release-to-rim time', unit: 's', digits: 2, needsPose: true },
] as const;

/**
 * Apex rise of the flight divided by its horizontal span — a camera-agnostic
 * "how much rainbow" number computed purely from the tracked trajectory
 * (dimensionless, so it survives any camera distance). ~0.15 is a flat dart,
 * ~0.30 a classic arc, >0.45 a moon ball. Null when the arc can't be fitted
 * or the flight is too short/vertical to be meaningful.
 */
export function arcHeightRatio(shot: ResolvedShot): number | null {
  const fit = fitArc(shot.trajectory);
  if (!fit) return null;
  const pts = sampleArc(fit, 16);
  if (pts.length < 3) return null;
  const x0 = pts[0]!.x;
  const x1 = pts[pts.length - 1]!.x;
  const span = Math.abs(x1 - x0);
  if (span < 1e-6) return null;
  const startY = pts[0]!.y;
  let minY = Infinity;
  for (const p of pts) if (p.y < minY) minY = p.y;
  const rise = startY - minY; // +y down: apex above start = positive rise
  if (rise <= 0) return null;
  const ratio = rise / span;
  // Degenerate near-vertical flights produce absurd ratios — not a real arc.
  return ratio > 2 ? null : ratio;
}

/** Value of a Lab metric for one shot, or null when unmeasured. */
export function metricOf(shot: ResolvedShot, key: LabMetricKey): number | null {
  switch (key) {
    case 'releaseAngleDeg':
      return shot.releaseAngleDeg ?? shot.form?.metrics.releaseAngleDeg ?? null;
    case 'entryAngleDeg':
      return shot.entryAngleDeg ?? shot.form?.metrics.entryAngleDeg ?? null;
    case 'arcHeightRatio':
      return arcHeightRatio(shot);
    case 'releaseTimeMs':
      return shot.form?.metrics.releaseTimeMs ?? null;
    case 'setPointElbowDeg':
      return shot.form?.metrics.setPointElbowDeg ?? null;
    case 'kneeFlexionDeg':
      return shot.form?.metrics.kneeFlexionDeg ?? null;
    case 'followThroughHeldMs':
      return shot.form?.metrics.followThroughHeldMs ?? null;
    case 'releaseHeightNorm':
      return shot.form?.metrics.releaseHeightNorm ?? null;
    case 'releaseToRimSec':
      return shot.releaseToRimSec ?? null;
  }
}

// ---------------------------------------------------------------------------
// Make vs miss
// ---------------------------------------------------------------------------

export interface GroupStats {
  n: number;
  mean: number | null;
  std: number | null;
}

export interface MetricSplit {
  def: LabMetricDef;
  make: GroupStats;
  miss: GroupStats;
  /** make.mean - miss.mean (null unless both measured). */
  delta: number | null;
  /**
   * Cohen's d (pooled σ): |d| ≥ 0.5 is a solid habit difference, ≥ 0.8 a big
   * one. Null when either side has n < MIN_GROUP_N or the pooled σ is ~0.
   */
  effect: number | null;
  /** Raw per-shot values for the dot strips: [value, isMake]. */
  points: [number, boolean][];
}

export const MIN_GROUP_N = 3;

function stats(values: number[]): GroupStats {
  const n = values.length;
  if (n === 0) return { n: 0, mean: null, std: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, std: null };
  const varSum = values.reduce((a, b) => a + (b - mean) * (b - mean), 0);
  return { n, mean, std: Math.sqrt(varSum / (n - 1)) };
}

/** Decided shots only (corrections respected — outcome is the source of truth). */
function decided(shots: readonly ResolvedShot[]): ResolvedShot[] {
  return shots.filter((s) => s.outcome === 'make' || s.outcome === 'miss');
}

export function splitMetric(shots: readonly ResolvedShot[], def: LabMetricDef): MetricSplit {
  const makeVals: number[] = [];
  const missVals: number[] = [];
  const points: [number, boolean][] = [];
  for (const s of decided(shots)) {
    const v = metricOf(s, def.key);
    if (v == null || !Number.isFinite(v)) continue;
    const isMake = s.outcome === 'make';
    (isMake ? makeVals : missVals).push(v);
    points.push([v, isMake]);
  }
  const make = stats(makeVals);
  const miss = stats(missVals);
  let delta: number | null = null;
  let effect: number | null = null;
  if (make.mean != null && miss.mean != null) {
    delta = make.mean - miss.mean;
    if (make.n >= MIN_GROUP_N && miss.n >= MIN_GROUP_N && make.std != null && miss.std != null) {
      const pooled = Math.sqrt(
        ((make.n - 1) * make.std * make.std + (miss.n - 1) * miss.std * miss.std) /
          (make.n + miss.n - 2),
      );
      effect = pooled > 1e-9 ? delta / pooled : null;
    }
  }
  return { def, make, miss, delta, effect, points };
}

export interface MakeMissReport {
  makes: number;
  misses: number;
  splits: MetricSplit[];
  /** Splits with a real effect (|d| ≥ 0.35), biggest first. */
  differentiators: MetricSplit[];
  /** Human headline for the #1 differentiator (null when none qualifies). */
  headline: string | null;
}

/** Effect-size floor before a metric is called a differentiator. */
const EFFECT_FLOOR = 0.35;

export function makeMissReport(shots: readonly ResolvedShot[]): MakeMissReport {
  const d = decided(shots);
  const makes = d.filter((s) => s.outcome === 'make').length;
  const misses = d.length - makes;
  const splits = LAB_METRICS.map((def) => splitMetric(shots, def));
  const differentiators = splits
    .filter((s) => s.effect != null && Math.abs(s.effect) >= EFFECT_FLOOR)
    .sort((a, b) => Math.abs(b.effect!) - Math.abs(a.effect!));
  let headline: string | null = null;
  const top = differentiators[0];
  if (top && top.delta != null) {
    const arrow = top.delta > 0 ? 'higher' : 'lower';
    const mag = Math.abs(top.delta).toFixed(top.def.digits);
    headline = `Your makes average ${mag}${top.def.unit} ${arrow} ${top.def.label.toLowerCase()} than your misses.`;
  }
  return { makes, misses, splits, differentiators, headline };
}

// ---------------------------------------------------------------------------
// Radar vs NBA
// ---------------------------------------------------------------------------

export interface RadarAxisScore {
  axis: BenchmarkAxis;
  /** The user's raw value in native units (null = unmeasured). */
  value: number | null;
  /** 0..100 (null when unmeasured). */
  user: number | null;
  nba: number;
  elite: number;
}

/**
 * Band-distance scorer: 100 anywhere inside the ideal band, falling linearly
 * to 0 at `zeroAt` beyond the nearer band edge. One-sided axes only penalize
 * shortfall below the band.
 */
export function scoreAxis(axis: BenchmarkAxis, value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const [lo, hi] = axis.ideal;
  let over = 0;
  if (value < lo) over = lo - value;
  else if (value > hi) over = axis.oneSided ? 0 : value - hi;
  const s = 100 * (1 - over / axis.zeroAt);
  return Math.max(0, Math.min(100, s));
}

export function radarScores(shots: readonly ResolvedShot[]): RadarAxisScore[] {
  const d = decided(shots);
  // Session-level values per axis.
  const releaseAngles: number[] = [];
  const perAxisVals = new Map<AxisKey, number[]>();
  for (const s of d) {
    const rel = metricOf(s, 'releaseAngleDeg');
    if (rel != null) releaseAngles.push(rel);
    for (const axis of BENCHMARK_AXES) {
      if (axis.key === 'consistencyStdDeg') continue;
      const m = s.form?.metrics;
      let v: number | null = null;
      if (axis.key === 'releaseAngleDeg') v = metricOf(s, 'releaseAngleDeg');
      else if (axis.key === 'entryAngleDeg') v = metricOf(s, 'entryAngleDeg');
      else if (m) v = axisValueFromMetrics(m, axis.key);
      if (v != null && Number.isFinite(v)) {
        const arr = perAxisVals.get(axis.key) ?? [];
        arr.push(v);
        perAxisVals.set(axis.key, arr);
      }
    }
  }
  return BENCHMARK_AXES.map((axis) => {
    let value: number | null = null;
    if (axis.key === 'consistencyStdDeg') {
      value = releaseAngles.length >= 4 ? stats(releaseAngles).std : null;
    } else {
      const vals = perAxisVals.get(axis.key) ?? [];
      value = vals.length > 0 ? stats(vals).mean : null;
    }
    return {
      axis,
      value,
      user: scoreAxis(axis, value),
      // Benchmarks scored through the SAME function — honest comparison.
      nba: scoreAxis(axis, axis.nbaAvg) ?? 0,
      elite: scoreAxis(axis, axis.elite) ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Archetype match
// ---------------------------------------------------------------------------

export interface ArchetypeMatch {
  player: PlayerArchetype;
  /** 0..100 similarity. */
  similarity: number;
  /** Per-dimension rows for the comparison chart. */
  rows: {
    key: keyof PlayerArchetype['profile'];
    label: string;
    unit: string;
    user: number;
    player: number;
  }[];
}

const DIM_LABELS: Record<keyof PlayerArchetype['profile'], { label: string; unit: string }> = {
  releaseAngleDeg: { label: 'Release angle', unit: '°' },
  entryAngleDeg: { label: 'Entry angle', unit: '°' },
  releaseTimeMs: { label: 'Release time', unit: 'ms' },
  consistencyStdDeg: { label: 'Consistency σ', unit: '°' },
};

/** User profile means for the archetype dimensions (null = not enough data). */
export function userProfile(shots: readonly ResolvedShot[]): Partial<Record<keyof PlayerArchetype['profile'], number>> {
  const d = decided(shots);
  const rel: number[] = [];
  const ent: number[] = [];
  const rt: number[] = [];
  for (const s of d) {
    const r = metricOf(s, 'releaseAngleDeg');
    if (r != null) rel.push(r);
    const e = metricOf(s, 'entryAngleDeg');
    if (e != null) ent.push(e);
    const t = metricOf(s, 'releaseTimeMs');
    if (t != null) rt.push(t);
  }
  const out: Partial<Record<keyof PlayerArchetype['profile'], number>> = {};
  if (rel.length >= 4) {
    out.releaseAngleDeg = stats(rel).mean!;
    const sd = stats(rel).std;
    if (sd != null) out.consistencyStdDeg = sd;
  }
  if (ent.length >= 4) out.entryAngleDeg = stats(ent).mean!;
  if (rt.length >= 3) out.releaseTimeMs = stats(rt).mean!;
  return out;
}

/**
 * Ranked archetype matches. Requires at least the release-angle dimension
 * (≥4 measured shots); missing dimensions are simply excluded from the
 * distance, so a no-pose session still matches on ball-flight dimensions.
 * Returns [] when there isn't enough data for a meaningful match.
 */
export function matchArchetype(shots: readonly ResolvedShot[]): ArchetypeMatch[] {
  const profile = userProfile(shots);
  const dims = Object.keys(profile) as (keyof PlayerArchetype['profile'])[];
  if (profile.releaseAngleDeg == null || dims.length < 2) return [];
  const matches = PLAYER_ARCHETYPES.map((player) => {
    let acc = 0;
    let wsum = 0;
    for (const k of dims) {
      const u = profile[k]!;
      const p = player.profile[k];
      const w = ARCHETYPE_WEIGHTS[k];
      const norm = Math.abs(u - p) / ARCHETYPE_SCALES[k];
      acc += w * Math.min(2, norm); // cap one dimension's damage
      wsum += w;
    }
    const dist = acc / wsum; // 0 = identical, 2 = maximally far on every dim
    const similarity = Math.round(100 * Math.max(0, 1 - dist / 2));
    const rows = dims.map((k) => ({
      key: k,
      label: DIM_LABELS[k].label,
      unit: DIM_LABELS[k].unit,
      user: profile[k]!,
      player: player.profile[k],
    }));
    return { player, similarity, rows };
  });
  return matches.sort((a, b) => b.similarity - a.similarity);
}

// ---------------------------------------------------------------------------
// Coach plan
// ---------------------------------------------------------------------------

export interface CoachFocus {
  def: LabMetricDef;
  /** Fraction of measured shots outside the ideal band (0..1). */
  violationRate: number;
  /** Signed effect size from the make/miss split (null when unknown). */
  effect: number | null;
  priority: number;
  title: string;
  /** The user's own numbers, in one sentence. */
  dataLine: string;
  /** A concrete drill to run next session. */
  drill: string;
  /** The measurable target. */
  targetLine: string;
}

const DRILLS: Record<LabMetricKey, { fixTitle: string; drill: string }> = {
  releaseAngleDeg: {
    fixTitle: 'Add launch arc',
    drill: 'One-hand form shooting from 2m: exaggerate a high finish ("hand in the rim"), 3×15 makes before backing up.',
  },
  entryAngleDeg: {
    fixTitle: 'Land the ball softer',
    drill: 'Swish-only game to 10 from the elbow — rim-touch makes count as misses, forcing a 45° drop-in.',
  },
  arcHeightRatio: {
    fixTitle: 'Shape the rainbow',
    drill: 'Shoot over a broomstick held by a partner (or a chair back) 1m in front of you — the ball must clear it and still drop.',
  },
  releaseTimeMs: {
    fixTitle: 'Speed up the trigger',
    drill: 'Catch-and-shoot countdown: partner (or wall pass) feeds, you must release before a spoken "two". 3×10.',
  },
  setPointElbowDeg: {
    fixTitle: 'Fix the set point',
    drill: 'Mirror reps: pause at the dip, check the elbow makes an L (75–90°), then finish. 20 slow-motion reps daily.',
  },
  kneeFlexionDeg: {
    fixTitle: 'Load the legs',
    drill: 'Chair-rise shooting: start seated on a chair edge, rise and shoot in one motion so the legs drive the ball. 3×10.',
  },
  followThroughHeldMs: {
    fixTitle: 'Freeze the finish',
    drill: 'Hold the follow-through until the ball hits the floor — every rep, no exceptions, for one full session.',
  },
  releaseHeightNorm: {
    fixTitle: 'Raise the release',
    drill: 'Wall-reach reps: mark your one-hand reach on a wall, release the ball above that mark 20 times in a row.',
  },
  // Unreachable today (no ideal band ⇒ coachPlan never selects it); the
  // Record type keeps this exhaustive so a future band gets a drill for free.
  releaseToRimSec: {
    fixTitle: 'Shape the flight',
    drill: 'Same-spot arc ladder: from one spot, alternate a flat make and a high-arc make — feel how flight time changes while the ball still drops in.',
  },
};

export function coachPlan(shots: readonly ResolvedShot[], maxItems = 3): CoachFocus[] {
  const d = decided(shots);
  if (d.length < 4) return [];
  const report = makeMissReport(shots);
  const out: CoachFocus[] = [];
  for (const split of report.splits) {
    const def = split.def;
    if (!def.ideal) continue;
    const values = split.points.map(([v]) => v);
    if (values.length < 4) continue;
    const [lo, hi] = def.ideal;
    const violations = values.filter((v) => v < lo || v > hi).length;
    const violationRate = violations / values.length;
    if (violationRate < 0.34) continue; // habit, not a blip
    const effect = split.effect;
    const priority = violationRate * (1 + Math.min(1.5, Math.abs(effect ?? 0)));
    const mean = stats(values).mean!;
    const dir = mean < lo ? 'below' : mean > hi ? 'above' : 'around';
    const dataLine =
      `${Math.round(violationRate * 100)}% of your shots were outside the ideal ` +
      `${lo}–${hi}${def.unit} band (your average: ${mean.toFixed(def.digits)}${def.unit}, ${dir} it)` +
      (effect != null && Math.abs(effect) >= EFFECT_FLOOR
        ? ' — and this metric clearly separates your makes from your misses.'
        : '.');
    const drill = DRILLS[def.key];
    out.push({
      def,
      violationRate,
      effect,
      priority,
      title: drill.fixTitle,
      dataLine,
      drill: drill.drill,
      targetLine: `Target: keep ${def.label.toLowerCase()} inside ${lo}–${hi}${def.unit}.`,
    });
  }
  return out.sort((a, b) => b.priority - a.priority).slice(0, maxItems);
}

// ---------------------------------------------------------------------------
// Normalized arcs (for the make-vs-miss overlay chart)
// ---------------------------------------------------------------------------

export interface NormalizedArc {
  /** 24 points, x normalized 0..1 left→right, y in the SAME scale, +up. */
  pts: { x: number; y: number }[];
  outcome: 'make' | 'miss';
}

const ARC_SAMPLES = 24;

/**
 * Fit + sample each decided shot's trajectory, then normalize: release at
 * (0,0), horizontal span scaled to 1 (mirrored so flight always reads
 * left→right), y flipped to +up and scaled by the same factor — so arc SHAPE
 * (height ratio, entry steepness) is comparable across shots and camera
 * distances. Shots whose arc can't be fitted are skipped.
 */
export function normalizedArcs(shots: readonly ResolvedShot[]): NormalizedArc[] {
  const out: NormalizedArc[] = [];
  for (const s of decided(shots)) {
    const fit = fitArc(s.trajectory);
    if (!fit) continue;
    const pts = sampleArc(fit, ARC_SAMPLES);
    if (pts.length < 3) continue;
    const x0 = pts[0]!.x;
    const y0 = pts[0]!.y;
    const dx = pts[pts.length - 1]!.x - x0;
    if (Math.abs(dx) < 1e-6) continue;
    const sx = 1 / dx; // negative dx mirrors right-to-left flights
    const norm = pts.map((p) => ({
      x: (p.x - x0) * sx,
      y: -(p.y - y0) * Math.abs(sx), // +y down → +up, same scale as x
    }));
    // Sanity: reject degenerate fits that exploded.
    if (norm.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.y) > 3)) {
      continue;
    }
    out.push({ pts: norm, outcome: s.outcome as 'make' | 'miss' });
  }
  return out;
}

/** Bucket-average arc of a group at ARC_SAMPLES x positions (null if <2 arcs). */
export function meanArc(arcs: readonly NormalizedArc[], outcome: 'make' | 'miss'): { x: number; y: number }[] | null {
  const group = arcs.filter((a) => a.outcome === outcome);
  if (group.length < 2) return null;
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i < ARC_SAMPLES; i++) {
    let sx = 0;
    let sy = 0;
    for (const a of group) {
      sx += a.pts[i]!.x;
      sy += a.pts[i]!.y;
    }
    pts.push({ x: sx / group.length, y: sy / group.length });
  }
  return pts;
}
