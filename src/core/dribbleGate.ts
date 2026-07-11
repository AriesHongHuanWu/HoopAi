/**
 * Dribble gate — suppresses the live flight-guide DRAWING while the player
 * dribbles.
 *
 * WHY: every fall between dribble bounces is a genuine gravity parabola, so
 * the curvature/R² gates that qualify the flight-arc HUD pass on dribble
 * segments too, and the overlay draws a downward guide + landing ghost at the
 * floor while the player is just pounding the ball.
 *
 * HONESTY CONTRACT (iron rule): this module gates DRAWING ONLY. Its outputs
 * must never feed FsmFrameInput, ShotFsm, recheck, or any make/miss/2-3
 * judgment. Hiding a guide overlay is a rendering decision; the shot
 * pipeline's inputs stay byte-identical whether the gate is active or not.
 *
 * All geometry is in analysis-frame pixels (+y DOWN). Time comes exclusively
 * from camera sample timestamps (never Date.now), so a recorded session
 * replays deterministically. Callers must reset() when the sample stream
 * restarts (new session / seek), since timestamps are the only clock.
 */
import type { RimGeometry } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Rolling window (seconds) in which bounce reversals count toward the latch. */
const REVERSAL_WINDOW_SEC = 1.6;

/** Bounce reversals within the window required to latch dribble mode ON. */
const LATCH_REVERSAL_COUNT = 2;

/** The latch clears after this long (seconds) without a new reversal. */
const CLEAR_NO_REVERSAL_SEC = 1.2;

/**
 * A reversal only counts when it happens at least this many rim widths BELOW
 * the rim plane. Dribble bounces live near the floor; anything near the rim
 * is shot territory and must never feed the dribble latch (a rim-rattler's
 * bounce is exactly a falling→rising flip, but it happens AT the rim).
 */
const MIN_REVERSAL_DEPTH_RIM_WIDTHS = 1;

/**
 * The latch ALSO clears on a REAL rising (vy < 0) sample within this many rim
 * widths BELOW the rim plane. Exactly symmetric with
 * {@link MIN_REVERSAL_DEPTH_RIM_WIDTHS}: reversals are only ever recorded at
 * least one rim width below the plane, so a rising ball INSIDE that band is
 * shot territory a dribble never reverses in. Waiting for a sample strictly
 * ABOVE the plane (the (a) clear) blanked a dribble→quick shot whose
 * above-rim detections drop out — the latch then outlived the whole flight.
 * One-sided by construction: this can only clear EARLIER (draw more), never
 * suppress more.
 */
const CLEAR_NEAR_PLANE_RIM_WIDTHS = 1;

/**
 * Max stored reversal timestamps — a small ring so memory stays bounded no
 * matter how long the player dribbles; window pruning does the real work.
 */
const MAX_TRACKED_REVERSALS = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One ball observation for the gate (analysis px, +y DOWN, seconds). */
export interface DribbleSample {
  /** Camera time, seconds. */
  t: number;
  /** Ball center y. */
  cy: number;
  /** Vertical velocity, px/s (+ = falling). */
  vy: number;
  /** True for a real detection; false for a Kalman-predicted coast. */
  real: boolean;
}

// ---------------------------------------------------------------------------
// Detector
// ---------------------------------------------------------------------------

/**
 * Latching dribble detector.
 *
 * A "bounce reversal" is a vy sign flip from falling (vy > 0) to rising
 * (vy < 0) observed on REAL samples while the ball center is at least one rim
 * width BELOW the rim plane. Two reversals inside a rolling
 * {@link REVERSAL_WINDOW_SEC} window latch dribble mode ON; the latch clears
 * when a REAL sample rises above the rim plane (the actual shot must draw!),
 * when a REAL rising sample appears within
 * {@link CLEAR_NEAR_PLANE_RIM_WIDTHS} rim width(s) BELOW the plane (a
 * dribble never reverses that high, so it is shot territory even when the
 * above-rim detections drop out), when {@link CLEAR_NO_REVERSAL_SEC} pass
 * with no new reversal, or on reset().
 *
 * Predicted (Kalman-coasted) samples are the tracker's OPINION, not evidence:
 * they neither create reversals nor clear the latch — only their timestamps
 * advance the clock for the timeout/window checks.
 */
export class DribbleDetector {
  /** Recent reversal timestamps, chronological, capped (small ring). */
  private reversalTs: number[] = [];
  /** vy of the most recent REAL sample; null before any real sample. */
  private lastRealVy: number | null = null;
  /** Time of the most recent reversal; -Infinity before any. */
  private lastReversalT = -Infinity;
  /** The dribble-mode latch. */
  private latched = false;

