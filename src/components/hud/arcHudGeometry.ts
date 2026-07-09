/**
 * arcHudGeometry — pure worklet math for the live arc HUD.
 *
 * Derives display-only arc facts (apex, release/entry angles, quality band,
 * comet tail split) from flat point arrays [x0, y0, x1, y1, ...] in
 * analysis-frame px with +y DOWN — a rising ball has DECREASING y, so the
 * screen apex of a shot is the MINIMUM y of the arc. This is the same space
 * as OverlayState.fullArc / traj.
 *
 * Everything here is a display aid for TrajectoryOverlay / ArcReadout:
 * nothing feeds arming, judging, or make/miss.
 *
 * Worklet rules (same incident history as src/ml/yoloParser.ts): every
 * exported function body starts with 'worklet'; NO module-level mutable state
 * (a module `let` written from a worklet crashes the frame processor); any
 * helper must be declared textually BEFORE its caller — the Babel worklet
 * plugin captures module-scope closures eagerly at module evaluation, so a
 * forward reference is `undefined` at call time. No Skia/React/Reanimated
 * imports so plain jest can test this file directly.
 */

/**
 * Display-layer entry-angle grading band, degrees above horizontal.
 * Deliberately WIDER than the coaching money zone FORM.entryAngle (43–47) in
 * src/core/config.ts: the HUD grades visual arc shape with loose tolerance,
 * and keeping the band here (display layer, not core config) keeps core
 * byte-identical. Visual grade only — never a judgment input.
 */
export const ARC_ENTRY_IDEAL_MIN = 43;
export const ARC_ENTRY_IDEAL_MAX = 52;

export type ArcQuality = 'ideal' | 'flat' | 'steep';

/**
 * Screen apex (minimum y — +y down) of a flat polyline, with its POINT index.
 * Null when there are fewer than 5 points (pts.length < 10) or the minimum
 * sits on either endpoint: an arc must show both ascent and descent for the
 * apex marker to mean anything.
 */
export function apexOfFlatArc(pts: readonly number[]): { x: number; y: number; i: number } | null {
  'worklet';
  if (pts.length < 10) return null;
  const n = pts.length >> 1; // point count
  let minI = 0;
  let minY = pts[1];
  for (let i = 1; i < n; i++) {
    const y = pts[i * 2 + 1];
    if (y < minY) {
      minY = y;
      minI = i;
    }
  }
  if (minI === 0 || minI === n - 1) return null;
  return { x: pts[minI * 2], y: minY, i: minI };
}

/**
 * Release angle in positive degrees above horizontal: the tangent at pts[0].
 * The input polyline is a noise-free, evenly-TIME-sampled resample of the
 * fitted parabola (shotPipeline fullArc, K=16), so each segment's chord is the
 * true velocity at that segment's temporal midpoint; extrapolating half a step
 * back from the first two chords (d0 - (d1 - d0) / 2, component-wise) recovers
 * the tangent at pts[0] EXACTLY for a parabola. A plain chord underreads the
 * angle by the gravity bled off inside its span — the old 3-segment secant was
 * 5–8° low on realistic shots. Falls back to the first-segment chord when only
 * 2 points exist. Requires ascent on the first segment (+y down ⇒ y1 < y0),
 * else null. Null for fewer than 2 points or a degenerate zero-length segment.
 */
export function releaseAngleDegFromFlat(pts: readonly number[]): number | null {
  'worklet';
  const n = pts.length >> 1;
  if (n < 2) return null;
  const dx0 = pts[2] - pts[0];
  const dy0 = pts[3] - pts[1];
  if (dx0 === 0 && dy0 === 0) return null;
  if (dy0 >= 0) return null; // no ascent off the first segment — not a release window
  if (n < 3) return Math.atan2(-dy0, Math.abs(dx0)) * (180 / Math.PI);
  const dx1 = pts[4] - pts[2];
  const dy1 = pts[5] - pts[3];
  const dxt = dx0 - (dx1 - dx0) / 2;
  const dyt = dy0 - (dy1 - dy0) / 2;
  // Extrapolated tangent must still ascend; weird data falls back to the chord.
  if (dyt >= 0) return Math.atan2(-dy0, Math.abs(dx0)) * (180 / Math.PI);
  return Math.atan2(-dyt, Math.abs(dxt)) * (180 / Math.PI);
}

