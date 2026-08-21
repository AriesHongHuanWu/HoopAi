/**
 * RadarChart — Skia radar/spider chart comparing the user's shooting profile
 * (accent gradient fill + vertex dots) against NBA-average (dashed chalk
 * outline) and elite (faint chalk envelope) references across the Shot Lab
 * benchmark axes. Axis labels are RN Text anchored around the canvas (Skia
 * text needs font assets; RN Text doesn't) and carry the user's 0–100 score
 * inline so each spoke is readable at a glance. A legend-chip row below the
 * canvas names the three series.
 *
 * Unmeasured axes (user score null) render at 0 and dim their label — the
 * shape stays honest instead of inventing a value.
 *
 * Optional draw-on reveal: PASSING `progress` opts ONLY the user series
 * (gradient fill, accent stroke, vertex dots) into a scale-up from the chart
 * center with an opacity fade on mount (Sparkline's exact contract). Grid,
 * spokes, elite envelope, NBA outline and the RN-Text labels are static from
 * frame one, and the final geometry is unchanged — the pop never redraws the
 * shape, so it can't imply a different profile. Omitting `progress` (default
 * 1) renders the finished chart statically, so existing callers stay
 * pixel-identical. Reduced motion always renders static. The transform
 * worklets return plain arrays over the shared value only — no JS helpers
 * (the fx/particles crash precedent).
 */
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  LinearGradient,
  Path,
  Skia,
  vec,
  type SkPath,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, radius, space, type } from '@/constants/tokens';
import type { RadarAxisScore } from '@/core/shotLab';

/** Space reserved around the polygon for the labels, px. */
const LABEL_RING = 36;
/** Absolute label box width, px (one line: axis name + score). */
const LABEL_W = 92;
/** Grid rings, as fractions of full score. */
const RINGS = [1 / 3, 2 / 3, 1] as const;
/** Accent hue (palette.leather) at graded alpha — Skia gradients need rgba strings. */
const USER_FILL_TOP = 'rgba(240, 90, 36, 0.40)';
const USER_FILL_BOTTOM = 'rgba(240, 90, 36, 0.07)';
/** Chalk hue at low alpha for the elite envelope. */
const ELITE_FILL = 'rgba(245, 241, 236, 0.06)';
const ELITE_EDGE = 'rgba(245, 241, 236, 0.18)';

/** Scale the user series pops in from (about the chart center). */
const POP_FROM_SCALE = 0.5;

function clampProgress01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface RadarChartProps {
  scores: readonly RadarAxisScore[];
  size: number;
  /**
   * Reveal target, 0..1. PROVIDING this prop opts the user series into a
   * scale/opacity pop on mount (static under reduced motion); omitting it
   * (the default, 1) renders the full chart statically — existing callers
   * stay pixel-identical.
   */
  progress?: number;
  accessibilityLabel?: string;
}

type LabelSide = 'left' | 'center' | 'right';

interface Geometry {
  grid: SkPath[];
  spokes: SkPath;
  user: SkPath;
  nba: SkPath;
  elite: SkPath;
  userDots: { x: number; y: number }[];
  labels: { x: number; y: number; text: string; score: string; measured: boolean; side: LabelSide }[];
  center: { x: number; y: number };
  radius: number;
}

function polygon(pts: { x: number; y: number }[]): SkPath {
  const p = Skia.Path.Make();
  if (pts.length === 0) return p;
  p.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) p.lineTo(pts[i]!.x, pts[i]!.y);
  p.close();
  return p;
}

