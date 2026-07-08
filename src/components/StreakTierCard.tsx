/**
 * StreakTierCard — the "don't break the chain" loop, gamified into a medal
 * ladder. The raw day-streak becomes a tier (Spark → Bronze → Silver → Gold →
 * Legend) with the next medal to chase and a progress bar toward it, so a
 * streak isn't just a number but a run at the next badge.
 *
 * Pure presentational: tiers come from streakStanding() in src/core/streak.ts.
 * Render only when a streak exists (current >= 1) — the parent guards that.
 */
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';
import { streakStanding, type StreakResult } from '@/core/streak';

/** Medal colors. Gold/Legend/Spark come from the palette; Bronze/Silver are
 *  semantic metallic tones with no palette equivalent. */
const TIER_COLOR: Record<string, string> = {
  Spark: color.accent,
  Bronze: '#C8823C',
  Silver: '#C2CAD2',
  Gold: color.threePt,
  Legend: color.ghost,
};

export function StreakTierCard({ streak }: { streak: StreakResult }) {
  const { current, longest, shotToday } = streak;
  const standing = streakStanding(current);
  const tierColor = standing.tier ? (TIER_COLOR[standing.tier.label] ?? color.accent) : color.accent;
  const nextColor = standing.next ? (TIER_COLOR[standing.next.label] ?? color.accent) : tierColor;

  const sub = !shotToday
    ? 'Shoot today to keep it alive.'
    : standing.next
      ? `${standing.daysToNext} ${standing.daysToNext === 1 ? 'day' : 'days'} to ${standing.next.label}`
      : `Legend tier — the top of the ladder. Longest run: ${longest}.`;

  const a11y =
    `${current} day shooting streak` +
    (standing.tier ? `, ${standing.tier.label} tier` : '') +
    (shotToday
      ? standing.next
        ? `. ${standing.daysToNext} days to ${standing.next.label}.`
        : '.'
      : '. Shoot today to keep it going.');

  return (
    <View style={styles.row} accessible accessibilityLabel={a11y}>
      <View style={styles.flame}>
        <Ionicons name="flame" size={18} color={tierColor} />
      </View>
      <View style={styles.body}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{`${current}-day streak`}</Text>
          {standing.tier && (
            <View style={[styles.tierChip, { borderColor: tierColor }]}>
              <Text style={[styles.tierChipText, { color: tierColor }]}>
                {standing.tier.label.toUpperCase()}
              </Text>
            </View>
          )}
        </View>
        <Text style={styles.sub} numberOfLines={1}>
          {sub}
        </Text>
        {standing.next && (
          <View style={styles.track} importantForAccessibility="no-hide-descendants">
            <View
              style={[
                styles.fill,
                { width: `${Math.max(4, standing.progressToNext * 100)}%`, backgroundColor: nextColor },
              ]}
            />
          </View>
        )}
      </View>
      {!shotToday && <Text style={styles.nudge}>TODAY</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  flame: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  title: {
    ...type.bodyMedium,
    color: color.text,
  },
  tierChip: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  tierChipText: {
    ...type.micro,
    letterSpacing: 0.8,
  },
  sub: {
    ...type.caption,
    color: color.textDim,
  },
  track: {
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
    marginTop: 2,
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  nudge: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1,
  },
});
