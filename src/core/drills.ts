/**
 * Structured shooting drills — HomeCourt-style guided workouts layered on the
 * make/miss shot stream.
 *
 * A drill is a fixed sequence of SPOTS, each with a make goal and an advance
 * rule. The player works the current spot until its goal is met (or its attempt
 * cap is hit), then the drill moves to the next spot; clearing every spot wins.
 * It is exactly the "spot shooting" shape — so a drill RUNS AS the `spotShooting`
 * game mode: it produces a {@link ModeState} with `modeId: 'spotShooting'` and
 * carries its progression in `config.drill`. That makes the whole existing mode
 * framework (ModeBanner, SpotTracker, ModeComplete, History, share cards) light
 * up for drills for free, with zero new GameModeId and the eight catalog modes
 * left byte-identical.
 *
 * ZONE MAPPING (how a shot is attributed to a spot)
 * -------------------------------------------------
 * Hoopilot has no court calibration in v1 — the only positional signal a shot
 * carries is {@link ResolvedShot.originX} (the shooter's foot midpoint,
 * normalized 0..1 across the analysis frame) which {@link zoneOf} thirds into
 * 'left' | 'center' | 'right'. Every drill spot therefore declares which
 * {@link ChartZone} it lives in (its `zone`). When `advance` is:
 *   - 'anySpot'  the shot counts toward the current spot regardless of where the
 *     player stood — honest for FT / layup / catch-and-shoot drills where the AI
 *     can't verify the exact floor position and asking it to would drop makes.
 *   - 'matchZone' the make only counts toward the current spot when the shot's
 *     zone matches the spot's zone (a make from the wrong third is tracked as an
 *     off-spot make and nudges the player back). This is the strictest we can be
 *     honestly, given left/center/right is the whole positional vocabulary.
 *
 * A spot also carries a normalized (x, y) COURT POSITION in [0,1] (x across, y
 * from baseline 0 → half-court 1) purely so the on-screen half-court diagram can
 * light up the right dot; the progression engine never reads it.
 *
 * All functions are pure and return NEW state; inputs are never mutated. Mirrors
 * gameModes.ts conventions: `unsure` shots are non-events, and once `done`
 * further shots are ignored.
 */
import type { ModeSpot, ModeState } from './gameModes';
import { zoneOf } from './stats';
import type { ChartZone, ResolvedShot } from './types';

// ---------------------------------------------------------------------------
// Drill catalog (pure data)
// ---------------------------------------------------------------------------

/** Stable drill identifiers (persisted in config.drill.id / history). */
export type DrillId =
  | 'corners3'
  | 'ftLadder'
  | 'midClock'
  | 'aroundKey'
  | 'catchShoot10';

/** How a shot is attributed to the current drill spot (see module ZONE MAPPING). */
export type DrillAdvanceMode = 'anySpot' | 'matchZone';

/** One spot in a drill: where to stand, the goal, and an optional attempt cap. */
export interface DrillSpot {
  /** Player-facing spot label (drives SpotTracker / ModeComplete breakdown). */
  label: string;
  /** Zone this spot lives in — used when the drill advances by 'matchZone'. */
  zone: ChartZone;
  /** Makes required at this spot to clear it. */
  goal: number;
  /**
   * Normalized half-court position for the diagram ONLY: x across 0 (far left)
   * → 1 (far right); y from baseline 0 → half-court line 1. Never read by the
   * progression engine.
   */
  pos: { x: number; y: number };
}

/** A preset drill: an ordered spot sequence + attribution/attempt rules. */
export interface Drill {
  id: DrillId;
  title: string;
  /** Ionicons glyph for the drill's picker card + banner mark. */
  icon: string;
  /** One-line hook for the picker. */
  tagline: string;
  /** Full rules, one or two sentences. */
  rules: string;
  /** How makes are attributed to the current spot. */
  advance: DrillAdvanceMode;
  /**
   * Optional TOTAL attempt cap across the whole drill (catch-and-shoot: "10
   * makes in 15 attempts"). When the cap is reached the drill ends where it
   * stands, cleared or not. Undefined = no cap (work each spot to its goal).
   */
  attemptCap?: number;
  /** The spots, worked in order. */
  spots: readonly DrillSpot[];
}

