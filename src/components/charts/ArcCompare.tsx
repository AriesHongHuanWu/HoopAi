/**
 * ArcCompare — every decided shot's flight, normalized to a unit span
 * (release at left, rim arrival at right) and overlaid: makes in make-green,
 * misses in miss-red, with each group's AVERAGE arc drawn bold. The instant
 * visual answer to "how do my makes fly differently from my misses?".
 *
 * All arcs share one vertical scale, so a higher rainbow genuinely reads
 * higher. A hoop tick marks the common arrival point.
 */
import { Canvas, Circle, Path, Skia, type SkPath } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '@/constants/tokens';
import { meanArc, type NormalizedArc } from '@/core/shotLab';

const PAD = 14;
/** Fixed vertical reference (in normalized-arc units) so typical arcs fill
 *  the canvas but one moon ball can't crush the rest; taller arcs clamp. */
const REF_MAX_Y = 0.55;

export interface ArcCompareProps {
  arcs: readonly NormalizedArc[];
  width: number;
  height: number;
  accessibilityLabel?: string;
}

interface Geometry {
  makes: SkPath[];
  misses: SkPath[];
  makeMean: SkPath | null;
  missMean: SkPath | null;
  hoop: { x: number; y: number };
}

export function ArcCompare({ arcs, width, height, accessibilityLabel }: ArcCompareProps) {
  const geom = useMemo<Geometry | null>(() => {
    if (arcs.length === 0 || width <= 0 || height <= 0) return null;
    const innerW = width - PAD * 2;
    const innerH = height - PAD * 2;
    let maxY = 0.25;
    for (const a of arcs) for (const p of a.pts) if (p.y > maxY) maxY = p.y;
    const refY = Math.min(Math.max(maxY, 0.3), REF_MAX_Y);
    const sy = innerH / refY;
    const baseY = height - PAD;
    const toPath = (pts: readonly { x: number; y: number }[]): SkPath => {
      const path = Skia.Path.Make();
      pts.forEach((p, i) => {
        const x = PAD + Math.max(0, Math.min(1, p.x)) * innerW;
        const y = Math.max(PAD, baseY - Math.max(0, p.y) * sy);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      });
      return path;
    };
    const makes = arcs.filter((a) => a.outcome === 'make').map((a) => toPath(a.pts));
    const misses = arcs.filter((a) => a.outcome === 'miss').map((a) => toPath(a.pts));
    const mkMean = meanArc(arcs, 'make');
    const msMean = meanArc(arcs, 'miss');
    // Arrival marker: end of the make mean (fallback: any arc's end).
    const endPts = (mkMean ?? msMean ?? arcs[0]!.pts);
    const end = endPts[endPts.length - 1]!;
    return {
      makes,
      misses,
      makeMean: mkMean ? toPath(mkMean) : null,
      missMean: msMean ? toPath(msMean) : null,
      hoop: {
        x: PAD + Math.max(0, Math.min(1, end.x)) * innerW,
        y: Math.max(PAD, baseY - Math.max(0, end.y) * sy),
      },
    };
  }, [arcs, width, height]);

  if (!geom) {
    return <View style={{ width: Math.max(width, 0), height: Math.max(height, 0) }} />;
  }

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={{ width, height }}
    >
      <Canvas style={{ width, height }}>
        {geom.misses.map((p, i) => (
          <Path key={`ms-${i}`} path={p} style="stroke" strokeWidth={1.5} color={color.miss} opacity={0.28} />
        ))}
        {geom.makes.map((p, i) => (
          <Path key={`mk-${i}`} path={p} style="stroke" strokeWidth={1.5} color={color.make} opacity={0.32} />
        ))}
        {geom.missMean && (
          <Path path={geom.missMean} style="stroke" strokeWidth={3} strokeCap="round" color={color.miss} />
        )}
        {geom.makeMean && (
          <Path path={geom.makeMean} style="stroke" strokeWidth={3} strokeCap="round" color={color.make} />
        )}
        {/* Arrival hoop tick. */}
        <Circle cx={geom.hoop.x} cy={geom.hoop.y} r={5} style="stroke" strokeWidth={2} color={color.accent} />
      </Canvas>
      <View style={styles.legend} pointerEvents="none">
        <View style={[styles.dot, { backgroundColor: color.make }]} />
        <Text style={styles.legendText}>makes</Text>
        <View style={[styles.dot, { backgroundColor: color.miss }]} />
        <Text style={styles.legendText}>misses</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    position: 'absolute',
    top: 6,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginLeft: space.sm,
  },
  legendText: {
    ...type.micro,
    color: color.textDim,
  },
});
