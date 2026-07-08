/**
 * Game-mode engine — pure rules layered on the make/miss shot stream.
 *
 * Each mode is a small state machine over {@link ResolvedShot} events. The core
 * is three pure functions:
 *   - {@link initMode}  — fresh {@link ModeState} for a mode.
 *   - {@link stepMode}  — fold one resolved shot into the state (scoring, spot
 *     advance, HORSE letters, streaks, …).
 *   - {@link tickMode}  — advance wall-clock for timed modes (countdown / done).
 *
 * All functions are pure and return NEW state; inputs are never mutated. Time
 * is passed in as `nowSec` (seconds, monotonic) — this module never reads the
 * clock. `unsure` shots are treated as non-events by every mode (they neither
 * score nor advance nor cost a letter) so the AI's low-confidence calls don't
 * corrupt a game.
 */
import { stepDrill, type DrillState } from './drills';
import type { GameModeId, ResolvedShot, ShotOutcome, ShotValue } from './types';

/**
 * Structural alias for the drill progression stored on {@link ModeState.config}.
 * Kept as an alias (not a re-declaration) so gameModes and drills never drift.
 */
type DrillConfig = DrillState;

// ---------------------------------------------------------------------------
// Mode catalog
// ---------------------------------------------------------------------------

export interface GameModeDef {
  id: GameModeId;
  name: string;
  emoji: string;
  /** One-line hook shown on the mode picker. */
  tagline: string;
  /** Full rules, one or two sentences. */
  rules: string;
  /** Mode counts down wall-clock (tickMode drives completion). */
  needsTimer: boolean;
  /** Mode uses ordered shooting spots (progress is spot-based). */
  needsSpots: boolean;
}

/** Spots used by Around the World / Spot Shooting (baseline → wing → corner). */
const SPOT_LABELS = [
  'Left Corner',
  'Left Wing',
  'Top of Key',
  'Right Wing',
  'Right Corner',
] as const;

export const GAME_MODES: readonly GameModeDef[] = [
  {
    id: 'free',
    name: 'Free Play',
    emoji: '🏀',
    tagline: 'Just shoot — every make counts.',
    rules:
      'Open run. Every shot is tracked and scored 2 or 3 by its distance; no target, no timer. Points climb with your makes.',
    needsTimer: false,
    needsSpots: false,
  },
  {
    id: 'aroundTheWorld',
    name: 'Around the World',
    emoji: '🌍',
    tagline: 'Make each spot to move on.',
    rules:
      'Five spots, corner to corner. Sink one at the current spot to advance to the next. Clear all five to win.',
    needsTimer: false,
    needsSpots: true,
  },
  {
    id: 'spotShooting',
    name: 'Spot Shooting',
    emoji: '🎯',
    tagline: '5 spots × N makes. Track % per spot.',
    rules:
      'Bank the required makes at each of five spots before moving on. Your make percentage is tracked per spot for a shooting report.',
    needsTimer: false,
    needsSpots: true,
  },
  {
    id: 'timed',
    name: 'Timed Challenge',
    emoji: '⏱️',
    tagline: '60 seconds — most makes wins.',
    rules:
      'The clock starts on tip-off. Score as many makes as you can before it hits zero. Beat your best.',
    needsTimer: true,
    needsSpots: false,
  },
  {
    id: 'threePoint',
    name: '3-Point Contest',
    emoji: '💰',
    tagline: '5 racks, last ball is money.',
    rules:
      'NBA-style: five racks of five balls. Each make is 1 point, but the last ball of every rack is a money ball worth 2. 25 balls, 30 points possible.',
    needsTimer: false,
    needsSpots: false,
  },
  {
    id: 'ftStreak',
    name: 'Free Throw Streak',
    emoji: '🔥',
    tagline: 'How many in a row?',
    rules:
      'Consecutive free throws. Your streak grows with every make and resets to zero the moment you miss. Chase your best run.',
    needsTimer: false,
    needsSpots: false,
  },
  {
    id: 'horse',
    name: 'H-O-R-S-E',
    emoji: '🐴',
    tagline: 'Land it, then repeat it — or take a letter.',
    rules:
      'Solo H-O-R-S-E. Land a shot to "call" it, then you must make your next attempt to match it. Miss a called shot and you take a letter. Spell HORSE and you are out.',
    needsTimer: false,
    needsSpots: false,
  },
  {
    id: 'ghost',
    name: 'Ghost Challenge',
    emoji: '👻',
    tagline: 'Race your past self, make for make.',
    rules:
      'Pick a past session and race its make timeline in real time. Your first shot starts the clock; finish ahead of the ghost when its clock expires to win.',
    // The race clock is inherited from the ghost session (not the setup-screen
    // duration picker) and the live tick loop keys on the mode id, so this
    // stays false even though tickMode drives completion.
    needsTimer: false,
    needsSpots: false,
  },
];

