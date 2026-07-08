/**
 * trajectoryArc — turn a stored ball trajectory (analysis-frame pixels) into a
 * clean, elegant arc laid out inside a target box in CARD space, for the POSTER
 * layout's flourish.
 *
 * WHY THIS EXISTS
 * ---------------
 * The raw samples ({@link BallSample}, origin top-left, +y DOWN) live in the
 * detector's letterboxed frame — a different size and aspect than the share
 * card, and often noisy near release. Drawing them verbatim would look like a
 * scribble. Instead we:
 *   1. sort by time and keep the flight from release toward the rim,
 *   2. fit the samples into the target box preserving their own aspect (so a
 *      high floaty arc stays high, a flat line stays flat),
 *   3. expose the fitted points so the caller can draw a smooth curve and drop
 *      a "ball at the rim" dot on the LAST point (the ball meeting the hoop).
 *
 * Everything here is PURE MATH on numbers — no Skia, no React — so the layout
 * can be snapshot-tested (positions given a box) without a canvas.
 */
import type { BallSample } from '../../core/types';

export interface ArcPoint {
  x: number;
  y: number;
}

export interface ArcLayout {
  /** Fitted polyline in card space (first = release-ish, last = at the rim). */
  points: readonly ArcPoint[];
  /** The rim end of the flight — where the ball dot sits (== last point). */
  ball: ArcPoint;
  /** The release end of the flight (== first point). */
  release: ArcPoint;
}

/** Target box (card space) the arc is fitted into. */
export interface ArcBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Fit `samples` into `box`. Returns null when there's nothing meaningful to
 * draw (fewer than 2 points, or a zero-extent cloud). `inset` (0..0.5) keeps
 * the arc off the box edges. When `flip` is true the horizontal direction is
 * mirrored — handy so the arc always sweeps INTO the box's chosen side.
 */
export function layoutTrajectoryArc(
  samples: readonly BallSample[],
  box: ArcBox,
  opts: { inset?: number; flip?: boolean } = {},
): ArcLayout | null {
  if (samples.length < 2) return null;

  // Chronological — the flight goes release → apex → rim over time.
  const pts = [...samples].sort((a, b) => a.t - b.t);

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.cx < minX) minX = p.cx;
    if (p.cx > maxX) maxX = p.cx;
    if (p.cy < minY) minY = p.cy;
    if (p.cy > maxY) maxY = p.cy;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  // Degenerate (all coincident): nothing to draw.
  if (spanX < 1e-3 && spanY < 1e-3) return null;

  const inset = opts.inset != null ? clamp01(opts.inset) : 0.08;
  const innerX = box.x + box.width * inset;
  const innerY = box.y + box.height * inset;
  const innerW = box.width * (1 - inset * 2);
  const innerH = box.height * (1 - inset * 2);

  // Uniform scale preserves the arc's real shape (no squashing a high arc into
  // a flat one). Guard the zero-span axis so a vertical/horizontal-only flight
  // still maps to the box center on that axis.
  const sx = spanX > 1e-3 ? innerW / spanX : 0;
  const sy = spanY > 1e-3 ? innerH / spanY : 0;
  const s = Math.min(sx > 0 ? sx : Infinity, sy > 0 ? sy : Infinity);
  const scale = Number.isFinite(s) ? s : Math.max(sx, sy);

  const drawnW = spanX * scale;
  const drawnH = spanY * scale;
  // Center the drawn arc inside the inner box.
  const offX = innerX + (innerW - drawnW) / 2;
  const offY = innerY + (innerH - drawnH) / 2;

  const out: ArcPoint[] = pts.map((p) => {
    const nx = (p.cx - minX) * scale; // 0..drawnW
    const x = opts.flip ? offX + (drawnW - nx) : offX + nx;
    // +y is DOWN in both source and card space, so no y flip is needed: a
    // small cy (high in frame) stays high (small y) in the card.
    const y = offY + (p.cy - minY) * scale;
    return { x, y };
  });

  return {
    points: out,
    release: out[0]!,
    ball: out[out.length - 1]!,
  };
}

/**
 * Build an SVG-ish path string (M/L commands) for a fitted arc. Kept separate
 * from {@link layoutTrajectoryArc} so the geometry stays testable without any
 * path-string coupling; the Skia layer parses this with `Skia.Path.MakeFromSVGString`.
 * A smooth Catmull-Rom → cubic pass rounds the polyline so the flight reads as
 * one continuous shot line rather than connected segments.
 */
export function arcToSvgPath(points: readonly ArcPoint[]): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    const p = points[0]!;
    return `M${p.x} ${p.y}`;
  }
  if (points.length === 2) {
    return `M${points[0]!.x} ${points[0]!.y} L${points[1]!.x} ${points[1]!.y}`;
  }
  // Catmull-Rom through the points, converted to cubic Béziers.
  let d = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? 0 : i - 1]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < points.length ? i + 2 : points.length - 1]!;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}
