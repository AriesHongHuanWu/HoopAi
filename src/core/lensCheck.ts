/**
 * Lens glare/haze self-check.
 *
 * HONESTY CONTRACT: this is a pre-session ADVISORY heuristic only. It never
 * gates detection, arming, or judgment — its sole output is a hint chip shown
 * before the rim is locked. The copy it drives is hedged on purpose: a
 * saturated static blob is USUALLY lens flare and a milky low-contrast image
 * is USUALLY a smudged lens, but neither can be distinguished from a bright
 * sky or fog with certainty from luma statistics alone.
 *
 * The caller (engine worklet) samples an 8x8 mean-luma grid (0..1) over the
 * CONTENT rect every ~2 s and feeds it here on the JS thread. This module is
 * pure TypeScript: deterministic, no I/O, time only via the tSec parameter.
 *
 * Signals over the rolling window of buffered snapshots:
 * - GLARE: enough cells whose temporal mean is near-saturated AND temporally
 *   static (population variance ~0). A light fixture panned across the view
 *   moves between cells (low per-cell mean), and a flickering highlight has
 *   high variance — only a stuck bright blob (flare / sun on the element)
 *   survives both gates. A fully blown-out frame also reads as glare, which
 *   is deliberate: it deserves the same "fix your lens/exposure" nudge.
 * - HAZE: the median per-snapshot spatial luma spread (p90 - p10 across the
 *   64 cells) is milky-low while the global light is mid-range. A dark gym or
 *   a blown-out scene is excluded — low contrast there is not a smudge.
 */

export const LENS = {
  grid: 8, // 8x8 mean-luma cells (0..1), sampled by the caller
  snapshotIntervalSec: 2, // caller cadence (documented; not enforced here)
  windowSnapshots: 8, // rolling analysis window (~16 s)
  minSnapshots: 5, // never flag before this many snapshots
  glareLumaMin: 0.92, // a cell this bright...
  glareVarMax: 5e-4, // ...and this temporally static reads as lens flare
  glareMinCells: 3, // contiguous-ish blob size floor (count, not adjacency)
  hazeSpreadMax: 0.1, // p90-p10 spatial luma spread below this = milky image
  hazeLightMin: 0.2, // haze only judged in mid light —
  hazeLightMax: 0.85, // a dark gym or blown-out scene is not a smudge
} as const;

export type LensStatus = 'ok' | 'glare' | 'haze';

/** Cells per snapshot grid. */
const CELLS = LENS.grid * LENS.grid;

/** Sorted-array quantile index convention: round((n-1)·q). */
const P10_IDX = Math.round((CELLS - 1) * 0.1);
const P90_IDX = Math.round((CELLS - 1) * 0.9);

/**
 * Rolling accumulator for lens-check snapshots.
 *
 * Keeps the last {@link LENS.windowSnapshots} grids in a preallocated ring
 * (grids are COPIED on push — the caller reuses its array) and recomputes the
 * status on every accepted push. All scratch buffers are fields, so steady
 * state allocates nothing.
 */
export class LensCheckAccumulator {
  /** Ring of buffered snapshots (windowSnapshots × CELLS). */
  private readonly ring: Float64Array[];
  /** Per-ring-slot spatial spread (p90 - p10 of that snapshot's cells). */
  private readonly spreads: Float64Array;
  /** Sort scratch for one snapshot's cells. */
  private readonly cellScratch: Float64Array;
  /** Sort scratch for the buffered spreads (median). */
  private readonly spreadScratch: Float64Array;

  /** Total accepted pushes since construction/reset. */
  private accepted = 0;
  /** Mean luma of the newest snapshot (global light for the haze gate). */
  private newestMean = 0;
  /** Timestamp (s) of the last accepted push. Recorded for contract parity —
   *  the analysis is windowed by snapshot COUNT; cadence is the caller's job. */
  private lastTSec = 0;
  private current: LensStatus = 'ok';

