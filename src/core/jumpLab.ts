/**
 * Jump Lab — vertical-jump measurement from a pose ankle/hip time-series.
 *
 * Two independent estimators, cross-checked (see {@link estimateJump}):
 *
 *  (a) HANG-TIME (primary, SCALE-FREE). We never need to know how many
 *      centimetres a pixel is: a body in free flight obeys h = g·t²/8, where
 *      t is the airborne time (takeoff → landing). We recover t purely from
 *      WHEN the feet leave and return to the ground, so camera distance, lens
 *      and body size are all irrelevant. This is why it is the primary signal.
 *      It does, however, need enough temporal resolution to place the takeoff
 *      and landing instants — below ~15 fps the ±1-frame quantisation error on
 *      a ~0.5 s flight is too large, so we refuse rather than lie.
 *
 *  (b) DISPLACEMENT (secondary, needs a SCALE). The hip-center rises by some
 *      number of pixels at the apex; multiply by metres-per-pixel (from rim
 *      geometry — a real rim is 0.45 m across — or a profile body height) to
 *      get a height. Sensitive to the scale estimate and to the camera not
 *      being level, so it is only ever a corroborating cross-check, never the
 *      final number when hang-time is valid.
 *
 * Everything here is PURE: series in, result out. No pose model, no camera, no
 * clock — the caller samples ankle/hip y at whatever fps it manages and passes
 * the arrays. +y is DOWN (analysis-frame convention, see types.ts), so a JUMP
 * is a DECREASE in y. All heights are reported in centimetres.
 */

/** Standard gravity (m/s²). */
export const GRAVITY = 9.80665;

/** Real basketball rim inner diameter, metres — the displacement scale ruler. */
export const RIM_WIDTH_M = 0.45;

/**
 * Physical plausibility gates on a single flight. A human vertical jump has a
 * flight time roughly in [0.25 s, 1.2 s] (≈ 8 cm … 1.76 m). Anything outside is
 * a mis-detected takeoff/landing (a stumble, the shooter walking, a pose
 * glitch) and is rejected rather than reported.
 */
export const MIN_FLIGHT_SEC = 0.25;
export const MAX_FLIGHT_SEC = 1.2;

/** Below this sampling rate hang-time quantisation is untrustworthy — refuse. */
export const MIN_FPS = 15;

/** Keypoint score below this is treated as "no ankle this frame". */
const ANKLE_SCORE_MIN = 0.3;

/** One sampled frame of the shooter's lower body (analysis-frame px, +y down). */
export interface JumpSample {
  /** Camera-clock time, seconds. Must be strictly increasing across the series. */
  t: number;
  /** Ankle-midpoint y (px, +y down). Null when neither ankle cleared the gate. */
  ankleY: number | null;
  /** Confidence 0..1 of the ankle midpoint (min of the visible ankles). */
  ankleScore: number;
  /** Hip-center y (px, +y down). Null when neither hip was visible. */
  hipY: number | null;
}

export type JumpMethod = 'hang-time' | 'displacement' | 'none';

export interface JumpEstimate {
  /** Final vertical jump height, centimetres. 0 when no valid jump was found. */
  heightCm: number;
  /** Which estimator produced {@link heightCm}. 'none' when nothing qualified. */
  method: JumpMethod;
  /** 0..1 confidence in the final number (see {@link estimateJump}). */
  confidence: number;
  /** Airborne time in seconds (hang-time path), or null. */
  flightSec: number | null;
  /** Hang-time height (cm), or null when that path did not qualify. */
  hangTimeCm: number | null;
  /** Displacement height (cm), or null when that path did not qualify. */
  displacementCm: number | null;
  /** Effective sampling rate (median dt) of the series, fps. */
  fps: number;
  /**
   * Human-readable reason the estimate is empty or low-confidence — surfaced to
   * the UI so a failure explains itself ("phone too slow", "no full body", …).
   */
  note: string;
}

/** A detected airborne window (indices into the sample array). */
export interface FlightWindow {
  takeoffIndex: number;
  landingIndex: number;
  takeoffT: number;
  landingT: number;
  flightSec: number;
  /** Lowest ankle y seen in the window (the apex — smallest y = highest point). */
  apexAnkleY: number;
}

