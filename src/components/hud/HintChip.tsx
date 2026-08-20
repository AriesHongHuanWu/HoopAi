/**
 * HintChip — a one-shot contextual hint pill (live HUD + summary).
 *
 * Reads the persisted hintSeen ledger (settingsStore v7): once a hint has been
 * dismissed anywhere it renders null everywhere, forever. Tapping anywhere on
 * the chip dismisses it (markHintSeen); the optional accent action fires
 * onAction FIRST and then dismisses. Pre-migration hydration is treated as
 * UNSEEN — only an explicit `true` hides — so a store that has not run the
 * v6→7 migration yet shows the hint rather than silently swallowing it.
 *
 * Visual: the same layered-glass language as every HUD chip (composes
 * HudChip), with a sparkles glyph and honesty-first caption copy. Purely
 * informational — no judgment inputs, no haptics, no loops; the only motion is
 * a single reduced-motion-aware entrance fade. The chip claims its own taps,
 * so call sites place it inside pointerEvents="box-none" containers.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeInDown, ReduceMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';

import { color, motion, space, touch, type } from '@/constants/tokens';
import { useSettings, type HintKey } from '@/state/settingsStore';
import { HudChip } from './HudChip';

export function HintChip({
  hintKey,
  text,
  actionLabel,
  onAction,
  style,
}: {
  hintKey: HintKey;
  text: string;
  /** Optional accent text button (e.g. "How calls are made"). */
  actionLabel?: string;
  /** Fires before the hint is marked seen, so navigation wins the race. */
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  // Only an explicit `true` hides: pre-migration hydration (hintSeen missing)
  // must SHOW the hint, never hide it.
  const seen = useSettings((s) => s.hintSeen?.[hintKey] === true);
  const markHintSeen = useSettings((s) => s.markHintSeen);
  if (seen) return null;

  return (
    <Animated.View
      entering={FadeInDown.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      style={style}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${text}. Double-tap to dismiss.`}
        onPress={() => markHintSeen(hintKey)}
      >
        <HudChip style={styles.chip}>
          <Ionicons name="sparkles-outline" size={13} color={color.accent} />
          <Text style={styles.text} numberOfLines={2}>
            {text}
          </Text>
          {actionLabel != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={actionLabel}
              hitSlop={{ top: 12, bottom: 12, left: 8, right: 8 }}
              style={styles.action}
              onPress={() => {
                onAction?.();
                markHintSeen(hintKey);
              }}
            >
              <Text style={styles.actionText}>{actionLabel}</Text>
            </Pressable>
          )}
        </HudChip>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  text: {
    ...type.caption,
    color: color.text,
    flex: 1,
  },
  action: {
    minHeight: touch.minTarget,
    justifyContent: 'center',
    paddingLeft: space.xs,
  },
  actionText: {
    ...type.bodyMedium,
    color: color.accent,
  },
});
