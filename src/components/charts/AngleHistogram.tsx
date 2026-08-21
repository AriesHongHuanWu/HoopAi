/**
 * AngleHistogram — Skia histogram of entry angles across a session's decided
 * shots. 2° bins over the 30–60° domain, bars in the leather accent with the
 * 43–47° optimal band (FORM.entryAngle) shaded in swish tint behind them and
 * a chalk mean-marker line. Renders a quiet caption instead when fewer than
 * five angles are available.
 *
 * Optional draw-on reveal: PASSING `progress` opts the chart into a grow-up
 * of the bars from the baseline on mount (Sparkline's exact contract). One
 * shared value tweens 0→target over motion.celebrate; useDerivedValue
 * worklets rebuild the bin RRect paths at height h·reveal per frame, and the
 * optimal band + mean marker fade in on the same value. Omitting `progress`
 * (default 1) renders the finished chart statically, so every existing
 * caller stays pixel-identical. Reduced motion always renders static. The
 * worklets close over plain number arrays only and call no JS helpers (the
 * fx/particles crash precedent).
 */
import { Canvas, Path, Rect, Skia } from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Row } from '@/components/ui';
import { color, motion, space, type } from '@/constants/tokens';
import { FORM } from '@/core/config';
import type { ShotOutcome } from '@/core/types';

/** Histogram domain, degrees above horizontal. */
const DOMAIN_MIN = 30;
const DOMAIN_MAX = 60;
/** Bin width, degrees. */
const BIN_DEG = 2;
const BIN_COUNT = (DOMAIN_MAX - DOMAIN_MIN) / BIN_DEG;
/** Minimum angle samples before the distribution is worth drawing. */
const MIN_SAMPLES = 5;
/** Headroom above the tallest bar, px. */
const TOP_PAD = 10;
/** Gap between adjacent bars, px. */
const BAR_GAP = 3;
/** Mean marker line width, px. */
const MEAN_W = 1.5;
/** Chalk cap height on the latest bin, px. */
const CAP_H = 2.5;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Plain-number bar geometry the reveal worklets close over. */
interface BarGeometry {
  /** x of each non-latest bar with count > 0. */
  dimXs: number[];
  /** Full height of each non-latest bar (index-paired with dimXs). */
  dimHs: number[];
  /** Latest-shot bin bar; height 0 = nothing to draw yet. */
  latestX: number;
  latestH: number;
  barW: number;
  capR: number;
  /** Baseline y (bars grow up from here). */
  base: number;
}

/** Stable empty geometry so the pre-layout worklet closures never churn. */
const EMPTY_BARS: BarGeometry = {
  dimXs: [],
  dimHs: [],
  latestX: 0,
  latestH: 0,
  barW: 0,
  capR: 0,
  base: 0,
};

/**
 * Entry angles of decided (make | miss) shots, in shot order. Accepts both
 * ResolvedShot and db ShotRow shapes (each carries outcome + entryAngleDeg).
 */
export function decidedEntryAngles(
  shots: readonly { outcome: ShotOutcome; entryAngleDeg: number | null }[],
): number[] {
  const out: number[] = [];
  for (const s of shots) {
    if (s.outcome !== 'make' && s.outcome !== 'miss') continue;
    if (s.entryAngleDeg == null || !Number.isFinite(s.entryAngleDeg)) continue;
    out.push(s.entryAngleDeg);
  }
  return out;
}

export interface AngleHistogramProps {
  /** Entry angles (degrees) of decided shots — see {@link decidedEntryAngles}. */
  angles: readonly number[];
  /** Bar-area height in px; width fills the container. */
  height?: number;
  /**
   * Reveal target, 0..1. PROVIDING this prop opts the chart into a grow-up
   * draw-on to the target on mount (static under reduced motion); omitting
   * it (the default, 1) renders the full chart statically — existing
   * callers stay pixel-identical.
   */
  progress?: number;
}

interface HistogramModel {
  bins: number[];
  maxCount: number;
  mean: number;
  count: number;
  /** Bin holding the most recent shot's angle — emphasized in the render. */
  lastIdx: number;
  /** The most recent shot's angle, degrees. */
  last: number;
}

