/**
 * Shot heat-map engine — the "where do I cook / where do I need work" court map.
 *
 * Pure + deterministic: buckets decided shots into a 3×3 grid (left/center/
 * right × near/mid/far) and reports make%, volume, and the hot/cold spots. One
 * engine powers the Trends heat map, the session court map, and the Records
 * zone board. Unusure shots are excluded (they never count for or against FG%),
 * matching the rest of the app. No camera, no UI — just numbers a screen renders.
 */
import { DEFAULT_3PT_RIMWIDTHS } from './config';
import { zoneOf } from './stats';
import type { ChartZone, ResolvedShot } from './types';

/** Horizontal court zone (reuses the app-wide left/center/right split). */
export type HeatZone = ChartZone;
/** Distance band from the rim. */
export type HeatBand = 'near' | 'mid' | 'far';

export interface HeatCell {
  zone: HeatZone;
  band: HeatBand;
  makes: number;
  /** Decided (make|miss) attempts in this cell. */
  attempts: number;
  /** makes / attempts, 0..1; 0 when the cell is empty. */
  fgPct: number;
}

export interface Heatmap {
  /** All 9 cells, always present (attempts 0 when empty), row-major
   *  left→right, near→far. */
  cells: HeatCell[];
  totalMakes: number;
  totalAttempts: number;
  /** Placed shots that couldn't be bucketed (missing origin or distance). */
  unplaced: number;
  /** Hottest cell with at least the min attempts, or null. */
  best: HeatCell | null;
  /** Coldest cell with at least the min attempts, or null. */
  worst: HeatCell | null;
}

/** Below this many rim widths from the rim is the "near" (paint/close) band. */
const BAND_NEAR_MAX_RIMWIDTHS = 4.5;
/** At/above this (the 3-point line) is the "far" band. */
const BAND_FAR_MIN_RIMWIDTHS = DEFAULT_3PT_RIMWIDTHS;
/** A cell needs this many attempts before it's ranked hot/cold (kills 1/1 noise). */
export const HEATMAP_MIN_CELL_ATTEMPTS = 3;

const ZONES: HeatZone[] = ['left', 'center', 'right'];
const BANDS: HeatBand[] = ['near', 'mid', 'far'];

/** Distance band from a shot's estimated distance, falling back to its 2/3 value. */
function bandOfShot(shot: ResolvedShot): HeatBand | null {
  const d = shot.distanceRimWidths;
  if (d != null && Number.isFinite(d)) {
    if (d < BAND_NEAR_MAX_RIMWIDTHS) return 'near';
    if (d < BAND_FAR_MIN_RIMWIDTHS) return 'mid';
    return 'far';
  }
  // No metric distance — the 2/3 estimate still places it coarsely.
  if (shot.shotValue === 3) return 'far';
  if (shot.shotValue === 2) return 'mid';
  return null;
}

/**
 * Build the heat map over a set of shots. Only decided (make|miss) shots with a
 * known zone AND band are placed; the rest are counted as `unplaced`.
 */
export function buildHeatmap(
  shots: readonly ResolvedShot[],
  minCellAttempts: number = HEATMAP_MIN_CELL_ATTEMPTS,
): Heatmap {
  const index = new Map<string, HeatCell>();
  const cells: HeatCell[] = [];
  for (const zone of ZONES) {
    for (const band of BANDS) {
      const cell: HeatCell = { zone, band, makes: 0, attempts: 0, fgPct: 0 };
      cells.push(cell);
      index.set(`${zone}:${band}`, cell);
    }
  }

  let totalMakes = 0;
  let totalAttempts = 0;
  let unplaced = 0;
  for (const s of shots) {
    if (s.outcome !== 'make' && s.outcome !== 'miss') continue; // unsure excluded
    const zone = zoneOf(s.originX ?? null);
    const band = bandOfShot(s);
    if (zone === null || band === null) {
      unplaced += 1;
      continue;
    }
    const cell = index.get(`${zone}:${band}`)!;
    cell.attempts += 1;
    totalAttempts += 1;
    if (s.outcome === 'make') {
      cell.makes += 1;
      totalMakes += 1;
    }
  }

  let best: HeatCell | null = null;
  let worst: HeatCell | null = null;
  for (const cell of cells) {
    cell.fgPct = cell.attempts > 0 ? cell.makes / cell.attempts : 0;
    if (cell.attempts < minCellAttempts) continue;
    if (best === null || cell.fgPct > best.fgPct) best = cell;
    if (worst === null || cell.fgPct < worst.fgPct) worst = cell;
  }

  return { cells, totalMakes, totalAttempts, unplaced, best, worst };
}

/** Human label for a cell, e.g. "left corner three" / "top of the key". */
export function cellLabel(cell: HeatCell): string {
  const zoneWord = cell.zone === 'center' ? 'middle' : cell.zone;
  if (cell.band === 'far') {
    return cell.zone === 'center' ? 'top-of-key three' : `${cell.zone} corner three`;
  }
  if (cell.band === 'near') return cell.zone === 'center' ? 'the paint' : `${zoneWord} close`;
  return `${zoneWord} mid-range`;
}