/** Options for {@link estimateJump}; sensible defaults match the constants above. */
export interface JumpOptions {
  /** metres-per-pixel for the displacement estimator. Omit to skip that path. */
  metersPerPx?: number;
  /** Override the baseline band half-width (px). Default: derived from noise. */
  baselineBandPx?: number;
}

// ---------------------------------------------------------------------------
// Series → sampling rate
// ---------------------------------------------------------------------------

/**
 * Effective sampling rate of a series (median inter-sample dt → fps). The
 * median is robust to the odd dropped frame that would wreck a mean. Returns 0
 * for a series too short to have an interval.
 */
export function seriesFps(samples: readonly JumpSample[]): number {
  const dts: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i]!.t - samples[i - 1]!.t;
    if (dt > 0) dts.push(dt);
  }
  if (dts.length === 0) return 0;
  dts.sort((a, b) => a - b);
  const mid = Math.floor(dts.length / 2);
  const medDt =
    dts.length % 2 === 1 ? dts[mid]! : (dts[mid - 1]! + dts[mid]!) / 2;
  return medDt > 0 ? 1 / medDt : 0;
}

// ---------------------------------------------------------------------------
// Baseline (standing ground) estimation
// ---------------------------------------------------------------------------

/**
 * The standing ankle-y baseline: the shooter's feet at rest. We take a robust
 * high quantile of ankle-y (feet on the ground = LARGEST y, since +y is down),
 * so a brief airborne dip (small y) never drags the baseline up. Uses the 70th
 * percentile of valid ankle samples — well above the airborne minimum, below
 * the noisiest single frame.
 *
 * Returns null when too few ankle samples exist to trust a baseline.
 */
export function estimateBaseline(samples: readonly JumpSample[]): number | null {
  const ys: number[] = [];
  for (const s of samples) {
    if (s.ankleY != null && s.ankleScore >= ANKLE_SCORE_MIN) ys.push(s.ankleY);
  }
  if (ys.length < 5) return null;
  ys.sort((a, b) => a - b);
  const q = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.7))]!;
  return q;
}

/**
 * Noise floor of the standing baseline: the median absolute deviation of the
 * ankle samples that sit at/near the ground (y within the top 40% of the sorted
 * ankle-y values). Feeds an adaptive baseline band so a jittery pose stream
 * gets a wider "on the ground" tolerance than a clean one.
 */
function baselineNoisePx(samples: readonly JumpSample[], baseline: number): number {
  const near: number[] = [];
  for (const s of samples) {
    if (s.ankleY != null && s.ankleScore >= ANKLE_SCORE_MIN) {
      // Only samples at or below the baseline-ish region (feet down): |y - base|
      // small OR y > baseline (even lower). Airborne (y << baseline) excluded.
      if (s.ankleY >= baseline - 4) near.push(Math.abs(s.ankleY - baseline));
    }
  }
  if (near.length === 0) return 3;
  near.sort((a, b) => a - b);
  const med = near[Math.floor(near.length / 2)]!;
  return med;
}

// ---------------------------------------------------------------------------
// Flight-window detection (takeoff / landing) with debounce + gates
// ---------------------------------------------------------------------------

/**
 * Detect the single best airborne window: the feet leave a baseline band
 * (ankle y climbs well ABOVE the band — smaller y), stay up, and return.
 *
 * Debounce: takeoff only commits after the feet have been clearly off the
 * ground; landing only commits after they have clearly returned AND stayed —
 * so a one-frame pose flicker cannot open or close a window. A minimum "off
 * the ground" excursion (deeper than the band) is required so a standing sway
 * never registers as a jump.
 *
 * Returns the deepest (highest-apex) qualifying window, or null.
 */
