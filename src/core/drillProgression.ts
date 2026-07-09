/**
 * Drill progression — levels layered on the drill catalog WITHOUT touching
 * drills.ts or persistence.
 *
 * A drill "level" is nothing but scaled goals (and, where the drill has one, a
 * proportionally scaled attempt cap). Both already live per-instance inside
 * `DrillState` (which History persists inside modeResultJson), so a leveled
 * drill is a byte-ordinary `spotShooting` ModeState: stepDrill, ModeBanner,
 * SpotTracker, ModeComplete and History persistence all work untouched, and no
 * new field is ever persisted. The level a past run was played at is INFERRED
 * from its persisted goals ({@link levelOfGoals}) rather than stored.
 *
 * All functions are pure: no clock, no I/O, inputs never mutated.
 */
import { DRILLS, getDrill, initDrillMode, type Drill, type DrillId, type DrillState } from './drills';
import type { ModeState } from './gameModes';

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export type DrillLevel = 1 | 2 | 3;

export const LEVEL_LABEL: Record<DrillLevel, string> = { 1: 'Starter', 2: 'Regular', 3: 'Advanced' };

/** Goal multiplier per level (L1 is the catalog verbatim). */
const LEVEL_FACTOR: Record<DrillLevel, number> = { 1: 1, 2: 1.5, 3: 2 };

/** The goals (and optional attempt cap) a drill demands at a given level. */
export interface LevelGoals {
  goals: number[];
  attemptCap?: number;
}

/**
 * Level-scaled goals for a drill. L1 = catalog goals verbatim (+ catalog
 * attemptCap); L2 = ceil(goal × 1.5); L3 = goal × 2. An attempt cap scales by
 * the TOTAL-goals ratio so the make-rate the drill demands stays constant
 * (catchShoot10: 10-in-15 → 15-in-23 → 20-in-30).
 */
export function levelGoals(id: DrillId, level: DrillLevel): LevelGoals {
  const drill = getDrill(id);
  const base = drill.spots.map((s) => s.goal);
  if (level === 1) {
    return { goals: base, ...(drill.attemptCap != null ? { attemptCap: drill.attemptCap } : {}) };
  }
  const factor = LEVEL_FACTOR[level];
  const goals = base.map((g) => Math.ceil(g * factor));
  if (drill.attemptCap == null) return { goals };
  const baseTotal = base.reduce((a, g) => a + g, 0);
  const total = goals.reduce((a, g) => a + g, 0);
  return { goals, attemptCap: Math.ceil((drill.attemptCap * total) / baseTotal) };
}

/**
 * Infer the level a persisted goals array was played at by exact match against
 * {@link levelGoals}, checking 3 → 2 → 1 (first match wins). Two consequences,
 * both deliberate:
 *   - Where two levels demand identical goals (aroundKey: ceil(1×1.5) = 1×2 =
 *     2), the HIGHER level wins — the work done was identical, so credit the
 *     harder read.
 *   - No match → 1: safe degradation for any future catalog goal change (an
 *     old run whose goals no longer map anywhere just counts as Starter).
 */
