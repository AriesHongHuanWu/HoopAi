/**
 * SelectableChip — the ONE selectable pill.
 *
 * Filter rows and segment pickers had each hand-rolled the same chip with an
 * instant-cut selected state, so selection was the only interaction in the
 * app with no motion at all. This chip is the shared shape:
 *
 *  - PRESS: PressScale's exact spring (0.97 in {damping:20, stiffness:400},
 *    1 out {damping:16, stiffness:300}); under reduced motion, a plain
 *    pressed-opacity state instead — the PressScale idiom.
 *  - SELECTION: bg/border/label crossfade withTiming(motion.quick), the
 *    ModeSectionHeader chevron idiom (pose shared value seeded from mount
 *    state, snapped under reduced motion). No new raw worklets, no repeats.
 *  - HAPTIC: haptic.selection() through the settings gateway, ONLY on a tap
 *    that CHANGES the selection. Re-tapping the active chip of a radio row is
 *    silent; pass `deselects` when tapping the active chip clears it
 *    (multi-select filters) so that change ticks too.
 *
 * Rest/selected colors default to the hand-rolled chips' shared look
 * (border/textDim at rest; accent edge + tint + accent label selected), so
 * adoption is pixel-faithful at both rest states.
 */
import React, { useEffect } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  type AccessibilityState,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Ionicons } from '@expo/vector-icons';

import { color, iconSize, motion, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

/** Pressable that can carry a reanimated style — no wrapper view, so call-site
 *  layout styles (flex, margins) land exactly where they always did. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);


export interface SelectableChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
  /** A tap on the ACTIVE chip clears it (multi-select filter): tick that too. */
  deselects?: boolean;
  /** Selected border + label color. Default color.accent. */
  selectedColor?: string;
  /** Selected fill. Default color.accentTint. */
  selectedTint?: string;
  /** Rest fill the selection fades from. Default color.accentClear — accent
   *  at zero alpha, so the crossfade ramps one hue instead of passing
   *  through black. */
  unselectedTint?: string;
  /**
   * Render a checkmark while selected. Selection must never be carried by
   * COLOR ALONE (WCAG 1.4.1), so any chip that is the only marker of a
   * choice — a settings picker, a radio row — sets this. Filter rows whose
   * result is itself visible (the list below changes) may leave it off.
   */
  check?: boolean;
  /** 'button' (default) or 'radio' — match the row's semantics. */
  accessibilityRole?: 'button' | 'radio';
  /** Defaults to the label. */
  accessibilityLabel?: string;
  /** Defaults to {selected}; radio adopters pass their exact flags. */
  accessibilityState?: AccessibilityState;
  style?: StyleProp<ViewStyle>;
  labelStyle?: StyleProp<TextStyle>;
  testID?: string;
}

export function SelectableChip({
  label,
  selected,
  onPress,
  disabled = false,
  deselects = false,
  check = false,
  selectedColor = color.accent,
  selectedTint = color.accentTint,
  unselectedTint = color.accentClear,
  accessibilityRole = 'button',
  accessibilityLabel,
  accessibilityState,
  style,
  labelStyle,
  testID,
}: SelectableChipProps) {
  const reducedMotion = useReducedMotion();
  const scale = useSharedValue(1);
  // Selection pose: 0 = rest, 1 = selected. Seeded from mount-time state so
  // first paint needs no animation (the ModeSectionHeader chevron idiom).
  const pose = useSharedValue(selected ? 1 : 0);

  useEffect(() => {
    const target = selected ? 1 : 0;
    // Snap instantly under reduced motion; otherwise a quick timed crossfade.
    pose.value = reducedMotion ? target : withTiming(target, { duration: motion.quick });
  }, [selected, reducedMotion, pose]);

  // Declared above use, colors captured from the JS side — no helper worklets.
  const chipAnim = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: interpolateColor(pose.value, [0, 1], [unselectedTint, selectedTint]),
    borderColor: interpolateColor(pose.value, [0, 1], [color.border, selectedColor]),
  }));
  const labelAnim = useAnimatedStyle(() => ({
    color: interpolateColor(pose.value, [0, 1], [color.textDim, selectedColor]),
  }));

  const handlePress = () => {
    // Tick only when the tap changes the selection — see the header comment.
    if (deselects || !selected) haptic.selection();
    onPress();
  };

  const a11y = {
    accessibilityRole,
    accessibilityLabel: accessibilityLabel ?? label,
    accessibilityState: accessibilityState ?? { selected },
  } as const;

  if (reducedMotion) {
    // No spring, no crossfade — static colors and a pressed-opacity state.
    return (
      <Pressable
        onPress={handlePress}
        disabled={disabled}
        testID={testID}
        {...a11y}
        style={({ pressed }) => [
          styles.chip,
          {
            backgroundColor: selected ? selectedTint : unselectedTint,
            borderColor: selected ? selectedColor : color.border,
          },
          disabled && styles.disabled,
          style,
          pressed && { opacity: 0.85 },
        ]}
      >
        {check && selected && (
          <Ionicons
            name="checkmark"
            size={iconSize.sm}
            color={selectedColor}
            importantForAccessibility="no"
          />
        )}
        <Text
          style={[styles.label, { color: selected ? selectedColor : color.textDim }, labelStyle]}
          numberOfLines={1}
        >
          {label}
        </Text>
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      onPress={handlePress}
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 300 });
      }}
      disabled={disabled}
      testID={testID}
      {...a11y}
      style={[styles.chip, disabled && styles.disabled, style, chipAnim]}
    >
      {/* The check is a hard cut on purpose: it is the NON-COLOR marker, so
          it must be unambiguous the instant the choice changes rather than
          ramping in behind the tint. The colors still crossfade around it. */}
      {check && selected && (
        <Ionicons
          name="checkmark"
          size={iconSize.sm}
          color={selectedColor}
          importantForAccessibility="no"
        />
      )}
      <Animated.Text style={[styles.label, labelStyle, labelAnim]} numberOfLines={1}>
        {label}
      </Animated.Text>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: touch.minTarget,
    // Row + gap so a `check` chip lays out exactly like the hand-rolled one
    // it replaced; with a lone label the direction makes no difference.
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  disabled: {
    opacity: 0.4,
  },
  label: {
    ...type.bodyMedium,
  },
});

export default SelectableChip;
