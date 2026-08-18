/**
 * Sparkline — tiny Skia line + area chart for a 0..1 series (FG% trend).
 * Accent stroke over a vertical gradient fill that fades to nothing at the
 * baseline, soft halo + dot on the last point. Purely presentational; parent
 * supplies pixel width/height.
 *
 * Optional draw-on reveal: PASSING `progress` opts the chart into a
 * left-to-right draw-in to that target on mount (the trends hero does this so
 * the line sweeps in with its CountUp numeral). The reveal is a Skia path
 * rebuilt per frame from the leading slice of the polyline — the exact
 * MiniArcReplay pattern, and `partialPolyline` (already workletised at its
 * definition) is the ONLY helper the worklet calls; everything else stays
 * inline over plain closed-over numbers (the fx/particles crash precedent).
 * Omitting `progress` (default 1) renders the finished chart statically, so
 * every existing caller stays pixel-identical. Reduced motion always renders
 * static.
 */
import {
  Canvas,
  Circle,
  LinearGradient,
  Path,
  Rect,
  Skia,
  vec,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion } from '@/constants/tokens';
import type { Point } from '@/core/types';

import { partialPolyline } from './miniArcReplayGeometry';

/** Inset so the stroke and last-point dot never clip. */
const PAD = 6;
/** Radius of the dot on the last point, px. */
const DOT_R = 4;
/** Radius of the chalk core inside the last-point dot, px. */
const CORE_R = 1.75;
/** Radius of the soft halo behind the last-point dot, px. */
const HALO_R = 9;

/** Gradient fill under the curve: accent at the crest, nothing at the floor. */
const FILL_TOP = 'rgba(240, 90, 36, 0.26)';
const FILL_BOTTOM = 'rgba(240, 90, 36, 0)';
/** Soft halo tint behind the latest point. */
const HALO_TINT = 'rgba(240, 90, 36, 0.22)';

/** Stable empty polyline so the pre-layout worklet closure never churns. */
const EMPTY_PTS: Point[] = [];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface SparklineProps {
  /** Series of 0..1 values, oldest first. */
  data: readonly number[];
  width: number;
  height: number;
  /**
   * Reveal target, 0..1. PROVIDING this prop opts the chart into a
   * left-to-right draw-on to the target on mount (static under reduced
   * motion); omitting it (the default, 1) renders the full chart statically —
   * existing callers stay pixel-identical.
   */
  progress?: number;
  /**
   * Accessible description for this chart. The Canvas itself can't carry a
   * semantic label, so when provided this wraps the chart in an accessible
   * View — pass it here instead of relying on the call site to remember its
   * own wrapper.
   */
  accessibilityLabel?: string;
}

interface SparklineGeometry {
  /** Normalized polyline points (plain objects — safe to close over in worklets). */
  pts: Point[];
  last: Point;
}

export function Sparkline({ data, width, height, progress, accessibilityLabel }: SparklineProps) {
  const reducedMotion = useReducedMotion();
  const target = clamp01(progress ?? 1);
  // Draw-on only when the caller explicitly threaded a progress in — the
  // default renders finished from the first frame, exactly as before.
  const animateIn = progress != null && !reducedMotion;

  const geom = useMemo<SparklineGeometry | null>(() => {
    if (width <= 0 || height <= 0 || data.length === 0) return null;
    const innerW = width - PAD * 2;
    const innerH = height - PAD * 2;
    const pts = data.map((v, i) => ({
      x:
        data.length === 1
          ? width - PAD
          : PAD + (i / (data.length - 1)) * innerW,
      y: PAD + (1 - clamp01(v)) * innerH,
    }));
    return { pts, last: pts[pts.length - 1] };
  }, [data, width, height]);

  // Reveal head. Starts at 0 only when it will actually draw in; otherwise it
  // holds the target so the static render is the finished chart.
  const reveal = useSharedValue(animateIn ? 0 : target);

  useEffect(() => {
    if (!animateIn) {
      reveal.value = target;
      return;
    }
    reveal.value = withTiming(target, {
      duration: motion.celebrate,
      easing: Easing.out(Easing.cubic),
    });
  }, [animateIn, target, reveal]);

  // Plain values only past this line — the worklets close over these, never
  // over `geom` (module objects don't cross the thread boundary).
  const pts = geom?.pts ?? EMPTY_PTS;
  const lastX = geom?.last.x ?? 0;
  const lastY = geom?.last.y ?? 0;

  // One leading slice per frame; the line path, area fill and head dot are all
  // views of it (the MiniArcReplay pattern — partialPolyline is the only
  // helper called from the worklet, and it carries the 'worklet' directive).
  const partial = useDerivedValue(() => partialPolyline(pts, reveal.value));
  const linePath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const p = partial.value;
    if (p.length < 2) return path;
    path.moveTo(p[0]!.x, p[0]!.y);
    for (let i = 1; i < p.length; i++) path.lineTo(p[i]!.x, p[i]!.y);
    return path;
  });
  const areaPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const p = partial.value;
    if (p.length < 2) return path;
    path.moveTo(p[0]!.x, height);
    for (let i = 0; i < p.length; i++) path.lineTo(p[i]!.x, p[i]!.y);
    path.lineTo(p[p.length - 1]!.x, height);
    path.close();
    return path;
  });
  // Dot rides the reveal tip; single-point series (no polyline) keep the
  // static last-point dot exactly where it always sat.
  const headX = useDerivedValue(() => {
    const p = partial.value;
    return p.length > 0 ? p[p.length - 1]!.x : lastX;
  });
  const headY = useDerivedValue(() => {
    const p = partial.value;
    return p.length > 0 ? p[p.length - 1]!.y : lastY;
  });

  if (geom == null) {
    return (
      <View
        accessible={accessibilityLabel != null}
        accessibilityLabel={accessibilityLabel}
        style={{ width: Math.max(width, 0), height: Math.max(height, 0) }}
      />
    );
  }

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height }}
    >
      <Canvas style={{ width, height }}>
        {/* quiet reference grid: 100% / 50% lines, solid baseline at 0 */}
        <Rect
          x={PAD}
          y={PAD}
          width={width - PAD * 2}
          height={1}
          color={color.border}
          opacity={0.35}
        />
        <Rect
          x={PAD}
          y={height / 2}
          width={width - PAD * 2}
          height={1}
          color={color.border}
          opacity={0.5}
        />
        <Rect
          x={PAD}
          y={height - PAD}
          width={width - PAD * 2}
          height={1}
          color={color.border}
          opacity={0.9}
        />
        {data.length > 1 && (
          <Path path={areaPath}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, height)}
              colors={[FILL_TOP, FILL_BOTTOM]}
            />
          </Path>
        )}
        {data.length > 1 && (
          <Path
            path={linePath}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={color.accent}
          />
        )}
        <Circle cx={headX} cy={headY} r={HALO_R} color={HALO_TINT} />
        <Circle cx={headX} cy={headY} r={DOT_R} color={color.accent} />
        <Circle cx={headX} cy={headY} r={CORE_R} color={color.text} />
      </Canvas>
    </View>
  );
}