/** Lookup a mode definition by id. Throws on an unknown id (programmer error). */
export function getModeDef(id: GameModeId): GameModeDef {
  const def = GAME_MODES.find((m) => m.id === id);
  if (def === undefined) throw new Error(`Unknown game mode: ${id}`);
  return def;
}

// ---------------------------------------------------------------------------
// Ghost Challenge — race a previous session's make timeline
// ---------------------------------------------------------------------------

/** Minimum makes a past session needs to be raceable as a ghost. */
export const GHOST_MIN_MAKES = 3;

/** One point on the ghost's make timeline: the ghost's cumulative make count
 * as of `tOffsetSec` seconds after ITS first decided shot. */
export interface GhostTimelinePoint {
  tOffsetSec: number;
  /** Cumulative makes at that instant (1 for the first make, 2 for the second…). */
  makes: number;
}

/** Immutable per-race config: the ghost session's make timeline + duration. */
export interface GhostConfig {
  /** Make timeline, ascending by tOffsetSec (see {@link deriveGhostConfig}). */
  timeline: GhostTimelinePoint[];
  /** Ghost session length in seconds (first → last decided shot). */
  durationSec: number;
  /** Source session row id, for labels/replay bookkeeping. */
  sourceSessionId?: number;
  /** Short player-facing label for the ghost (session tag or date). */
  sourceLabel?: string;
}

/** Live race scoreboard for the Ghost Challenge (modeId 'ghost' only). */
export interface GhostRaceState {
  /** Your cumulative makes this run. */
  yourMakes: number;
  /** The ghost's cumulative makes at the current elapsed time. */
  ghostMakesNow: number;
  /** yourMakes − ghostMakesNow. Positive ⇒ you're ahead. */
  lead: number;
  /** The ghost's final make total — the target to beat. */
  finalGhostMakes: number;
  /** Race outcome vs the ghost's final total; set when the mode completes. */
  result?: 'win' | 'tie' | 'loss';
  /** Final margin (yourMakes − finalGhostMakes); set when the mode completes. */
  finalMargin?: number;
}

/** Tint for the banner status line (`ModeState.message`). Modes that never set
 * it render neutral, exactly as before this field existed. */
export type ModeMessageTone = 'positive' | 'negative' | 'neutral';

// ---------------------------------------------------------------------------
// Mode state
// ---------------------------------------------------------------------------

/** One tracked shooting spot (Around the World / Spot Shooting). */
export interface ModeSpot {
  label: string;
  attempts: number;
  makes: number;
}

export interface ModeState {
  modeId: GameModeId;
  /** Wall-clock seconds when the game started (timed modes). null = not armed. */
  started: number | null;
  /** Game over (won, lost, or clock expired). */
  done: boolean;
  /** Points / makes / letters depending on mode (see per-mode notes). */
  score: number;
  /** 0..1 progress toward completion (spots cleared, balls thrown, streak…). */
  progress: number;
  /** Active spot index for spot-based modes. */
  currentSpot?: number;
  /** HORSE letters accrued so far, e.g. "HOR" (empty until first fail). */
  letters?: string;
  /** Seconds left for timed modes (mirrors the countdown). */
  timeLeftSec?: number;
  /** Short player-facing status line. */
  message: string;
  /** Per-spot attempts/makes for spot-based modes. */
  spots?: ModeSpot[];
  /**
   * Immutable per-game config captured at {@link initMode} time. Kept on the
   * state (rather than reconstructed) so step/tick stay pure and exact:
   * durationSec for timed, makesPerSpot for spot shooting, the ghost timeline
   * for the Ghost Challenge, bestStreak for ftStreak's running best.
   */
  config?: {
    durationSec?: number;
    makesPerSpot?: number;
    ghost?: GhostConfig;
    /**
     * Structured-drill progression (src/core/drills.ts). Present ONLY when a
     * drill is running: a drill rides inside the `spotShooting` mode, so its
     * running state lives here rather than as a new GameModeId. When set,
     * {@link stepMode} delegates the shot to the drill engine. Typed as the
     * drill layer's `DrillState`; kept as a structural field here so gameModes
     * carries no value-import of the drills module (types only, no cycle).
     */
    drill?: DrillConfig;
  };
  /** ftStreak: best consecutive-make run so far. */
  bestStreak?: number;
  /** Ghost Challenge: the live race scoreboard (modeId 'ghost' only). */
  ghost?: GhostRaceState;
  /** Optional tint for `message` (ghost lead coloring). Absent ⇒ neutral. */
  messageTone?: ModeMessageTone;
}

