/**
 * DayStreakShelf — the consecutive-practice-DAY badge shelf on the Profile tab.
 *
 * WHY this exists: src/core/dayStreakBadges.ts models a "don't break the chain"
 * ladder (3 / 7 / 14 / 30 / 60 / 100 days in a row) that no screen rendered, so
 * the reward loop was invisible. Records already shows the *number* of days;
 * this shows what that number BUYS, which is the part that pulls a player back
 * tomorrow.
 *
 * WHY two different streak numbers: badges are earned by the BEST-ever streak
 * (a thing you did stays done — breaking a streak never takes a badge away),
 * while the chase line ("N more days to …") comes from the CURRENT streak,
 * because that is the number the user can move today. Both come straight from
 * earnedDayStreakBadges(); this file computes no thresholds of its own.
 *
 * HONESTY: a badge here asserts only that the app recorded a session on that
 * many consecutive local days — nothing about how well those sessions went, and
 * the shelf says so. With no sessions at all it renders an honest empty state
 * with every rung locked, never a fabricated streak. While the session dates
 * are still loading it renders nothing rather than a placeholder zero.
 */
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { EnteringProp } from '@/components/motion';
import { Card, Chip, Eyebrow, Row, StatNumber } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import {
  DAY_STREAK_BADGES,
  dayStreakTier,
  earnedDayStreakBadges,
  streakStatusLine,
  type DayStreakBadge,
} from '@/core/dayStreakBadges';
import { computeDayStreak } from '@/core/streak';
import { allSessionStartedAt } from '@/data/db';

type IconName = ComponentProps<typeof Ionicons>['name'];

const MEDAL_SIZE = 34;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * One rung. Earned rungs light up in the accent; locked ones stay dim and
 * state their price in days, so the ladder reads as a plan rather than a wall.
 */
function BadgeTile({ badge, earned }: { badge: DayStreakBadge; earned: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={
        earned
          ? `${badge.name}, earned. ${badge.blurb}`
          : `${badge.name}, locked. Needs ${badge.days} ${plural(badge.days, 'day', 'days')} in a row.`
      }
      style={[styles.tile, earned ? styles.tileEarned : styles.tileLocked]}
    >
      <View style={[styles.medal, earned ? styles.medalEarned : styles.medalLocked]}>
        <Ionicons
          // Core keeps `icon` a plain string (no UI imports there); every name
          // on the ladder is a checked Ionicons glyph.
          name={badge.icon as IconName}
          size={17}
          color={earned ? color.accent : color.textFaint}
        />
      </View>
      <Text style={[styles.tileName, earned && styles.tileNameEarned]} numberOfLines={1}>
        {badge.name}
      </Text>
      <Text style={styles.tileDays}>{earned ? 'Earned' : `${badge.days} days`}</Text>
    </View>
  );
}

export function DayStreakShelf({ entering }: { entering?: EnteringProp }) {
  /** null = session dates not loaded yet; [] = loaded, user never practised. */
  const [startedAt, setStartedAt] = useState<readonly number[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void allSessionStartedAt()
        .then((dates) => {
          if (alive) setStartedAt(dates);
        })
        .catch(() => {
          if (alive) setStartedAt([]);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  // Read the clock once per data change — a badge shelf doesn't tick live.
  const streak = useMemo(
    () => (startedAt == null ? null : computeDayStreak(startedAt, Date.now())),
    [startedAt],
  );

  // Loading: render nothing rather than a zero that might be wrong.
  if (streak == null) return null;

  const { current, longest, shotToday } = streak;
  const standing = earnedDayStreakBadges(current, longest);
  const earnedIds = new Set(standing.earned.map((b) => b.id));
  const tier = dayStreakTier(longest);
  const neverPractised = (startedAt?.length ?? 0) === 0;

  return (
    <Card entering={entering}>
      <Row style={styles.head}>
        <Eyebrow>Day streak</Eyebrow>
        {tier != null && <Chip label={tier.name} tone="accent" />}
      </Row>

      {neverPractised ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No practice days recorded yet</Text>
          <Text style={styles.emptyBody}>
            Track one session and the chain starts. Every rung below is still locked.
          </Text>
        </View>
      ) : (
        <>
          <Row gap={space.xl} style={styles.statRow}>
            <StatNumber
              size="large"
              value={String(current)}
              label="day streak"
              tint={current > 0 ? color.accent : color.textDim}
            />
            <View style={styles.statDivider} />
            <StatNumber size="large" value={String(longest)} label="best ever" />
          </Row>
          <Text style={styles.status}>{streakStatusLine(current, shotToday)}</Text>
        </>
      )}

      <View style={styles.shelf}>
        {DAY_STREAK_BADGES.map((b) => (
          <BadgeTile key={b.id} badge={b} earned={earnedIds.has(b.id)} />
        ))}
      </View>

      <Text style={styles.next}>
        {standing.next != null && standing.daysToNext != null
          ? `${standing.daysToNext} more ${plural(standing.daysToNext, 'day', 'days')} in a row to earn ${standing.next.name}`
          : 'Every rung earned — 100 days is the top of the ladder'}
      </Text>
      <Text style={styles.footnote}>
        A badge only means a session was recorded on that many days in a row — it says nothing
        about how you shot.
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  head: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statRow: {
    alignItems: 'center',
    marginTop: space.xs,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
    backgroundColor: color.border,
  },
  status: {
    ...type.body,
    color: color.textDim,
    marginTop: space.sm,
  },
  empty: {
    gap: space.xs,
    paddingVertical: space.xs,
  },
  emptyTitle: {
    ...type.heading,
    color: color.text,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
  shelf: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.lg,
  },
  tile: {
    flexGrow: 1,
    flexBasis: '28%',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.md,
    paddingHorizontal: space.sm,
  },
  tileEarned: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  tileLocked: {
    backgroundColor: color.surface,
    borderColor: color.border,
    opacity: 0.6,
  },
  medal: {
    width: MEDAL_SIZE,
    height: MEDAL_SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medalEarned: {
    backgroundColor: color.accentTint,
  },
  medalLocked: {
    backgroundColor: color.surfaceRaised,
  },
  tileName: {
    ...type.caption,
    color: color.textDim,
    textAlign: 'center',
  },
  tileNameEarned: {
    color: color.text,
  },
  tileDays: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  next: {
    ...type.bodyMedium,
    color: color.text,
    marginTop: space.lg,
  },
  footnote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.xs,
  },
});
