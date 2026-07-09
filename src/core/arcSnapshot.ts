/**
 * Persisted flight-arc snapshot encode/decode (shots.arcJson, db v9).
 *
 * HONESTY CONTRACT: VISUAL-ONLY replay data. Drawing is not judging: nothing
 * here may ever feed make/miss, the FSM, fuse(), recheck, or 2/3 estimation.
 * The snapshot exists solely so replay surfaces (3D shot replay, thumbnail
 * strips) can redraw a shot's flight after the session — it is frozen at the
 * resolve frame from the SAME confidence-gated arc the live overlay draws.
 *
 * Everything operates in analysis-frame pixel space (+y DOWN, see types.ts),
 * time in seconds from camera timestamps. Pure TypeScript: no I/O, no wall
 * clock. Decoding NEVER throws — a corrupt persisted blob yields null, never
 * a repaired object (reject, never repair), mirroring decodeSequence's
 * graceful-degradation contract in formSequence.ts.
 */
import type { Box, PersistedFlightArc, Point } from './types';

// Canonical shape lives in types.ts (next to ResolvedShot.flightArc);
// re-exported here so snapshot consumers can import it with the codec.
export type { PersistedFlightArc } from './types';

/**
 * Absolute-time parabola coefficients frozen at resolve — a field-for-field
 * mirror of trajectory.ts {@link import('./trajectory').ArcFit}:
 *   y(t) = ya*t² + yb*t + yc   (screen coords, y down ⇒ ya > 0 under gravity)
 *   x(t) = xm*t + xq
 * valid over the observed window [tMin, tMax].
 */
export interface ArcSnapshotFit {
  ya: number;
  yb: number;
  yc: number;
  xm: number;
  xq: number;
  r2y: number;
  tMin: number;
  tMax: number;
}

/** Max persisted path points (34 numbers) — matches the pipeline's K=16 fullFlightPath sampling (K+1 points). */
export const ARC_PATH_MAX_POINTS = 17;

/** Fewest flat path entries (4 points) that still sketch an arc. */
const ARC_PATH_MIN_NUMBERS = 8;

/** Round one coordinate to 0.1 px to keep the JSON small. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** All eight fit fields finite, gravity signature present, non-empty window. */
function validFitNumbers(fit: ArcSnapshotFit): boolean {
  return (
    Number.isFinite(fit.ya) &&
    Number.isFinite(fit.yb) &&
    Number.isFinite(fit.yc) &&
    Number.isFinite(fit.xm) &&
    Number.isFinite(fit.xq) &&
    Number.isFinite(fit.r2y) &&
    Number.isFinite(fit.tMin) &&
    Number.isFinite(fit.tMax) &&
    fit.ya > 0 &&
    fit.tMax > fit.tMin
  );
}

/**
 * Build the persisted snapshot from the pipeline's resolve-frame state, or
 * null when any input is unusable (bad fit, degenerate path, empty frame or
 * rim). Inputs are NEVER mutated; every field is deep-copied because both the
 * ArcFit object and the RimLock geometry box are live, reused objects on the
 * pipeline side — persisting an alias would let later frames corrupt the
 * snapshot.
 *
 * `path` is the flat [x,y,...] fullFlightPath; when it carries more than
 * {@link ARC_PATH_MAX_POINTS} points it is downsampled evenly, always keeping
 * the first and last point, and every coordinate is rounded to 0.1 px.
 */
export function buildArcSnapshot(
  fit: ArcSnapshotFit,
  path: readonly number[],
  rimBox: Box,
  frameW: number,
  frameH: number,
): PersistedFlightArc | null {
  if (!validFitNumbers(fit)) return null;
  if (path.length < ARC_PATH_MIN_NUMBERS || path.length % 2 !== 0) return null;
  for (let i = 0; i < path.length; i++) {
    if (!Number.isFinite(path[i]!)) return null;
  }
  if (!(Number.isFinite(frameW) && frameW > 0)) return null;
  if (!(Number.isFinite(frameH) && frameH > 0)) return null;
  if (!Number.isFinite(rimBox.x) || !Number.isFinite(rimBox.y)) return null;
  if (!(Number.isFinite(rimBox.width) && rimBox.width > 0)) return null;
  if (!(Number.isFinite(rimBox.height) && rimBox.height > 0)) return null;

  const nPts = path.length / 2;
  const out: number[] = [];
  if (nPts > ARC_PATH_MAX_POINTS) {
    // Even downsample keeping first + last (same idea as formSequence's
    // pickIndices). Strides are ≥ 1 here, so indices never collide.
    for (let i = 0; i < ARC_PATH_MAX_POINTS; i++) {
      const j = Math.round((i * (nPts - 1)) / (ARC_PATH_MAX_POINTS - 1));
      out.push(round1(path[2 * j]!), round1(path[2 * j + 1]!));
    }
  } else {
    for (let i = 0; i < path.length; i++) out.push(round1(path[i]!));
  }

  return {
    v: 1,
    fit: {
      ya: fit.ya,
      yb: fit.yb,
      yc: fit.yc,
      xm: fit.xm,
      xq: fit.xq,
      r2y: fit.r2y,
      tMin: fit.tMin,
      tMax: fit.tMax,
    },
    path: out,
    rimBox: {
      x: rimBox.x,
      y: rimBox.y,
      width: rimBox.width,
      height: rimBox.height,
    },
    frameW,
    frameH,
  };
}

