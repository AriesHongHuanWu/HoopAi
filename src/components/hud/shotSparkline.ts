/**
 * shotSparkline — pure geometry for the ShotToast mini trajectory.
 *
 * Normalizes a resolved shot's trajectory samples (analysis-frame px — see
 * the coordinate convention in src/core/types.ts: origin top-left, +y DOWN)
 * into a small sparkline box. Screen space is also +y down, so the arc keeps
 * its true shape with no axis flip: the apex of the shot renders at the top
 * of the box.
 *
 * Kept free of Skia/React imports so it stays trivially unit-testable; the
 * component turns the returned points into a Skia polyline.
 */
import type { BallSample, Point } from '../../core/types';

/** Sparkline box (dp) — sized to sit inline in the toast row. */
export const SPARK_WIDTH = 72;
export const SPARK_HEIGHT = 36;

/** Default inset so round stroke caps at the extremes don't clip. */
const INSET = 2;

/**
 * Fit trajectory samples into a `width`×`height` box, inset on all sides.
 *
 * Each axis is normalized independently against the samples' bounding box —
 * the toast wants a readable arc glyph, not a to-scale plot. Returns [] when
 * there is nothing to draw (fewer than 2 samples, or a box too small for the
 * inset). A flat axis (all samples at one x or one y) centers on that axis
 * instead of dividing by zero.
 */
export function buildSparklinePoints(
  trajectory: readonly BallSample[],
  width: number = SPARK_WIDTH,
  height: number = SPARK_HEIGHT,
  inset: number = INSET,
): Point[] {
  if (trajectory.length < 2) return [];
  const innerW = width - inset * 2;
  const innerH = height - inset * 2;
  if (innerW <= 0 || innerH <= 0) return [];

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of trajectory) {
    if (s.cx < minX) minX = s.cx;
    if (s.cx > maxX) maxX = s.cx;
    if (s.cy < minY) minY = s.cy;
    if (s.cy > maxY) maxY = s.cy;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;

  return trajectory.map((s) => ({
    x: spanX > 0 ? inset + ((s.cx - minX) / spanX) * innerW : width / 2,
    y: spanY > 0 ? inset + ((s.cy - minY) / spanY) * innerH : height / 2,
  }));
}
