/**
 * miniArcReplayGeometry — pure geometry for the MiniArcReplay comet sweep.
 *
 * Operates on already-normalized screen points (the output of
 * buildSparklinePoints), so it carries no coordinate convention beyond
 * "a polyline". Kept free of Skia/React/Reanimated imports so plain jest can
 * test it directly.
 *
 * partialPolyline runs inside a useDerivedValue worklet: it carries the
 * 'worklet' directive and keeps no module-level mutable state (same rules as
 * src/components/hud/arcHudGeometry.ts).
 */
import type { Point } from '../../core/types';

/** Sweep duration fallback when the trajectory has no usable time span, ms. */
const FALLBACK_MS = 900;
/** Sweep duration clamps, ms — a dart never blinks, a lob never drags. */
const MIN_MS = 600;
const MAX_MS = 2000;

/**
 * Leading slice of a polyline for an animation sweep at `progress` (clamped
 * to [0, 1]). The exact head sits at fractional index f = progress * (n - 1):
 * the result is points[0..floor(f)] plus, when f has a fractional part, one
 * point lerped between points[floor(f)] and points[floor(f) + 1].
 * progress 0 → [points[0]] (callers draw nothing until length ≥ 2, which
 * happens immediately); progress 1 → a fresh copy of all points. Fewer than
 * 2 input points → [].
 */
export function partialPolyline(points: readonly Point[], progress: number): Point[] {
  'worklet';
  const n = points.length;
  if (n < 2) return [];
  const p = progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
  const f = p * (n - 1);
  const i = Math.floor(f);
  const frac = f - i;
  const out = points.slice(0, i + 1);
  if (frac > 0 && i + 1 < n) {
    const a = points[i]!;
    const b = points[i + 1]!;
    out.push({ x: a.x + (b.x - a.x) * frac, y: a.y + (b.y - a.y) * frac });
  }
  return out;
}

/**
 * Sweep duration for a shot replay: the real flight time (last − first
 * sample, seconds → ms) clamped to [600, 2000]. Falls back to 900 ms when
 * there are fewer than 2 samples or the span is non-finite/non-positive.
 */
export function replayDurationMs(trajectory: readonly { t: number }[]): number {
  if (trajectory.length < 2) return FALLBACK_MS;
  const spanMs = (trajectory[trajectory.length - 1]!.t - trajectory[0]!.t) * 1000;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return FALLBACK_MS;
  return spanMs < MIN_MS ? MIN_MS : spanMs > MAX_MS ? MAX_MS : spanMs;
}