export function levelOfGoals(id: DrillId, goals: readonly number[]): DrillLevel {
  for (const level of [3, 2, 1] as const) {
    const lg = levelGoals(id, level).goals;
    if (lg.length === goals.length && lg.every((g, i) => g === goals[i])) return level;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Level-scaled init — still a plain spotShooting ModeState
// ---------------------------------------------------------------------------

/**
 * {@link initDrillMode} with the goals/attemptCap patched to the level (and
 * the opening message re-derived from the scaled first goal). L1 returns the
 * plain init untouched. The result is indistinguishable from any other drill
 * state to the rest of the app.
 */
export function initDrillModeAtLevel(id: DrillId, level: DrillLevel): ModeState {
  const base = initDrillMode(id);
  if (level === 1) return base;
  const lg = levelGoals(id, level);
  const drill: DrillState = {
    ...base.config!.drill!,
    goals: lg.goals,
    ...(lg.attemptCap != null ? { attemptCap: lg.attemptCap } : {}),
  };
  return {
    ...base,
    config: { ...base.config, drill },
    message: `${lg.goals[0]} at ${getDrill(id).spots[0].label}.`,
  };
}

// ---------------------------------------------------------------------------
// History parsing — DrillResult from a persisted modeResultJson blob
// ---------------------------------------------------------------------------

/** One finished drill run, recovered from history. */
export interface DrillResult {
  drillId: DrillId;
  startedAt: number;
  cleared: boolean;
  makes: number;
  attempts: number;
  level: DrillLevel;
}

function isDrillId(id: unknown): id is DrillId {
  return typeof id === 'string' && DRILLS.some((d) => d.id === id);
}

/**
 * Tolerantly parse a persisted modeResultJson value (already JSON.parse'd by
 * the caller, hence `unknown`) into a {@link DrillResult}. Returns null unless
 * the blob is a FINISHED spotShooting state carrying a known drill with a
 * numeric goals array — any shape violation (malformed, ghost-stripped, future
 * schema) yields null rather than a throw, so one bad history row can never
 * take down an aggregate.
 */
export function drillResultFromModeState(state: unknown, startedAt: number): DrillResult | null {
  try {
    if (typeof state !== 'object' || state === null) return null;
    const s = state as Record<string, unknown>;
    if (s.modeId !== 'spotShooting' || s.done !== true) return null;
    const config = s.config;
    if (typeof config !== 'object' || config === null) return null;
    const drill = (config as Record<string, unknown>).drill;
    if (typeof drill !== 'object' || drill === null) return null;
    const d = drill as Record<string, unknown>;
    if (!isDrillId(d.id)) return null;
    const goals = d.goals;
    if (!Array.isArray(goals) || !goals.every((g) => typeof g === 'number')) return null;

    const spots: unknown[] = Array.isArray(s.spots) ? s.spots : [];
    const makesOf = (sp: unknown): number | null => {
      const m = (sp as { makes?: unknown } | null)?.makes;
      return typeof m === 'number' ? m : null;
    };
    const attemptsOf = (sp: unknown): number => {
      const a = (sp as { attempts?: unknown } | null)?.attempts;
      return typeof a === 'number' ? a : 0;
    };

    const makes = spots.reduce<number>((acc, sp) => acc + (makesOf(sp) ?? 0), 0);
    const attempts =
      typeof d.attempts === 'number'
        ? d.attempts
        : spots.reduce<number>((acc, sp) => acc + attemptsOf(sp), 0);
    const cleared =
      spots.length === goals.length &&
      spots.every((sp, i) => {
        const m = makesOf(sp);
        return m !== null && m >= (goals[i] ?? 1);
      });

    return {
      drillId: d.id,
      startedAt,
      cleared,
      makes,
      attempts,
      level: levelOfGoals(d.id, goals),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Promotion ladder + prescription copy
// ---------------------------------------------------------------------------

/**
 * The level a player has earned for a drill: 1→2 after two clears, 2→3 after
 * two clears at L2 or above. Pure counting — order-independent, monotonic,
 * never regresses (a later non-clear can't take a level back).
 */
export function levelForDrill(results: readonly DrillResult[]): DrillLevel {
  const clearsL1 = results.filter((r) => r.cleared && r.level >= 1).length;
  const clearsL2 = results.filter((r) => r.cleared && r.level >= 2).length;
  return clearsL2 >= 2 ? 3 : clearsL1 >= 2 ? 2 : 1;
}

/** Plan-card copy for a drill at the player's current level. */
export function drillPrescription(id: DrillId, level: DrillLevel, results: readonly DrillResult[]): string {
  const drill: Drill = getDrill(id);
  const first = drill.spots[0];
  const g = levelGoals(id, level).goals[0];
  const clears = results.filter((r) => r.cleared).length;
  if (level === 1) {
    return clears === 0
      ? `Start at Starter: ${drill.tagline} Clear it twice to unlock Level 2.`
      : `One clear down — clear ${drill.title} once more to unlock Level 2.`;
  }
  if (level === 2) {
    return `Level 2 unlocked: ${g} at ${first.label} now. Two Level-2 clears open Advanced.`;
  }
  return `Advanced: ${g} at ${first.label}. This is game-weight volume — hold your form on the last rep like the first.`;
}
