/**
 * GoalRing — daily make-goal progress ring for Home.
 *
 * Same Skia progress-ring shape as TimerRing (src/components/modes/TimerRing.tsx)
 * plus the app's signature shot-arc motif traced faintly inside the ring, with
 * the make count over goal in the center. Past 75% the arc picks up a soft
 * heat glow; at/above 100% the ring and count flip to the make-green accent
 * and a small celebratory glow blooms behind the numeral. The first time the
 * goal is reached each day the ring also plays a one-shot celebration —
 * numeral pop + expanding ripple. Everything is reduced-motion aware: glows
 * hold at their resting opacity and the one-shot celebration is skipped.
 */
import { BlurMask, Canvas, Circle, Path, Skia } from '@shopify/react-native-skia';
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { goalProgress } from '../core/goals';
import { color, motion, space, type } from '../constants/tokens';

const SIZE = 120;
const STROKE = 10;
const R = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
/** Progress past which the arc picks up its subtle heat glow. */
const HOT_PROGRESS = 0.75;

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

/**
 * Day stamp of the last goal-reached celebration, per JS runtime. Keeps the
 * one-shot pop from replaying every time Home refocuses and remounts the ring
 * on a day the goal is already met. Presentation-only memory — it resets on
 * app restart, which is exactly as sticky as a celebration needs to be.
 */
let celebratedDay: string | null = null;

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
  /** Closing in (>75%) or done — the arc earns its glow. */
  const hot = complete || progress >= HOT_PROGRESS;
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

  // One-shot goal-reached celebration: numeral pop + expanding ripple, at
  // most once per day (module-level day stamp). Under reduced motion the
  // stamp is still set but nothing moves — the settled glow above already
  // marks the completed state.
  const pop = useSharedValue(0);
  const ripple = useSharedValue(0);
  useEffect(() => {
    if (!complete) return;
    const day = new Date().toDateString();
    if (celebratedDay === day) return;
    celebratedDay = day;
    if (reducedMotion) return;
    pop.value = 0;
    ripple.value = 0;
    pop.value = withSequence(
      withTiming(1, { duration: 300, easing: Easing.out(Easing.back(2.5)) }),
      withTiming(0, { duration: motion.celebrate - 300, easing: Easing.out(Easing.quad) }),
    );
    ripple.value = withTiming(1, { duration: motion.celebrate, easing: Easing.out(Easing.cubic) });
  }, [complete, pop, reducedMotion, ripple]);

  const glowOpacity = useDerivedValue(() => (complete ? 0.18 + glow.value * 0.22 : 0));
  const glowR = useDerivedValue(() => R * 0.55 + glow.value * (complete ? 8 : 0));
  const rippleR = useDerivedValue(() => R * (0.45 + ripple.value * 0.5));
  const rippleOpacity = useDerivedValue(() =>
    ripple.value > 0 ? (1 - ripple.value) * 0.5 : 0,
  );
  const centerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 1 + pop.value * 0.12 }],
  }));

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
        {hot && (
          <Path
            path={arcPath}
            style="stroke"
            strokeWidth={STROKE}
            strokeCap="round"
            color={ringColor}
            opacity={complete ? 0.55 : 0.4}
          >
            <BlurMask blur={7} style="normal" />
          </Path>
        )}
        <Path
          path={arcPath}
          style="stroke"
          strokeWidth={STROKE}
          strokeCap="round"
          color={ringColor}
        />
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={rippleR}
          style="stroke"
          strokeWidth={2}
          color={color.make}
          opacity={rippleOpacity}
        />
      </Canvas>
      <Animated.View style={[styles.center, centerStyle]} pointerEvents="none">
        <Text style={[styles.count, complete && { color: color.make }]}>{made}</Text>
        <Text style={styles.goal}>{`OF ${goal}`}</Text>
      </Animated.View>
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