export function AngleHistogram({ angles, height = 120, progress }: AngleHistogramProps) {
  const [width, setWidth] = useState(0);
  const reducedMotion = useReducedMotion();
  const target = clamp01(progress ?? 1);
  // Draw-on only when the caller explicitly threaded a progress in — the
  // default renders finished from the first frame, exactly as before.
  const animateIn = progress != null && !reducedMotion;

  const model = useMemo<HistogramModel | null>(() => {
    const valid = angles.filter((a) => Number.isFinite(a));
    if (valid.length < MIN_SAMPLES) return null;
    const bins = new Array<number>(BIN_COUNT).fill(0);
    let sum = 0;
    let lastIdx = 0;
    for (const a of valid) {
      // Out-of-domain angles clamp into the edge bins so no shot vanishes.
      const idx = Math.min(
        BIN_COUNT - 1,
        Math.max(0, Math.floor((a - DOMAIN_MIN) / BIN_DEG)),
      );
      bins[idx] += 1;
      sum += a;
      lastIdx = idx;
    }
    return {
      bins,
      maxCount: Math.max(...bins),
      mean: sum / valid.length,
      count: valid.length,
      lastIdx,
      last: valid[valid.length - 1]!,
    };
  }, [angles]);

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

  // Plain-number bar geometry — the reveal worklets close over these arrays
  // and numbers, never over `model` (module objects don't cross the thread
  // boundary).
  const bars = useMemo<BarGeometry>(() => {
    if (model == null || width <= 0) return EMPTY_BARS;
    const slot = width / BIN_COUNT;
    const barW = Math.max(2, slot - BAR_GAP);
    const usableH = height - TOP_PAD - 1;
    const base = height - 1;
    const dimXs: number[] = [];
    const dimHs: number[] = [];
    let latestX = 0;
    let latestH = 0;
    model.bins.forEach((count, i) => {
      if (count === 0) return;
      const h = Math.max(3, (count / model.maxCount) * usableH);
      const x = slot * i + (slot - barW) / 2;
      if (i === model.lastIdx) {
        latestX = x;
        latestH = h;
      } else {
        dimXs.push(x);
        dimHs.push(h);
      }
    });
    return {
      dimXs,
      dimHs,
      latestX,
      latestH,
      barW,
      capR: Math.min(3, barW / 2),
      base,
    };
  }, [model, width, height]);

  const { dimXs, dimHs, latestX, latestH, barW, capR, base } = bars;

  // Bin RRect paths rebuilt at height h·reveal per frame. Skia clamps RRect
  // radii to the half-height, so the caps round exactly as the static bars
  // did. All math stays inline in the worklets over the plain values above.
  const dimBarsPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    for (let i = 0; i < dimXs.length; i++) {
      const h = dimHs[i]! * reveal.value;
      if (h <= 0) continue;
      path.addRRect(Skia.RRectXY(Skia.XYWHRect(dimXs[i]!, base - h, barW, h), capR, capR));
    }
    return path;
  });
  const latestBarPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const h = latestH * reveal.value;
    if (h <= 0) return path;
    path.addRRect(Skia.RRectXY(Skia.XYWHRect(latestX, base - h, barW, h), capR, capR));
    return path;
  });
  // Chalk cap rides the latest bar's top edge, like Sparkline's head dot.
  const capPath = useDerivedValue(() => {
    const path = Skia.Path.Make();
    const h = latestH * reveal.value;
    if (h <= 0) return path;
    path.addRRect(Skia.RRectXY(Skia.XYWHRect(latestX, base - h, barW, CAP_H), capR, capR));
    return path;
  });
  // Optimal band + mean marker fade in on the same value; both land on the
  // static opacities (1 and 0.8).
  const bandOpacity = useDerivedValue(() => reveal.value);
  const meanOpacity = useDerivedValue(() => 0.8 * reveal.value);

  if (model == null) {
    return (
      <Text style={styles.quiet}>
        Entry-angle spread appears once five decided shots have arc data.
      </Text>
    );
  }

  /** Degrees → x px, clamped to the domain. */
  const toX = (deg: number) =>
    ((Math.min(DOMAIN_MAX, Math.max(DOMAIN_MIN, deg)) - DOMAIN_MIN) /
      (DOMAIN_MAX - DOMAIN_MIN)) *
    width;

  const bandX = toX(FORM.entryAngle.min);
  const bandW = toX(FORM.entryAngle.max) - bandX;
  const meanX = Math.min(Math.max(toX(model.mean) - MEAN_W / 2, 0), width - MEAN_W);
  const usableH = height - TOP_PAD - 1;

  const a11yLabel =
    `Entry angle histogram across ${model.count} shots. ` +
    `Mean ${Math.round(model.mean)} degrees. ` +
    `Latest ${Math.round(model.last)} degrees. ` +
    `Optimal band ${FORM.entryAngle.min} to ${FORM.entryAngle.max} degrees.`;

  return (
    <View accessible accessibilityLabel={a11yLabel}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height }}
      >
        {width > 0 && (
          <Canvas style={{ width, height }}>
            {/* optimal-arc band behind everything */}
            <Rect
              x={bandX}
              y={0}
              width={bandW}
              height={height}
              color={color.makeTint}
              opacity={bandOpacity}
            />
            {/* count gridlines at 50% and 100% of the tallest bar */}
            <Rect
              x={0}
              y={height - 1 - usableH}
              width={width}
              height={1}
              color={color.border}
              opacity={0.35}
            />
            <Rect
              x={0}
              y={height - 1 - usableH / 2}
              width={width}
              height={1}
              color={color.border}
              opacity={0.55}
            />
            {/* baseline */}
            <Rect x={0} y={height - 1} width={width} height={1} color={color.border} />
            <Path path={dimBarsPath} color={color.accent} opacity={0.72} />
            <Path path={latestBarPath} color={color.accent} />
            {/* chalk cap on the bin holding the latest shot */}
            <Path path={capPath} color={color.text} opacity={0.9} />
            {/* mean marker */}
            <Rect
              x={meanX}
              y={0}
              width={MEAN_W}
              height={height - 1}
              color={color.text}
              opacity={meanOpacity}
            />
          </Canvas>
        )}
      </View>
      <Row style={{ justifyContent: 'space-between', marginTop: space.xs }}>
        <Text style={styles.axis}>{DOMAIN_MIN}°</Text>
        <Text style={styles.axis}>{(DOMAIN_MIN + DOMAIN_MAX) / 2}°</Text>
        <Text style={styles.axis}>{DOMAIN_MAX}°</Text>
      </Row>
      <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
        <Text style={styles.meta}>
          Mean {Math.round(model.mean)}° · Latest {Math.round(model.last)}°
        </Text>
        <Text style={[styles.meta, { color: color.make }]}>
          Optimal {FORM.entryAngle.min}–{FORM.entryAngle.max}°
        </Text>
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  quiet: {
    ...type.caption,
    color: color.textDim,
  },
  axis: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  meta: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
});
