/**
 * Records — lifetime numbers and the badge board.
 *
 * Hero "lifetime" numerals (makes, attempts, make rate, best streak) from the
 * career aggregates in SQLite, then the badge board split into Unlocked
 * (accent-tinted rows) and In progress (thin progress bar + "42/100" caption,
 * sorted nearest-to-unlock first). Rows cascade in with a small stagger;
 * under reduced motion they render statically.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { AnimatedProgressBar, ArcReveal, MotionStat, useCardStagger } from '@/components/motion';
// Concrete path, not the '@/components/motion' barrel: suites mock the barrel
// down to the symbols they assert on (the SegmentedTabs idiom).
import { useSkeletonExit } from '@/components/motion/stagger';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { AchievementRow } from '@/components/AchievementRow';
import { ProBadge } from '@/components/ProBadge';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen, SkeletonCard } from '@/components/ui';
import { color, layout, motion, radius, space, type } from '@/constants/tokens';
import { ACHIEVEMENTS, evaluate, type LifetimeTotals } from '@/core/achievements';
import { computeDayStreak } from '@/core/streak';
import { allSessionStartedAt, lifetimeTotals } from '@/data/db';
import { useAchievementsSeen } from '@/state/achievementsSeenStore';

/** Stagger index cap so long badge boards stay snappy. */
const STAGGER_CAP = 8;

/**
 * True once the persisted seen-badges store has rehydrated (same
 * zustand-persist gate as _layout.tsx's settings hydration). The NEW-pip
 * pass both reads AND writes it: run before hydration, markSeen would stamp
 * hasVisited/seenBadgeIds over the pre-hydration defaults — clobbering the
 * real persisted seen-set (every old badge floods back as NEW next visit)
 * or, on the hasVisited=false default, silently swallowing genuinely new pips.
 */
function useAchievementsSeenHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useAchievementsSeen.persist.hasHydrated());
  useEffect(() => {
    if (useAchievementsSeen.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useAchievementsSeen.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

/** Icon circle diameter on a personal-best tile, px. */
const PB_ICON_SIZE = 28;

/**
 * Height of the signature-arc canvas behind the career-makes hero. Covers the
 * scoreboard numeral plus its label so the arc reads as the number's backdrop.
 */
const HERO_ARC_H = 112;

/**
 * Personal-best tile — one lifetime number with a real identity: an Ionicons
 * glyph in a tinted circle, the value in broadcast condensed numerals, a
 * micro label underneath. Raised surface so the trio reads as a scoreboard
 * strip inside the hero card.
 */
function PbTile({
  icon,
  tint,
  tintBg,
  value,
  label,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  tint: string;
  tintBg: string;
  value: string;
  label: string;
}) {
  return (
    <View style={styles.pbTile} accessible accessibilityLabel={`${label}: ${value}`}>
      <View style={[styles.pbIcon, { backgroundColor: tintBg }]}>
        <Ionicons name={icon} size={15} color={tint} />
      </View>
      <Text style={styles.pbValue}>{value}</Text>
      <Text style={styles.pbLabel}>{label.toUpperCase()}</Text>
    </View>
  );
}

function BadgeList({
  defs,
  totals,
  unlocked,
  newIds,
}: {
  defs: readonly (typeof ACHIEVEMENTS)[number][];
  totals: LifetimeTotals;
  unlocked: boolean;
  /** Badge ids unlocked since the last visit — these rows get a "NEW" pip. */
  newIds?: readonly string[];
}) {
  // Canonical row cascade (undefined under reduced motion — static render).
  const enter = useCardStagger({ durationMs: motion.standard });
  return (
    <View style={styles.badgeList}>
      {defs.map((def, i) => (
        <Animated.View
          key={def.id}
          entering={enter(Math.min(i, STAGGER_CAP))}
        >
          <AchievementRow
            def={def}
            totals={totals}
            unlocked={unlocked}
            isNew={newIds?.includes(def.id) ?? false}
          />
        </Animated.View>
      ))}
    </View>
  );
}

export default function RecordsScreen() {
  const [totals, setTotals] = useState<LifetimeTotals | null>(null);
  // Snapshot of "unlocked since last visit" ids, fixed for this visit so the
  // NEW pips don't vanish mid-view when the seen-store updates underneath.
  const [newIds, setNewIds] = useState<readonly string[]>([]);
  // Longest career day-streak (consecutive calendar days shot) — computed from
  // all session dates, distinct from totals.bestStreak (consecutive makes).
  const [longestDayStreak, setLongestDayStreak] = useState(0);
  // Measured width of the hero card's inner stage, for the arc canvas.
  const [heroWidth, setHeroWidth] = useState(0);
  const seenHydrated = useAchievementsSeenHydrated();
  // The one skeleton dissolve: the placeholder fades under the arriving hero
  // instead of hard-cutting (undefined under reduced motion — plain swap).
  const skeletonExit = useSkeletonExit();

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void allSessionStartedAt().then((dates) => {
        if (!alive) return;
        setLongestDayStreak(computeDayStreak(dates, Date.now()).longest);
      });
      void lifetimeTotals().then((t) => {
        if (!alive) return;
        setTotals(t);
        // The pip pass must wait for the persisted seen-set (see
        // useAchievementsSeenHydrated) — the hydration flip re-creates this
        // callback and re-fires the effect while focused, so pips still land,
        // just never computed against (or written over) default store state.
        if (!seenHydrated) return;
        const unlockedIds = evaluate(t).unlocked.map((d) => d.id);
        const { hasVisited, seenBadgeIds, markSeen } = useAchievementsSeen.getState();
        // First visit ever: record everything silently, no pip shower.
        setNewIds(
          hasVisited ? unlockedIds.filter((id) => !seenBadgeIds.includes(id)) : [],
        );
        markSeen(unlockedIds);
      });
      return () => {
        alive = false;
      };
    }, [seenHydrated]),
  );

  if (totals === null) {
    return (
      <Screen scroll>
        <Row style={styles.headerRow}>
          <BackPill />
        </Row>
        <Eyebrow>Records</Eyebrow>
        <Text style={styles.title}>Lifetime</Text>
        {/* One loading language: the shape of the hero card that is arriving,
            dissolving under it (see useSkeletonExit). The Screen container
            reconciles across the swap, so the exit actually plays. */}
        <Animated.View exiting={skeletonExit}>
          <SkeletonCard hero lines={3} />
        </Animated.View>
      </Screen>
    );
  }

  const { unlocked, locked } = evaluate(totals);
  // Locked badges surface nearest-to-unlock first — the next chase on top.
  const lockedByProgress = [...locked].sort(
    (a, b) => b.progress(totals) - a.progress(totals),
  );
  const makeRate = totals.attempts > 0 ? Math.round((totals.makes / totals.attempts) * 100) : 0;
  const hasShots = totals.attempts > 0;

  return (
    <Screen scroll>
      <Row style={styles.headerRow}>
        <BackPill />
      </Row>
      <Row gap={space.sm} style={styles.titleRow}>
        <Eyebrow>Records</Eyebrow>
        <ProBadge long />
      </Row>
      <Text style={styles.title}>Lifetime</Text>

      <View style={styles.stack}>
        {/* Hero numerals */}
        <Card>
          <View
            onLayout={(e) => setHeroWidth(e.nativeEvent.layout.width)}
            style={styles.heroStage}
          >
            {/* The signature arc as the career number's backdrop — static
                (no draw-in): Records is a ledger, not a celebration. It sits
                BEHIND the MotionStat and stays decorative. */}
            {heroWidth > 0 && (
              <View
                style={StyleSheet.absoluteFill}
                pointerEvents="none"
                importantForAccessibility="no-hide-descendants"
              >
                <ArcReveal width={heroWidth} height={HERO_ARC_H} animate={false} />
              </View>
            )}
            {/* Career makes rolls in; trigger keyed on the value so a
                newly-set record re-rolls on the next visit. Always a plain
                integer (never '—'), so no static fallback branch needed. */}
            <MotionStat
              value={totals.makes}
              size="hero"
              label="career makes"
              tint={color.accent}
              trigger={totals.makes}
            />
          </View>
          <Row gap={space.sm} style={styles.heroRow}>
            <PbTile
              icon="basketball-outline"
              tint={color.accent}
              tintBg={color.accentTint}
              value={String(totals.attempts)}
              label="attempts"
            />
            <PbTile
              icon="analytics-outline"
              tint={color.make}
              tintBg={color.makeTint}
              value={`${makeRate}%`}
              label="make rate"
            />
            <PbTile
              icon="flame-outline"
              tint={color.threePt}
              tintBg={color.threePtTint}
              value={String(totals.bestStreak)}
              label="best streak"
            />
          </Row>
          <Row gap={space.sm} style={styles.heroRow}>
            <PbTile
              icon="calendar-outline"
              tint={color.accent}
              tintBg={color.accentTint}
              value={longestDayStreak > 0 ? `${longestDayStreak}d` : '—'}
              label="longest streak"
            />
            <PbTile
              icon="trophy-outline"
              tint={color.make}
              tintBg={color.makeTint}
              value={totals.bestWeekSessions > 0 ? String(totals.bestWeekSessions) : '—'}
              label="best week"
            />
            <PbTile
              icon="disc-outline"
              tint={color.threePt}
              tintBg={color.threePtTint}
              value={String(totals.threes)}
              label="career 3s"
            />
          </Row>
        </Card>

        {!hasShots && (
          <Card>
            <Text style={styles.heading}>Your trophy shelf is waiting</Text>
            <Text style={[styles.dim, { marginTop: space.xs }]}>
              Every make, streak and session counts toward a badge.
            </Text>
            <PillButton
              variant="ghost"
              label="Start a session"
              onPress={() => router.push('/session/setup')}
              style={styles.emptyCta}
            />
          </Card>
        )}

        {/* Unlocked badges */}
        {unlocked.length > 0 && (
          <View>
            <Row style={styles.sectionHeader}>
              {/* SectionEyebrow carries no bottom margin, so the old
                  eyebrowTrim counter-margin hack is gone with the ui.tsx
                  Eyebrow it existed to cancel. */}
              <SectionEyebrow icon="trophy-outline">Unlocked</SectionEyebrow>
              <Chip label={`${unlocked.length} of ${ACHIEVEMENTS.length}`} tone="accent" />
            </Row>
            {/* Board completion — decorative; the chip above carries the count
                (same a11y stance as the old hand-rolled track, which hid
                itself). The fill animates to its width via the shared bar. */}
            <View importantForAccessibility="no-hide-descendants" style={styles.boardBar}>
              <AnimatedProgressBar
                progress={unlocked.length / ACHIEVEMENTS.length}
                height={3}
              />
            </View>
            <BadgeList defs={unlocked} totals={totals} unlocked newIds={newIds} />
          </View>
        )}

        {/* Locked badges with progress */}
        {lockedByProgress.length > 0 && (
          <View>
            <Row style={styles.sectionHeader}>
              <SectionEyebrow icon="hourglass-outline">In progress</SectionEyebrow>
            </Row>
            <BadgeList defs={lockedByProgress} totals={totals} unlocked={false} />
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    marginBottom: space.lg,
  },
  titleRow: {
    justifyContent: 'space-between',
  },
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  stack: {
    // Common rhythm — see `layout` in constants/tokens.ts.
    gap: layout.sectionGap,
  },
  heroRow: {
    alignItems: 'stretch',
    marginTop: space.lg,
  },
  pbTile: {
    flex: 1,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    padding: space.md,
    gap: space.xs,
  },
  pbIcon: {
    width: PB_ICON_SIZE,
    height: PB_ICON_SIZE,
    borderRadius: PB_ICON_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  pbValue: {
    ...type.statMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  pbLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  /** Anchors the arc canvas behind the career-makes numeral. */
  heroStage: {
    minHeight: HERO_ARC_H,
    justifyContent: 'center',
  },
  boardBar: {
    marginBottom: space.md,
  },
  sectionHeader: {
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.xs,
  },
  badgeList: {
    gap: space.sm,
  },
  heading: {
    ...type.heading,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  emptyCta: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
});
