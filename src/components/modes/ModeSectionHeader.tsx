/**
 * ModeSectionHeader — static or collapsible section header for the mode picker.
 *
 * Static form (no onToggle): Eyebrow-style title + optional item count, with
 * the lede below. Toggle form (onToggle present): the whole row becomes a
 * 48px-tall Pressable with a trailing chevron; the lede renders only while
 * expanded. The Eyebrow look is rolled locally from tokens (ui.tsx Eyebrow
 * cannot carry the count chip — ui.tsx stays untouched).
 *
 * Fully prop-driven: collapse state lives in the caller (in-memory, defaults
 * expanded), and the caller owns haptics — none fire here. Motion: the chevron
 * is ONE glyph flipped by a shared-value pose (the CollapsibleSection idiom —
 * withTiming at motion.quick, snapped under reduced motion); the only other
 * motion is the pressed-state opacity.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, space, touch, type } from '@/constants/tokens';

export interface ModeSectionHeaderProps {
  /** 'Games', 'Drills', 'Quick start', 'Training tools'. */
  title: string;
  /** Item count chip, e.g. 7. */
  count?: number;
  /** Shown under the header ONLY when expanded (or when non-collapsible). */
  lede?: string | null;
  /** undefined → static header (no toggle affordance). */
  collapsed?: boolean;
  /** Present → renders as a Pressable toggle. */
  onToggle?: () => void;
}

export function ModeSectionHeader({
  title,
  count,
  lede,
  collapsed,
  onToggle,
}: ModeSectionHeaderProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();

  // Chevron pose: 0 = collapsed (points forward), 1 = expanded (points down).
  // Seeded from the mount-time state so first paint needs no animation. Hooks
  // run for the static form too (harmless — it renders no chevron).
  const chevronPose = useSharedValue(collapsed ? 0 : 1);
  useEffect(() => {
    const target = collapsed ? 0 : 1;
    // Snap instantly under reduced motion; otherwise a quick timed flip.
    chevronPose.value = reducedMotion
      ? target
      : withTiming(target, { duration: motion.quick });
  }, [collapsed, reducedMotion, chevronPose]);
  const chevronStyle = useAnimatedStyle(() => ({
    // One chevron-down glyph rotated -90° when collapsed reads as forward.
    transform: [{ rotate: `${(chevronPose.value - 1) * 90}deg` }],
  }));

  const a11yLabel = `${title}${count != null ? `, ${count} options` : ''}`;
  const showLede = lede != null && lede.length > 0 && !collapsed;

  const titleCluster = (
    <View style={styles.left}>
      <Text style={styles.title}>{title.toUpperCase()}</Text>
      {count != null && <Text style={styles.count}>{`(${count})`}</Text>}
    </View>
  );

  if (onToggle == null) {
    // Static header — plain eyebrow row, no toggle affordance.
    return (
      <View>
        <View accessible accessibilityRole="header" accessibilityLabel={a11yLabel}>
          {titleCluster}
        </View>
        {showLede && <Text style={styles.lede}>{lede}</Text>}
      </View>
    );
  }

  return (
    <View>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityHint={collapsed ? 'Expands this section' : 'Collapses this section'}
        accessibilityState={{ expanded: !collapsed }}
        style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}
      >
        {titleCluster}
        <Animated.View style={chevronStyle}>
          <Ionicons name="chevron-down" size={16} color={color.textDim} />
        </Animated.View>
      </Pressable>
      {showLede && <Text style={styles.lede}>{lede}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  left: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.xs,
  },
  // The system eyebrow style (type.eyebrow: 12/16, tracking 1.2) — replaces
  // the hand-rolled caption + letterSpacing 1 dialect.
  title: {
    ...type.eyebrow,
    color: color.textFaint,
  },
  count: {
    ...type.caption,
    color: color.textFaint,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
    minHeight: touch.minTarget,
  },
  pressed: {
    opacity: 0.7,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
});
