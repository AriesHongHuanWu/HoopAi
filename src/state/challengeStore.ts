/**
 * Daily-challenge ledger, persisted across launches via expo-sqlite's
 * key-value store (same pattern as settingsStore / scoreboardStore).
 *
 * The store is deliberately tiny: which day the completions belong to, which
 * challenge ids completed that day, and a lifetime points total. Challenge
 * selection and progress math are pure (src/core/dailyChallenges.ts); Home
 * recomputes progress from today's persisted sessions on focus and calls
 * {@link ChallengeState.award} for anything newly complete — awards are
 * idempotent per (day, id), so refocusing never double-counts.
 *
 * Day rollover: completedIds belong to `dateKey` only. When a caller passes
 * a different day (local midnight passed), the completed set resets and the
 * points total carries on accumulating — it is a career ledger, not a daily
 * one.
 */
import Storage from 'expo-sqlite/kv-store';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import {
  dayAggregate,
  isSameLocalDay,
  type DayAggregate,
  type DaySessionFacts,
} from '../core/dailyChallenges';
import { listSessions, sessionShots } from '../data/db';

/**
 * Sessions scanned when rebuilding today's aggregate — generous for the same
 * reason as Home's GOAL_SCAN_LIMIT: a heavy day of many short sessions must
 * still count every shot.
 */
const DAY_SCAN_LIMIT = 100;

export interface ChallengeState {
  /** Local day ('YYYY-MM-DD') the completed set belongs to. */
  dateKey: string;
  /** Challenge ids (plus the perfect-day pseudo-id) completed on dateKey. */
  completedIds: string[];
  /** Lifetime points ledger — accumulates across days, never resets. */
  totalPoints: number;

  /**
   * Reset the completed set when the stored day is not `dateKey` (local
   * midnight rollover). No-op on the same day. Call on focus before reading
   * completedIds.
   */
  ensureDay: (dateKey: string) => void;
  /**
   * Record a completion and bank its points. Idempotent per (dateKey, id):
   * an id already completed today is a no-op, so recomputing progress on
   * every focus can call this freely. Passing a new dateKey rolls the
   * completed set over first (same as {@link ensureDay}).
   */
  award: (dateKey: string, id: string, points: number) => void;
}

export const useChallenges = create<ChallengeState>()(
  persist(
    (set) => ({
      dateKey: '',
      completedIds: [],
      totalPoints: 0,

      ensureDay: (dateKey) =>
        set((s) =>
          s.dateKey === dateKey ? s : { dateKey, completedIds: [] },
        ),

      award: (dateKey, id, points) =>
        set((s) => {
          const sameDay = s.dateKey === dateKey;
          const completed = sameDay ? s.completedIds : [];
          if (completed.includes(id)) return s;
          return {
            dateKey,
            completedIds: [...completed, id],
            totalPoints: s.totalPoints + Math.max(0, points),
          };
        }),
    }),
    {
      name: 'hoopai-challenges',
      storage: createJSONStorage(() => Storage),
      partialize: ({ ensureDay: _ensureDay, award: _award, ...rest }) => rest,
      // See settingsStore.ts for the rationale on starting persisted schema
      // versioning at 1 rather than leaving it unset.
      version: 1,
      migrate: (persisted) => persisted as ChallengeState,
    },
  ),
);

/**
 * Rebuild today's {@link DayAggregate} from the persisted sessions: pull
 * recent session summaries (src/data/db.ts listSessions), keep the ones whose
 * startedAt falls on the same local day as `nowMs` (the todayMakes windowing
 * from src/core/goals.ts), fetch each one's shots and fold them with the pure
 * aggregator. Never throws — db reads already return safe fallbacks, so the
 * worst case is an empty aggregate.
 */
export async function loadTodayAggregate(nowMs = Date.now()): Promise<DayAggregate> {
  const sessions = await listSessions(DAY_SCAN_LIMIT);
  const today = sessions.filter((row) => isSameLocalDay(row.startedAt, nowMs));
  const facts: DaySessionFacts[] = await Promise.all(
    today.map(async (row) => ({
      modeId: row.modeId,
      shots: (await sessionShots(row.id)).map((shot) => ({
        outcome: shot.outcome,
        shotValue: shot.shotValue,
      })),
    })),
  );
  return dayAggregate(facts);
}