export function RadarChart({ scores, size, progress, accessibilityLabel }: RadarChartProps) {
  const reducedMotion = useReducedMotion();
  const target = clampProgress01(progress ?? 1);
  // Draw-on only when the caller explicitly threaded a progress in — the
  // default renders finished from the first frame, exactly as before.
  const animateIn = progress != null && !reducedMotion;

  // Pop head. Starts at 0 only when it will actually draw in; otherwise it
  // holds the target so the static render is the finished chart.
  const pop = useSharedValue(animateIn ? 0 : target);

  useEffect(() => {
    if (!animateIn) {
      pop.value = target;
      return;
    }
    pop.value = withTiming(target, {
      duration: motion.celebrate,
      easing: Easing.out(Easing.cubic),
    });
  }, [animateIn, target, pop]);

  // Plain transform array + opacity for the user-series Group; math stays
  // inline in the worklets over the shared value only.
  const userTransform = useDerivedValue(() => [
    { scale: POP_FROM_SCALE + (1 - POP_FROM_SCALE) * pop.value },
  ]);
  const userOpacity = useDerivedValue(() => pop.value);

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

    const clamp01 = (v: number | null) => Math.max(0, Math.min(100, v ?? 0)) / 100;
    const shape = (pick: (s: RadarAxisScore) => number | null) =>
      polygon(scores.map((s, i) => at(i, clamp01(pick(s)))));

    // Vertex dots on the user polygon — measured axes only.
    const userDots = scores
      .map((s, i) => (s.user != null ? at(i, clamp01(s.user)) : null))
      .filter((p): p is { x: number; y: number } => p != null);

    const labels = scores.map((s, i) => {
      const p = at(i, 1);
      const lx = cx + (p.x - cx) * (1 + LABEL_RING / R / 1.4);
      const ly = cy + (p.y - cy) * (1 + LABEL_RING / R / 1.4);
      // Anchor by which side of the chart the spoke exits, so text grows
      // AWAY from the polygon instead of over it.
      const side: LabelSide =
        Math.abs(p.x - cx) < R * 0.35 ? 'center' : p.x > cx ? 'right' : 'left';
      return {
        x: lx,
        y: ly,
        text: s.axis.label,
        score: s.user != null ? String(Math.round(s.user)) : '—',
        measured: s.user != null,
        side,
      };
    });

    return {
      grid,
      spokes,
      user: shape((s) => s.user),
      nba: shape((s) => s.nba),
      elite: shape((s) => s.elite),
      userDots,
      labels,
      center: { x: cx, y: cy },
      radius: R,
    };
  }, [scores, size]);

  if (!geom) return <View style={{ width: size, height: size }} />;

  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      style={{ width: size, alignItems: 'center' }}
    >
      <View style={{ width: size, height: size }}>
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
          {/* Elite envelope: faint chalk fill + hairline edge under everything else. */}
          <Path path={geom.elite} color={ELITE_FILL} />
          <Path path={geom.elite} style="stroke" strokeWidth={1} color={ELITE_EDGE} />
          {/* NBA average: dashed chalk outline — clearly a reference, not you. */}
          <Path path={geom.nba} style="stroke" strokeWidth={1.5} color={color.textDim}>
            <DashPathEffect intervals={[6, 5]} />
          </Path>
          {/* The user: gradient fill + accent stroke + vertex dots. Unmistakable.
              The ONLY animated group — it pops about the chart center while the
              references hold still, and lands on the exact static geometry. */}
          <Group
            transform={userTransform}
            origin={vec(geom.center.x, geom.center.y)}
            opacity={userOpacity}
          >
            <Path path={geom.user}>
              <LinearGradient
                start={vec(geom.center.x, geom.center.y - geom.radius)}
                end={vec(geom.center.x, geom.center.y + geom.radius)}
                colors={[USER_FILL_TOP, USER_FILL_BOTTOM]}
              />
            </Path>
            <Path path={geom.user} style="stroke" strokeWidth={2.5} strokeJoin="round" color={color.accent} />
            {geom.userDots.map((p, i) => (
              <React.Fragment key={`ud-${i}`}>
                <Circle cx={p.x} cy={p.y} r={4} color={color.accent} />
                <Circle cx={p.x} cy={p.y} r={1.6} color={color.bg} />
              </React.Fragment>
            ))}
          </Group>
          <Circle cx={geom.center.x} cy={geom.center.y} r={2} color={color.textFaint} />
        </Canvas>
        {geom.labels.map((l) => {
          const top = Math.max(0, Math.min(l.y - 7, size - 14));
          const pos =
            l.side === 'center'
              ? { left: l.x - LABEL_W / 2, top, textAlign: 'center' as const }
              : l.side === 'right'
                ? { left: l.x - 6, top, textAlign: 'left' as const }
                : { left: l.x - LABEL_W + 6, top, textAlign: 'right' as const };
          return (
            <Text
              key={l.text}
              style={[styles.label, pos, { color: l.measured ? color.textDim : color.textFaint }]}
              numberOfLines={1}
            >
              {l.text.toUpperCase()}{' '}
              <Text style={{ color: l.measured ? color.accent : color.textFaint }}>{l.score}</Text>
            </Text>
          );
        })}
      </View>
      {/* Legend chips — who is who, in the series' own visual language. */}
      <View style={styles.legendRow}>
        <View style={styles.legendChip}>
          <View style={[styles.swatch, { backgroundColor: color.accent }]} />
          <Text style={styles.legendText}>You</Text>
        </View>
        <View style={styles.legendChip}>
          <View style={styles.swatchDashed} />
          <Text style={styles.legendText}>NBA avg</Text>
        </View>
        <View style={styles.legendChip}>
          <View style={[styles.swatch, { backgroundColor: ELITE_EDGE }]} />
          <Text style={styles.legendText}>Elite</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  label: {
    ...type.micro,
    position: 'absolute',
    width: LABEL_W,
    letterSpacing: 0.8,
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  legendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  legendText: {
    ...type.micro,
    color: color.textDim,
    textTransform: 'uppercase',
  },
  swatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  swatchDashed: {
    width: 10,
    height: 10,
    borderRadius: 3,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.textDim,
  },
});
