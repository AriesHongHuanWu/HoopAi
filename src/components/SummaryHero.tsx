/**
 * SummaryHero — the broadcast box-score strip that opens the post-session
 * summary: MAKES | FG% | PTS in scoreboard numerals with a staggered
 * entrance, plus a one-shot celebration chip when the session earned one
 * (perfect night or a 5+ make heater).
 *
 * Visual-only: everything renders from the SessionStats already loaded by
 * the summary screen — no queries, no store writes. All motion is one-shot
 * and fully disabled under system reduced-motion.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  FadeInDown,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { StatNumber } from '@/components/ui';
import { color, font, motion, radius, space, type } from '@/constants/tokens';
import type { SessionStats } from '@/core/types';

/** Width of the moving shimmer band inside the celebration chip. */
const SHIMMER_WIDTH = 42;
/** Chip entrance waits for the box-score columns to land first. */
const CELEBRATION_DELAY_MS = 420;
/** Perfect-session celebration needs a non-trivial sample. */
const PERFECT_MIN_ATTEMPTS = 3;

/**
 * Perfect session — every shot decided AND made, over a non-trivial sample.
 * Exported (rather than re-derived by callers) so the summary screen can
 * suppress the redundant bestFgPct personal-best line when this predicate
 * already earned the PERFECT chip: a perfect night is definitionally the
 * career-best FG%, and two adjacent banners celebrating the same fact reads
 * as a duplicate, not a double win.
 */
export function isPerfectSession(stats: SessionStats): boolean {
  return (
    stats.attempts >= PERFECT_MIN_ATTEMPTS && stats.misses === 0 && stats.unsure === 0
  );
}

// ---------------------------------------------------------------------------
// CelebrationChip — one-shot pop + shimmer sweep, reduced-motion aware
// ---------------------------------------------------------------------------

function CelebrationChip({
  icon,
  label,
  fg,
  bg,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  fg: string;
  bg: string;
}) {
  const reducedMotion = useReducedMotion();
  // 0 → hidden/small, 1 → resting. Spring overshoot gives the trophy "pop".
  const pop = useSharedValue(reducedMotion ? 1 : 0);
  // 0 → 1 drives one shimmer band sweep across the chip. Never loops.
  const sweep = useSharedValue(0);
  const [chipWidth, setChipWidth] = useState(0);

  useEffect(() => {
    if (reducedMotion) {
      pop.value = 1;
      return;
    }
    pop.value = withDelay(
      CELEBRATION_DELAY_MS,
      withSpring(1, { damping: 12, stiffness: 200 }),
    );
  }, [reducedMotion, pop]);

  useEffect(() => {
    if (reducedMotion || chipWidth <= 0) return;
    sweep.value = 0;
    sweep.value = withDelay(
      CELEBRATION_DELAY_MS + motion.quick,
      withTiming(1, { duration: motion.celebrate }),
    );
  }, [reducedMotion, chipWidth, sweep]);

  const popStyle = useAnimatedStyle(() => ({
    opacity: Math.min(pop.value, 1),
    transform: [{ scale: 0.6 + 0.4 * pop.value }],
  }));

  const sweepStyle = useAnimatedStyle(() => ({
    opacity: interpolate(sweep.value, [0, 0.1, 0.9, 1], [0, 1, 1, 0]),
    transform: [
      { translateX: -SHIMMER_WIDTH + sweep.value * (chipWidth + SHIMMER_WIDTH * 2) },
      { skewX: '-16deg' },
    ],
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    setChipWidth(e.nativeEvent.layout.width);
  };

  return (
    <Animated.View
      onLayout={onLayout}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      style={[
        styles.chip,
        { backgroundColor: bg, borderColor: `${fg}40` },
        popStyle,
      ]}
    >
      <Ionicons name={icon} size={14} color={fg} />
      <Text style={[styles.chipLabel, { color: fg }]}>{label}</Text>
      {!reducedMotion && (
        <Animated.View pointerEvents="none" style={[styles.shimmer, sweepStyle]} />
      )}
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// SummaryHero
// ---------------------------------------------------------------------------

export function SummaryHero({
  stats,
  style,
}: {
  stats: SessionStats;
  style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  const fgValue = stats.attempts > 0 ? `${Math.round(stats.fgPct * 100)}%` : '—';

  // Celebration — derived purely from stats already on screen. A perfect
  // session (every shot decided AND made) outranks the heater; tiny perfect
  // sessions (1/1) stay quiet.
  const perfect = isPerfectSession(stats);
  const heater = !perfect && stats.bestStreak >= 5;

  const enter = (delayMs: number) =>
    reducedMotion ? undefined : FadeInDown.duration(motion.standard).delay(delayMs);

  const a11yLabel =
    stats.attempts > 0
      ? `Box score. ${fgValue} field goals. ${stats.makes} of ${stats.attempts} makes. ${stats.points} points.`
      : 'Box score. No shots recorded this session.';

  return (
    <View style={style}>
      <View style={styles.strip} accessible accessibilityLabel={a11yLabel}>
        <Animated.View entering={enter(90)} style={styles.col}>
          <StatNumber
            value={`${stats.makes}/${stats.attempts}`}
            label="makes"
            size="medium"
          />
        </Animated.View>
        <View style={styles.divider} />
        <Animated.View entering={enter(0)} style={styles.col}>
          <StatNumber value={fgValue} label="field goals" size="large" />
        </Animated.View>
        <View style={styles.divider} />
        <Animated.View entering={enter(160)} style={styles.col}>
          <StatNumber value={String(stats.points)} label="pts" size="medium" />
        </Animated.View>
      </View>
      {(perfect || heater) && (
        <View style={styles.chipRow}>
          <CelebrationChip
            icon={perfect ? 'trophy' : 'flame'}
            label={
              perfect
                ? 'Perfect session — every shot dropped'
                : `Heater — ${stats.bestStreak} straight makes`
            }
            fg={perfect ? color.make : color.threePt}
            bg={perfect ? color.makeTint : color.threePtTint}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: space.lg,
  },
  col: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 44,
    backgroundColor: color.border,
    marginBottom: space.xs,
  },
  chipRow: {
    alignItems: 'center',
    marginTop: space.lg,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: 7,
    overflow: 'hidden',
  },
  chipLabel: {
    ...type.caption,
    fontFamily: font.bodySemiBold,
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: SHIMMER_WIDTH,
    backgroundColor: 'rgba(245, 241, 236, 0.28)',
  },
});
