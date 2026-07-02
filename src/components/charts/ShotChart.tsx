/**
 * ShotChart — Skia scatter of resolved shots in camera space (v1: no court
 * calibration). Draws a subtle "court hint" (baseline + the signature shot
 * arc) underneath, then one mark per shot at the shooter's normalized origin:
 * make = filled dot, miss = X, unsure = ring — always color + shape.
 * Shots without a tracked origin cluster into an "unplaced" pip row below
 * the chart with a count caption.
 *
 * Also exports HeroArcStat — the summary hero: a scoreboard numeral with the
 * signature arc drawn behind it and a small ball dot at the arc's end.
 */
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';

import { MakeMissDot, Row, StatNumber } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import type { ResolvedShot } from '@/core/types';

/** Radius of a make dot / unsure ring, px. */
const MARK_R = 5;
/** Half-length of a miss X stroke, px. */
const X_ARM = 4.5;
/** Max distance (px) from a tap to a mark for the hit test to accept it. */
const HIT_RADIUS = 26;
/** Keep marks off the chart edges. */
const EDGE_PAD = 14;
/** Max pips shown in the unplaced cluster before "+N". */
const MAX_UNPLACED_PIPS = 16;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

interface PlacedShot {
  x: number;
  y: number;
  shot: ResolvedShot;
}

export interface ShotChartProps {
  shots: readonly ResolvedShot[];
  /** Chart height in px; width fills the container via onLayout. */
  height?: number;
  /** Called with the nearest plotted shot when the user taps the chart. */
  onSelect?: (shot: ResolvedShot) => void;
}