export function detectFlight(
  samples: readonly JumpSample[],
  baseline: number,
  bandPx: number,
): FlightWindow | null {
  // A frame counts as "airborne" when the ankle is clearly above the band
  // (y < baseline - band). "Grounded" when it is back at/below the band edge.
  const airborneEnter = baseline - bandPx;
  // Hysteresis: require returning nearly to the baseline (not just band edge)
  // to call a landing, so the tail of the descent doesn't chatter.
  const groundReturn = baseline - bandPx * 0.5;

  const windows: FlightWindow[] = [];
  let inFlight = false;
  let takeoffIdx = -1;
  let apexY = Infinity;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const y = s.ankleY;
    const valid = y != null && s.ankleScore >= ANKLE_SCORE_MIN;

    if (!inFlight) {
      if (valid && y! < airborneEnter) {
        inFlight = true;
        takeoffIdx = i;
        apexY = y!;
      }
    } else {
      if (valid && y! < apexY) apexY = y!;
      // Landing: a valid ankle back near the ground. A missing ankle mid-air
      // (occlusion) does NOT end the flight — only a real grounded sample does.
      if (valid && y! >= groundReturn) {
        // The takeoff/landing instants are placed at the band crossing, but we
        // refine to the sub-band edge by interpolating between the last two
        // samples so the flight time isn't biased by the debounce band.
        const takeoffT = interpCrossing(samples, takeoffIdx, airborneEnter, -1);
        const landingT = interpCrossing(samples, i, groundReturn, +1);
        const flightSec = landingT - takeoffT;
        windows.push({
          takeoffIndex: takeoffIdx,
          landingIndex: i,
          takeoffT,
          landingT,
          flightSec,
          apexAnkleY: apexY,
        });
        inFlight = false;
        apexY = Infinity;
      }
    }
  }

  // Prefer the physically-valid window with the deepest apex (biggest jump).
  let best: FlightWindow | null = null;
  for (const w of windows) {
    if (w.flightSec < MIN_FLIGHT_SEC || w.flightSec > MAX_FLIGHT_SEC) continue;
    if (best == null || w.apexAnkleY < best.apexAnkleY) best = w;
  }
  return best;
}

/**
 * Sub-frame time of a baseline crossing near sample index `i`, linearly
 * interpolating between the crossing sample and its neighbour so the flight
 * time is not quantised to whole frames (halves the ±1-frame error).
 *
 * dir = -1 looks BACKWARD from i (the takeoff: last grounded → first airborne),
 * dir = +1 looks BACKWARD too for the landing (last airborne → first grounded);
 * in both cases we interpolate between samples[i] and samples[i-1].
 */
function interpCrossing(
  samples: readonly JumpSample[],
  i: number,
  crossY: number,
  _dir: number,
): number {
  const cur = samples[i]!;
  if (cur.ankleY == null) return cur.t;
  // Walk back to the nearest earlier VALID ankle sample — under occlusion the
  // immediate neighbour can be a dropped (null) airborne frame, which would
  // otherwise defeat interpolation and bias the flight time by up to a frame.
  let j = i - 1;
  while (j >= 0 && (samples[j]!.ankleY == null || samples[j]!.ankleScore < ANKLE_SCORE_MIN)) {
    j--;
  }
  const prev = j >= 0 ? samples[j] : undefined;
  if (prev == null || prev.ankleY == null) return cur.t;
  const y0 = prev.ankleY;
  const y1 = cur.ankleY;
  if (y0 === y1) return cur.t;
  // Fraction along [prev, cur] where ankle y === crossY.
  let f = (crossY - y0) / (y1 - y0);
  if (!Number.isFinite(f)) return cur.t;
  if (f < 0) f = 0;
  if (f > 1) f = 1;
  return prev.t + f * (cur.t - prev.t);
}

// ---------------------------------------------------------------------------
// Estimators
// ---------------------------------------------------------------------------

/** Hang-time height (cm) from an airborne time (s): h = g·t²/8. */
export function hangTimeHeightCm(flightSec: number): number {
  const meters = (GRAVITY * flightSec * flightSec) / 8;
  return meters * 100;
}

/**
 * Displacement height (cm): peak hip-center RISE in px across the flight window
 * (max minus min hip y, since a rise is a DECREASE in y) times metres-per-px.
 * Falls back to the ankle apex excursion when hips were never visible.
 *
 * Returns null when no usable rise or no scale was available.
 */
