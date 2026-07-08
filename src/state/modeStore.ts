/**
 * Active game-mode state (Zustand). Sits alongside {@link useSession}: the
 * session store owns the raw make/miss stream and cumulative stats, while this
 * store owns the currently selected {@link GameModeId} and its running
 * {@link ModeState} (score, spots, letters, clock).
 *
 * The screen wiring is:
 *   selectMode(id)      when the player picks a mode
 *   applyShot(shot)     from the same onShot path that feeds useSession.addShot
 *   tick(nowSec)        on a timer for timed modes (drives the countdown)
 *
 * All game logic lives in the pure functions in src/core/gameModes.ts; this
 * store is a thin, immutable wrapper over initMode/stepMode/tickMode.
 */
import { create } from 'zustand';

import { initDrillMode, type DrillId } from '../core/drills';
import {
  initMode,
  shiftModeClock,
  stepMode,
  tickMode,
  type InitModeOpts,
  type ModeState,
} from '../core/gameModes';
import type { GameModeId, ResolvedShot } from '../core/types';

export interface ModeStoreState {
  /** The running mode, or null when the player is in no game (e.g. free-form). */
  activeMode: ModeState | null;

  /** Start a fresh game of `id`. Replaces any running mode. */
  selectMode: (id: GameModeId, opts?: InitModeOpts) => void;
  /**
   * Start a fresh structured drill (src/core/drills.ts). A drill runs AS the
   * `spotShooting` mode with its progression on `config.drill`, so it flows
   * through the same banner/complete/history surfaces. Replaces any running
   * mode.
   */
  selectDrill: (id: DrillId) => void;
  /**
   * Fold a resolved shot into the active mode. No-op when no mode is active or
   * the game is already done. `nowSec` should be the shot's resolve time
   * (seconds, monotonic — same source the pipeline uses), defaulting to the
   * wall clock when the caller has no frame time handy.
   */
  applyShot: (shot: ResolvedShot, nowSec?: number) => void;
  /** Advance the clock for timed modes. No-op otherwise. */
  tick: (nowSec: number) => void;
  /**
   * Shift an armed Timed/Ghost clock forward by `deltaSec` — a REAL pause.
   * Called on foreground with the backgrounded duration so the wall-clock
   * `started` doesn't silently drain the game while the app was away (see
   * shiftModeClock in src/core/gameModes.ts). No-op for every other state.
   */
  shiftClock: (deltaSec: number) => void;
  /** Clear the active mode (back to free-form / no game). */
  reset: () => void;
}

/** Monotonic seconds fallback when a caller doesn't supply a frame time. */
function nowSecFallback(): number {
  return Date.now() / 1000;
}

export const useMode = create<ModeStoreState>((set, get) => ({
  activeMode: null,

  selectMode: (id, opts) => {
    set({ activeMode: initMode(id, opts) });
  },

  selectDrill: (id) => {
    set({ activeMode: initDrillMode(id) });
  },

  applyShot: (shot, nowSec) => {
    const active = get().activeMode;
    if (active === null || active.done) return;
    const t = nowSec ?? shot.tResolved ?? nowSecFallback();
    set({ activeMode: stepMode(active, shot, t) });
  },

  tick: (nowSec) => {
    const active = get().activeMode;
    if (active === null || active.done) return;
    const next = tickMode(active, nowSec);
    if (next !== active) set({ activeMode: next });
  },

  shiftClock: (deltaSec) => {
    const active = get().activeMode;
    if (active === null) return;
    const next = shiftModeClock(active, deltaSec);
    if (next !== active) set({ activeMode: next });
  },

  reset: () => set({ activeMode: null }),
}));
