/**
 * NBA / pro-shooting reference data for the Shot Lab.
 *
 * The 12 player profiles below come from a sourced research pass over public
 * shooting analyses (ESPN Sport Science, FiveThirtyEight, Noah arc research,
 * Splash Lab / BBallBreakdown-style coaching film, sports-science reporting),
 * cross-checked for physical consistency (release vs entry angle, motion type
 * vs release time) and normalized into the units THIS APP measures. Each value
 * is a measured/reported figure where one exists and a coach-grade ESTIMATE
 * where it doesn't — the UI labels the whole dataset "est.". They are coaching
 * references, not claims of precision.
 *
 * Key normalizations applied during research:
 * - releaseTimeMs uses the HomeCourt dip→release definition (NBA avg ~540ms);
 *   published catch→release figures were converted.
 * - Retired-era players (Allen, Miller, Nash, Nowitzki) predate modern shot
 *   tracking, so their numbers lean more on estimation.
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
    elite: 1.5,
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
    nbaAvg: 122,
    elite: 118,
  },
] as const;

/** Documented shot-motion classification. */
export type ShotMotion = 'one-motion' | 'two-motion';

/**
 * A comparable pro-shooter profile in the app's own units, plus the coaching
 * substance: how the form actually works, which traits transfer to an amateur
 * and which are body-specific quirks that don't.
 */
export interface PlayerArchetype {
  name: string;
  /** One-line signature of the style. */
  style: string;
  motion: ShotMotion;
  profile: {
    releaseAngleDeg: number;
    entryAngleDeg: number;
    releaseTimeMs: number;
    consistencyStdDeg: number;
  };
  /** Approximate release height, meters (display only, est.). */
  releaseHeightM: number;
  /** 2-3 sentence signature of the mechanics, from coaching film analyses. */
  mechanics: string;
  /** Coachable universals worth stealing. */
  whatToCopy: string[];
  /** Body-specific traits that DON'T transfer (and why). */
  idiosyncratic: string[];
}