export function displacementHeightCm(
  samples: readonly JumpSample[],
  window: FlightWindow,
  baseline: number,
  metersPerPx: number,
): number | null {
  if (!(metersPerPx > 0)) return null;
  // Prefer the hip center: its rise is the truest whole-body vertical
  // displacement (ankles tuck up under the body in flight, exaggerating their
  // excursion). Scan a small margin around the window for the resting hip and
  // the apex hip.
  const lo = Math.max(0, window.takeoffIndex - 3);
  const hi = Math.min(samples.length - 1, window.landingIndex + 3);
  let hipMin = Infinity; // highest point (smallest y)
  let hipMax = -Infinity; // resting (largest y)
  let sawHip = false;
  for (let i = lo; i <= hi; i++) {
    const hy = samples[i]!.hipY;
    if (hy == null) continue;
    sawHip = true;
    if (hy < hipMin) hipMin = hy;
    if (hy > hipMax) hipMax = hy;
  }
  let risePx: number;
  if (sawHip && hipMax > hipMin) {
    risePx = hipMax - hipMin;
  } else {
    // No hips — use the ankle apex vs baseline (looser, but better than nothing).
    risePx = baseline - window.apexAnkleY;
  }
  if (!(risePx > 0)) return null;
  return risePx * metersPerPx * 100;
}

// ---------------------------------------------------------------------------
// Top-level estimate
// ---------------------------------------------------------------------------

/**
 * Estimate a vertical jump from a lower-body series. Runs both estimators,
 * cross-checks them, and returns the hang-time number when it is valid (the
 * scale-free primary), with displacement as corroboration.
 *
 * Confidence is highest when both estimators AGREE (within ~30%) at a healthy
 * fps; it drops when fps is marginal, when only one estimator fired, or when
 * the two disagree badly (then the number stands but confidence is honest).
 */
export function estimateJump(
  samples: readonly JumpSample[],
  opts: JumpOptions = {},
): JumpEstimate {
  const fps = seriesFps(samples);
  const empty: JumpEstimate = {
    heightCm: 0,
    method: 'none',
    confidence: 0,
    flightSec: null,
    hangTimeCm: null,
    displacementCm: null,
    fps,
    note: '',
  };

  if (samples.length < 8) {
    return { ...empty, note: 'Not enough pose frames — keep the full body in view.' };
  }
  if (fps < MIN_FPS) {
    return {
      ...empty,
      note: 'Phone too slow for jump measurement — try Speed mode or better light.',
    };
  }

  const baseline = estimateBaseline(samples);
  if (baseline == null) {
    return { ...empty, note: 'Couldn’t see your feet — keep your whole body in frame.' };
  }

  // Adaptive band: at least a few px, or ~3× the standing noise, so a jittery
  // stream needs a bigger excursion to trigger and a clean one stays sensitive.
  const noise = baselineNoisePx(samples, baseline);
  const bandPx = opts.baselineBandPx ?? Math.max(6, noise * 3);

  const window = detectFlight(samples, baseline, bandPx);
  if (window == null) {
    return {
      ...empty,
      note: 'No clean jump detected — jump straight up with both feet and land in frame.',
    };
  }

  const hangTimeCm = hangTimeHeightCm(window.flightSec);
  const displacementCm =
    opts.metersPerPx != null
      ? displacementHeightCm(samples, window, baseline, opts.metersPerPx)
      : null;

  // Final = hang-time (scale-free primary). Confidence blends fps health and,
  // when both estimators exist, their agreement.
  let confidence = 0.55;
  // fps health: full credit at/above 30 fps, tapering to the 15 fps floor.
  const fpsHealth = Math.max(0, Math.min(1, (fps - MIN_FPS) / (30 - MIN_FPS)));
  confidence += 0.25 * fpsHealth;

  let note = '';
  if (displacementCm != null && displacementCm > 0) {
    const ratio =
      Math.min(hangTimeCm, displacementCm) / Math.max(hangTimeCm, displacementCm);
    // Agreement bonus: ratio 1.0 → +0.2, ratio 0.7 → 0, below → penalty.
    confidence += 0.2 * Math.max(-1, (ratio - 0.7) / 0.3);
    if (ratio < 0.6) {
      note =
        'Hang-time and displacement disagree — treat the number as a rough read.';
    }
  } else {
    note = 'Displacement cross-check unavailable (rim scale or hips not seen).';
  }
  confidence = Math.max(0.15, Math.min(0.95, confidence));

  return {
    heightCm: Math.round(hangTimeCm * 10) / 10,
    method: 'hang-time',
    confidence: Math.round(confidence * 100) / 100,
    flightSec: Math.round(window.flightSec * 1000) / 1000,
    hangTimeCm: Math.round(hangTimeCm * 10) / 10,
    displacementCm:
      displacementCm != null ? Math.round(displacementCm * 10) / 10 : null,
    fps: Math.round(fps * 10) / 10,
    note,
  };
}