/** Options accepted by {@link initMode}. All optional with sane defaults. */
export interface InitModeOpts {
  /** Timed-mode duration, seconds (default 60). */
  durationSec?: number;
  /** Spot Shooting: makes required per spot (default 5). */
  makesPerSpot?: number;
  /** Ghost Challenge: the ghost session's timeline. Required for a live race —
   * without it the mode initializes already-done (empty-ghost guard). */
  ghost?: GhostConfig;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const HORSE = 'HORSE';
const TIMED_DEFAULT_SEC = 60;
const SPOT_MAKES_DEFAULT = 5;
const THREEPT_RACKS = 5;
const THREEPT_BALLS_PER_RACK = 5;
const THREEPT_TOTAL_BALLS = THREEPT_RACKS * THREEPT_BALLS_PER_RACK;

/** Is this shot a scoring event? unsure shots are ignored by every mode. */
function isDecided(shot: ResolvedShot): boolean {
  return shot.outcome === 'make' || shot.outcome === 'miss';
}

function isMake(shot: ResolvedShot): boolean {
  return shot.outcome === 'make';
}

/** Point value of a made shot; defaults to 2 when the estimate is absent. */
function madeValue(shot: ResolvedShot): ShotValue {
  return shot.shotValue ?? 2;
}

function freshSpots(): ModeSpot[] {
  return SPOT_LABELS.map((label) => ({ label, attempts: 0, makes: 0 }));
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---------------------------------------------------------------------------
// initMode
// ---------------------------------------------------------------------------

/**
 * Build the initial {@link ModeState} for a mode. Pure; call once when the
 * player picks a mode. Timed modes start `done: false` with a full clock but
 * `started: null` — the first {@link tickMode}/{@link stepMode} with a nowSec
 * arms the clock.
 */
export function initMode(modeId: GameModeId, opts: InitModeOpts = {}): ModeState {
  switch (modeId) {
    case 'free':
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        message: 'Free play — shoot around.',
      };

    case 'aroundTheWorld':
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        currentSpot: 0,
        spots: freshSpots(),
        message: `Make it from ${SPOT_LABELS[0]}.`,
      };

    case 'spotShooting': {
      const makesPerSpot = opts.makesPerSpot ?? SPOT_MAKES_DEFAULT;
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        currentSpot: 0,
        spots: freshSpots(),
        config: { makesPerSpot },
        message: `${makesPerSpot} makes from ${SPOT_LABELS[0]}.`,
      };
    }

    case 'timed': {
      const dur = opts.durationSec ?? TIMED_DEFAULT_SEC;
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        timeLeftSec: dur,
        config: { durationSec: dur },
        message: `${dur}s — most makes wins.`,
      };
    }

    case 'threePoint':
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        message: 'Rack 1 — money ball on ball 5.',
      };

    case 'ftStreak':
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        bestStreak: 0,
        message: 'Free throws — how many in a row?',
      };

    case 'horse':
      return {
        modeId,
        started: null,
        done: false,
        score: 0,
        progress: 0,
        letters: '',
        message: 'Land a shot to call it.',
      };

    case 'ghost': {
      const ghostCfg = opts.ghost;
      const timeline = ghostCfg?.timeline ?? [];
      const durationSec = ghostCfg?.durationSec ?? 0;
      const finalGhostMakes = timeline.reduce((a, p) => Math.max(a, p.makes), 0);
      // Empty-ghost guard: a race needs at least one ghost make and a real
      // clock. Anything else starts (and stays) done so no phantom race runs.
      const valid = timeline.length > 0 && durationSec > 0 && finalGhostMakes > 0;
      return {
        modeId,
        started: null,
        done: !valid,
        score: 0,
        progress: 0,
        timeLeftSec: valid ? durationSec : 0,
        ...(ghostCfg != null ? { config: { ghost: ghostCfg } } : {}),
        ghost: { yourMakes: 0, ghostMakesNow: 0, lead: 0, finalGhostMakes },
        message: valid
          ? `Beat ${finalGhostMakes} makes in ${Math.ceil(durationSec)}s — your first shot starts the race.`
          : 'No ghost run loaded — pick a past session to race.',
      };
    }
  }
}

