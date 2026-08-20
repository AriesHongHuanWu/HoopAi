/**
 * AnimatedProgressBar — a token-colored progress track whose fill animates to
 * the target width (motion.standard, ease-out cubic). Reduced motion sets the
 * width instantly instead of animating. Colors are token parameters only.
 */
import React, { useEffect, useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, radius } from '@/constants/tokens';

/** Clamp to [0, 1]; NaN maps to 0. Exported pure for tests. */
export function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface AnimatedProgressBarProps {
  /** 0..1 (clamped). */
  progress: number;
  height?: number;
  trackColor?: string;
  fillColor?: string;
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
}

export function AnimatedProgressBar({
  progress,
  height = 6,
  trackColor = color.surfaceRaised,
  fillColor = color.accent,
  style,
  accessibilityLabel,
}: AnimatedProgressBarProps) {
  const reducedMotion = useReducedMotion();
  const clamped = clamp01(progress);
  const [trackW, setTrackW] = useState(0);
  const fillW = useSharedValue(0);

  useEffect(() => {
    const target = clamped * trackW;
    if (reducedMotion) {
      // Reduced motion: land instantly, no tween.
      fillW.value = target;
      return;
    }
    fillW.value = withTiming(target, {
      duration: motion.standard,
      easing: Easing.out(Easing.cubic),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clamped, trackW, reducedMotion]);

  const fillStyle = useAnimatedStyle(() => ({ width: fillW.value }));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      onLayout={(e) => setTrackW(e.nativeEvent.layout.width)}
      style={[
        {
          height,
          borderRadius: radius.pill,
          backgroundColor: trackColor,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <Animated.View
        style={[
          { height: '100%', borderRadius: radius.pill, backgroundColor: fillColor },
          fillStyle,
        ]}
      />
    </View>
  );
}

export default AnimatedProgressBar;
