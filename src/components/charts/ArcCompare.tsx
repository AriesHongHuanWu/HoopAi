/**
 * ArcCompare — every decided shot's flight, normalized to a unit span
 * (release at left, rim arrival at right) and overlaid: makes in make-green,
 * misses in miss-red, with each group's AVERAGE arc drawn bold (the make
 * mean gets a soft glow — the user's money arc is the hero of the frame).
 * A dashed chalk reference shows an NBA-average launch angle fitted to the
 * same release→rim span, and entry-angle callouts by the rim answer "how
 * steep do I actually come in?" without leaving the chart.
 *
 * All arcs share one vertical scale, so a higher rainbow genuinely reads
 * higher. A hoop tick marks the common arrival point; a dashed floor line
 * with RELEASE/RIM end labels anchors the reading direction.
 */
import {
  BlurMask,
  Canvas,
  Circle,
  DashPathEffect,
  Line,
  Path,
  Skia,
  vec,
  type SkPath,
} from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { BENCHMARK_AXES } from '@/core/nbaBenchmarks';
import { meanArc, type NormalizedArc } from '@/core/shotLab';

const PAD = 14;
/** Extra room under the floor line for the RELEASE/RIM end labels. */
const PAD_BOTTOM = 34;
/** Fixed vertical reference (in normalized-arc units) so typical arcs fill
 *  the canvas but one moon ball can't crush the rest; taller arcs clamp. */
const REF_MAX_Y = 0.55;
/** NBA-average launch angle — single source: the radar's benchmark axes. */
const NBA_RELEASE_DEG =
  BENCHMARK_AXES.find((a) => a.key === 'releaseAngleDeg')?.nbaAvg ?? 48;
/** Series hues at graded alpha for Skia glow passes (rgba strings). */
const MAKE_GLOW = 'rgba(47, 214, 163, 0.5)';
const ACCENT_GLOW = 'rgba(240, 90, 36, 0.45)';

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
  /** Dashed NBA-average launch reference over the same span. */
  nbaRef: SkPath | null;
  /** Entry angles read off the drawn mean arcs' final segments, degrees. */
  makeEntryDeg: number | null;
  missEntryDeg: number | null;
  hoop: { x: number; y: number };
  baseY: number;
  calloutTop: number;
}

/** Angle of descent (° from horizontal) of a sampled arc's final segment. */
function entryDeg(pts: readonly { x: number; y: number }[]): number | null {
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2]!;
  const b = pts[pts.length - 1]!;
  const dx = b.x - a.x;
  if (dx <= 1e-6) return null;
  const deg = (Math.atan2(a.y - b.y, dx) * 180) / Math.PI;
  return Number.isFinite(deg) ? Math.round(deg) : null;
}

