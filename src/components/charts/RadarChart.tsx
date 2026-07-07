/**
 * RadarChart — Skia radar/spider chart comparing the user's shooting profile
 * (accent, filled) against NBA-average (chalk stroke) and elite (faint fill)
 * references across the Shot Lab benchmark axes. Axis labels are RN Text
 * positioned around the canvas (Skia text needs font assets; RN Text doesn't).
 *
 * Unmeasured axes (user score null) render at 0 and dim their label — the
 * shape stays honest instead of inventing a value.
 */
import { Canvas, Circle, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, type } from '@/constants/tokens';
import type { RadarAxisScore } from '@/core/shotLab';

/** Space reserved around the polygon for the labels, px. */
const LABEL_RING = 34;
/** Grid rings, as fractions of full score. */
const RINGS = [1 / 3, 2 / 3, 1] as const;

export interface RadarChartProps {
  scores: readonly RadarAxisScore[];
  size: number;
  accessibilityLabel?: string;
}

interface Geometry {
  grid: SkPath[];
  spokes: SkPath;
  user: SkPath;
  nba: SkPath;
  elite: SkPath;
  labels: { x: number; y: number; text: string; measured: boolean }[];
  center: { x: number; y: number };
}

function polygon(pts: { x: number; y: number }[]): SkPath {
  const p = Skia.Path.Make();
  if (pts.length === 0) return p;
  p.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]!.x, pts[i]!.y);
  p.close();
  return p;
}

export function RadarChart({ scores, size, accessibilityLabel }: RadarChartProps) {
  const geom = useMemo<Geometry | null>(() => {
    const n = scores.length;
    if (n < 3 || size <= 0) return null;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - LABEL_RING;
    const angle = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
    const at = (i: number, frac: number) => ({
      x: cx + Math.cos(angle(i)) * R * frac,
      y: cy + Math.sin(angle(i)) * R * frac,
    });

    const grid = RINGS.map((f) =>
      polygon(scores.map((_, i) => at(i, f))),
    );
    const spokes = Skia.Path.Make();
    scores.forEach((_, i) => {
      spokes.moveTo(cx, cy);
      const p = at(i, 1);
      spokes.lineTo(p.x, p.y);
    });

    const shape = (pick: (s: RadarAxisScore) => number | null) =>
      polygon(scores.map((s, i) => at(i, Math.max(0, Math.min(100, pick(s) ?? 0)) / 100)));

    const labels = scores.map((s, i) => {
      const p = at(i, 1);
      const lx = cx + (p.x - cx) * (1 + LABEL_RING / R / 1.4);
      const ly = cy + (p.y - cy) * (1 + LABEL_RING / R / 1.4);
      return { x: lx, y: ly, text: s.axis.label, measured: s.user != null };
    });

    return {
      grid,
      spokes,
      user: shape((s) => s.user),
      nba: shape((s) => s.nba),
      elite: shape((s) => s.elite),
      labels,
      center: { x: cx, y: cy },
    };
  }, [scores, size]);

  if (!geom) return <View style={{ width: size, height: size }} />;

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={{ width: size, height: size }}
    >
      <Canvas style={{ width: size, height: size }}>
        {geom.grid.map((g, i) => (
          <Path
            key={`ring-${i}`}
            path={g}
            style="stroke"
            strokeWidth={1}
            color={color.border}
          />
        ))}
        <Path path={geom.spokes} style="stroke" strokeWidth={1} color={color.border} opacity={0.7} />
        {/* Elite envelope: faint fill under everything else. */}
        <Path path={geom.elite} color={color.text} opacity={0.06} />
        {/* NBA average: thin chalk outline. */}
        <Path path={geom.nba} style="stroke" strokeWidth={1.5} color={color.textFaint} />
        {/* The user: accent fill + stroke. */}
        <Path path={geom.user} color={color.accent} opacity={0.22} />
        <Path path={geom.user} style="stroke" strokeWidth={2} strokeJoin="round" color={color.accent} />
        <Circle cx={geom.center.x} cy={geom.center.y} r={2} color={color.textFaint} />
      </Canvas>
      {geom.labels.map((l) => (
        <Text
          key={l.text}
          style={[
            styles.label,
            {
              left: l.x - 44,
              top: l.y - 8,
              color: l.measured ? color.textDim : color.textFaint,
            },
          ]}
          numberOfLines={1}
        >
          {l.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...type.micro,
    position: 'absolute',
    width: 88,
    textAlign: 'center',
  },
});
