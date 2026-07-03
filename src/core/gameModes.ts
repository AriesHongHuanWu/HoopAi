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
import type { GameModeId, ResolvedShot, ShotValue } from './types';

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
];

/** Lookup a mode definition by id. Throws on an unknown id (programmer error). */
export function getModeDef(id: GameModeId): GameModeDef {
  const def = GAME_MODES.find((m) => m.id === id);
  if (def === undefined) throw new Error(`Unknown game mode: ${id}`);
  return def;
}

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
   * durationSec for timed, makesPerSpot for spot shooting, bestStreak for
   * ftStreak's running best.
   */
  config?: {
    durationSec?: number;
    makesPerSpot?: number;
  };
  /** ftStreak: best consecutive-make run so far. */
  bestStreak?: number;
}

/** Options accepted by {@link initMode}. All optional with sane defaults. */
export interface InitModeOpts {
  /** Timed-mode duration, seconds (default 60). */
  durationSec?: number;
  /** Spot Shooting: makes required per spot (default 5). */
  makesPerSpot?: number;
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

// ---------------------------------------------------------------------------
// tickMode
// ---------------------------------------------------------------------------

/**
 * Advance wall-clock for timed modes. Pure; returns NEW state (or the same
 * object when nothing changes). For non-timed modes this is a no-op.
 *
 * The clock arms on the first tick (started := nowSec) so a mode picked but not
 * yet begun doesn't silently burn time. When the countdown reaches 0 the mode
 * is marked done.
 */
export function tickMode(state: ModeState, nowSec: number): ModeState {
  if (state.modeId !== 'timed' || state.done) return state;

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

  return {
    ...state,
    timeLeftSec,
    progress: clamp01(elapsed / dur),
    message: `${Math.ceil(timeLeftSec)}s · ${state.score} makes`,
  };
}
