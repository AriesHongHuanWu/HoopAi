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
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { AchievementRow } from '@/components/AchievementRow';
import { ProBadge } from '@/components/ProBadge';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, motion, radius, space, type } from '@/constants/tokens';
import { ACHIEVEMENTS, evaluate, type LifetimeTotals } from '@/core/achievements';
import { lifetimeTotals } from '@/data/db';

/** Cascade step between badge rows (ms), capped so long boards stay snappy. */
const STAGGER_MS = 40;
const STAGGER_CAP = 8;

/** Icon circle diameter on a personal-best tile, px. */
const PB_ICON_SIZE = 28;

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
        <Card>
          <Text style={styles.dim}>Loading your records…</Text>
        </Card>
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
              <View style={styles.eyebrowTrim}>
                <Eyebrow>Unlocked</Eyebrow>
              </View>
              <Chip label={`${unlocked.length} of ${ACHIEVEMENTS.length}`} tone="accent" />
            </Row>
            {/* Board completion — decorative; the chip above carries the count. */}
            <View style={styles.boardTrack} importantForAccessibility="no-hide-descendants">
              <View
                style={[
                  styles.boardFill,
                  { width: `${Math.round((unlocked.length / ACHIEVEMENTS.length) * 100)}%` },
                ]}
              />
            </View>
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
  boardTrack: {
    height: 3,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
    marginBottom: space.md,
  },
  boardFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  sectionHeader: {
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.xs,
  },
  // Eyebrow (src/components/ui.tsx) bakes in its own marginBottom: space.sm,
  // which pushes its text off-center against a trailing Chip in this Row.
  // Cancel it locally so the Row's `alignItems: 'center'` aligns the actual
  // text baseline against the Chip instead of the Eyebrow's padded box.
  eyebrowTrim: {
    marginBottom: -space.sm,
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
