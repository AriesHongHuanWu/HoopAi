/**
 * PersonalBestBanner — the compact gold "NEW PERSONAL BEST" row shown on the
 * post-session summary, directly under the SummaryHero strip, when
 * detectNewBests (src/core/achievements.ts) says this session set at least
 * one CAREER record.
 *
 * Division of labor with SummaryHero's celebration chip: the chip celebrates
 * IN-SESSION moments (perfect night, 5+ heater); this banner celebrates
 * CAREER records (most makes ever, longest streak ever, best FG% ever) — the
 * two never describe the same thing, so both can appear.
 *
 * Motion is a single one-shot entrance (fade/slide + a small trophy pop),
 * fully disabled under system reduced-motion. Purely presentational: the
 * bests are computed upstream, nothing is fetched here.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  FadeInDown,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSpring,
} from 'react-native-reanimated';

import { color, font, motion, radius, space, type } from '@/constants/tokens';
import type { PersonalBest } from '@/core/achievements';

/** Trophy circle diameter, px. */
const TROPHY_SIZE = 36;
/** Banner waits for the hero box-score columns to land first. */
const ENTER_DELAY_MS = 360;

/** One line of copy per record kind. */
export function personalBestLine(pb: PersonalBest): string {
  switch (pb.kind) {
    case 'mostMakes':
      return `${pb.value} makes — your most ever in one session`;
    case 'bestStreak':
      return `${pb.value} straight — your longest run yet`;
    case 'bestFgPct':
      return `${Math.round(pb.value * 100)}% — your best shooting night`;
  }
}

export function PersonalBestBanner({
  bests,
  style,
}: {
  bests: readonly PersonalBest[];
  style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  // 0 → small, 1 → resting; spring overshoot gives the trophy its pop.
  const pop = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    if (reducedMotion) {
      pop.value = 1;
      return;
    }
    pop.value = withDelay(
      ENTER_DELAY_MS + motion.quick,
      withSpring(1, { damping: 11, stiffness: 220 }),
    );
  }, [reducedMotion, pop]);

  const trophyStyle = useAnimatedStyle(() => ({
    transform: [{ scale: 0.4 + 0.6 * pop.value }],
  }));

  if (bests.length === 0) return null;

  const a11yLabel = `New personal best. ${bests
    .map((pb) => personalBestLine(pb))
    .join('. ')}.`;

  return (
    <Animated.View
      entering={
        reducedMotion
          ? undefined
          : FadeInDown.duration(motion.standard).delay(ENTER_DELAY_MS)
      }
      accessible
      accessibilityRole="text"
      accessibilityLabel={a11yLabel}
      style={[styles.banner, style]}
    >
      <Animated.View style={[styles.trophy, trophyStyle]}>
        <Ionicons name="trophy" size={18} color={color.threePt} />
      </Animated.View>
      <View style={styles.body}>
        <Text style={styles.eyebrow}>NEW PERSONAL BEST</Text>
        {bests.map((pb) => (
          <Text key={pb.kind} style={styles.line}>
            {personalBestLine(pb)}
          </Text>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.threePtTint,
    borderColor: `${color.threePt}40`,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  trophy: {
    width: TROPHY_SIZE,
    height: TROPHY_SIZE,
    borderRadius: TROPHY_SIZE / 2,
    backgroundColor: color.threePtTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  eyebrow: {
    ...type.micro,
    color: color.threePt,
    letterSpacing: 1.2,
    marginBottom: 2,
  },
  line: {
    ...type.body,
    fontFamily: font.bodySemiBold,
    color: color.text,
  },
});
