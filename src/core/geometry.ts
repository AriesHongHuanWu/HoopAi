/**
 * Tiny pure geometry helpers shared across the pipeline.
 * Analysis-frame pixel space: origin top-left, +y DOWN (see types.ts).
 */
import type { Box, Point } from './types';

export function boxCenter(b: Box): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

export function boxContains(b: Box, p: Point): boolean {
  return (
    p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  );
}

export function boxesIntersect(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

export function boxDiagonal(b: Box): number {
  return Math.hypot(b.width, b.height);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Interior angle at vertex `b` formed by points a–b–c, in degrees [0, 180].
 * Returns null when either segment is degenerate.
 */
export function angleAtDeg(a: Point, b: Point, c: Point): number | null {
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const la = Math.hypot(abx, aby);
  const lc = Math.hypot(cbx, cby);
  if (la === 0 || lc === 0) return null;
  const cos = clamp((abx * cbx + aby * cby) / (la * lc), -1, 1);
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Angle of a displacement above the horizontal in REAL-WORLD orientation
 * (screen y is flipped), degrees. Positive = upward motion, negative =
 * downward. E.g. a ball dropping steeply into the rim ⇒ strongly negative;
 * report `Math.abs()` of it as the "entry angle".
 */
export function elevationAngleDeg(dx: number, dy: number): number {
  return (Math.atan2(-dy, Math.abs(dx)) * 180) / Math.PI;
}

/**
 * Linear interpolation of x at a given y between two points.
 * Returns null when the segment is horizontal (dy = 0).
 */
export function interpolateXAtY(p1: Point, p2: Point, y: number): number | null {
  const dy = p2.y - p1.y;
  if (dy === 0) return null;
  const s = (y - p1.y) / dy;
  return p1.x + (p2.x - p1.x) * s;
}
