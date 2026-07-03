/**
 * GoalRing — daily make-goal progress ring for Home.
 *
 * Same Skia progress-ring shape as TimerRing (src/components/modes/TimerRing.tsx)
 * plus the app's signature shot-arc motif traced faintly inside the ring, with
 * the make count over goal in the center. At/above 100% the ring and count
 * flip to the make-green accent and a small celebratory glow blooms behind
 * the numeral — reduced-motion aware (the glow holds at its resting opacity
 * instead of pulsing).
 */
import { Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { goalProgress } from '../core/goals';
import { color, space, type } from '../constants/tokens';

const SIZE = 120;
const STROKE = 10;
const R = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export function GoalRing({
  made,
  goal,
}: {
  /** Makes so far today (see src/core/goals.ts todayMakes). */
  made: number;
  /** Daily goal in makes. Callers should not render this component when goal <= 0. */
  goal: number;
}) {
  const reducedMotion = useReducedMotion();
  const progress = goalProgress(made, goal);
  const complete = goal > 0 && made >= goal;
  const ringColor = complete ? color.make : color.accent;

  const glow = useSharedValue(0);
  useEffect(() => {
    if (!complete) {
      glow.value = 0;
      return;
    }
    if (reducedMotion) {
      // Hold at a settled glow instead of pulsing.
      glow.value = 0.6;
      return;
    }
    glow.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [complete, glow, reducedMotion]);

  const glowOpacity = useDerivedValue(() => (complete ? 0.18 + glow.value * 0.22 : 0));
  const glowR = useDerivedValue(() => R * 0.55 + glow.value * (complete ? 8 : 0));

  const trackPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(CENTER, CENTER, R);
    return p;
  }, []);

  const arcPath = useMemo(() => {
    const p = Skia.Path.Make();
    const sweep = 360 * Math.max(0, Math.min(1, progress));
    if (sweep > 0) {
      p.addArc(Skia.XYWHRect(STROKE / 2, STROKE / 2, R * 2, R * 2), -90, sweep);
    }
    return p;
  }, [progress]);

  // Faint shot arc traced inside the ring — the signature motif, echoed at
  // small scale. Purely decorative, sits behind the numeral.
  const motifPath = useMemo(() => {
    const pad = STROKE + 14;
    return `M ${pad} ${SIZE - pad} Q ${CENTER} ${pad * 0.2} ${SIZE - pad} ${pad}`;
  }, []);

  const pct = Math.round(progress * 100);
  const label = complete
    ? `Daily goal reached, ${made} of ${goal} makes`
    : `Daily goal, ${made} of ${goal} makes, ${pct} percent`;

  return (
    <View style={styles.wrap} accessible accessibilityLabel={label}>
      <Canvas style={styles.canvas}>
        <Circle cx={CENTER} cy={CENTER} r={glowR} color={color.make} opacity={glowOpacity} />
        <Path
          path={motifPath}
          style="stroke"
          strokeWidth={2}
          color={color.text}
          opacity={0.14}
        />
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
          color={ringColor}
        />
      </Canvas>
      <View style={styles.center} pointerEvents="none">
        <Text style={[styles.count, complete && { color: color.make }]}>{made}</Text>
        <Text style={styles.goal}>{`OF ${goal}`}</Text>
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
  count: {
    ...type.statLarge,
    fontSize: 40,
    lineHeight: 42,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  goal: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.xs,
  },
});
