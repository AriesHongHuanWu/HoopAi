/**
 * Standalone two-team scoreboard state, persisted across launches via
 * expo-sqlite's key-value store (same pattern as settingsStore).
 *
 * This is a self-contained pickup-game counter — independent of the
 * camera/detection session store (src/state/sessionStore.ts). It does not
 * read or write anything from a tracked shooting session.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type ScoreboardTeam = 'home' | 'away';

const MIN_SCORE = 0;
/** Generous ceiling — guards the tabular-nums display from ever wrapping. */
const MAX_SCORE = 999;
const MIN_PERIOD = 1;
const MAX_PERIOD = 99;

export interface ScoreboardState {
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
  period: number;

  /** Add `delta` points (1, 2 or 3; negative for the minus correction) to a team, clamped to [0, 999]. */
  score: (team: ScoreboardTeam, delta: number) => void;
  /** Rename a team. Trimmed; empty names are allowed (UI falls back to a placeholder). */
  setName: (team: ScoreboardTeam, name: string) => void;
  /** Advance to the next period, clamped at 99. */
  nextPeriod: () => void;
  /** Swap home/away names and scores (Swap sides). */
  swapSides: () => void;
  /** Reset both scores and the period to a fresh game. Team names are kept. */
  reset: () => void;
}

const DEFAULT_HOME_NAME = 'Home';
const DEFAULT_AWAY_NAME = 'Away';

function clampScore(v: number): number {
  return Math.min(MAX_SCORE, Math.max(MIN_SCORE, v));
}

export const useScoreboard = create<ScoreboardState>()(
  persist(
    (set) => ({
      homeName: DEFAULT_HOME_NAME,
      awayName: DEFAULT_AWAY_NAME,
      homeScore: 0,
      awayScore: 0,
      period: 1,

      score: (team, delta) =>
        set((s) => {
          const key = team === 'home' ? 'homeScore' : 'awayScore';
          return { [key]: clampScore(s[key] + delta) } as Partial<ScoreboardState>;
        }),

      setName: (team, name) =>
        set(team === 'home' ? { homeName: name } : { awayName: name }),

      nextPeriod: () =>
        set((s) => ({ period: Math.min(MAX_PERIOD, s.period + 1) })),

      swapSides: () =>
        set((s) => ({
          homeName: s.awayName,
          awayName: s.homeName,
          homeScore: s.awayScore,
          awayScore: s.homeScore,
        })),

      reset: () =>
        set({
          homeScore: 0,
          awayScore: 0,
          period: MIN_PERIOD,
        }),
    }),
    {
      name: 'hoopai-scoreboard',
      storage: createJSONStorage(() => Storage),
      partialize: ({ score: _score, setName: _setName, nextPeriod: _nextPeriod, swapSides: _swapSides, reset: _reset, ...rest }) =>
        rest,
      // See settingsStore.ts for the rationale on starting persisted schema
      // versioning at 1 rather than leaving it unset.
      version: 1,
      migrate: (persisted) => persisted as ScoreboardState,
    },
  ),
);