  constructor() {
    this.ring = [];
    for (let i = 0; i < LENS.windowSnapshots; i++) {
      this.ring.push(new Float64Array(CELLS));
    }
    this.spreads = new Float64Array(LENS.windowSnapshots);
    this.cellScratch = new Float64Array(CELLS);
    this.spreadScratch = new Float64Array(LENS.windowSnapshots);
  }

  /** grid.length must be LENS.grid**2; silently ignores malformed input. */
  push(grid: readonly number[], tSec: number): void {
    if (grid.length !== CELLS) return;
    this.lastTSec = tSec;

    const slot = this.accepted % LENS.windowSnapshots;
    const dst = this.ring[slot];
    let sum = 0;
    for (let i = 0; i < CELLS; i++) {
      const v = grid[i];
      dst[i] = v;
      sum += v;
    }
    this.newestMean = sum / CELLS;

    // Spatial spread of THIS snapshot: p90 - p10 over a sorted scratch copy.
    this.cellScratch.set(dst);
    this.cellScratch.sort();
    this.spreads[slot] = this.cellScratch[P90_IDX] - this.cellScratch[P10_IDX];

    this.accepted++;
    this.recompute();
  }

  /** Current status; recomputed on push. 'ok' until minSnapshots buffered. */
  get status(): LensStatus {
    return this.current;
  }

  /** Number of accepted snapshots since construction/reset. */
  get snapshotCount(): number {
    return this.accepted;
  }

  /** Returns to the empty initial state. */
  reset(): void {
    this.accepted = 0;
    this.newestMean = 0;
    this.lastTSec = 0;
    this.current = 'ok';
    // Ring contents need no clearing: only the first `accepted` slots are
    // ever read, and they are overwritten before becoming readable again.
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private recompute(): void {
    const n = Math.min(this.accepted, LENS.windowSnapshots);
    if (n < LENS.minSnapshots) {
      this.current = 'ok';
      return;
    }

    // GLARE: cells whose temporal mean is near-saturated and whose population
    // variance across the buffered snapshots is essentially zero. Slots
    // 0..n-1 are exactly the valid ones (the ring fills sequentially), and
    // mean/variance are order-independent, so ring rotation is irrelevant.
    let glareCells = 0;
    for (let c = 0; c < CELLS; c++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += this.ring[k][c];
      const mean = s / n;
      if (mean < LENS.glareLumaMin) continue;
      let sq = 0;
      for (let k = 0; k < n; k++) {
        const d = this.ring[k][c] - mean;
        sq += d * d;
      }
      if (sq / n <= LENS.glareVarMax) glareCells++;
    }
    if (glareCells >= LENS.glareMinCells) {
      // Glare beats haze: a saturated blob also crushes measured contrast,
      // and "shade the lens" is the more actionable advice of the two.
      this.current = 'glare';
      return;
    }

    // HAZE: median buffered spatial spread is milky-low AND the newest
    // snapshot's global light is mid-range.
    for (let k = 0; k < n; k++) this.spreadScratch[k] = this.spreads[k];
    // Insertion sort over the first n entries (n <= windowSnapshots, tiny)
    // so no subarray view is allocated on the recompute path.
    for (let i = 1; i < n; i++) {
      const v = this.spreadScratch[i];
      let j = i - 1;
      while (j >= 0 && this.spreadScratch[j] > v) {
        this.spreadScratch[j + 1] = this.spreadScratch[j];
        j--;
      }
      this.spreadScratch[j + 1] = v;
    }
    const medianSpread = this.spreadScratch[Math.round((n - 1) * 0.5)];
    if (
      medianSpread < LENS.hazeSpreadMax &&
      this.newestMean >= LENS.hazeLightMin &&
      this.newestMean <= LENS.hazeLightMax
    ) {
      this.current = 'haze';
      return;
    }

    this.current = 'ok';
  }
}