// Half-court diagram coordinates: x across (0..1), y baseline→half (0..1). The
// three thirds of x line up with zoneOf's left/center/right so a spot's dot and
// its zone agree visually.
const X = { farLeft: 0.1, leftWing: 0.26, left: 0.32, center: 0.5, right: 0.68, rightWing: 0.74, farRight: 0.9 } as const;

export const DRILLS: readonly Drill[] = [
  {
    id: 'corners3',
    title: 'Corners 3PT',
    icon: 'flag',
    tagline: 'Both corners from deep — 5 makes each.',
    rules:
      'The two 3-point corners, the shortest shot behind the arc. Bank five makes from the left corner, then five from the right. Ten corner threes to finish.',
    advance: 'matchZone',
    spots: [
      { label: 'Left Corner 3', zone: 'left', goal: 5, pos: { x: X.farLeft, y: 0.12 } },
      { label: 'Right Corner 3', zone: 'right', goal: 5, pos: { x: X.farRight, y: 0.12 } },
    ],
  },
  {
    id: 'ftLadder',
    title: 'Free-Throw Ladder',
    icon: 'remove',
    tagline: '10 from the stripe. Climb the ladder.',
    rules:
      'Ten free throws from the line. Every make climbs one rung; misses just cost you an attempt. Rack up ten makes to top out.',
    advance: 'anySpot',
    spots: [{ label: 'Free-Throw Line', zone: 'center', goal: 10, pos: { x: X.center, y: 0.34 } }],
  },
  {
    id: 'midClock',
    title: 'Mid-Range Clock',
    icon: 'time',
    tagline: '5 spots around the elbow — 3 makes each.',
    rules:
      'Work the mid-range clock: five spots from left baseline around to the right. Hit three makes at each before the clock ticks on. Fifteen mid-range makes in all.',
    advance: 'matchZone',
    spots: [
      { label: 'Left Baseline', zone: 'left', goal: 3, pos: { x: X.left, y: 0.1 } },
      { label: 'Left Elbow', zone: 'left', goal: 3, pos: { x: X.leftWing, y: 0.42 } },
      { label: 'Top of Key', zone: 'center', goal: 3, pos: { x: X.center, y: 0.52 } },
      { label: 'Right Elbow', zone: 'right', goal: 3, pos: { x: X.rightWing, y: 0.42 } },
      { label: 'Right Baseline', zone: 'right', goal: 3, pos: { x: X.right, y: 0.1 } },
    ],
  },
  {
    id: 'aroundKey',
    title: 'Around-Key Layups',
    icon: 'ellipse',
    tagline: '6 finishes around the rim.',
    rules:
      'Six spots ringing the key, right at the rim. One clean finish clears each — work all the way around the paint for six makes.',
    advance: 'anySpot',
    spots: [
      { label: 'Left Block', zone: 'left', goal: 1, pos: { x: X.left, y: 0.06 } },
      { label: 'Left Short Corner', zone: 'left', goal: 1, pos: { x: X.leftWing, y: 0.16 } },
      { label: 'Left of Rim', zone: 'center', goal: 1, pos: { x: 0.42, y: 0.14 } },
      { label: 'Right of Rim', zone: 'center', goal: 1, pos: { x: 0.58, y: 0.14 } },
      { label: 'Right Short Corner', zone: 'right', goal: 1, pos: { x: X.rightWing, y: 0.16 } },
      { label: 'Right Block', zone: 'right', goal: 1, pos: { x: X.right, y: 0.06 } },
    ],
  },
  {
    id: 'catchShoot10',
    title: 'Catch-and-Shoot 10',
    icon: 'flash',
    tagline: '10 makes in 15 shots. No misfires.',
    rules:
      'Catch-and-shoot from the top: ten makes before you use up fifteen attempts. Every shot counts — hunt the rhythm and stay above 66%.',
    advance: 'anySpot',
    attemptCap: 15,
    spots: [{ label: 'Top of Key', zone: 'center', goal: 10, pos: { x: X.center, y: 0.5 } }],
  },
];

