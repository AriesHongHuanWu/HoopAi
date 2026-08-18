/**
 * Challenge ledger (daily + weekly), persisted across launches via
 * expo-sqlite's key-value store (same pattern as settingsStore /
 * scoreboardStore).
 *
 * The store is deliberately tiny: which day the daily completions belong to,
 * which ISO week the weekly completions belong to, the ids completed in each
 * period, and ONE lifetime points total both feed. Challenge selection and
 * progress math are pure (src/core/dailyChallenges.ts,
 * src/core/weeklyChallenges.ts); Home recomputes progress from persisted
 * sessions on focus and calls {@link ChallengeState.award} /
 * {@link ChallengeState.awardWeekly} for anything newly complete — awards are
 * idempotent per (period, id), so refocusing never double-counts.
 *
 * WHY two ledgers and not one: the periods roll over on different clocks.
 * Local midnight must clear the daily set while leaving a half-finished week
 * untouched, and Monday 00:00 must clear the weekly set mid-day without
 * wiping today's daily progress. One shared set would make either rollover
 * destroy the other period's work. The points total is the part that IS
 * shared — it is a career ledger, not a period one, so it never resets.
 *
 * Weekly ids carry a 'w-' prefix (src/core/weeklyChallenges.ts) and therefore
 * can never be confused with a daily id even though both bank into the same
 * total.
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
import {
  prevWeekStartMs,
  weekAggregate,
  weekEndMs,
  weekStartMs,
  type WeekAggregate,
  type WeekSessionFacts,
} from '../core/weeklyChallenges';
import { listSessions, sessionShotOutcomes, type SessionSummaryRow } from '../data/db';

/**
 * Sessions scanned when rebuilding today's aggregate — generous for the same
 * reason as Home's GOAL_SCAN_LIMIT: a heavy day of many short sessions must
 * still count every shot.
 */
const DAY_SCAN_LIMIT = 100;

/**
 * Sessions scanned when rebuilding the week aggregate. Bigger than
 * DAY_SCAN_LIMIT because this scan has to reach back through TWO weeks (the
 * current one plus last week's FG% baseline) of a heavy shooter's history
 * before the newest-first page runs out — undershooting would silently
 * under-count a real week, which is worse than one larger indexed read.
 */
const WEEK_SCAN_LIMIT = 300;

export interface ChallengeState {
  /** Local day ('YYYY-MM-DD') the completed set belongs to. */
  dateKey: string;
  /** Challenge ids (plus the perfect-day pseudo-id) completed on dateKey. */
  completedIds: string[];
  /** Local ISO week ('YYYY-Www') the weekly completed set belongs to. */
  weekKey: string;
  /** Weekly challenge ids completed in weekKey. */
  completedWeeklyIds: string[];
  /** Lifetime points ledger — daily AND weekly, never resets. */
  totalPoints: number;

  /**
   * Reset the completed set when the stored day is not `dateKey` (local
   * midnight rollover). No-op on the same day. Call on focus before reading
   * completedIds.
   */
  ensureDay: (dateKey: string) => void;
  /**
   * Weekly twin of {@link ensureDay}: reset the weekly completed set when the
   * stored ISO week is not `weekKey` (Monday 00:00 rollover). Deliberately
   * leaves the daily ledger alone — see the module docblock.
   */
  ensureWeek: (weekKey: string) => void;
  /**
   * Record a completion and bank its points. Idempotent per (dateKey, id):
   * an id already completed today is a no-op, so recomputing progress on
   * every focus can call this freely. Passing a new dateKey rolls the
   * completed set over first (same as {@link ensureDay}).
   */
  award: (dateKey: string, id: string, points: number) => void;
  /**
   * Weekly twin of {@link award} — the same idempotence rule ({@link bankId}),
   * the same career points total, a different period key and completed set.
   */
  awardWeekly: (weekKey: string, id: string, points: number) => void;
}

/**
 * The ONE idempotent award rule, shared by both ledgers so day and week can
 * never drift apart. Returns the new completed set, or null when nothing
 * should change because this period already banked the id (the caller then
 * hands zustand the untouched state: no re-render, no double points).
 * Rollover is implicit — a stored key that is not the caller's key means the
 * period moved on, so the set starts empty.
 */
function bankId(
  storedKey: string,
  storedIds: readonly string[],
  key: string,
  id: string,
): string[] | null {
  const ids = storedKey === key ? storedIds : [];
  if (ids.includes(id)) return null;
  return [...ids, id];
}

