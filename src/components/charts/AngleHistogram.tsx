/**
 * AngleHistogram — Skia histogram of entry angles across a session's decided
 * shots. 2° bins over the 30–60° domain, bars in the leather accent with the
 * 43–47° optimal band (FORM.entryAngle) shaded in swish tint behind them and
 * a chalk mean-marker line. Renders a quiet caption instead when fewer than
 * five angles are available.
 */
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Row } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
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
}

interface HistogramModel {
  bins: number[];
  maxCount: number;
  mean: number;
  count: number;
}

export function AngleHistogram({ angles, height = 120 }: AngleHistogramProps) {
  const [width, setWidth] = useState(0);

  const model = useMemo<HistogramModel | null>(() => {
    const valid = angles.filter((a) => Number.isFinite(a));
    if (valid.length < MIN_SAMPLES) return null;
    const bins = new Array<number>(BIN_COUNT).fill(0);
    let sum = 0;
    for (const a of valid) {
      // Out-of-domain angles clamp into the edge bins so no shot vanishes.
      const idx = Math.min(
        BIN_COUNT - 1,
        Math.max(0, Math.floor((a - DOMAIN_MIN) / BIN_DEG)),
      );
      bins[idx] += 1;
      sum += a;
    }
    return {
      bins,
      maxCount: Math.max(...bins),
      mean: sum / valid.length,
      count: valid.length,
    };
  }, [angles]);

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

  const slot = width / BIN_COUNT;
  const barW = Math.max(2, slot - BAR_GAP);
  const capR = Math.min(3, barW / 2);
  const bandX = toX(FORM.entryAngle.min);
  const bandW = toX(FORM.entryAngle.max) - bandX;
  const meanX = Math.min(Math.max(toX(model.mean) - MEAN_W / 2, 0), width - MEAN_W);
  const usableH = height - TOP_PAD - 1;

  const a11yLabel =
    `Entry angle histogram across ${model.count} shots. ` +
    `Mean ${Math.round(model.mean)} degrees. ` +
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
            <Rect x={bandX} y={0} width={bandW} height={height} color={color.makeTint} />
            {/* baseline */}
            <Rect x={0} y={height - 1} width={width} height={1} color={color.border} />
            {model.bins.map((count, i) => {
              if (count === 0) return null;
              const h = Math.max(3, (count / model.maxCount) * usableH);
              return (
                <RoundedRect
                  key={i}
                  x={slot * i + (slot - barW) / 2}
                  y={height - 1 - h}
                  width={barW}
                  height={h}
                  r={capR}
                  color={color.accent}
                />
              );
            })}
            {/* mean marker */}
            <Rect
              x={meanX}
              y={0}
              width={MEAN_W}
              height={height - 1}
              color={color.text}
              opacity={0.8}
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
        <Text style={styles.meta}>Mean {Math.round(model.mean)}°</Text>
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