  /**
   * Feed one sample; returns whether drawing should be suppressed THIS frame.
   * With rim == null it returns false and leaves state untouched: no rim, no
   * suppression (and no way to judge bounce depth anyway).
   */
  update(s: DribbleSample, rim: RimGeometry | null): boolean {
    if (!rim) return false;

    // (a) A REAL sample above the rim plane is shot-like — clear immediately
    // so the guide draws for the actual attempt.
    if (s.real && s.cy < rim.planeY) {
      this.latched = false;
      this.reversalTs.length = 0;
      this.lastReversalT = -Infinity;
      this.lastRealVy = s.vy;
      return false;
    }

    // (a2) A REAL rising sample within CLEAR_NEAR_PLANE_RIM_WIDTHS rim
    // width(s) BELOW the plane is shot territory too: reversals are only
    // recorded at least one rim width below the plane (the same line,
    // mirrored), so no dribble ever reverses inside this band. Clearing here
    // instead of waiting for an above-plane sample keeps a dribble→quick
    // shot drawing even when its above-rim detections drop out. Predicted
    // samples stay inert — they neither clear nor create anything.
    if (
      s.real &&
      s.vy < 0 &&
      s.cy < rim.planeY + CLEAR_NEAR_PLANE_RIM_WIDTHS * rim.box.width
    ) {
      this.latched = false;
      this.reversalTs.length = 0;
      this.lastReversalT = -Infinity;
      this.lastRealVy = s.vy;
      return false;
    }

    // Record a bounce reversal: falling → rising on real samples, deep below
    // the rim plane.
    if (s.real) {
      const depthLine =
        rim.planeY + MIN_REVERSAL_DEPTH_RIM_WIDTHS * rim.box.width;
      if (
        this.lastRealVy !== null &&
        this.lastRealVy > 0 &&
        s.vy < 0 &&
        s.cy > depthLine
      ) {
        this.reversalTs.push(s.t);
        if (this.reversalTs.length > MAX_TRACKED_REVERSALS) {
          this.reversalTs.shift();
        }
        this.lastReversalT = s.t;
      }
      this.lastRealVy = s.vy;
    }

    // Prune reversals that fell out of the rolling window.
    const cutoff = s.t - REVERSAL_WINDOW_SEC;
    while (this.reversalTs.length > 0 && this.reversalTs[0] < cutoff) {
      this.reversalTs.shift();
    }

    if (this.reversalTs.length >= LATCH_REVERSAL_COUNT) this.latched = true;

    // (b) No reversal for a while → the dribble ended (pickup, hold, pass).
    if (this.latched && s.t - this.lastReversalT >= CLEAR_NO_REVERSAL_SEC) {
      this.latched = false;
    }

    return this.latched;
  }

  /** Current latch state (same value the last update() returned). */
  get active(): boolean {
    return this.latched;
  }

  /** Forget everything (session restart / stream seek). */
  reset(): void {
    this.reversalTs.length = 0;
    this.lastRealVy = null;
    this.lastReversalT = -Infinity;
    this.latched = false;
  }
}

// ---------------------------------------------------------------------------
// Apex gate
// ---------------------------------------------------------------------------

/**
 * True when the fitted parabola's vertex — its apex, the minimum y since
 * +y is DOWN — sits above `rim.planeY + marginRimWidths * rimWidth`.
 *
 * A real shot arcs well above the rim, so its apex clears the line easily; a
 * waist-high dribble fall fits a perfectly valid parabola whose apex never
 * gets near the rim, and fails. PERMISSIVE by contract: a null fit, a null
 * rim, a non-gravity fit (ya <= 0 has no finite apex), a non-finite vertex,
 * or — when the fit carries its observed window — a vertex whose time falls
 * OUTSIDE [tMin, tMax] all return true. The gate must never suppress a real
 * shot for lack of information, and an EXTRAPOLATED vertex is exactly that:
 * an early-ascent fit of a real shot routinely projects a bogus low apex, so
 * only an apex the samples actually straddled may suppress. Callers that do
 * not pass tMin/tMax (or pass non-finite values) keep the legacy semantics
 * unchanged. Fit is y(t) = ya·t² + yb·t + yc in analysis px / seconds, with
 * [tMin, tMax] the observed sample window in the same absolute time.
 */
export function apexAboveRim(
  fit: {
    ya: number;
    yb: number;
    yc: number;
    /** Observed fit window (e.g. ArcFit.tMin/tMax); optional, back-compat. */
    tMin?: number;
    tMax?: number;
  } | null,
  rim: RimGeometry | null,
  marginRimWidths: number,
): boolean {
  if (!fit || !rim) return true;
  if (!(fit.ya > 0)) return true; // not gravity-shaped: no apex to judge
  // Apex-straddle guard: with a known observed window, only an apex the
  // samples actually bracketed may suppress. An ascending-only (tMax before
  // the vertex) or descending-only (tMin after it) fit extrapolates its
  // vertex — an opinion, not an observation — and returns true.
  const { tMin, tMax } = fit;
  if (
    typeof tMin === 'number' &&
    typeof tMax === 'number' &&
    Number.isFinite(tMin) &&
    Number.isFinite(tMax)
  ) {
    const vertexT = -fit.yb / (2 * fit.ya);
    if (!(tMin <= vertexT && vertexT <= tMax)) return true;
  }
  const vertexY = fit.yc - (fit.yb * fit.yb) / (4 * fit.ya);
  if (!Number.isFinite(vertexY)) return true;
  return vertexY < rim.planeY + marginRimWidths * rim.box.width;
}