export const useChallenges = create<ChallengeState>()(
  persist(
    (set) => ({
      dateKey: '',
      completedIds: [],
      weekKey: '',
      completedWeeklyIds: [],
      totalPoints: 0,

      ensureDay: (dateKey) =>
        set((s) => (s.dateKey === dateKey ? s : { dateKey, completedIds: [] })),

      ensureWeek: (weekKey) =>
        set((s) => (s.weekKey === weekKey ? s : { weekKey, completedWeeklyIds: [] })),

      award: (dateKey, id, points) =>
        set((s) => {
          const completedIds = bankId(s.dateKey, s.completedIds, dateKey, id);
          if (completedIds === null) return s;
          return { dateKey, completedIds, totalPoints: s.totalPoints + Math.max(0, points) };
        }),

      awardWeekly: (weekKey, id, points) =>
        set((s) => {
          const completedWeeklyIds = bankId(s.weekKey, s.completedWeeklyIds, weekKey, id);
          if (completedWeeklyIds === null) return s;
          return {
            weekKey,
            completedWeeklyIds,
            totalPoints: s.totalPoints + Math.max(0, points),
          };
        }),
    }),
    {
      name: 'hoopai-challenges',
      storage: createJSONStorage(() => Storage),
      partialize: ({
        ensureDay: _ensureDay,
        ensureWeek: _ensureWeek,
        award: _award,
        awardWeekly: _awardWeekly,
        ...rest
      }) => rest,
      // See settingsStore.ts for the rationale on starting persisted schema
      // versioning at 1 rather than leaving it unset.
      version: 2,
      migrate: (persisted, version) => {
        const s = persisted as ChallengeState;
        // v2: the weekly ledger lands beside the daily one. v1 payloads carry
        // neither weekly key, and zustand's shallow rehydrate would leave them
        // undefined forever — completedWeeklyIds.includes() would then throw
        // on the first weekly award. Backfill an empty, un-owned week: nothing
        // is lost, because no weekly challenge existed before this version.
        if (version < 2) {
          s.weekKey = '';
          s.completedWeeklyIds = [];
        }
        return s;
      },
    },
  ),
);

/**
 * Rebuild today's {@link DayAggregate} from the persisted sessions: pull
 * recent session summaries (src/data/db.ts listSessions), keep the ones whose
 * startedAt falls on the same local day as `nowMs` (the todayMakes windowing
 * from src/core/goals.ts), fetch each one's outcome stream and fold it with
 * the pure aggregator. Uses the NARROW sessionShotOutcomes reader on purpose:
 * this runs on EVERY Home focus across every today-session, and the full
 * sessionShots SELECT * would drag each shot's multi-KB trajectoryJson /
 * formJson blobs along for numbers that only need outcome + shotValue.
 * Never throws — db reads already return safe fallbacks, so the worst case
 * is an empty aggregate.
 */
export async function loadTodayAggregate(nowMs = Date.now()): Promise<DayAggregate> {
  const sessions = await listSessions(DAY_SCAN_LIMIT);
  const today = sessions.filter((row) => isSameLocalDay(row.startedAt, nowMs));
  const facts: DaySessionFacts[] = await Promise.all(
    today.map(async (row) => ({
      modeId: row.modeId,
      shots: await sessionShotOutcomes(row.id),
    })),
  );
  return dayAggregate(facts);
}

/** Narrow outcome streams for one window's sessions, fetched in parallel. */
function weekFactsFor(rows: readonly SessionSummaryRow[]): Promise<WeekSessionFacts[]> {
  return Promise.all(
    rows.map(async (row) => ({
      startedAt: row.startedAt,
      shots: await sessionShotOutcomes(row.id),
    })),
  );
}

/**
 * Rebuild this ISO week's {@link WeekAggregate} — the weekly twin of
 * {@link loadTodayAggregate}: same narrow-read discipline, windowed with
 * weekStartMs/weekEndMs (half-open, so consecutive weeks tile) instead of the
 * local-day check.
 *
 * Last week's sessions are folded too, purely to supply the FG% baseline the
 * 'beatLastWeek' goal needs. It goes through the SAME aggregator so both
 * percentages are computed identically (decided shots only, 'unsure'
 * excluded); a week with no decided shot folds to null, which the evaluator
 * reports as "no previous week on record yet" rather than as a beatable 0%.
 *
 * HONESTY — `spotsMeasured: false`: sessionShotOutcomes selects outcome and
 * shotValue only, so these rows genuinely carry no court placement. Reporting
 * distinctSpots as UNMEASURED (undefined) makes the evaluator attach its
 * "court position was not recorded" note, instead of showing a court-coverage
 * bar frozen at 0 that reads as a lazy week. Long-range makes ARE measurable
 * here — shotValue rides along in the same narrow read — so that one stays on.
 *
 * Never throws: db reads return safe fallbacks, worst case an empty week.
 */
export async function loadWeekAggregate(nowMs = Date.now()): Promise<WeekAggregate> {
  const sessions = await listSessions(WEEK_SCAN_LIMIT);
  const start = weekStartMs(nowMs);
  const end = weekEndMs(nowMs);
  const prevStart = prevWeekStartMs(nowMs);
  const inWindow = (from: number, to: number) =>
    sessions.filter((row) => row.startedAt >= from && row.startedAt < to);

  const [thisWeek, lastWeek] = await Promise.all([
    weekFactsFor(inWindow(start, end)),
    weekFactsFor(inWindow(prevStart, start)),
  ]);

  const prevWeekFgPct = weekAggregate(lastWeek, { spotsMeasured: false }).fgPct;
  return weekAggregate(thisWeek, { spotsMeasured: false, prevWeekFgPct });
}