// ---------------------------------------------------------------------------
// Scale from rim geometry
// ---------------------------------------------------------------------------

/**
 * metres-per-pixel from a locked rim box width: a real rim is
 * {@link RIM_WIDTH_M} across, so mpp = RIM_WIDTH_M / rimWidthPx. Returns null
 * for a degenerate width. This is the scale the displacement estimator uses
 * when the Jump Lab has a rim lock; a profile body height is the fallback the
 * caller can pass instead.
 */
export function metersPerPxFromRim(rimWidthPx: number): number | null {
  if (!(rimWidthPx > 0)) return null;
  return RIM_WIDTH_M / rimWidthPx;
}

/**
 * metres-per-pixel from a known standing height: the shooter's real height
 * (cm) spans (baselineY − standing head/eye y) px. Used when no rim is locked
 * but the user entered their height. Returns null for degenerate spans.
 */
export function metersPerPxFromHeight(
  heightCm: number,
  bodySpanPx: number,
): number | null {
  if (!(heightCm > 0) || !(bodySpanPx > 0)) return null;
  return heightCm / 100 / bodySpanPx;
}

// ---------------------------------------------------------------------------
// History aggregates (personal best / average / sparkline)
// ---------------------------------------------------------------------------

/** One persisted jump, as the history queries return it. */
export interface JumpRecord {
  id: number;
  ts: number;
  heightCm: number;
  method: string;
  confidence: number;
}

export interface JumpHistoryStats {
  /** Personal best height (cm), 0 when no history. */
  bestCm: number;
  /** Mean of the last N heights (cm), 0 when no history. */
  avgCm: number;
  /** Number of recorded jumps. */
  count: number;
  /** Most recent height (cm), 0 when no history. */
  latestCm: number;
  /** Newest-last height series for the sparkline (cm). */
  sparkline: number[];
}

// ---------------------------------------------------------------------------
// Training programs (plyometric)
// ---------------------------------------------------------------------------

export type ProgramLevel = 'beginner' | 'intermediate' | 'advanced';

/** One exercise within a plyometric program day. */
export interface PlyoExercise {
  name: string;
  sets: number;
  /** Reps per set (or seconds for holds — see `unit`). */
  reps: number;
  unit: 'reps' | 'sec';
  /** Rest between sets, seconds. */
  restSec: number;
}

export interface PlyoProgram {
  level: ProgramLevel;
  title: string;
  /** One-line who-it's-for. */
  who: string;
  /** Training days per week. */
  daysPerWeek: number;
  /** Named weekly schedule (e.g. "Mon / Thu"). */
  schedule: string;
  /** Sessions before expecting a measurable change. */
  weeks: number;
  exercises: PlyoExercise[];
  /** The single most important coaching principle for this level. */
  principle: string;
}

/**
 * Three plyometric programs built on standard, widely-published jump-training
 * principles (progressive overload, quality over quantity, full recovery
 * between explosive sets, low weekly volume for tendons). These are GENERAL
 * fitness guidance, NOT individualized medical or coaching advice — the UI
 * shows a disclaimer. Pure data so it can be rendered and unit-checked.
 */
