/**
 * CountUp — a broadcast-style number roll for stat reveals (summary hero
 * numbers, personal-best values, FG%). The value eases from `from` to `to`
 * over a short window with tabular numerals (so digits don't jitter width as
 * they change), with an optional haptic "tick" at the settle.
 *
 * It's a reveal, not an idle loop: the roll fires once per `to`/`trigger`
 * change and then holds. Driven entirely by a `useSharedValue` clock feeding a
 * read-only `AnimatedTextInput` via `animatedProps` — the native text node is
 * updated on the UI thread with ZERO per-frame React re-render (the canonical
 * Reanimated pattern for frequently-changing text; a plain animated <Text>
 * cannot take a UI-thread `text` prop).
 *
 * Reduced motion: shows the final formatted value immediately (no roll), and
 * no haptic. Purely presentational.
 */
import React, { useEffect, useMemo } from 'react';
import { StyleSheet, TextInput, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedProps,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { scheduleOnRN } from 'react-native-worklets';

import { motion } from '@/constants/tokens';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);

export interface CountUpProps {
  /** Target value to land on. */
  to: number;
  /** Start value for the roll. Default 0. */
  from?: number;
  /** Roll duration (ms). Default motion.celebrate. */
  durationMs?: number;
  /** Decimal places to render. Default 0. */
  decimals?: number;
  /** Text prepended to the number (e.g. "$"). */
  prefix?: string;
  /** Text appended (e.g. "%", " PTS"). */
  suffix?: string;
  /**
   * Fire a light haptic when the roll settles. Default false — the caller
   * opts in so a screen full of CountUps doesn't buzz N times.
   */
  haptic?: boolean;
  /**
   * Re-run the roll when this changes (in addition to `to`). Useful when the
   * same target should replay on a view re-entry.
   */
  trigger?: number | string;
  style?: StyleProp<TextStyle>;
  /** Accessibility label override; defaults to the final formatted value. */
  accessibilityLabel?: string;
}

/** Format a numeric value with fixed decimals + affixes. Pure/worklet-safe. */
function format(v: number, decimals: number, prefix: string, suffix: string): string {
  'worklet';
  return prefix + v.toFixed(decimals) + suffix;
}

export function CountUp({
  to,
  from = 0,
  durationMs = motion.celebrate,
  decimals = 0,
  prefix = '',
  suffix = '',
  haptic = false,
  trigger,
  style,
  accessibilityLabel,
}: CountUpProps) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 1 : 0);
  // Guards the settle haptic so re-renders during the roll never double-fire it.
  const ticked = useSharedValue(false);

  const finalLabel = useMemo(
    () => format(to, decimals, prefix, suffix),
    [to, decimals, prefix, suffix],
  );

  useEffect(() => {
    if (reducedMotion) {
      progress.value = 1;
      return;
    }
    ticked.value = false;
    progress.value = 0;
    progress.value = withTiming(1, {
      duration: durationMs,
      easing: Easing.out(Easing.cubic),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, from, durationMs, trigger, reducedMotion]);

  const fireHaptic = () => {
    // Fire-and-forget; haptics can be unavailable (simulator, permissions).
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
  };

  const display = useDerivedValue(() => {
    const v = from + (to - from) * progress.value;
    // Settle tick: once, when the roll effectively completes.
    if (haptic && !ticked.value && progress.value >= 0.999) {
      ticked.value = true;
      scheduleOnRN(fireHaptic);
    }
    return format(v, decimals, prefix, suffix);
  });

  const animatedProps = useAnimatedProps(() => ({
    text: display.value,
    // `defaultValue` (uncontrolled) lets the UI-thread `text` prop drive the
    // node; a controlled `value` would fight it. Under reduced motion the roll
    // never runs, so this default IS the final value.
    defaultValue: reducedMotion ? finalLabel : format(from, decimals, prefix, suffix),
  }));

  return (
    <AnimatedTextInput
      animatedProps={animatedProps}
      editable={false}
      // Never focusable / never a real input — this is a display node.
      focusable={false}
      pointerEvents="none"
      // The rolling digits are decorative; the label carries the value.
      accessibilityLabel={accessibilityLabel ?? finalLabel}
      style={[styles.num, style]}
    />
  );
}

const styles = StyleSheet.create({
  num: {
    fontVariant: ['tabular-nums'],
    // Strip the TextInput's implicit vertical padding so it lays out like text.
    padding: 0,
  },
});

export default CountUp;
