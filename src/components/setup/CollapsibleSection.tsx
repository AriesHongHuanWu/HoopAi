/**
 * CollapsibleSection — controlled expand/collapse card for the setup screen's
 * Options stack. The PARENT owns `expanded` (session-local state); this
 * component only reports header taps via `onToggle`, so a summary chip on the
 * hero can expand a section from the outside with the same state.
 *
 * Motion notes (iron rules): the body is a conditional render with a quick
 * FadeInDown — deliberately NO height animation, so there are no layout
 * animation dependencies and no per-frame allocations. The chevron flip is a
 * single shared value driven by withTiming; both are snapped/skipped under
 * reduced motion.
 */
import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { Card, Eyebrow } from '@/components/ui';
import { color, motion, space, touch, type } from '@/constants/tokens';

export function CollapsibleSection({
  title,
  subtitle,
  expanded,
  onToggle,
  children,
  entering,
  plainBody = false,
  onLayout,
}: {
  title: string;
  /** Current-value summary shown under the title (e.g. "On · Makes only"). */
  subtitle?: string;
  /** Controlled — the parent owns expand/collapse state. */
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  /** Optional reanimated entrance (mount stagger), forwarded to the Card. */
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
  /**
   * Skip the Card chrome and render header + body in a plain View. Used by
   * the Calibration section, whose child (CalibrationHealthCard) draws its
   * own Card — nesting two Cards would double-box it.
   */
  plainBody?: boolean;
  /**
   * Fires on the OUTER wrapper so the parent can record each section's Y
   * offset (hero summary chips scroll to their section).
   */
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const reducedMotion = useReducedMotion();

  // Chevron pose: 0 = collapsed (points down), 1 = expanded (points up).
  // Seeded from the mount-time `expanded` so first paint needs no animation.
  const chevronPose = useSharedValue(expanded ? 1 : 0);
  useEffect(() => {
    const target = expanded ? 1 : 0;
    // Snap instantly under reduced motion; otherwise a quick timed flip.
    chevronPose.value = reducedMotion
      ? target
      : withTiming(target, { duration: motion.quick });
  }, [expanded, reducedMotion, chevronPose]);
  const chevronStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${chevronPose.value * 180}deg` }],
  }));

  const header = (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={subtitle != null ? `${title}, ${subtitle}` : title}
      accessibilityHint={expanded ? 'Collapses this section' : 'Expands this section'}
      style={styles.header}
    >
      <View style={styles.headerText}>
        <Eyebrow>{title}</Eyebrow>
        {subtitle != null && (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      <Animated.View style={chevronStyle}>
        <Ionicons name="chevron-down" size={18} color={color.textDim} />
      </Animated.View>
    </Pressable>
  );

  // Conditional render — collapsed sections cost nothing; expanding fades the
  // body in. No exiting animation: unmount is instant by design (content
  // above the fold must never lag a collapse tap).
  const body = expanded ? (
    <Animated.View
      entering={reducedMotion ? undefined : FadeInDown.duration(motion.quick)}
      style={styles.body}
    >
      {children}
    </Animated.View>
  ) : null;

  if (plainBody) {
    return (
      <View onLayout={onLayout}>
        <Animated.View entering={entering} style={styles.section}>
          {header}
          {body}
        </Animated.View>
      </View>
    );
  }
  return (
    <View onLayout={onLayout}>
      <Card entering={entering} style={styles.section}>
        {header}
        {body}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touch.minTarget,
    gap: space.md,
  },
  headerText: {
    flex: 1,
  },
  subtitle: {
    ...type.body,
    color: color.textDim,
  },
  body: {
    marginTop: space.md,
  },
});
