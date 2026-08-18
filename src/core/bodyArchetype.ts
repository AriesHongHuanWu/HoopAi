/**
 * Anthropometric ("body data") archetype matching — the DIRECTION half of the
 * app's headline promise: BODY DATA SETS THE STYLE DIRECTION, SHOT DATA SETS
 * THE DISTANCE.
 *
 * ┌─ HONESTY ────────────────────────────────────────────────────────────────┐
 * │ This is a transparent similarity RANKING over a hand-labelled reference   │
 * │ set of pro styles, using published measurements for the minority of them  │
 * │ that have any. Nothing here is trained, nothing here is personalised, and │
 * │ a frame cannot tell you how someone shoots. Confidence is capped at       │
 * │ 'medium' BY TYPE — 'high' is not a member of StyleDirection['confidence'] │
 * │ — because the honest ceiling for "your body says X" is a direction, not a │
 * │ prescription. How far out to practise comes from the user's OWN logged    │
 * │ shots (see {@link rangeFromShots}), never from the body match.            │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Why a wingspan-to-height RATIO rather than raw wingspan: the ratio is what
 * actually changes which shot a frame supports. Two 188 cm guards with a 191 cm
 * and a 203 cm wingspan get meaningfully different release points out of the
 * same technique, so the ratio carries the heaviest weight in the distance.
 *
 * Pure + deterministic (src/core convention): no wall clock, no RNG, no I/O,
 * no React. Same input in ⇒ byte-identical output out.
 */
import { clamp } from './geometry';
import { PLAYER_ARCHETYPES, type PlayerAnthro, type PlayerArchetype } from './nbaBenchmarks';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

/**
 * The body fields the match understands. Mirrors the nullable shape of
 * `src/state/profileStore.ts` (heightCm / wingspanCm / birthYear-derived age),
 * so a screen can hand its profile straight in without massaging it.
 *
 * `weightKg` is accepted but DELIBERATELY NOT USED in the ranking: the profile
 * store is explicit that it carries no BMI / fitness claims, and we hold no
 * sourced weights for the reference set, so any weight-driven advice would be
 * invention. It stays on the interface only so callers can pass a whole
 * profile without a lint error, and so a future sourced dataset has a slot.
 */
export interface BodyInput {
  heightCm: number | null;
  wingspanCm: number | null;
  standingVertCm?: number | null;
  weightKg?: number | null;
  ageYears?: number | null;
}

/** One ranked archetype frame, best-first out of {@link bodyMatches}. */
export interface BodyMatch {
  name: string;
  /** 0-100 anthropometric similarity (NOT a shooting-similarity claim). */
  affinity: number;
  /** Why this frame is comparable, in the user's own numbers. */
  reasons: string[];
  /** Where the comparison breaks down — read this before copying anything. */
  caution: string[];
}

/**
 * The "身體數據定方向" output: what style a frame supports, in on-court terms.
 * `confidence` has no 'high' member on purpose — see the file banner.
 */