export const PLAYER_ARCHETYPES: readonly PlayerArchetype[] = [
  {
    name: 'Stephen Curry',
    style: 'Lightning one-motion release',
    motion: 'one-motion',
    profile: { releaseAngleDeg: 55, entryAngleDeg: 52, releaseTimeMs: 400, consistencyStdDeg: 1.2 },
    releaseHeightM: 2.4,
    mechanics:
      'Pure one-motion: the ball never stops from hip-level dip to release, leaving his hand while still ascending. Set point at the forehead with a documented 90° elbow; minimal knee bend, with a ~55° rainbow launch gone in 0.4 seconds.',
    whatToCopy: [
      'Ball flows continuously from the dip upward without pause — maximum energy transfer and speed.',
      'Release on the way UP, not at the jump peak — saves 0.1–0.2s against closeouts.',
      'High launch (~55°) beats contests without needing jump height.',
    ],
    idiosyncratic: [
      'Minimal knee bend only works because his release is too fast to contest.',
      'The above-eyebrow release point is tuned to his frame and arm length.',
    ],
  },
  {
    name: 'Klay Thompson',
    style: 'Textbook two-motion, minimal pause',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 48, entryAngleDeg: 45, releaseTimeMs: 650, consistencyStdDeg: 1.5 },
    releaseHeightM: 2.6,
    mechanics:
      'Two-motion with the pause compressed to near zero, so the legs still power the shot. Set point reached at the forehead before his feet leave the ground, elbow at a documented 90° directly under the ball; identical footwork on every catch.',
    whatToCopy: [
      'Reach the set point before your feet leave the ground — one consistent release window.',
      'Elbow aligned directly under the ball — the repeatable L-shape.',
      'Shoulder-width balanced stance: the base for shooting off movement.',
    ],
    idiosyncratic: [
      'Holding a full set point while grounded suits his height; shorter players run out of time vs closeouts.',
    ],
  },
  {
    name: 'Ray Allen',
    style: 'Flat-arc phone-booth discipline',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 40, entryAngleDeg: 37, releaseTimeMs: 850, consistencyStdDeg: 1.4 },
    releaseHeightM: 2.3,
    mechanics:
      'Controlled two-motion executed inside a "phone booth": straight up, straight down, zero drift. Chest-high set point feeding his signature flat arc — a tiny margin he could only afford through legendary repetition.',
    whatToCopy: [
      'Phone-booth footwork — jump and land on the same spot, killing lateral drift.',
      'Full alignment check: hips, knees, feet at the rim before the ball goes up.',
      'Elbow tucked throughout — a tight motion that survives fatigue.',
    ],
    idiosyncratic: [
      'The 40° flat arc gives the ball a tiny entry window — it worked only on 10,000-rep consistency. Copy the discipline, not the arc.',
    ],
  },
  {
    name: 'Reggie Miller',
    style: 'Unorthodox flared-elbow quick release',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 50, entryAngleDeg: 46, releaseTimeMs: 570, consistencyStdDeg: 1.6 },
    releaseHeightM: 2.45,
    mechanics:
      'Compact, economical two-motion with a high release and a famously flared elbow. Proof that an imperfect arm line can be overcome — IF the release point itself repeats perfectly and the wrist snap stays aggressive.',
    whatToCopy: [
      'Elbow-under-ball AT THE RELEASE POINT — that is the part that must be perfect.',
      'Compact load with zero wasted movement — less to go wrong under pressure.',
      'Aggressive wrist-snap follow-through for consistent arc and backspin.',
    ],
    idiosyncratic: [
      'The flared elbow is highly individual — he built compensations over decades. Start with a straight arm line.',
    ],
  },
  {
    name: 'Kevin Durant',
    style: 'High-tower two-motion, triple-90s',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 52, entryAngleDeg: 47, releaseTimeMs: 580, consistencyStdDeg: 2.5 },
    releaseHeightM: 2.9,
    mechanics:
      'Deliberate two-motion built on the "triple 90s" — roughly 90° angles at elbow, knee and hip during the load. High forehead set point, deep rhythmic dip, shooting hand centered dead under the ball.',
    whatToCopy: [
      'Shooting hand centered directly under the ball — kills off-axis rotation.',
      'High set point with full extension — range and contest-resistance together.',
      'Triple-90s load — a rhythm checkpoint you can self-check every shot.',
    ],
    idiosyncratic: [
      'A 2.9m release point comes from a 7-footer’s wingspan — everyone else earns height with legs and timing instead.',
    ],
  },
  {
    name: 'Kawhi Leonard',
    style: 'Slow-windup textbook two-motion',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 51, entryAngleDeg: 46, releaseTimeMs: 620, consistencyStdDeg: 2.2 },
    releaseHeightM: 2.8,
    mechanics:
      'Methodical two-motion with an unusually slow, deliberate load. Eye-level set point, dip controlled to mid-torso; enormous hands let him steer the ball one-handed with a featherweight guide hand.',
    whatToCopy: [
      'Unhurried load timing — slowing the gather raises consistency under fatigue.',
      'Lightest possible guide-hand touch — the cleanest way to kill side-spin.',
      'Balance discipline that survives stepbacks and off-rhythm attempts.',
    ],
    idiosyncratic: [
      'One-handed ball control needs 99th-percentile hand size — keep two hands on the gather.',
      'The slow cadence fits an iso role; catch-and-shoot players need a faster clock.',
    ],
  },
  {
    name: 'Damian Lillard',
    style: 'Explosive one-motion, logo range',
    motion: 'one-motion',
    profile: { releaseAngleDeg: 48, entryAngleDeg: 42, releaseTimeMs: 510, consistencyStdDeg: 3.1 },
    releaseHeightM: 2.65,
    mechanics:
      'Explosive one-motion with a shallow dip: pickup to release is one fluid climb, the set point existing for only an instant. Violent leg drive supplies deep range without a deep load.',
    whatToCopy: [
      'One-motion flow for a faster release against tight perimeter defense.',
      'Explosive leg drive substituting for dip depth — power without load time.',
      'One tempo for every shot type — a rhythm that repeats under pressure.',
    ],
    idiosyncratic: [
      'The shallow dip demands serious lower-body explosion — weaker legs need a real dip.',
    ],
  },
  {
    name: 'Kyrie Irving',
    style: 'Footwork-independent quick release',
    motion: 'one-motion',
    profile: { releaseAngleDeg: 50, entryAngleDeg: 44, releaseTimeMs: 530, consistencyStdDeg: 3.2 },
    releaseHeightM: 2.62,
    mechanics:
      'Quick one-motion release riding on top of wildly varied footwork: the upper-body mechanics are decoupled from whatever the feet are doing, so the same shot fires from any platform.',
    whatToCopy: [
      'Decouple the release from the footwork — one upper-body motion for every platform.',
      'Quick release with an efficient leg drive — volume without fatigue collapse.',
      'High follow-through with deliberate spin control for a soft rim touch.',
    ],
    idiosyncratic: [
      'Shooting off one leg or mid-drift needs elite ankle/core stability — square up first.',
    ],
  },
  {
    name: 'Devin Booker',
    style: 'Variable-height pure release',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 53, entryAngleDeg: 48, releaseTimeMs: 520, consistencyStdDeg: 2.5 },
    releaseHeightM: 2.8,
    mechanics:
      'Two-motion from a low dip where the ball moves before the body commits, wrist loaded with elbows tucked, flowing to a forehead release. His signature: the same clean release from a dozen different platforms and heights.',
    whatToCopy: [
      'Low start with the ball moving first — one repeatable tempo for every distance.',
      'Loaded wrist with elbows-in at the set point — locks the arm line.',
      'Guide hand peels off without touching the release — the cleanest finish.',
    ],
    idiosyncratic: [
      'Varying release height on purpose works with his wingspan — amateurs should lock ONE height first.',
    ],
  },
  {
    name: 'Luka Doncic',
    style: 'Stepback engine, adaptive release',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 52, entryAngleDeg: 48, releaseTimeMs: 560, consistencyStdDeg: 3.5 },
    releaseHeightM: 2.75,
    mechanics:
      'Wide stance with a firm back-foot plant; from a waist-level pocket he snaps into pull-ups and stepbacks, the ball transitioning to a forehead launch pad that stays identical while the feet create separation.',
    whatToCopy: [
      'One ball pocket above the forehead — the same launch pad for every shot type.',
      'Firm back-foot plant with a drifting front foot — hips locked while creating space.',
    ],
    idiosyncratic: [
      'The stepback is baked into his release timing — groove the standstill shot before the moves.',
    ],
  },
  {
    name: 'Steve Nash',
    style: 'Quick one-motion, ambidextrous precision',
    motion: 'one-motion',
    profile: { releaseAngleDeg: 48, entryAngleDeg: 44, releaseTimeMs: 450, consistencyStdDeg: 2.0 },
    releaseHeightM: 2.35,
    mechanics:
      'Narrow, always-square base with feet at the rim. Ball and body rise together in one hitch-free motion, releasing near the start of the jump — quickness over elevation, with the hand perfectly centered under the ball.',
    whatToCopy: [
      'Synchronize ball rise with body rise — no hitch means no timing variable to drift.',
      'Release early in the jump — shrinks the contest window, unlocks pull-ups.',
      'Hand centered under the ball with a clean guide-hand peel.',
    ],
    idiosyncratic: [
      'The early low release solves a small guard’s problem — taller shooters give up a height advantage using it.',
    ],
  },
  {
    name: 'Dirk Nowitzki',
    style: 'One-leg fadeaway, 60° rainbow',
    motion: 'two-motion',
    profile: { releaseAngleDeg: 60, entryAngleDeg: 56, releaseTimeMs: 620, consistencyStdDeg: 3.0 },
    releaseHeightM: 2.9,
    mechanics:
      'From a staggered base, a leg-kick opens separation while the standing leg holds balance; over-the-head set point releasing at the true jump peak with a documented ~60° Geschwindner-designed launch.',
    whatToCopy: [
      'Textbook wrist and follow-through preserved inside an exotic shot shape.',
      'Release at the true peak, on balance — the discipline transfers even if the fadeaway doesn’t.',
    ],
    idiosyncratic: [
      'The one-leg fade needs a 7-foot frame and decades of specialist coaching.',
      'A 60° launch only pencils out from a 2.9m release — shorter shooters lose too much energy.',
    ],
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