// ---------------------------------------------------------------------------
// stepMode
// ---------------------------------------------------------------------------

/**
 * Fold one resolved shot into the mode state. Pure; returns NEW state.
 *
 * Common rules:
 *   - `unsure` shots never score, advance, or cost anything.
 *   - Once `done`, further shots are ignored (state returned unchanged).
 *   - `nowSec` arms `started` on the first shot (used by timed modes; a shot
 *     arriving after the clock expired does not score — see 'timed').
 */
export function stepMode(
  state: ModeState,
  shot: ResolvedShot,
  nowSec: number,
): ModeState {
  if (state.done) return state;

  // A structured drill rides inside the spotShooting mode (config.drill set):
  // its per-spot goals / zone attribution are variable, so delegate to the
  // pure drill engine. Real Spot Shooting never sets config.drill, so its
  // branch below stays untouched.
  if (state.config?.drill != null) return stepDrill(state, shot);

  switch (state.modeId) {
    case 'free':
      return stepFree(state, shot, nowSec);
    case 'aroundTheWorld':
      return stepAroundTheWorld(state, shot, nowSec);
    case 'spotShooting':
      return stepSpotShooting(state, shot, nowSec);
    case 'timed':
      return stepTimed(state, shot, nowSec);
    case 'threePoint':
      return stepThreePoint(state, shot, nowSec);
    case 'ftStreak':
      return stepFtStreak(state, shot, nowSec);
    case 'horse':
      return stepHorse(state, shot, nowSec);
    case 'ghost':
      return stepGhost(state, shot, nowSec);
  }
}

function withStart(state: ModeState, nowSec: number): number | null {
  return state.started ?? nowSec;
}

// --- free -----------------------------------------------------------------

function stepFree(state: ModeState, shot: ResolvedShot, nowSec: number): ModeState {
  if (!isDecided(shot)) return state;
  const started = withStart(state, nowSec);
  if (!isMake(shot)) {
    return { ...state, started, message: 'Miss — keep shooting.' };
  }
  const pts = madeValue(shot);
  const score = state.score + pts;
  return {
    ...state,
    started,
    score,
    message: `+${pts} · ${score} pts`,
  };
}

// --- aroundTheWorld -------------------------------------------------------

function stepAroundTheWorld(
  state: ModeState,
  shot: ResolvedShot,
  nowSec: number,
): ModeState {
  if (!isDecided(shot)) return state;
  const spots = (state.spots ?? freshSpots()).map((s) => ({ ...s }));
  const idx = state.currentSpot ?? 0;
  const started = withStart(state, nowSec);
  spots[idx].attempts += 1;

  if (!isMake(shot)) {
    return {
      ...state,
      started,
      spots,
      message: `Miss at ${spots[idx].label} — try again.`,
    };
  }

  spots[idx].makes += 1;
  const nextIdx = idx + 1;
  const total = spots.length;

  if (nextIdx >= total) {
    return {
      ...state,
      started,
      done: true,
      spots,
      currentSpot: idx,
      score: total,
      progress: 1,
      message: 'Around the World complete! 🌍',
    };
  }

  return {
    ...state,
    started,
    spots,
    currentSpot: nextIdx,
    score: nextIdx,
    progress: nextIdx / total,
    message: `On to ${spots[nextIdx].label}.`,
  };
}

// --- spotShooting ---------------------------------------------------------