export function ShotChart({ shots, height = 200, onSelect }: ShotChartProps) {
  const [width, setWidth] = useState(0);

  const placed = useMemo<PlacedShot[]>(() => {
    if (width <= 0) return [];
    const out: PlacedShot[] = [];
    for (const shot of shots) {
      if (shot.originX == null || shot.originY == null) continue;
      out.push({
        x: EDGE_PAD + clamp01(shot.originX) * (width - 2 * EDGE_PAD),
        y: EDGE_PAD + clamp01(shot.originY) * (height - 2 * EDGE_PAD),
        shot,
      });
    }
    return out;
  }, [shots, width, height]);

  const unplaced = useMemo(
    () => shots.filter((s) => s.originX == null || s.originY == null),
    [shots],
  );

  /** Court hint: baseline + the signature shot arc, in hairline color. */
  const hintPath = useMemo(() => {
    if (width <= 0) return null;
    const p = Skia.Path.Make();
    const baseY = height - 10;
    p.moveTo(EDGE_PAD, baseY);
    p.lineTo(width - EDGE_PAD, baseY);
    p.moveTo(width * 0.14, baseY);
    p.quadTo(width * 0.5, height * 0.16, width * 0.86, baseY);
    return p;
  }, [width, height]);

  const makePath = useMemo(() => {
    const p = Skia.Path.Make();
    for (const { x, y, shot } of placed) {
      if (shot.outcome === 'make') p.addCircle(x, y, MARK_R);
    }
    return p;
  }, [placed]);

  const missPath = useMemo(() => {
    const p = Skia.Path.Make();
    for (const { x, y, shot } of placed) {
      if (shot.outcome !== 'miss') continue;
      p.moveTo(x - X_ARM, y - X_ARM);
      p.lineTo(x + X_ARM, y + X_ARM);
      p.moveTo(x + X_ARM, y - X_ARM);
      p.lineTo(x - X_ARM, y + X_ARM);
    }
    return p;
  }, [placed]);

  const unsurePath = useMemo(() => {
    const p = Skia.Path.Make();
    for (const { x, y, shot } of placed) {
      if (shot.outcome === 'unsure') p.addCircle(x, y, MARK_R);
    }
    return p;
  }, [placed]);

  const handlePress = (e: GestureResponderEvent) => {
    if (!onSelect) return;
    const { locationX, locationY } = e.nativeEvent;
    let best: PlacedShot | null = null;
    let bestD = HIT_RADIUS * HIT_RADIUS;
    for (const p of placed) {
      const dx = p.x - locationX;
      const dy = p.y - locationY;
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        best = p;
        bestD = d;
      }
    }
    if (best) onSelect(best.shot);
  };

  const makes = shots.filter((s) => s.outcome === 'make').length;
  const misses = shots.filter((s) => s.outcome === 'miss').length;
  const unsureCount = shots.length - makes - misses;
  const chartLabel =
    `Shot chart. ${shots.length} shots: ${makes} makes, ${misses} misses` +
    (unsureCount > 0 ? `, ${unsureCount} unsure.` : '.');

  return (
    <View>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height }}
        accessible={!onSelect}
        accessibilityLabel={onSelect ? undefined : chartLabel}
      >
        {width > 0 && (
          <Canvas style={{ width, height }}>
            {hintPath != null && (
              <Path
                path={hintPath}
                style="stroke"
                strokeWidth={1.5}
                strokeCap="round"
                color={color.border}
              />
            )}
            <Path path={makePath} color={color.make} />
            <Path
              path={missPath}
              style="stroke"
              strokeWidth={2}
              strokeCap="round"
              color={color.miss}
            />
            <Path
              path={unsurePath}
              style="stroke"
              strokeWidth={2}
              color={color.unsure}
            />
          </Canvas>
        )}
        {onSelect != null && width > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={chartLabel}
            accessibilityHint="Tap near a mark to select that shot"
            onPress={handlePress}
            style={StyleSheet.absoluteFill}
          />
        )}
      </View>

      <Row gap={space.lg} style={{ marginTop: space.sm }}>
        <Row gap={space.xs}>
          <MakeMissDot outcome="make" size={10} />
          <Text style={styles.legend}>Make</Text>
        </Row>
        <Row gap={space.xs}>
          <MakeMissDot outcome="miss" size={10} />
          <Text style={styles.legend}>Miss</Text>
        </Row>
        {unsureCount > 0 && (
          <Row gap={space.xs}>
            <MakeMissDot outcome="unsure" size={10} />
            <Text style={styles.legend}>Unsure</Text>
          </Row>
        )}
      </Row>

      {unplaced.length > 0 && (
        <View style={{ marginTop: space.md, gap: space.xs }}>
          <Row gap={space.xs} style={{ flexWrap: 'wrap' }}>
            {unplaced.slice(0, MAX_UNPLACED_PIPS).map((s) => (
              <MakeMissDot key={s.id} outcome={s.outcome} size={10} />
            ))}
            {unplaced.length > MAX_UNPLACED_PIPS && (
              <Text style={styles.legend}>
                +{unplaced.length - MAX_UNPLACED_PIPS}
              </Text>
            )}
          </Row>
          <Text style={styles.legend}>
            {unplaced.length === 1
              ? '1 shot had no tracked position'
              : `${unplaced.length} shots had no tracked position`}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------

/** Height of the hero block, px. */
const HERO_H = 176;

/**
 * Scoreboard hero: a huge numeral with the signature shot arc drawn behind it
 * and a ball dot where the arc lands. Used by the session summary and the
 * history detail screen.
 */
export function HeroArcStat({
  value,
  caption,
}: {
  value: string;
  caption?: string;
}) {
  const [width, setWidth] = useState(0);

  const arc = useMemo(() => {
    if (width <= 0) return null;
    const p = Skia.Path.Make();
    p.moveTo(width * 0.06, HERO_H - 30);
    p.quadTo(width * 0.5, -26, width * 0.94, HERO_H - 30);
    return p;
  }, [width]);

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={styles.hero}
    >
      {width > 0 && arc != null && (
        <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
          <Canvas style={{ width, height: HERO_H }}>
            <Path
              path={arc}
              style="stroke"
              strokeWidth={3}
              strokeCap="round"
              color={color.accent}
              opacity={0.55}
            />
            <Circle
              cx={width * 0.94}
              cy={HERO_H - 30}
              r={5}
              color={color.accent}
            />
          </Canvas>
        </View>
      )}
      <StatNumber value={value} size="hero" />
      {caption != null && <Text style={styles.heroCaption}>{caption}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  legend: {
    ...type.caption,
    color: color.textFaint,
  },
  hero: {
    height: HERO_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroCaption: {
    ...type.caption,
    color: color.textDim,
    letterSpacing: 1,
    marginTop: space.xs,
  },
});
