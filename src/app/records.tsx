/**
 * Records — lifetime numbers and the badge board.
 *
 * Hero "lifetime" numerals (makes, attempts, make rate, best streak) from the
 * career aggregates in SQLite, then the badge board split into Unlocked
 * (accent-tinted rows) and In progress (thin progress bar + "42/100" caption,
 * sorted nearest-to-unlock first). Rows cascade in with a small stagger;
 * under reduced motion they render statically.
 */
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { AchievementRow } from '@/components/AchievementRow';
import { ProBadge } from '@/components/ProBadge';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, motion, space, type } from '@/constants/tokens';
import { ACHIEVEMENTS, evaluate, type LifetimeTotals } from '@/core/achievements';
import { lifetimeTotals } from '@/data/db';

/** Cascade step between badge rows (ms), capped so long boards stay snappy. */
const STAGGER_MS = 40;
const STAGGER_CAP = 8;

function BadgeList({
  defs,
  totals,
  unlocked,
}: {
  defs: readonly (typeof ACHIEVEMENTS)[number][];
  totals: LifetimeTotals;
  unlocked: boolean;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <View style={styles.badgeList}>
      {defs.map((def, i) =>
        reducedMotion ? (
          <AchievementRow key={def.id} def={def} totals={totals} unlocked={unlocked} />
        ) : (
          <Animated.View
            key={def.id}
            entering={FadeInDown.duration(motion.standard).delay(
              Math.min(i, STAGGER_CAP) * STAGGER_MS,
            )}
          >
            <AchievementRow def={def} totals={totals} unlocked={unlocked} />
          </Animated.View>
        ),
      )}
    </View>
  );
}

export default function RecordsScreen() {
  const [totals, setTotals] = useState<LifetimeTotals | null>(null);

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void lifetimeTotals().then((t) => {
        if (alive) setTotals(t);
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  if (totals === null) {
    return (
      <Screen scroll>
        <Row style={styles.headerRow}>
          <BackPill />
        </Row>
        <Eyebrow>Records</Eyebrow>
        <Text style={styles.title}>Lifetime</Text>
        <Text style={styles.dim}>Loading your records…</Text>
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
          <StatNumber
            value={String(totals.makes)}
            size="hero"
            label="career makes"
            tint={color.accent}
          />
          <Row style={styles.heroRow}>
            <StatNumber value={String(totals.attempts)} size="medium" label="attempts" />
            <StatNumber value={`${makeRate}%`} size="medium" label="make rate" />
            <StatNumber value={String(totals.bestStreak)} size="medium" label="best streak" />
          </Row>
        </Card>

        {!hasShots && (
          <Card>
            <Text style={styles.heading}>Your trophy shelf is waiting</Text>
            <Text style={[styles.dim, { marginTop: space.xs }]}>
              Every make, streak and session counts toward a badge. Track one
              session and First bucket is basically yours.
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
              <Eyebrow>Unlocked</Eyebrow>
              <Chip label={`${unlocked.length} of ${ACHIEVEMENTS.length}`} tone="accent" />
            </Row>
            <BadgeList defs={unlocked} totals={totals} unlocked />
          </View>
        )}

        {/* Locked badges with progress */}
        {lockedByProgress.length > 0 && (
          <View>
            <Row style={styles.sectionHeader}>
              <Eyebrow>In progress</Eyebrow>
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
    gap: space.xl,
  },
  heroRow: {
    justifyContent: 'space-around',
    marginTop: space.lg,
  },
  sectionHeader: {
    justifyContent: 'space-between',
    // Eyebrow carries its own bottom margin; align the chip with the text.
    alignItems: 'flex-start',
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