function stepSpotShooting(
  state: ModeState,
  shot: ResolvedShot,
  nowSec: number,
): ModeState {
  if (!isDecided(shot)) return state;
  const spots = (state.spots ?? freshSpots()).map((s) => ({ ...s }));
  const idx = state.currentSpot ?? 0;
  const started = withStart(state, nowSec);
  const makesPerSpot = state.config?.makesPerSpot ?? SPOT_MAKES_DEFAULT;
  spots[idx].attempts += 1;
  if (isMake(shot)) spots[idx].makes += 1;

  const total = spots.length;
  const totalMakes = spots.reduce((a, s) => a + s.makes, 0);

  if (spots[idx].makes >= makesPerSpot) {
    const nextIdx = idx + 1;
    if (nextIdx >= total) {
      return {
        ...state,
        started,
        done: true,
        spots,
        currentSpot: idx,
        score: totalMakes,
        progress: 1,
        message: 'All spots cleared! 🎯',
      };
    }
    return {
      ...state,
      started,
      spots,
      currentSpot: nextIdx,
      score: totalMakes,
      progress: nextIdx / total,
      message: `${makesPerSpot} from ${spots[nextIdx].label}.`,
    };
  }

  const remaining = makesPerSpot - spots[idx].makes;
  return {
    ...state,
    started,
    spots,
    score: totalMakes,
    message: `${remaining} to go at ${spots[idx].label}.`,
  };
}

// --- timed ----------------------------------------------------------------

function stepTimed(state: ModeState, shot: ResolvedShot, nowSec: number): ModeState {
  if (!isDecided(shot)) return state;
  const started = state.started ?? nowSec;
  const dur = state.config?.durationSec ?? TIMED_DEFAULT_SEC;
  const elapsed = nowSec - started;
  const timeLeftSec = Math.max(0, dur - elapsed);

  // Shot landed after the buzzer ⇒ doesn't count; finalize.
  if (timeLeftSec <= 0) {
    return {
      ...state,
      started,
      done: true,
      timeLeftSec: 0,
      progress: 1,
      message: `Time! ${state.score} makes.`,
    };
  }

  if (!isMake(shot)) {
    return {
      ...state,
      started,
      timeLeftSec,
      progress: clamp01(elapsed / dur),
      message: `${Math.ceil(timeLeftSec)}s · ${state.score} makes`,
    };
  }
  const score = state.score + 1;
  return {
    ...state,
    started,
    score,
    timeLeftSec,
    progress: clamp01(elapsed / dur),
    message: `${Math.ceil(timeLeftSec)}s · ${score} makes`,
  };
}

// --- threePoint -----------------------------------------------------------

function stepThreePoint(
  state: ModeState,
  shot: ResolvedShot,
  nowSec: number,
): ModeState {
  if (!isDecided(shot)) return state;
  const started = withStart(state, nowSec);
  // progress carries the ball count 0..24 as (ballsThrown / total).
  const ballsThrown = Math.round(state.progress * THREEPT_TOTAL_BALLS);
  const ballIndexInRack = ballsThrown % THREEPT_BALLS_PER_RACK; // 0..4
  const isMoneyBall = ballIndexInRack === THREEPT_BALLS_PER_RACK - 1;

  let score = state.score;
  if (isMake(shot)) score += isMoneyBall ? 2 : 1;

  const nextThrown = ballsThrown + 1;
  const progress = nextThrown / THREEPT_TOTAL_BALLS;

  if (nextThrown >= THREEPT_TOTAL_BALLS) {
    return {
      ...state,
      started,
      done: true,
      score,
      progress: 1,
      message: `Contest done — ${score} points! 💰`,
    };
  }

  const rack = Math.floor(nextThrown / THREEPT_BALLS_PER_RACK) + 1;
  const ballInRack = (nextThrown % THREEPT_BALLS_PER_RACK) + 1;
  const moneyNext = nextThrown % THREEPT_BALLS_PER_RACK === THREEPT_BALLS_PER_RACK - 1;
  return {
    ...state,
    started,
    score,
    progress,
    message: moneyNext
      ? `Rack ${rack} — money ball! · ${score} pts`
      : `Rack ${rack} ball ${ballInRack} · ${score} pts`,
  };
}

// --- ftStreak -------------------------------------------------------------

