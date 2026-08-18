/**
 * StickyStartBar — bottom fallback START bar for /session/setup.
 *
 * Pure presentation, no store imports. The screen decides visibility (the bar
 * appears only once the StartHero CTA has scrolled off-screen, with
 * hysteresis), so two start CTAs are never visible at once. Mounted only when
 * visible: the FadeInUp entrance covers the appear moment and no exit
 * animation is attempted (Reanimated `exiting` is unreliable with plain
 * conditional rendering) — under reduced motion it mounts/unmounts plainly.
 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '@/components/ui';
import { color, motion, space, type } from '@/constants/tokens';

export interface StickyStartBarProps {
  /** True once the hero CTA is off-screen — the screen owns the hysteresis. */
  visible: boolean;
  /** Same disabled semantics as the hero CTA. */
  disabled: boolean;
  /** One-line session summary, e.g. "Free Play · Portrait · Makes only". */
  summary: string;
  /**
   * 'warning' paints the summary in the unsure/chalkYellow tint — the same
   * treatment as the hero's camera chip when permission is hard-denied.
   */
  tone?: 'default' | 'warning';
  onStart: () => void;
}

/** Accessibility label for the whole bar — the start action plus the summary. */
export function barAccessibilityLabel(summary: string): string {
  return `Start session. ${summary}`;
}

export function StickyStartBar({
  visible,
  disabled,
  summary,
  tone,
  onStart,
}: StickyStartBarProps) {
  // Hooks run unconditionally (before the early return) to keep order stable.
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  if (!visible) return null;
  return (
    <Animated.View
      entering={reducedMotion ? undefined : FadeInUp.duration(motion.quick)}
      accessibilityLabel={barAccessibilityLabel(summary)}
      style={[styles.bar, { paddingBottom: insets.bottom + space.md }]}
    >
      <Text
        style={[styles.summary, tone === 'warning' && styles.summaryWarning]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {summary}
      </Text>
      <PillButton
        label="START"
        variant="primary"
        icon="videocam"
        disabled={disabled}
        onPress={onStart}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // RN 0.86 dropped StyleSheet.absoluteFillObject — explicit edges only.
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.border,
    paddingTop: space.md,
    paddingHorizontal: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  summary: {
    flex: 1,
    ...type.caption,
    color: color.textDim,
  },
  /** The unsure/chalkYellow treatment — mirrors the hero's blocked-camera chip. */
  summaryWarning: {
    color: color.unsure,
  },
});