export function ArcCompare({ arcs, width, height, accessibilityLabel }: ArcCompareProps) {
  const geom = useMemo<Geometry | null>(() => {
    if (arcs.length === 0 || width <= 0 || height <= 0) return null;
    const innerW = width - PAD * 2;
    const innerH = height - PAD - PAD_BOTTOM;

    const mkMean = meanArc(arcs, 'make');
    const msMean = meanArc(arcs, 'miss');
    // Shared arrival point: end of the make mean (fallback: miss mean / any arc).
    const endPts = mkMean ?? msMean ?? arcs[0]!.pts;
    const end = endPts[endPts.length - 1]!;

    // NBA reference: a parabola through the same release→arrival span with
    // the NBA-average launch slope. Presentation-only geometry — it just
    // redraws a published launch angle inside the user's own frame.
    const xe = Math.max(0.05, Math.min(1, end.x));
    const slope = Math.tan((NBA_RELEASE_DEG * Math.PI) / 180);
    const quad = (end.y - slope * xe) / (xe * xe);
    let refPts: { x: number; y: number }[] | null = null;
    if (quad < 0) {
      refPts = [];
      for (let i = 0; i < 24; i++) {
        const x = (i / 23) * xe;
        refPts.push({ x, y: slope * x + quad * x * x });
      }
    }

    // One vertical scale for everything drawn (user arcs AND the reference).
    let maxY = 0.25;
    for (const a of arcs) for (const p of a.pts) if (p.y > maxY) maxY = p.y;
    if (refPts) for (const p of refPts) if (p.y > maxY) maxY = p.y;
    const refY = Math.min(Math.max(maxY, 0.3), REF_MAX_Y);
    const sy = innerH / refY;
    const baseY = height - PAD_BOTTOM;
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
    const hoop = {
      x: PAD + Math.max(0, Math.min(1, end.x)) * innerW,
      y: Math.max(PAD, baseY - Math.max(0, end.y) * sy),
    };
    return {
      makes,
      misses,
      makeMean: mkMean ? toPath(mkMean) : null,
      missMean: msMean ? toPath(msMean) : null,
      nbaRef: refPts ? toPath(refPts) : null,
      makeEntryDeg: mkMean ? entryDeg(mkMean) : null,
      missEntryDeg: msMean ? entryDeg(msMean) : null,
      hoop,
      baseY,
      calloutTop: Math.max(PAD + 28, Math.min(hoop.y + 12, baseY - 34)),
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
        {/* Floor line — grounds the frame, dashed so it reads as scaffolding. */}
        <Line
          p1={vec(PAD, geom.baseY + 5)}
          p2={vec(width - PAD, geom.baseY + 5)}
          strokeWidth={1.5}
          color={color.border}
        >
          <DashPathEffect intervals={[2, 6]} />
        </Line>
        {/* Individual flights: quiet, so the averages own the frame. */}
        {geom.misses.map((p, i) => (
          <Path key={`ms-${i}`} path={p} style="stroke" strokeWidth={1.5} color={color.miss} opacity={0.2} />
        ))}
        {geom.makes.map((p, i) => (
          <Path key={`mk-${i}`} path={p} style="stroke" strokeWidth={1.5} color={color.make} opacity={0.26} />
        ))}
        {/* NBA-average launch reference: dashed chalk, unmistakably not yours. */}
        {geom.nbaRef && (
          <Path path={geom.nbaRef} style="stroke" strokeWidth={2} strokeCap="round" color={color.textDim}>
            <DashPathEffect intervals={[7, 7]} />
          </Path>
        )}
        {geom.missMean && (
          <Path path={geom.missMean} style="stroke" strokeWidth={3} strokeCap="round" color={color.miss} />
        )}
        {/* The make mean is the hero: soft glow underlay + bold stroke. */}
        {geom.makeMean && (
          <Path path={geom.makeMean} style="stroke" strokeWidth={8} strokeCap="round" color={MAKE_GLOW}>
            <BlurMask blur={7} style="normal" />
          </Path>
        )}
        {geom.makeMean && (
          <Path path={geom.makeMean} style="stroke" strokeWidth={3.5} strokeCap="round" color={color.make} />
        )}
        {/* Arrival hoop tick with a warm halo. */}
        <Circle cx={geom.hoop.x} cy={geom.hoop.y} r={8} color={ACCENT_GLOW}>
          <BlurMask blur={6} style="normal" />
        </Circle>
        <Circle cx={geom.hoop.x} cy={geom.hoop.y} r={5} style="stroke" strokeWidth={2} color={color.accent} />
      </Canvas>
      {/* Legend chips — shape + color, never color alone. */}
      <View style={styles.legend} pointerEvents="none">
        <View style={styles.legendChip}>
          <View style={[styles.dot, { backgroundColor: color.make }]} />
          <Text style={styles.legendText}>Makes</Text>
        </View>
        <View style={styles.legendChip}>
          <Text style={styles.missX}>✕</Text>
          <Text style={styles.legendText}>Misses</Text>
        </View>
        {geom.nbaRef && (
          <View style={styles.legendChip}>
            <View style={styles.dashSwatch}>
              <View style={styles.dashSeg} />
              <View style={styles.dashSeg} />
            </View>
            <Text style={styles.legendText}>NBA {NBA_RELEASE_DEG}°</Text>
          </View>
        )}
      </View>
      {/* Entry-angle callouts by the rim. */}
      {(geom.makeEntryDeg != null || geom.missEntryDeg != null) && (
        <View style={[styles.callouts, { top: geom.calloutTop }]} pointerEvents="none">
          {geom.makeEntryDeg != null && (
            <Text style={[styles.calloutText, { color: color.make }]}>
              IN AT {geom.makeEntryDeg}°
            </Text>
          )}
          {geom.missEntryDeg != null && (
            <Text style={[styles.calloutText, { color: color.miss }]}>
              MISSES {geom.missEntryDeg}°
            </Text>
          )}
        </View>
      )}
      {/* End labels under the floor line. */}
      <Text style={[styles.axisLabel, { left: PAD }]} pointerEvents="none">
        RELEASE
      </Text>
      <Text style={[styles.axisLabel, { right: PAD }]} pointerEvents="none">
        RIM
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    position: 'absolute',
    top: 4,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  legendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  legendText: {
    ...type.micro,
    color: color.textDim,
    textTransform: 'uppercase',
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  missX: {
    ...type.micro,
    color: color.miss,
    fontSize: 9,
    lineHeight: 11,
  },
  dashSwatch: {
    flexDirection: 'row',
    gap: 2,
  },
  dashSeg: {
    width: 5,
    height: 2,
    borderRadius: 1,
    backgroundColor: color.textDim,
  },
  callouts: {
    position: 'absolute',
    right: 10,
    alignItems: 'flex-end',
    gap: 2,
  },
  calloutText: {
    ...type.micro,
    fontVariant: ['tabular-nums'],
  },
  axisLabel: {
    ...type.micro,
    color: color.textFaint,
    position: 'absolute',
    bottom: 6,
  },
});