function stepFtStreak(
  state: ModeState,
  shot: ResolvedShot,
  nowSec: number,
): ModeState {
  if (!isDecided(shot)) return state;
  const started = withStart(state, nowSec);
  // score = current streak; bestStreak = best run so far.
  const best = state.bestStreak ?? 0;
  if (!isMake(shot)) {
    return {
      ...state,
      started,
      score: 0,
      bestStreak: best,
      message: `Miss — streak reset (best ${best}).`,
    };
  }
  const score = state.score + 1;
  const newBest = Math.max(best, score);
  return {
    ...state,
    started,
    score,
    bestStreak: newBest,
    message: `${score} in a row!`,
  };
}

// --- horse ----------------------------------------------------------------

/**
 * Solo H-O-R-S-E. The player is either "open" (no called shot) or has a called
 * shot they must match. We encode the called state in `currentSpot`:
 *   currentSpot === 1 ⇒ a shot is called and must be matched next.
 *   currentSpot === 0 / undefined ⇒ open (call a new shot with a make).
 * A make while open calls the shot. A make while called clears it (back to
 * open). A miss while called costs a letter. A miss while open is harmless.
 */
function stepHorse(state: ModeState, shot: ResolvedShot, nowSec: number): ModeState {
  if (!isDecided(shot)) return state;
  const started = withStart(state, nowSec);
  const called = state.currentSpot === 1;
  const letters = state.letters ?? '';

  if (isMake(shot)) {
    if (called) {
      return {
        ...state,
        started,
        currentSpot: 0,
        letters,
        score: letters.length,
        message: 'Matched! Call your next shot.',
      };
    }
    return {
      ...state,
      started,
      currentSpot: 1,
      letters,
      score: letters.length,
      message: 'Shot called — now match it.',
    };
  }

  // Miss.
  if (!called) {
    return { ...state, started, currentSpot: 0, letters, score: letters.length, message: 'Open miss — no letter.' };
  }
  // Missed a called shot ⇒ take a letter, return to open.
  const nextLetters = HORSE.slice(0, Math.min(letters.length + 1, HORSE.length));
  const done = nextLetters.length >= HORSE.length;
  return {
    ...state,
    started,
    done,
    currentSpot: 0,
    letters: nextLetters,
    score: nextLetters.length,
    progress: nextLetters.length / HORSE.length,
    message: done ? "You're OUT — H-O-R-S-E." : `Letter: ${nextLetters}`,
  };
}

// --- ghost ------------------------------------------------------------------

/**
 * The ghost's cumulative makes at `tSec` seconds into the race — a
 * piecewise-constant (step) interpolation of the make timeline: the ghost is
 * credited with each make exactly at its recorded offset, never earlier.
 * Robust to unsorted timelines; returns 0 before the first make.
 */
export function ghostMakesAt(
  timeline: readonly GhostTimelinePoint[],
  tSec: number,
): number {
  let makes = 0;
  for (const p of timeline) {
    if (p.tOffsetSec <= tSec && p.makes > makes) makes = p.makes;
  }
  return makes;
}

/** The minimal shot shape {@link deriveGhostConfig} needs (ShotRow-compatible). */
export interface GhostSourceShot {
  /** Resolve time, seconds (any consistent clock — only offsets are used). */
  tResolved: number;
  outcome: ShotOutcome;
}

/**
 * Derive a {@link GhostConfig} from a past session's resolved shots: the make
 * timeline is timed from the session's FIRST decided shot (make or miss), and
 * the race duration runs to its last decided shot. `unsure` shots are ignored,
 * matching every mode's treatment of them.
 *
 * Returns null when the session can't be raced: no decided shots, no makes,
 * or a degenerate (zero-length) clock.
 */
export function deriveGhostConfig(
  shots: readonly GhostSourceShot[],
  meta: { sourceSessionId?: number; sourceLabel?: string } = {},
): GhostConfig | null {
  const decided = shots
    .filter((s) => s.outcome === 'make' || s.outcome === 'miss')
    .slice()
    .sort((a, b) => a.tResolved - b.tResolved);
  if (decided.length === 0) return null;
  const t0 = decided[0].tResolved;
  const timeline: GhostTimelinePoint[] = [];
  let makes = 0;
  for (const s of decided) {
    if (s.outcome !== 'make') continue;
    makes += 1;
    timeline.push({ tOffsetSec: s.tResolved - t0, makes });
  }
  if (timeline.length === 0) return null;
  const durationSec = decided[decided.length - 1].tResolved - t0;
  if (durationSec <= 0) return null;
  return { timeline, durationSec, ...meta };
}

