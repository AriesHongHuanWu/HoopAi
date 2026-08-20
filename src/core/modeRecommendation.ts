/**
 * Mode recommendation — a pure, deterministic recommender over recent session
 * rows, feeding the Train tab's Quick-start hero.
 *
 * INPUT: the SAME `listSessions(50)` rows the ghost picker already fetches
 * eagerly on tab mount — zero new queries, zero db changes. The input type is
 * structural (no import from src/data) so `SessionSummaryRow` satisfies it.
 *
 * ALGORITHM
 * ---------
 * 1. Window: keep rows with startedAt in [nowMs - 14d, nowMs + 1h] (inclusive;
 *    the 1h future tolerance absorbs clock skew — anything further in the
 *    future is skipped).
 * 2. Skip rows whose modeId is null (pre-v4 / plain free play), 'free' (the
 *    default — recommending it is noise), 'ghost' (cannot be one-tap armed; it
 *    needs a source-run pick), or not in GAME_MODES (forward-compat with rows
 *    written by a newer app version).
 * 3. Classify: a row with modeId 'spotShooting' whose modeResultJson parses
 *    (JSON.parse in try/catch) to an object whose config?.drill?.id is a
 *    string matching a DRILLS id counts as that DRILL (`drill:<id>`); its
 *    goals are captured when config.drill.goals is an array of finite numbers
 *    (else null). Every other kept row counts as its MODE (`mode:<modeId>`).
 *    modeResultJson is parsed ONLY for spotShooting rows (other blobs are
 *    never parsed). Real Spot Shooting never sets config.drill (engine
 *    invariant — see drills.ts), so classification is exact.
 * 4. Score per key: sum of 0.5 ** (ageDays / RECO_HALF_LIFE_DAYS) where
 *    ageDays = max(0, nowMs - startedAt) / 86_400_000 — recency-weighted
 *    frequency with a 7-day half-life. Also tracked: playCount (raw count in
 *    window), lastPlayedAt (max startedAt), and for drills the goals of the
 *    MOST RECENT run.
 * 5. Winner: highest score; ties → later lastPlayedAt; still tied → earlier
 *    catalog position (GAME_MODES order for modes, DRILLS order for drills;
 *    a mode ties before a drill — deterministic, arbitrary, documented).
 * 6. Return null unless the winner's playCount >= RECO_MIN_PLAYS.
 *
 * HONESTY (iron rule 8): {@link recommendationReason} is an exact db-derived
 * count — the UI must render it as-is and never dress it up with invented
 * stats or fake precision.
 *
 * Pure TS: no React, no I/O, no clock reads (nowMs is a parameter — the same
 * determinism invariant as gameModes.ts). Never throws on bad input.
 */
import { DRILLS, type DrillId } from './drills';
import { GAME_MODES } from './gameModes';
import type { GameModeId } from './types';

/** Structural subset of a session row (SessionSummaryRow satisfies this). */
export interface RecommendationInputRow {
  /** Epoch ms. */
  startedAt: number;
  /** sessions.modeId (null = pre-v4 / plain free play). */
  modeId: string | null;
  /** Final ModeState snapshot; drill runs carry config.drill. */
  modeResultJson: string | null;
}

export type ModeRecommendation =
  | { kind: 'mode'; modeId: GameModeId; playCount: number; lastPlayedAt: number }
  | {
      kind: 'drill';
      drillId: DrillId;
      goals: readonly number[] | null;
      playCount: number;
      lastPlayedAt: number;
    };

/** Recency window: only sessions in the last 14 days count. */
export const RECO_WINDOW_DAYS = 14;
/** Minimum plays inside the window before anything is recommended. */
export const RECO_MIN_PLAYS = 2;
/** A play's score weight halves every 7 days. */
export const RECO_HALF_LIFE_DAYS = 7;

const DAY_MS = 86_400_000;
/** Future tolerance for clock skew — rows beyond nowMs + 1h are skipped. */
const FUTURE_TOLERANCE_MS = 3_600_000;

/** Per-key accumulator while folding rows. */
interface Bucket {
  reco: ModeRecommendation;
  score: number;
  /** Catalog index for the deterministic final tie-break. */
  catalogIndex: number;
  /** startedAt of the run whose goals are currently captured (drills only). */
  goalsAt: number;
}

/** config.drill.goals must be an array of finite numbers to be trusted. */
function parseGoals(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  for (const g of value) {
    if (typeof g !== 'number' || !Number.isFinite(g)) return null;
  }
  return value as readonly number[];
}

