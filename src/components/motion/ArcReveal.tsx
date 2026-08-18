/**
 * ArcReveal — the signature shot arc as an enforced primitive.
 *
 * Part A, `arcMotif`, is the ONE canonical quadratic every arc in the app
 * draws: launch point just off the bottom-left, control at (0.36·w, −0.6·h),
 * rim point upper-right. BootIntro and Home's hero CTA had each hand-rolled
 * this formula verbatim; it lives here now so every future hero moment
 * (Train, Summary, Records, Coach, Profile) is the SAME arc, not a cousin.
 * arcMotif is pure JS-thread geometry — call it once at render, close over
 * the plain numbers it returns, and never call it (or `pointAt`) from a
 * worklet.
 *
 * Part B, `<ArcReveal>`, draws that motif with Home's double-stroke
 * treatment (7px echo at 0.08 alpha under a 3px stroke at 0.22) and reveals
 * it via Skia path trim: the stroke draws itself in as `progress` rises,
 * with an optional ball dot riding the trim tip. Under reduced motion (or
 * `animate={false}`) it renders the full static arc — the finished frame,
 * no draw-in.
 *
 * WORKLET SAFETY (the fx/particles crash precedent): the trim/dot math runs
 * in useDerivedValue and is kept ENTIRELY inline over plain closed-over
 * numbers — no JS helper is ever called from the worklet.
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import { useEffect } from 'react';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion } from '@/constants/tokens';

/** A 2D point on the motif. */
export interface ArcPoint {
  x: number;
  y: number;
}

export interface ArcMotif {
  /** Launch point, just off the bottom-left corner. */
  p0: ArcPoint;
  /** Quadratic control point — the top of the ball's flight. */
  c: ArcPoint;
  /** Rim point, upper-right. */
  p1: ArcPoint;
  /** SVG path string (`M … Q …`) for Skia's Path. */
  path: string;
  /** Point on the quadratic Bézier at t ∈ [0, 1]. JS thread only. */
  pointAt: (t: number) => ArcPoint;
}

/**
 * How far the rim point sits in from the right edge by default — Home's
 * hero value. BootIntro passes 72 (full-screen width breathes more).
 */
const DEFAULT_RIM_INSET = 44;

/**
 * The canonical shot-arc quadratic for a `width` × `height` canvas.
 *
 * Emits geometry byte-identical to the formulas BootIntro and Home's HeroArc
 * used to hand-roll: P0 = (−24, h+24), C = (0.36·w, −0.6·h),
 * P1 = (w − rimInset, 0.42·h). Pinned by arcReveal.test.ts — do not "clean
 * up" the arithmetic, the emitted path strings are the contract.
 */
export function arcMotif(
  width: number,
  height: number,
  opts?: { rimInset?: number },
): ArcMotif {
  const rimInset = opts?.rimInset ?? DEFAULT_RIM_INSET;
  const p0 = { x: -24, y: height + 24 };
  const c = { x: width * 0.36, y: -height * 0.6 };
  const p1 = { x: width - rimInset, y: height * 0.42 };
  const path = `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${p1.x} ${p1.y}`;
  return {
    p0,
    c,
    p1,
    path,
    pointAt: (t: number) => {
      const u = 1 - t;
      return {
        x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
        y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
      };
    },
  };
}

export interface ArcRevealProps {
  /** How much of the arc is revealed, 0..1. Defaults to the full arc. */
  progress?: number;
  width: number;
  height: number;
  /** Stroke color. Home's hero uses onAccent; default is the accent. */
  tint?: string;
  /** Ball dot riding the trim tip (at the rim when static). Default true. */
  dot?: boolean;
  /** Rim inset override, forwarded to arcMotif. */
  rimInset?: number;
  /**
   * false = no draw-in, render the full static arc (reduced motion always
   * does this regardless). Default true.
   */
  animate?: boolean;
}

/** HeroArc's double-stroke treatment — echo under crisp stroke. */
const ECHO_WIDTH = 7;
const ECHO_OPACITY = 0.08;
const STROKE_WIDTH = 3;
const STROKE_OPACITY = 0.22;
const DOT_RADIUS = 7;
const DOT_OPACITY = 0.9;
const HALO_RADIUS = 12;
const HALO_OPACITY = 0.12;

export function ArcReveal({
  progress = 1,
  width,
  height,
  tint = color.accent,
  dot = true,
  rimInset,
  animate = true,
}: ArcRevealProps) {
  const reducedMotion = useReducedMotion();
  const live = animate && !reducedMotion;
  const target = Math.min(1, Math.max(0, progress));

  // Trim head. Starts at 0 only when it will actually draw in; the static
  // path holds the finished arc from the first frame.
  const trim = useSharedValue(live ? 0 : 1);

  useEffect(() => {
    if (!live) {
      trim.value = 1;
      return;
    }
    trim.value = withTiming(target, {
      duration: motion.celebrate,
      easing: Easing.out(Easing.cubic),
    });
  }, [live, target, trim]);

  // Plain numbers only past this line — the derived values below close over
  // these, never over the motif object (it carries a JS function).
  const motif = arcMotif(width, height, rimInset != null ? { rimInset } : undefined);
  const p0x = motif.p0.x;
  const p0y = motif.p0.y;
  const cx = motif.c.x;
  const cy = motif.c.y;
  const p1x = motif.p1.x;
  const p1y = motif.p1.y;

  // Path trim runs in useDerivedValue; math stays inline in the worklet.
  const end = useDerivedValue(() => trim.value);
  const dotX = useDerivedValue(() => {
    const t = trim.value;
    const u = 1 - t;
    return u * u * p0x + 2 * u * t * cx + t * t * p1x;
  });
  const dotY = useDerivedValue(() => {
    const t = trim.value;
    const u = 1 - t;
    return u * u * p0y + 2 * u * t * cy + t * t * p1y;
  });

  if (width <= 0 || height <= 0) return null;

  return (
    <Canvas style={{ width, height }}>
      {/* Soft wide echo under the crisp stroke — same geometry, quieter
          opacity, so the arc reads as light rather than a line. */}
      <Path
        path={motif.path}
        style="stroke"
        strokeWidth={ECHO_WIDTH}
        color={tint}
        opacity={ECHO_OPACITY}
        start={0}
        end={end}
      />
      <Path
        path={motif.path}
        style="stroke"
        strokeWidth={STROKE_WIDTH}
        color={tint}
        opacity={STROKE_OPACITY}
        start={0}
        end={end}
      />
      {dot && (
        <>
          <Circle cx={dotX} cy={dotY} r={HALO_RADIUS} color={tint} opacity={HALO_OPACITY} />
          <Circle cx={dotX} cy={dotY} r={DOT_RADIUS} color={tint} opacity={DOT_OPACITY} />
        </>
      )}
    </Canvas>
  );
}

export default ArcReveal;