/** Status line: "YOU 7 · GHOST 6 · +1" (EVEN when tied). */
function ghostRaceMessage(yourMakes: number, ghostMakesNow: number): string {
  const lead = yourMakes - ghostMakesNow;
  const tail = lead > 0 ? `+${lead}` : lead < 0 ? `${lead}` : 'EVEN';
  return `YOU ${yourMakes} · GHOST ${ghostMakesNow} · ${tail}`;
}

function ghostTone(lead: number): ModeMessageTone {
  return lead > 0 ? 'positive' : lead < 0 ? 'negative' : 'neutral';
}

/** Finalize the race at the ghost clock's expiry: win/tie/loss + margin. */
function finishGhost(
  state: ModeState,
  started: number,
  race: GhostRaceState,
): ModeState {
  const finalMargin = race.yourMakes - race.finalGhostMakes;
  const result: 'win' | 'tie' | 'loss' =
    finalMargin > 0 ? 'win' : finalMargin < 0 ? 'loss' : 'tie';
  return {
    ...state,
    started,
    done: true,
    score: race.yourMakes,
    progress: 1,
    timeLeftSec: 0,
    ghost: {
      ...race,
      ghostMakesNow: race.finalGhostMakes,
      lead: finalMargin,
      result,
      finalMargin,
    },
    message:
      result === 'win'
        ? `Ghost beaten by ${finalMargin} — ${race.yourMakes} to ${race.finalGhostMakes}! 👻`
        : result === 'tie'
          ? `Dead heat — ${race.yourMakes} apiece.`
          : `Ghost wins by ${-finalMargin} — ${race.finalGhostMakes} to ${race.yourMakes}.`,
    messageTone: ghostTone(finalMargin),
  };
}

/**
 * Ghost Challenge: race your cumulative makes against the ghost's recorded
 * pace on one shared elapsed clock. The clock arms on YOUR first decided shot
 * (not on a tick — no time burns while you set up). A shot landing at or after
 * the ghost clock's expiry doesn't count and finalizes the race, mirroring the
 * timed mode's buzzer rule.
 */
function stepGhost(state: ModeState, shot: ResolvedShot, nowSec: number): ModeState {
  if (!isDecided(shot)) return state;
  const cfg = state.config?.ghost;
  const race = state.ghost;
  if (cfg == null || race == null || cfg.timeline.length === 0 || cfg.durationSec <= 0) {
    // Defensive — initMode's empty-ghost guard already marks these done.
    return { ...state, done: true };
  }
  const started = state.started ?? nowSec;
  const elapsed = nowSec - started;
  if (elapsed >= cfg.durationSec) return finishGhost(state, started, race);

  const yourMakes = race.yourMakes + (isMake(shot) ? 1 : 0);
  const ghostMakesNow = ghostMakesAt(cfg.timeline, elapsed);
  const lead = yourMakes - ghostMakesNow;
  return {
    ...state,
    started,
    score: yourMakes,
    progress: clamp01(elapsed / cfg.durationSec),
    timeLeftSec: Math.max(0, cfg.durationSec - elapsed),
    ghost: { ...race, yourMakes, ghostMakesNow, lead },
    message: ghostRaceMessage(yourMakes, ghostMakesNow),
    messageTone: ghostTone(lead),
  };
}

/**
 * Ghost clock tick. Unlike the timed mode, ticking never arms the clock — the
 * race waits for your first shot. Once armed, ticks advance the ghost's pace
 * (it can pull ahead between your shots) and finalize at the clock's expiry.
 */