/**
 * Entry angle in positive degrees below horizontal at the horizontal plane
 * y = planeY (typically the rim line). Scans segments from the END backward
 * and finds the LAST descending crossing — the segment where
 * y[i] < planeY && y[i+1] >= planeY && y[i+1] > y[i] (+y down ⇒ descending).
 * The returned angle is the TANGENT at the crossing point, not the whole
 * segment's chord: the chord is the velocity at the segment's temporal
 * midpoint (even time sampling), so blending toward a neighbor chord by the
 * crossing's offset from that midpoint reconstructs the crossing tangent —
 * exact for a parabola up to the (tiny, O(step²)) linear-in-y estimate of the
 * crossing fraction. The plain chord read up to ~3–4° low on high arcs, enough
 * to misgrade a 45.7° textbook entry as 'flat' at the 43° band edge.
 * Null when the arc never crosses the plane on the way down.
 */
export function entryAngleDegFromFlat(pts: readonly number[], planeY: number): number | null {
  'worklet';
  const n = pts.length >> 1;
  for (let i = n - 2; i >= 0; i--) {
    const y0 = pts[i * 2 + 1];
    const y1 = pts[i * 2 + 3];
    if (y0 < planeY && y1 >= planeY && y1 > y0) {
      const dx = pts[i * 2 + 2] - pts[i * 2];
      const dy = y1 - y0;
      // Single-segment trail: the chord is all we have.
      const j = i + 1 <= n - 2 ? i + 1 : i - 1;
      if (j < 0) return Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI);
      const ndx = pts[j * 2 + 2] - pts[j * 2];
      const ndy = pts[j * 2 + 3] - pts[j * 2 + 1];
      // Crossing fraction within this segment (0..1], linear in y, and its
      // signed offset from the segment midpoint toward the neighbor's midpoint.
      const u = (planeY - y0) / dy;
      const f = j > i ? u - 0.5 : 0.5 - u;
      const dxt = dx + f * (ndx - dx);
      const dyt = dy + f * (ndy - dy);
      // Blended tangent must still descend; weird data falls back to the chord.
      if (dyt <= 0) return Math.atan2(dy, Math.abs(dx)) * (180 / Math.PI);
      return Math.atan2(dyt, Math.abs(dxt)) * (180 / Math.PI);
    }
  }
  return null;
}

/**
 * Grade an entry angle against the display band. Null passes through so
 * callers can chain directly off entryAngleDegFromFlat.
 */
export function arcQuality(entryDeg: number | null): ArcQuality | null {
  'worklet';
  if (entryDeg === null) return null;
  if (entryDeg < ARC_ENTRY_IDEAL_MIN) return 'flat';
  if (entryDeg > ARC_ENTRY_IDEAL_MAX) return 'steep';
  return 'ideal';
}

/**
 * Split a flat polyline for the tapered comet: `head` holds the NEWEST
 * ceil(n * headFrac) points (minimum 2), `tail` holds the rest PLUS the
 * boundary point duplicated as its last point so the two stroked paths join
 * seamlessly. Fewer than 3 points (or a headFrac that swallows everything)
 * returns the whole polyline as `head` with an empty `tail`.
 * Allocates two fresh arrays per call — acceptable at once per frame on
 * ≤48-point trails.
 */
export function splitFlatTail(
  pts: readonly number[],
  headFrac: number,
): { tail: number[]; head: number[] } {
  'worklet';
  const n = pts.length >> 1;
  if (n < 3) return { tail: [], head: pts.slice(0) };
  let headCount = Math.ceil(n * headFrac);
  if (headCount < 2) headCount = 2;
  if (headCount >= n) return { tail: [], head: pts.slice(0) };
  const boundary = n - headCount; // point index shared by both halves
  return {
    tail: pts.slice(0, (boundary + 1) * 2),
    head: pts.slice(boundary * 2),
  };
}