export interface StyleDirection {
  /** Closest reference frame by anthropometrics (the comparison, not a goal). */
  archetype: string;
  label: string;
  blurb: string;
  /** Concrete on-court directives this frame supports. */
  play: string[];
  /** What this frame should NOT chase. */
  avoid: string[];
  confidence: 'low' | 'medium';
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Plausible standing-height window, cm. Mirrors MIN/MAX_HEIGHT_CM in
 * profileStore (duplicated rather than imported — importing the store would
 * drag zustand + expo-sqlite into pure core). Anything outside is refused
 * rather than matched, because a garbage height produces confident nonsense.
 */
export const BODY_HEIGHT_MIN_CM = 120;
export const BODY_HEIGHT_MAX_CM = 230;

/**
 * Plausible wingspan-to-height ratio window. Human ratios cluster around
 * 0.95-1.15; a value outside this is treated as MISSING (the match falls back
 * to height only) rather than trusted.
 */
export const BODY_RATIO_MIN = 0.85;
export const BODY_RATIO_MAX = 1.25;

/**
 * "One unit of difference" per dimension — the same normalization idea as
 * ARCHETYPE_SCALES in nbaBenchmarks, so cm and ratio points are comparable.
 * 8 cm is roughly one position step; 0.035 of ratio is roughly the gap between
 * an even-levered and a notably long-levered frame.
 */
export const BODY_SCALES = {
  heightCm: 8,
  wingspanRatio: 0.035,
  standingVertCm: 8,
} as const;

/**
 * Relative importance. The ratio outweighs raw height because it is what
 * changes the release point a given technique can reach — and it is the trait
 * the product promise (臂展比) names explicitly. Standing vertical is weighted
 * low: almost no reference player has a published figure, so it is a bonus
 * signal at best.
 */
export const BODY_WEIGHTS = {
  heightCm: 1,
  wingspanRatio: 1.2,
  standingVertCm: 0.5,
} as const;

/** Below this top-match affinity the direction is only ever 'low' confidence. */
export const MEDIUM_CONFIDENCE_MIN_AFFINITY = 60;

/** Height band edges (cm) used to pick a style direction. */
export const HEIGHT_BAND_COMPACT_MAX_CM = 178;
export const HEIGHT_BAND_MID_MAX_CM = 192;

/** Wingspan-ratio band edges used to pick a style direction. */
export const LEVER_BAND_SHORT_MAX = 1.01;
export const LEVER_BAND_NEUTRAL_MAX = 1.05;

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

interface Features {
  heightCm: number;
  /** wingspan / height, or null when wingspan is missing or implausible. */
  wingspanRatio: number | null;
  standingVertCm: number | null;
}

/** A finite number in [lo, hi], else null. */
function sane(v: number | null | undefined, lo: number, hi: number): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return v >= lo && v <= hi ? v : null;
}

/** User features, or null when height is unusable (the refusal path). */
function userFeatures(body: BodyInput): Features | null {
  const heightCm = sane(body.heightCm, BODY_HEIGHT_MIN_CM, BODY_HEIGHT_MAX_CM);
  if (heightCm == null) return null;
  const wingspanCm = sane(body.wingspanCm, 1, 400);
  const rawRatio = wingspanCm == null ? null : wingspanCm / heightCm;
  return {
    heightCm,
    wingspanRatio: sane(rawRatio, BODY_RATIO_MIN, BODY_RATIO_MAX),
    standingVertCm: sane(body.standingVertCm, 10, 130),
  };
}

