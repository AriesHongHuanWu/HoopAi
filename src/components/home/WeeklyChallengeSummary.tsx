/**
 * WeeklyChallengeSummary — Home's COMPACT weekly deck: one pressable row
 * ('Weekly · ★ earned/offered · n/total done') over a single aggregate
 * progress bar, deep-linking to Train where the full read-only
 * WeeklyChallengeCard lives under CHALLENGES.
 *
 * WHY a separate component instead of a `compact` prop on WeeklyChallengeCard:
 * weeklyChallengeCard.test.tsx pins the full card's copy, row a11y labels and
 * fill colors — this is a SEPARATE render path so those pins stay untouched
 * while Home reclaims the fold.
 *
 * PURE PRESENTATION, same contract as the full card: every number comes from
 * src/core/weeklyChallenges.ts evaluate/points over the aggregate the parent
 * loaded. The parent (Home) still owns the week key, the aggregate load and
 * the award pass — awardWeekly keeps running on Home even though only this
 * summary renders (points writes are Home-owned by contract; modes.tsx
 * displays read-only). Navigation is a prop: the parent owns the typed route.
 *
 * HONESTY: the bar is the plain arithmetic mean of each challenge's clamped
 * progress/target fraction — an exact aggregate of db-derived numbers, never
 * a projection. A goal blocked by missing input contributes its true zero.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type Animated from 'react-native-reanimated';

import { AnimatedProgressBar } from '@/components/motion';
import { PressableCard } from '@/components/ui';
import { color, iconSize, space, type } from '@/constants/tokens';
import {
  evaluateWeekly,
  weeklyPoints,
  type WeekAggregate,
  type WeeklyChallengeDef,
} from '@/core/weeklyChallenges';

export interface WeeklyChallengeSummaryProps {
  /** This ISO week's deterministic picks (src/core/weeklyChallenges.ts). */
  challenges: readonly WeeklyChallengeDef[];
  /** The week's folded session facts. Pass an empty aggregate while loading. */
  agg: WeekAggregate;
  /** Press-through to the full deck — the parent pushes the typed '/modes'. */
  onPress: () => void;
  /** Card stagger entrance from the parent's useCardStagger. */
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}

export function WeeklyChallengeSummary({
  challenges,
  agg,
  onPress,
  entering,
}: WeeklyChallengeSummaryProps) {
  // Defensive, mirroring the full card: nothing drawn → nothing rendered.
  if (challenges.length === 0) return null;

  const results = evaluateWeekly(challenges, agg);
  const earned = weeklyPoints(results);
  const offered = results.reduce((sum, r) => sum + Math.max(0, r.def.points), 0);
  const done = results.filter((r) => r.done).length;
  const allDone = done === results.length;
  /** Mean of clamped per-challenge fractions — exact arithmetic, no projection. */
  const progress =
    results.reduce(
      (sum, r) => sum + (r.target > 0 ? Math.min(1, r.progress / r.target) : 0),
      0,
    ) / results.length;

  return (
    <PressableCard
      onPress={onPress}
      haptic="selection"
      entering={entering}
      accessibilityLabel={`Weekly challenges, ${earned} of ${offered} points earned, ${done} of ${results.length} done. Opens Train for the full list.`}
    >
      <View style={styles.row}>
        {/* '★ earned/offered', matching the decks' voice — PTS stays reserved
            for scored basketball points app-wide. */}
        <Text style={styles.line} numberOfLines={1}>
          {`Weekly · ★ ${earned}/${offered} · ${done}/${results.length} done`}
        </Text>
        <Ionicons name="chevron-forward" size={iconSize.sm} color={color.textFaint} />
      </View>
      <AnimatedProgressBar
        progress={progress}
        height={5}
        fillColor={allDone ? color.make : color.accent}
        style={styles.bar}
      />
    </PressableCard>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  line: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  bar: {
    marginTop: space.md,
  },
});
