/**
 * TimerRing — countdown ring for the Timed Challenge mode.
 *
 * A Skia progress ring wrapping the seconds-left numeral. The arc drains
 * clockwise as time runs out and shifts leather → red under 10s so the pressure
 * reads from across the court. Glassy chip so it composites cheaply over the
 * live camera feed.
 */
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, space, type } from '../../constants/tokens';

const SIZE = 74;
const STROKE = 6;
const R = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
const LOW_SEC = 10;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export function TimerRing({
  timeLeftSec,
  progress,
}: {
  /** Seconds remaining (already Math.max(0, …) from the engine). */
  timeLeftSec: number;
  /** 0..1 elapsed fraction (fills as time drains). */
  progress: number;
}) {
  const secs = Math.ceil(Math.max(0, timeLeftSec));
  const low = secs <= LOW_SEC;
  const remain = Math.max(0, Math.min(1, 1 - progress));

  const trackPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(CENTER, CENTER, R);
    return p;
  }, []);

  const arcPath = useMemo(() => {
    const p = Skia.Path.Make();
    // Sweep from 12 o'clock clockwise for the remaining fraction.
    const sweep = 360 * remain;
    p.addArc(Skia.XYWHRect(STROKE / 2, STROKE / 2, R * 2, R * 2), -90, sweep);
    return p;
  }, [remain]);

  const arcColor = low ? color.miss : color.accent;

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityLabel={`${secs} seconds left`}
    >
      <Canvas style={styles.canvas}>
        <Path
          path={trackPath}
          style="stroke"
          strokeWidth={STROKE}
          color={color.hudGlassBorder}
          opacity={0.9}
        />
        <Path
          path={arcPath}
          style="stroke"
          strokeWidth={STROKE}
          strokeCap="round"
          color={arcColor}
        />
      </Canvas>
      <View style={styles.center} pointerEvents="none">
        <Text style={[styles.num, low && { color: color.miss }]}>{secs}</Text>
        <Text style={styles.unit}>SEC</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: SIZE,
    height: SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    width: SIZE,
    height: SIZE,
  },
  center: {
    ...absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  num: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
    marginBottom: -2,
  },
  unit: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.xs,
  },
});
