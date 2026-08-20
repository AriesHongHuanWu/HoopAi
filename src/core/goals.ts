/**
 * Daily make-goal helpers — pure, deterministic, no I/O.
 *
 * The goal itself (a make count, 0 = off) lives in the settings store
 * (src/state/settingsStore.ts dailyGoalMakes). These helpers turn a list of
 * persisted session summaries (src/data/db.ts SessionSummaryRow) plus "now"
 * into "how many makes today" and a 0..1 progress fraction for the ring.
 */

/**
 * The slice of a session summary (see `SessionSummaryRow` in src/data/db.ts)
 * that {@link todayMakes} actually needs. `makes` is typed loosely
 * (nullable/optional) so hand-built test fixtures and any future defensive
 * callers don't need to fake the DB's non-null guarantee. A real
 * `SessionSummaryRow` satisfies this shape as-is.
 */
export interface GoalSummaryRow {
  /** Epoch ms. */
  startedAt: number;
  makes?: number | null;
  /** Session row id — lets {@link goalBaselineMakes} exclude the in-progress session. */
  id?: number;
}

/**
 * Sums `makes` across every session summary whose `startedAt` (epoch ms)
 * falls on the same LOCAL calendar day as `nowMs`. Sessions still in
 * progress (no `endedAt`) count too — a make already persisted is a make.
 *
 * Rows with a null/undefined `makes` (defensive — SessionSummaryRow always
 * carries it from the DB's COUNT/SUM query) contribute 0.
 */
export function todayMakes(
  summaries: readonly GoalSummaryRow[],
  nowMs: number,
): number {
  const now = new Date(nowMs);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  let total = 0;
  for (const row of summaries) {
    const started = new Date(row.startedAt);
    if (
      started.getFullYear() === y &&
      started.getMonth() === m &&
      started.getDate() === d
    ) {
      total += row.makes ?? 0;
    }
  }
  return total;
}

/**
 * {@link todayMakes} minus the in-progress session's already-persisted rows.
 *
 * WHY the exclusion is load-bearing: the live GoalChip shows
 * `baseline + live store makes`. The in-progress session persists each shot as
 * it resolves, so its DB summary row already contains those makes. GoalChip
 * mounts under `rimLocked`, which flips false→true again on a re-aim — on that
 * remount a fresh DB fetch would count the current session's makes twice (once
 * in the baseline, once in live `stats.makes`) unless its row is excluded here.
 *
 * `excludeSessionId == null` (session not persisted, or caller doesn't care)
 * degrades to plain {@link todayMakes}. Rows without an `id` are never
 * excluded. Pure, deterministic, no I/O — time comes from `nowMs` only.
 */
export function goalBaselineMakes(
  summaries: readonly GoalSummaryRow[],
  nowMs: number,
  excludeSessionId?: number,
): number {
  const rows = excludeSessionId == null
    ? summaries
    : summaries.filter((r) => r.id !== excludeSessionId);
  return todayMakes(rows, nowMs);
}

/**
 * Turns `made`/`goal` into a 0..1 progress fraction for {@link GoalRing}.
 * - `goal <= 0` (goal off, or a defensively-negative value) ⇒ 0, never
 *   NaN/Infinity from a divide-by-zero.
 * - Clamped to at most 1 — the ring fills but never overflows once the goal
 *   is hit; callers use `made >= goal` separately to detect the 100%+ state.
 * - `made` below 0 (shouldn't happen, but defensive) clamps to 0.
 */
export function goalProgress(made: number, goal: number): number {
  if (goal <= 0) return 0;
  const safeMade = Math.max(0, made);
  return Math.min(1, safeMade / goal);
}