/** Lookup a drill by id. Throws on an unknown id (programmer error). */
export function getDrill(id: DrillId): Drill {
  const d = DRILLS.find((x) => x.id === id);
  if (d === undefined) throw new Error(`Unknown drill: ${id}`);
  return d;
}

/**
 * The running drill on a mode state, or null when the state isn't a drill.
 * The single seam every drill-aware UI (banner copy, complete sheet, overlay)
 * uses so none of them re-derive `config?.drill` by hand.
 */
export function drillOf(state: ModeState): Drill | null {
  const id = state.config?.drill?.id;
  return id != null ? getDrill(id) : null;
}

// ---------------------------------------------------------------------------
// Drill progression state (rides inside ModeState.config.drill)
// ---------------------------------------------------------------------------

/**
 * The running drill progression. Kept on `ModeState.config.drill` so the whole
 * state stays serializable (History persists modeResultJson) and the pure
 * step/init functions never touch a clock or the outside world.
 */
export interface DrillState {
  id: DrillId;
  /** Advance rule copied from the drill (so step never re-reads the catalog). */
  advance: DrillAdvanceMode;
  /** Optional total-attempt cap copied from the drill. */
  attemptCap?: number;
  /** Per-spot goals, index-aligned with {@link ModeState.spots}. */
  goals: number[];
  /**
   * Makes at the current or a past spot that landed in the WRONG zone (only
   * possible under 'matchZone'). Surfaced in the status line to nudge the
   * player back to the spot; never blocks completion.
   */
  offSpotMakes: number;
  /** Total decided attempts so far (for the attemptCap accounting + label). */
  attempts: number;
}

// ---------------------------------------------------------------------------
// initMode-style builder — a drill AS a spotShooting ModeState
// ---------------------------------------------------------------------------

function drillSpots(drill: Drill): ModeSpot[] {
  return drill.spots.map((s) => ({ label: s.label, attempts: 0, makes: 0 }));
}

/** First-spot status line for a fresh drill. */
function openMessage(drill: Drill): string {
  const first = drill.spots[0];
  return `${first.goal} at ${first.label}.`;
}

/**
 * Build the initial {@link ModeState} for a drill. The result is an ordinary
 * `spotShooting` state (so every mode surface renders it) with the drill's own
 * variable spot list and its progression tucked into `config.drill`. Pure; call
 * once when the player picks a drill.
 */
export function initDrillMode(id: DrillId): ModeState {
  const drill = getDrill(id);
  return {
    modeId: 'spotShooting',
    started: null,
    done: false,
    score: 0,
    progress: 0,
    currentSpot: 0,
    spots: drillSpots(drill),
    config: {
      drill: {
        id,
        advance: drill.advance,
        ...(drill.attemptCap != null ? { attemptCap: drill.attemptCap } : {}),
        goals: drill.spots.map((s) => s.goal),
        offSpotMakes: 0,
        attempts: 0,
      },
    },
    message: openMessage(drill),
  };
}

// ---------------------------------------------------------------------------
// stepDrill — fold one resolved shot into a drill's progression
// ---------------------------------------------------------------------------

/** Does this drill spot's zone match the shot's zone (matchZone rule)? */
function zoneMatches(shot: ResolvedShot, spotZone: ChartZone): boolean {
  const z = zoneOf(shot.originX);
  // No person tracked (null zone) ⇒ we can't disprove the spot, so we accept
  // the shot for the current spot rather than silently dropping the make.
  return z === null || z === spotZone;
}

