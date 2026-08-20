/**
 * PressScale — spring press feedback for cards/tiles that aren't PillButton.
 *
 * The spring numbers are copied EXACTLY from ui.tsx PillButton (ui.tsx is
 * read-only): press-in scale 0.97 spring {damping:20, stiffness:400},
 * press-out scale 1 spring {damping:16, stiffness:300}. The animated style is
 * applied DIRECTLY on the AnimatedPressable — never a wrapper View, because a
 * wrapper broke call-site flex/margin layout (see the ui.tsx L99-101 comment).
 *
 * Never re-wrap PillButton with this — it already carries its own spring.
 *
 * Reduced motion: no spring; a pressed state dims to opacity 0.85 instead.
 * Optional haptic feedback routes through the settings-gated gateway in
 * src/utils/haptics.ts (never expo-haptics directly).
 */
import React from 'react';
import { Pressable, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { haptic as hapticGateway } from '@/utils/haptics';

/** Pressable that can carry a reanimated style — no wrapper view, so call-site
 *  layout styles (flex, margins) land exactly where they always did. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressScaleProps {
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /** Settings-gated haptic fired on press. Default 'none'. */
  haptic?: 'none' | 'selection' | 'impactLight';
  accessibilityRole?: React.ComponentProps<typeof Pressable>['accessibilityRole'];
  accessibilityLabel?: string;
  hitSlop?: React.ComponentProps<typeof Pressable>['hitSlop'];
}

export function PressScale({
  onPress,
  onLongPress,
  disabled,
  style,
  children,
  haptic = 'none',
  accessibilityRole = 'button',
  accessibilityLabel,
  hitSlop,
}: PressScaleProps) {
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePress = () => {
    if (haptic === 'selection') hapticGateway.selection();
    else if (haptic === 'impactLight') hapticGateway.impactLight();
    onPress();
  };

  if (reducedMotion) {
    // No spring under reduced motion — a plain pressed-opacity state instead.
    return (
      <Pressable
        onPress={handlePress}
        onLongPress={onLongPress}
        disabled={disabled}
        accessibilityRole={accessibilityRole}
        accessibilityLabel={accessibilityLabel}
        hitSlop={hitSlop}
        style={({ pressed }) => [style, pressed && { opacity: 0.85 }]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      onPress={handlePress}
      onLongPress={onLongPress}
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 300 });
      }}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      hitSlop={hitSlop}
      style={[style, animStyle]}
    >
      {children}
    </AnimatedPressable>
  );
}

export default PressScale;