/** Reference-player features from a published anthro block. */
function anthroFeatures(a: PlayerAnthro): Features {
  return {
    heightCm: a.heightCm,
    wingspanRatio: a.wingspanCm / a.heightCm,
    standingVertCm: a.standingVertCm ?? null,
  };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** Signed gap phrasing that reads the same way every time. */
function gapWord(delta: number, more: string, less: string): string {
  return delta >= 0 ? more : less;
}

/**
 * Rank the reference frames by anthropometric similarity, best first.
 *
 * Returns [] when height is missing or implausible — the match REFUSES rather
 * than guessing, because height is the only dimension that is always required.
 * Archetypes without a published `anthro` block are skipped for the same
 * reason (see the sourcing note in nbaBenchmarks.ts).
 *
 * The distance mirrors shotLab's matchArchetype: per-dimension |Δ| normalized
 * by BODY_SCALES, capped at 2 so one wild dimension cannot dominate, weighted
 * by BODY_WEIGHTS, then mapped to a 0-100 affinity. Ties break on name so the
 * order is deterministic regardless of engine sort stability.
 */
export function bodyMatches(body: BodyInput): BodyMatch[] {
  const u = userFeatures(body);
  if (u == null) return [];

  const out: BodyMatch[] = [];
  for (const player of PLAYER_ARCHETYPES) {
    if (!player.anthro) continue;
    const p = anthroFeatures(player.anthro);

    let acc = 0;
    let wsum = 0;
    const add = (norm: number, weight: number) => {
      acc += weight * Math.min(2, norm);
      wsum += weight;
    };
    add(Math.abs(u.heightCm - p.heightCm) / BODY_SCALES.heightCm, BODY_WEIGHTS.heightCm);
    if (u.wingspanRatio != null && p.wingspanRatio != null) {
      add(
        Math.abs(u.wingspanRatio - p.wingspanRatio) / BODY_SCALES.wingspanRatio,
        BODY_WEIGHTS.wingspanRatio,
      );
    }
    if (u.standingVertCm != null && p.standingVertCm != null) {
      add(
        Math.abs(u.standingVertCm - p.standingVertCm) / BODY_SCALES.standingVertCm,
        BODY_WEIGHTS.standingVertCm,
      );
    }
    const dist = wsum === 0 ? 2 : acc / wsum;
    const affinity = Math.round(100 * Math.max(0, 1 - dist / 2));

    out.push({
      name: player.name,
      affinity,
      reasons: matchReasons(u, p, player),
      caution: matchCautions(u, p, player, affinity, body),
    });
  }
  return out.sort((a, b) => b.affinity - a.affinity || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Why the two frames are comparable — always in the user's own numbers. */
function matchReasons(u: Features, p: Features, player: PlayerArchetype): string[] {
  const reasons: string[] = [];
  const dh = u.heightCm - p.heightCm;
  if (Math.abs(dh) <= 4) {
    reasons.push(
      `Same height class: you ${round1(u.heightCm)} cm vs ${player.name}'s reported ${p.heightCm} cm.`,
    );
  } else if (Math.abs(dh) <= 10) {
    reasons.push(
      `Similar height: you ${round1(u.heightCm)} cm vs ${player.name}'s reported ${p.heightCm} cm (${Math.abs(round1(dh))} cm apart).`,
    );
  }
  if (u.wingspanRatio != null && p.wingspanRatio != null) {
    const dr = u.wingspanRatio - p.wingspanRatio;
    if (Math.abs(dr) <= 0.02) {
      reasons.push(
        `Nearly the same wingspan ratio (${u.wingspanRatio.toFixed(3)} vs ${p.wingspanRatio.toFixed(3)}) — the same lever length behind the release.`,
      );
    } else if (Math.abs(dr) <= 0.04) {
      reasons.push(
        `Comparable wingspan ratio (${u.wingspanRatio.toFixed(3)} vs ${p.wingspanRatio.toFixed(3)}).`,
      );
    }
  }
  if (u.standingVertCm != null && p.standingVertCm != null) {
    const dv = Math.abs(u.standingVertCm - p.standingVertCm);
    if (dv <= 6) reasons.push(`Standing vertical within ${round1(dv)} cm of the published figure.`);
  }
  if (reasons.length === 0) {
    reasons.push('Closest frame available in the reference set — not a close match.');
  }
  return reasons;
}

/** Where the comparison breaks down. Read before copying anything. */
function matchCautions(
  u: Features,
  p: Features,
  player: PlayerArchetype,
  affinity: number,
  body: BodyInput,
): string[] {
  const caution: string[] = [];
  const dh = u.heightCm - p.heightCm;
  if (Math.abs(dh) > 10) {
    caution.push(
      `You are ${Math.abs(round1(dh))} cm ${gapWord(dh, 'taller', 'shorter')} — ${player.name}'s release height is a body fact, not a technique.`,
    );
  }
  if (u.wingspanRatio != null && p.wingspanRatio != null) {
    const dr = u.wingspanRatio - p.wingspanRatio;
    if (Math.abs(dr) > 0.04) {
      caution.push(
        `Your wingspan ratio is ${Math.abs(dr).toFixed(3)} ${gapWord(dr, 'higher', 'lower')} (${u.wingspanRatio.toFixed(3)} vs ${p.wingspanRatio.toFixed(3)}) — expect a different release point from the same motion.`,
      );
    }
  }
  if (u.wingspanRatio == null) {
    caution.push('Wingspan not set — this ranking uses height alone, which is the weaker half of the signal.');
  }
  if (Math.abs(dh) > 12 && player.idiosyncratic[0]) {
    // Reuse the sourced "does not transfer" line rather than writing a new one.
    caution.push(player.idiosyncratic[0]);
  }
  if (affinity < 55) {
    caution.push('Weak anthropometric match — treat this as a rough frame reference only.');
  }
  const age = sane(body.ageYears, 0, 120);
  if (age != null && age < 18) {
    caution.push('Still growing — your height and wingspan ratio will move, so re-check this later.');
  }
  return caution;
}

// ---------------------------------------------------------------------------
// Style direction — the "body sets the direction" half
// ---------------------------------------------------------------------------

type HeightBand = 'compact' | 'mid' | 'tall';
type LeverBand = 'short' | 'neutral' | 'long';

function heightBand(cm: number): HeightBand {
  if (cm <= HEIGHT_BAND_COMPACT_MAX_CM) return 'compact';
  if (cm <= HEIGHT_BAND_MID_MAX_CM) return 'mid';
  return 'tall';
}

function leverBand(ratio: number | null): LeverBand {
  // Unknown ratio falls back to 'neutral' — the direction then leans on height
  // only, and confidence drops to 'low' (see styleDirection).
  if (ratio == null) return 'neutral';
  if (ratio <= LEVER_BAND_SHORT_MAX) return 'short';
  if (ratio <= LEVER_BAND_NEUTRAL_MAX) return 'neutral';
  return 'long';
}

/**
 * Height x lever grid of coaching directions. Hand-written, not derived — which
 * is precisely why confidence never exceeds 'medium'.
 */
const DIRECTIONS: Record<
  `${HeightBand}:${LeverBand}`,
  Pick<StyleDirection, 'label' | 'blurb' | 'play' | 'avoid'>
> = {
  'compact:short': {
    label: 'Handle-first separation game',
    blurb:
      'A compact frame with even levers: you will not shoot over a closeout, so the space has to come from the ball and the feet.',
    play: [
      'Create the window before you rise — step-back or side-step into the shot instead of jumping into a contest.',
      'Release early in the jump so the ball is gone before the contest arrives.',
      'Shoot a high arc: the launch height you cannot get from your frame, you buy with angle.',
    ],
    avoid: [
      'Straight-up contested pull-ups over a taller defender.',
      'Holding a full set point while grounded — you run out of time against a closeout.',
    ],
  },
  'compact:neutral': {
    label: 'Quick-trigger guard release',
    blurb:
      'Compact frame, ordinary lever length: your edge is trigger speed and repeatability, not reach.',
    play: [
      'One-motion flow from dip to release — no pause for a defender to arrive into.',
      'Groove ONE release height and one tempo so the fast trigger stays accurate.',
      'Live on movement: relocation, hand-offs and pindowns instead of standstill contests.',
    ],
    avoid: [
      'Adding a deeper dip for power — it spends the only advantage you have, which is time.',
      'Fadeaways: you cannot afford the energy they cost at range.',
    ],
  },
  'compact:long': {
    label: 'Quick-release pull-up',
    blurb:
      'Short frame, long arms: the ratio hands you a release point above your height class, so the pull-up is live.',
    play: [
      'Pull up off the dribble — your reach buys clearance a same-height defender does not have.',
      'Set point at the forehead and let the arms extend; do not jump for height.',
      'Attack closeouts one dribble into a rise rather than passing up the shot.',
    ],
    avoid: [
      'A low, slung release that throws the reach advantage away.',
      'Deep range before the mid-range pull-up repeats.',
    ],
  },
  'mid:short': {
    label: 'Repeatable set-point shooter',
    blurb:
      'Average frame with even levers — nothing about your body creates separation, so consistency is the entire edge.',
    play: [
      'Lock ONE set point and land on the same spot every rep (phone-booth footwork).',
      'Reach the set point before your feet leave the ground so the release window never moves.',
      'Take the catch-and-shoot looks where a teammate creates the space.',
    ],
    avoid: [
      'Varying release height by shot type — you have no reach to spare.',
      'Drifting, off-balance attempts.',
    ],
  },
  'mid:neutral': {
    label: 'Balanced catch-and-shoot base',
    blurb:
      'A balanced frame with no single lever to exploit, which makes footwork and tempo the differentiator.',
    play: [
      'Identical footwork on every catch — same feet, same rise, same landing.',
      'Elbow under the ball at the release point on every rep.',
      'Build volume from two or three fixed spots before adding range.',
    ],
    avoid: [
      'Copying a pro quirk (flared elbow, one-leg fade) before the base repeats.',
      'Chasing range as a substitute for repeatability.',
    ],
  },
  'mid:long': {
    label: 'Off-the-dribble pull-up with reach',
    blurb:
      'Average height, long arms: your release sits higher than your height suggests, which makes the pull-up your best shot.',
    play: [
      'Rise into pull-ups off one or two dribbles instead of settling for spot-ups.',
      'High set point with full extension — use the levers you actually have.',
      'On the catch, shoot over the closeout rather than side-stepping it.',
    ],
    avoid: [
      'A low chest set point, which gives the ratio advantage straight back.',
      'Guard-speed rushing when you already clear the contest.',
    ],
  },
  'tall:short': {
    label: 'High-platform spot-up',
    blurb:
      'Tall frame with even levers: the height is the advantage and the arms will not add to it, so the platform has to be still.',
    play: [
      'Shoot straight up over the top — you already clear most closeouts.',
      'Reach the set point before your feet leave the ground.',
      'Own the corners and the trail three where the catch is clean.',
    ],
    avoid: [
      'Rushing to a guard-speed trigger you do not need.',
      'Adding a stepback before the standstill shot is automatic.',
    ],
  },
  'tall:neutral': {
    label: 'Over-the-top set shooter',
    blurb:
      'A tall platform: your release already clears most contests, so the job is making the same shot repeat.',
    play: [
      'High forehead set point with full extension on every attempt.',
      'Use a deliberate two-motion load — your height buys you that time.',
      'Groove the mid-range over-the-top jumper before extending out.',
    ],
    avoid: [
      "Copying a small guard's early low release — it gives away your height advantage.",
      'Off-balance leaners when a square-up shot is available.',
    ],
  },
  'tall:long': {
    label: 'Over-the-top pull-up tower',
    blurb:
      'Tall with long levers — the frame that lets a release point sit above the contest entirely.',
    play: [
      'Play over the top: high set point, full extension, shoot through the contest rather than around it.',
      'Add a one-two into a pull-up — your release clears the recovery.',
      'Use a deep, rhythmic dip; you have the time to load it.',
    ],
    avoid: [
      'Trading height for speed with a flat, hurried release.',
      'Exotic shapes (one-leg fades) before the square-up jumper repeats.',
    ],
  },
};

/**
 * The "身體數據定方向" output: a readable style DIRECTION from body data alone.
 *
 * Null when height is missing/implausible or no reference frame has published
 * measurements to compare against. Confidence is 'medium' only when a wingspan
 * ratio was usable AND the closest frame is at least
 * {@link MEDIUM_CONFIDENCE_MIN_AFFINITY} — and never higher than that, because
 * a hand-labelled grid over a handful of measured pros is not personalisation.
 */
export function styleDirection(body: BodyInput): StyleDirection | null {
  const u = userFeatures(body);
  if (u == null) return null;
  const top = bodyMatches(body)[0];
  if (!top) return null;

  const key = `${heightBand(u.heightCm)}:${leverBand(u.wingspanRatio)}` as const;
  const base = DIRECTIONS[key];
  const confidence: StyleDirection['confidence'] =
    u.wingspanRatio != null && top.affinity >= MEDIUM_CONFIDENCE_MIN_AFFINITY ? 'medium' : 'low';

  const ratioNote =
    u.wingspanRatio == null
      ? ' Wingspan is not set, so this direction comes from height alone.'
      : ` Your wingspan ratio is ${u.wingspanRatio.toFixed(3)}.`;

  return {
    archetype: top.name,
    label: base.label,
    blurb: `${base.blurb}${ratioNote}`,
    play: [...base.play],
    avoid: [...base.avoid],
    confidence,
  };
}

// ---------------------------------------------------------------------------
// Range from shots — the "投籃數據定距離" half
// ---------------------------------------------------------------------------

/** Minimum logged attempts before a distance recommendation is allowed at all. */
export const RANGE_MIN_ATTEMPTS = 20;
/** Practice-band clamp, meters (roughly a floater to a logo three). */
export const RANGE_MIN_DISTANCE_M = 1;
export const RANGE_MAX_DISTANCE_M = 9;
/** Attempt-weighted make% at or above which the band is pushed OUT. */
export const RANGE_PUSH_OUT_PCT = 45;
/** Attempt-weighted make% below which the band is pulled IN. */
export const RANGE_PULL_IN_PCT = 30;

export interface RangeRecommendation {
  /** [near, far] practice distance band, meters. */
  recommendedBandM: [number, number];
  /** Exactly what in the user's data produced the band. */
  rationale: string;
}

/**
 * Recommend a practice DISTANCE band from the user's own shot log.
 *
 * Deliberately simple and deliberately strict: it needs a median distance AND
 * band data totalling at least {@link RANGE_MIN_ATTEMPTS} attempts, otherwise
 * it returns null. A median with an unknown or tiny sample size is not a basis
 * for telling somebody where to stand, so the honest answer there is "not yet",
 * not a confident-sounding number.
 *
 * `pct` is a percentage in 0-100. Band LABELS are free-form strings and carry
 * no distance, so they are used only to weight the overall make rate — the band
 * itself is always anchored on the measured median distance.
 */
export function rangeFromShots(input: {
  medianDistanceM: number | null;
  makePctByBand?: { band: string; pct: number; attempts: number }[] | null;
}): RangeRecommendation | null {
  const median = input.medianDistanceM;
  if (median == null || !Number.isFinite(median) || median <= 0) return null;

  const bands = (input.makePctByBand ?? []).filter(
    (b) => Number.isFinite(b.pct) && Number.isFinite(b.attempts) && b.attempts > 0,
  );
  const attempts = bands.reduce((n, b) => n + b.attempts, 0);
  if (attempts < RANGE_MIN_ATTEMPTS) return null;

  const made = bands.reduce((n, b) => n + (clamp(b.pct, 0, 100) / 100) * b.attempts, 0);
  const pct = (made / attempts) * 100;

  let lo: number;
  let hi: number;
  let verdict: string;
  if (pct >= RANGE_PUSH_OUT_PCT) {
    lo = median;
    hi = median + 1;
    verdict = 'that is holding up, so step the practice band out';
  } else if (pct < RANGE_PULL_IN_PCT) {
    lo = median - 1;
    hi = median;
    verdict = 'that is not holding up yet, so pull the practice band in';
  } else {
    lo = median - 0.5;
    hi = median + 0.5;
    verdict = 'that is about right, so keep the practice band where you shoot';
  }

  lo = clamp(lo, RANGE_MIN_DISTANCE_M, RANGE_MAX_DISTANCE_M);
  hi = clamp(hi, RANGE_MIN_DISTANCE_M, RANGE_MAX_DISTANCE_M);
  // Clamping can collapse the band at the ends of the court — reopen it.
  if (hi - lo < 0.5) {
    hi = Math.min(RANGE_MAX_DISTANCE_M, lo + 0.5);
    lo = Math.max(RANGE_MIN_DISTANCE_M, hi - 0.5);
  }
  lo = round1(lo);
  hi = round1(hi);

  return {
    recommendedBandM: [lo, hi],
    rationale:
      `Across ${attempts} logged attempts you are making ${Math.round(pct)}% around a ${round1(median)} m median — ` +
      `${verdict}: ${lo}-${hi} m. Distance only; this says nothing about your form.`,
  };
}

// ---------------------------------------------------------------------------
// Combined plan
// ---------------------------------------------------------------------------

export interface BodyPlan {
  direction: StyleDirection | null;
  range: RangeRecommendation | null;
  /** One honest sentence covering what was produced and what was not. */
  summary: string;
}

/**
 * The headline recommendation: BODY sets the direction, SHOTS set the distance.
 *
 * Each half fails independently and says so — a user with a profile but no
 * logged shots gets a direction and an explicit "no distance yet", and the
 * reverse also holds. The summary never claims more than the two halves did.
 */
export function bodyPlan(
  body: BodyInput,
  shots: Parameters<typeof rangeFromShots>[0],
): BodyPlan {
  const direction = styleDirection(body);
  const range = rangeFromShots(shots);

  let summary: string;
  if (direction && range) {
    summary =
      `Your frame points at a ${direction.label.toLowerCase()} (closest measured frame: ${direction.archetype}), ` +
      `and your own ${range.recommendedBandM[0]}-${range.recommendedBandM[1]} m band is where to drill it — ` +
      `a ${direction.confidence}-confidence direction from a hand-labelled reference set, not a personalised model.`;
  } else if (direction) {
    summary =
      `Your frame points at a ${direction.label.toLowerCase()} (closest measured frame: ${direction.archetype}), ` +
      `but with fewer than ${RANGE_MIN_ATTEMPTS} logged attempts there is no honest distance recommendation yet.`;
  } else if (range) {
    summary =
      `Add your height and wingspan to get a style direction; for now the only recommendation your data supports is ` +
      `a ${range.recommendedBandM[0]}-${range.recommendedBandM[1]} m practice band.`;
  } else {
    summary =
      `Nothing to recommend yet — add your height (and wingspan) to the profile, and log at least ` +
      `${RANGE_MIN_ATTEMPTS} shots with distance, before this can say anything.`;
  }
  return { direction, range, summary };
}