/**
 * Fold one resolved shot into a drill-mode state. Pure; returns NEW state.
 *
 * Rules (mirrors gameModes' spot logic, generalized to per-spot goals):
 *   - `unsure` shots are non-events; a `done` state is returned unchanged.
 *   - The attempt is recorded on the CURRENT spot (drives SpotTracker's n/N and
 *     the ModeComplete breakdown), and against the drill-wide attempt tally.
 *   - Under 'matchZone', a make whose zone doesn't match the current spot's zone
 *     counts as an OFF-SPOT make (tallied, surfaced) but does not advance.
 *   - When the current spot reaches its goal, advance; clearing the last spot
 *     wins. An `attemptCap` (catch-and-shoot) ends the drill the moment total
 *     attempts hit the cap, cleared or not.
 */
export function stepDrill(state: ModeState, shot: ResolvedShot): ModeState {
  if (state.done) return state;
  const drill = state.config?.drill;
  if (drill == null) return state; // Not a drill — caller should not have routed here.
  if (shot.outcome === 'unsure') return state;

  const isMake = shot.outcome === 'make';
  const spots = (state.spots ?? []).map((s) => ({ ...s }));
  const idx = state.currentSpot ?? 0;
  const spot = spots[idx];
  const started = state.started ?? shot.tResolved;
  const goals = drill.goals;
  const goal = goals[idx] ?? 1;
  const drillDef = getDrill(drill.id);
  const spotZone = drillDef.spots[idx]?.zone ?? 'center';

  // Record the attempt (current spot + drill total).
  spot.attempts += 1;
  const attempts = drill.attempts + 1;

  // Attribute the make.
  const onSpot = drill.advance === 'anySpot' || zoneMatches(shot, spotZone);
  let offSpotMakes = drill.offSpotMakes;
  if (isMake && onSpot) {
    spot.makes += 1;
  } else if (isMake) {
    offSpotMakes += 1;
  }

  const totalMakes = spots.reduce((a, s) => a + s.makes, 0);
  const nextDrill: DrillState = { ...drill, offSpotMakes, attempts };

  const capHit = drill.attemptCap != null && attempts >= drill.attemptCap;

  // Spot cleared?
  if (spot.makes >= goal) {
    const nextIdx = idx + 1;
    if (nextIdx >= spots.length) {
      return finishDrill(state, spots, idx, totalMakes, nextDrill, started);
    }
    const nextGoal = goals[nextIdx] ?? 1;
    return {
      ...state,
      started,
      spots,
      currentSpot: nextIdx,
      score: totalMakes,
      progress: nextIdx / spots.length,
      config: { ...state.config, drill: nextDrill },
      message: `${nextGoal} at ${spots[nextIdx].label}.`,
    };
  }

  // Attempt cap reached before clearing (catch-and-shoot ran out of shots).
  if (capHit) {
    return finishDrill(state, spots, idx, totalMakes, nextDrill, started);
  }

  const remaining = goal - spot.makes;
  const offNote =
    !onSpot && isMake ? ` — that make was off-spot, back to ${spot.label}.` : '';
  return {
    ...state,
    started,
    spots,
    score: totalMakes,
    // Progress mixes cleared spots with fractional progress on the active spot.
    progress: (idx + spot.makes / goal) / spots.length,
    config: { ...state.config, drill: nextDrill },
    message: `${remaining} to go at ${spot.label}${offNote}`,
  };
}

/** Finalize a drill: score = total makes, progress = 1, tailored headline. */
function finishDrill(
  state: ModeState,
  spots: ModeSpot[],
  lastIdx: number,
  totalMakes: number,
  drill: DrillState,
  started: number | null,
): ModeState {
  const cleared = spots.every((s, i) => s.makes >= (drill.goals[i] ?? 1));
  return {
    ...state,
    started,
    done: true,
    spots,
    currentSpot: lastIdx,
    score: totalMakes,
    progress: 1,
    config: { ...state.config, drill },
    message: cleared
      ? 'Drill complete — every spot cleared! 🎯'
      : `Time's up — ${totalMakes} makes in ${drill.attempts} shots.`,
  };
}