/** Finite-number read from an unknown record; null on anything else. */
function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Validate + copy the fit sub-object of a parsed snapshot. */
function readFit(raw: unknown): ArcSnapshotFit | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const ya = finiteNumber(rec.ya);
  const yb = finiteNumber(rec.yb);
  const yc = finiteNumber(rec.yc);
  const xm = finiteNumber(rec.xm);
  const xq = finiteNumber(rec.xq);
  const r2y = finiteNumber(rec.r2y);
  const tMin = finiteNumber(rec.tMin);
  const tMax = finiteNumber(rec.tMax);
  if (
    ya === null || yb === null || yc === null || xm === null ||
    xq === null || r2y === null || tMin === null || tMax === null
  ) {
    return null;
  }
  if (!(ya > 0) || !(tMax > tMin)) return null;
  return { ya, yb, yc, xm, xq, r2y, tMin, tMax };
}

/** Validate + copy the flat path array of a parsed snapshot. */
function readPath(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  const len = raw.length;
  if (len < ARC_PATH_MIN_NUMBERS || len > 2 * ARC_PATH_MAX_POINTS) return null;
  if (len % 2 !== 0) return null;
  const out: number[] = new Array(len);
  for (let i = 0; i < len; i++) {
    const v = finiteNumber(raw[i]);
    if (v === null) return null;
    out[i] = v;
  }
  return out;
}

/** Validate + copy the rim box of a parsed snapshot. */
function readBox(raw: unknown): Box | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const x = finiteNumber(rec.x);
  const y = finiteNumber(rec.y);
  const width = finiteNumber(rec.width);
  const height = finiteNumber(rec.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/**
 * Decode a persisted snapshot from a raw arcJson STRING or an already-parsed
 * object. NEVER throws; any structural or numeric violation returns null
 * (reject, never repair — a half-valid snapshot would draw a lying arc).
 * Returns a fresh object built from validated copies, so callers can never
 * alias a shared parse tree.
 */
export function decodeArcSnapshot(raw: unknown): PersistedFlightArc | null {
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== 1) return null;
  const fit = readFit(rec.fit);
  if (!fit) return null;
  const path = readPath(rec.path);
  if (!path) return null;
  const rimBox = readBox(rec.rimBox);
  if (!rimBox) return null;
  const frameW = finiteNumber(rec.frameW);
  const frameH = finiteNumber(rec.frameH);
  if (frameW === null || !(frameW > 0)) return null;
  if (frameH === null || !(frameH > 0)) return null;
  return { v: 1, fit, path, rimBox, frameW, frameH };
}

/**
 * Evaluate the snapshot's parabola at absolute time `t` (seconds), returning
 * the ball center in analysis-frame px. `t` is NOT clamped to [tMin, tMax];
 * extrapolation is the caller's choice (matches trajectory.ts evalArc).
 */
export function evalArcSnapshot(arc: PersistedFlightArc, t: number): Point {
  return {
    x: arc.fit.xm * t + arc.fit.xq,
    y: (arc.fit.ya * t + arc.fit.yb) * t + arc.fit.yc,
  };
}

/** Unpack the flat [x,y,...] path into points for thumbnail polylines. */
export function arcPathPoints(arc: PersistedFlightArc): Point[] {
  const n = arc.path.length >> 1;
  const pts: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    pts[i] = { x: arc.path[2 * i]!, y: arc.path[2 * i + 1]! };
  }
  return pts;
}
