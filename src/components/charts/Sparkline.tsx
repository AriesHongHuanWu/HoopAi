/**
 * Sparkline — tiny Skia line + area chart for a 0..1 series (FG% trend).
 * Accent stroke over a vertical gradient fill that fades to nothing at the
 * baseline, soft halo + dot on the last point. Purely presentational; parent
 * supplies pixel width/height.
 */
import {
  Canvas,
  Circle,
  LinearGradient,
  Path,
  Rect,
  Skia,
  vec,
  type SkPath,
} from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { View } from 'react-native';

import { color } from '@/constants/tokens';

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

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface SparklineProps {
  /** Series of 0..1 values, oldest first. */
  data: readonly number[];
  width: number;
  height: number;
  /**
   * Accessible description for this chart. The Canvas itself can't carry a
   * semantic label, so when provided this wraps the chart in an accessible
   * View — pass it here instead of relying on the call site to remember its
   * own wrapper.
   */
  accessibilityLabel?: string;
}

interface SparklineGeometry {
  line: SkPath;
  area: SkPath;
  last: { x: number; y: number };
}

export function Sparkline({ data, width, height, accessibilityLabel }: SparklineProps) {
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

    const line = Skia.Path.Make();
    line.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) line.lineTo(pts[i].x, pts[i].y);

    const area = Skia.Path.Make();
    area.moveTo(pts[0].x, height);
    for (const pt of pts) area.lineTo(pt.x, pt.y);
    area.lineTo(pts[pts.length - 1].x, height);
    area.close();

    return { line, area, last: pts[pts.length - 1] };
  }, [data, width, height]);

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
          <Path path={geom.area}>
            <LinearGradient
              start={vec(0, 0)}
              end={vec(0, height)}
              colors={[FILL_TOP, FILL_BOTTOM]}
            />
          </Path>
        )}
        {data.length > 1 && (
          <Path
            path={geom.line}
            style="stroke"
            strokeWidth={2.5}
            strokeCap="round"
            strokeJoin="round"
            color={color.accent}
          />
        )}
        <Circle cx={geom.last.x} cy={geom.last.y} r={HALO_R} color={HALO_TINT} />
        <Circle cx={geom.last.x} cy={geom.last.y} r={DOT_R} color={color.accent} />
        <Circle cx={geom.last.x} cy={geom.last.y} r={CORE_R} color={color.text} />
      </Canvas>
    </View>
  );
}