function tickGhost(state: ModeState, nowSec: number): ModeState {
  const cfg = state.config?.ghost;
  const race = state.ghost;
  if (cfg == null || race == null || cfg.timeline.length === 0 || cfg.durationSec <= 0) {
    return state;
  }
  if (state.started === null) return state;
  const elapsed = nowSec - state.started;
  if (elapsed >= cfg.durationSec) return finishGhost(state, state.started, race);

  const ghostMakesNow = ghostMakesAt(cfg.timeline, elapsed);
  const lead = race.yourMakes - ghostMakesNow;
  const timeLeftSec = Math.max(0, cfg.durationSec - elapsed);
  // Identity stability: the live screen ticks at 4 Hz for the WHOLE race
  // (potentially 30-60 min for a long ghost session), and a fresh object per
  // tick re-renders the entire live screen 4×/sec. Nothing displayed changes
  // that fast — the banner shows the race score (ghostMakesNow / lead) and a
  // progress bar rounded to whole percents, which whole-second quantization
  // covers. Return the SAME object unless a displayed value actually moved;
  // the store's `next !== active` check then skips the setState entirely.
  if (
    ghostMakesNow === race.ghostMakesNow &&
    lead === race.lead &&
    Math.floor(timeLeftSec) === Math.floor(state.timeLeftSec ?? cfg.durationSec)
  ) {
    return state;
  }
  return {
    ...state,
    progress: clamp01(elapsed / cfg.durationSec),
    timeLeftSec,
    ghost: { ...race, ghostMakesNow, lead },
    message: ghostRaceMessage(race.yourMakes, ghostMakesNow),
    messageTone: ghostTone(lead),
  };
}

// ---------------------------------------------------------------------------
// tickMode
// ---------------------------------------------------------------------------

/**
 * Advance wall-clock for tick-driven modes (timed countdown, ghost race).
 * Pure; returns NEW state (or the same object when nothing changes). For all
 * other modes this is a no-op.
 *
 * Timed: the clock arms on the first tick (started := nowSec) so a mode picked
 * but not yet begun doesn't silently burn time. Ghost: the clock only arms on
 * the first shot (see {@link tickGhost}). Either way, when the clock expires
 * the mode is marked done.
 */
export function tickMode(state: ModeState, nowSec: number): ModeState {
  if (state.done) return state;
  if (state.modeId === 'ghost') return tickGhost(state, nowSec);
  if (state.modeId !== 'timed') return state;

  if (state.started === null) {
    // Arm the clock; keep the full duration on the board.
    return { ...state, started: nowSec };
  }

  const dur = state.config?.durationSec ?? TIMED_DEFAULT_SEC;
  const elapsed = nowSec - state.started;
  const timeLeftSec = Math.max(0, dur - elapsed);

  if (timeLeftSec <= 0) {
    return {
      ...state,
      done: true,
      timeLeftSec: 0,
      progress: 1,
      message: `Time! ${state.score} makes.`,
    };
  }

  // Identity stability (same rationale as tickGhost): everything the timed
  // HUD displays is quantized to whole seconds — the status line and the
  // TimerRing numeral both go through Math.ceil — so ticks landing inside
  // the same displayed second return the SAME object and cost zero renders.
  if (Math.ceil(timeLeftSec) === Math.ceil(state.timeLeftSec ?? dur)) {
    return state;
  }

  return {
    ...state,
    timeLeftSec,
    progress: clamp01(elapsed / dur),
    message: `${Math.ceil(timeLeftSec)}s · ${state.score} makes`,
  };
}

// ---------------------------------------------------------------------------
// shiftModeClock
// ---------------------------------------------------------------------------

/**
 * Shift an armed mode clock forward by `deltaSec` seconds — the "pause"
 * primitive for the tick-driven modes (timed countdown, ghost race).
 *
 * WHY: this module never reads the clock; `started` is a wall-clock instant
 * and elapsed = nowSec − started. A caller that merely stops ticking (e.g.
 * the live screen while the app is backgrounded) has NOT paused the game —
 * time keeps accruing unseen, and the first tick after resume drains the
 * whole gap at once (a phone call could silently end the race). Moving
 * `started` forward by the gap makes the pause real: on resume the clock
 * holds exactly where it left off, and the ghost's pace pauses with it.
 *
 * No-op (same object) for unarmed, finished, or non-clock modes and for a
 * non-positive delta.
 */
export function shiftModeClock(state: ModeState, deltaSec: number): ModeState {
  if (state.done || state.started === null) return state;
  if (state.modeId !== 'timed' && state.modeId !== 'ghost') return state;
  if (!(deltaSec > 0)) return state;
  return { ...state, started: state.started + deltaSec };
}