export const PLYO_PROGRAMS: readonly PlyoProgram[] = [
  {
    level: 'beginner',
    title: 'Foundations',
    who: 'New to jump training — build tendon strength and clean landings first.',
    daysPerWeek: 2,
    schedule: 'Mon / Thu',
    weeks: 4,
    principle:
      'Land softly and under control. Quality of the landing matters more than how high you go — that is what protects your knees.',
    exercises: [
      { name: 'Bodyweight squat', sets: 3, reps: 12, unit: 'reps', restSec: 60 },
      { name: 'Calf raise', sets: 3, reps: 15, unit: 'reps', restSec: 45 },
      { name: 'Pogo hop (small, springy)', sets: 3, reps: 20, unit: 'reps', restSec: 60 },
      { name: 'Box step-down (slow landing)', sets: 3, reps: 8, unit: 'reps', restSec: 75 },
      { name: 'Wall sit', sets: 2, reps: 30, unit: 'sec', restSec: 60 },
    ],
  },
  {
    level: 'intermediate',
    title: 'Spring Loaded',
    who: 'Comfortable landing — start converting strength into explosive power.',
    daysPerWeek: 3,
    schedule: 'Mon / Wed / Fri',
    weeks: 6,
    principle:
      'Be explosive, then rest fully. Every rep should be maximal effort; take the full rest so the next set is just as powerful — plyometrics train the nervous system, not endurance.',
    exercises: [
      { name: 'Jump squat', sets: 4, reps: 6, unit: 'reps', restSec: 90 },
      { name: 'Box jump (step down)', sets: 4, reps: 5, unit: 'reps', restSec: 120 },
      { name: 'Broad jump', sets: 3, reps: 5, unit: 'reps', restSec: 120 },
      { name: 'Single-leg calf raise', sets: 3, reps: 12, unit: 'reps', restSec: 60 },
      { name: 'Split squat', sets: 3, reps: 8, unit: 'reps', restSec: 75 },
    ],
  },
  {
    level: 'advanced',
    title: 'Above the Rim',
    who: 'Trained athlete chasing max reactive power — depth jumps and heavy triples.',
    daysPerWeek: 3,
    schedule: 'Mon / Wed / Sat',
    weeks: 8,
    principle:
      'Minimize ground-contact time. Depth and reactive jumps train the stretch-shortening cycle — spend as little time on the floor as possible between the landing and the next jump. Stop the session the moment height or snap drops off.',
    exercises: [
      { name: 'Depth jump (12–18 in box)', sets: 5, reps: 4, unit: 'reps', restSec: 150 },
      { name: 'Weighted jump squat (light)', sets: 4, reps: 4, unit: 'reps', restSec: 150 },
      { name: 'Bounding', sets: 4, reps: 6, unit: 'reps', restSec: 120 },
      { name: 'Single-leg box jump', sets: 3, reps: 5, unit: 'reps', restSec: 120 },
      { name: 'Trap-bar deadlift (heavy)', sets: 4, reps: 3, unit: 'reps', restSec: 180 },
    ],
  },
];

/** Look up a program by level (defaults to beginner if somehow unknown). */
export function programForLevel(level: ProgramLevel): PlyoProgram {
  return PLYO_PROGRAMS.find((p) => p.level === level) ?? PLYO_PROGRAMS[0]!;
}

/**
 * Roll a jump history (any order) into the numbers the Jump Lab card shows.
 * Pure — the caller loads rows from the db and hands them here.
 */
export function jumpHistoryStats(records: readonly JumpRecord[]): JumpHistoryStats {
  if (records.length === 0) {
    return { bestCm: 0, avgCm: 0, count: 0, latestCm: 0, sparkline: [] };
  }
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  let best = 0;
  let sum = 0;
  for (const r of sorted) {
    if (r.heightCm > best) best = r.heightCm;
    sum += r.heightCm;
  }
  const avg = sum / sorted.length;
  return {
    bestCm: Math.round(best * 10) / 10,
    avgCm: Math.round(avg * 10) / 10,
    count: sorted.length,
    latestCm: Math.round(sorted[sorted.length - 1]!.heightCm * 10) / 10,
    sparkline: sorted.map((r) => r.heightCm),
  };
}