/** Drill classification for a spotShooting row; null = plain Spot Shooting. */
function classifyDrill(
  modeResultJson: unknown,
): { drillId: DrillId; goals: readonly number[] | null } | null {
  if (typeof modeResultJson !== 'string') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(modeResultJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const config = (parsed as { config?: unknown }).config;
  if (typeof config !== 'object' || config === null) return null;
  const drill = (config as { drill?: unknown }).drill;
  if (typeof drill !== 'object' || drill === null) return null;
  const id = (drill as { id?: unknown }).id;
  if (typeof id !== 'string') return null;
  if (!DRILLS.some((d) => d.id === id)) return null;
  return {
    drillId: id as DrillId,
    goals: parseGoals((drill as { goals?: unknown }).goals),
  };
}

/**
 * Pick the strongest recent mode/drill from session rows, or null when
 * nothing was played at least {@link RECO_MIN_PLAYS} times in the window.
 * Pure and deterministic; never throws on malformed rows.
 */
export function recommendFromSessions(
  rows: readonly RecommendationInputRow[],
  nowMs: number,
): ModeRecommendation | null {
  if (!Number.isFinite(nowMs)) return null;
  const windowStart = nowMs - RECO_WINDOW_DAYS * DAY_MS;
  const windowEnd = nowMs + FUTURE_TOLERANCE_MS;
  const buckets = new Map<string, Bucket>();

  for (const raw of rows ?? []) {
    // Defensive re-widening: never throw even if a caller hands us junk rows.
    const row = raw as Partial<RecommendationInputRow> | null | undefined;
    if (row == null) continue;
    const startedAt = row.startedAt;
    // NaN / non-finite startedAt fails both comparisons and is skipped.
    if (!(typeof startedAt === 'number' && startedAt >= windowStart && startedAt <= windowEnd)) {
      continue;
    }
    const modeId = row.modeId;
    if (modeId == null || modeId === 'free' || modeId === 'ghost') continue;
    const catalogIndex = GAME_MODES.findIndex((m) => m.id === modeId);
    if (catalogIndex < 0) continue; // Unknown mode id (forward-compat).

    // Classify as drill or mode. Parse modeResultJson ONLY for spotShooting.
    let key: string;
    let make: () => Bucket;
    const drillInfo = modeId === 'spotShooting' ? classifyDrill(row.modeResultJson) : null;
    if (drillInfo !== null) {
      key = `drill:${drillInfo.drillId}`;
      make = () => ({
        reco: {
          kind: 'drill',
          drillId: drillInfo.drillId,
          goals: drillInfo.goals,
          playCount: 0,
          lastPlayedAt: startedAt,
        },
        score: 0,
        catalogIndex: DRILLS.findIndex((d) => d.id === drillInfo.drillId),
        goalsAt: startedAt,
      });
    } else {
      key = `mode:${modeId}`;
      make = () => ({
        reco: {
          kind: 'mode',
          modeId: modeId as GameModeId,
          playCount: 0,
          lastPlayedAt: startedAt,
        },
        score: 0,
        catalogIndex,
        goalsAt: startedAt,
      });
    }

    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = make();
      buckets.set(key, bucket);
    }
    const ageDays = Math.max(0, nowMs - startedAt) / DAY_MS;
    bucket.score += 0.5 ** (ageDays / RECO_HALF_LIFE_DAYS);
    bucket.reco = {
      ...bucket.reco,
      playCount: bucket.reco.playCount + 1,
      lastPlayedAt: Math.max(bucket.reco.lastPlayedAt, startedAt),
    };
    // Drills: keep the goals of the MOST RECENT run.
    if (bucket.reco.kind === 'drill' && drillInfo !== null && startedAt >= bucket.goalsAt) {
      bucket.reco = { ...bucket.reco, goals: drillInfo.goals };
      bucket.goalsAt = startedAt;
    }
  }

  let winner: Bucket | null = null;
  for (const bucket of buckets.values()) {
    if (winner === null || beats(bucket, winner)) winner = bucket;
  }
  if (winner === null || winner.reco.playCount < RECO_MIN_PLAYS) return null;
  return winner.reco;
}

/** Deterministic ordering: score desc → lastPlayedAt desc → mode before drill → catalog order. */
function beats(a: Bucket, b: Bucket): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.reco.lastPlayedAt !== b.reco.lastPlayedAt) {
    return a.reco.lastPlayedAt > b.reco.lastPlayedAt;
  }
  if (a.reco.kind !== b.reco.kind) return a.reco.kind === 'mode';
  return a.catalogIndex < b.catalogIndex;
}

/**
 * The hero's reason line — an EXACT db-derived count (iron rule 8: the UI
 * must never dress this up with invented stats).
 */
export function recommendationReason(reco: ModeRecommendation): string {
  return `Played ${reco.playCount}× in the last 2 weeks`;
}
