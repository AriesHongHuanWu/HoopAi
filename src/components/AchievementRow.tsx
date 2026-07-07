/**
 * One badge row on the Records screen.
 *
 * Unlocked: accent-tinted card, emoji in a leather-tint medal circle, plus a
 *           small tier crest (the badge's Ionicons glyph in its bronze /
 *           silver / gold tier color) on the trailing edge.
 * Locked:   quiet surface card, dimmed emoji, thin token-styled progress bar
 *           with a tabular "42/100" caption.
 * isNew:    a subtle "NEW" pip next to the name for badges unlocked since the
 *           user's last Records visit (see src/state/achievementsSeenStore.ts).
 *
 * Purely presentational — progress/caption come from the AchievementDef so
 * the row stays dumb and testable logic stays in src/core/achievements.ts.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, font, radius, space, touch, type } from '@/constants/tokens';
import type { AchievementDef, BadgeTier, LifetimeTotals } from '@/core/achievements';

const MEDAL_SIZE = 44;
const BAR_HEIGHT = 4;

/**
 * Tier crest colors. Gold rides the existing downtown-gold token; silver the
 * dimmed-chalk token; bronze has no token sibling, so a warmed leather-brown
 * literal (kept here, next to its only use).
 */
const TIER_COLOR: Record<BadgeTier, string> = {
  bronze: '#C08552',
  silver: color.textDim,
  gold: color.threePt,
};

export function AchievementRow({
  def,
  totals,
  unlocked,
  isNew = false,
}: {
  def: AchievementDef;
  totals: LifetimeTotals;
  unlocked: boolean;
  /** Show the "NEW" pip — badge unlocked since the last Records visit. */
  isNew?: boolean;
}) {
  const progress = def.progress(totals);
  const caption = def.progressLabel(totals);
  const a11y = unlocked
    ? `${def.name}, ${def.tier} badge unlocked${isNew ? ', new' : ''}. ${def.blurb}`
    : `${def.name}, in progress, ${caption}. ${def.blurb}`;

  return (
    <View
      accessible
      accessibilityLabel={a11y}
      style={[styles.row, unlocked ? styles.rowUnlocked : styles.rowLocked]}
    >
      <View style={[styles.medal, unlocked ? styles.medalUnlocked : styles.medalLocked]}>
        <Text style={[styles.emoji, !unlocked && styles.emojiLocked]}>{def.emoji}</Text>
      </View>
      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={[styles.name, unlocked && { color: color.accent }]}>{def.name}</Text>
          {isNew && (
            <View style={styles.newPip}>
              <Text style={styles.newPipText}>NEW</Text>
            </View>
          )}
        </View>
        <Text style={styles.blurb} numberOfLines={2}>
          {def.blurb}
        </Text>
        {!unlocked && (
          <View style={styles.progressRow}>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` },
                ]}
              />
            </View>
            <Text style={styles.caption}>{caption}</Text>
          </View>
        )}
      </View>
      {unlocked && (
        <Ionicons
          // def.icon is a plain string in core (no UI imports there); every
          // board entry is a valid Ionicons glyph name.
          name={def.icon as React.ComponentProps<typeof Ionicons>['name']}
          size={16}
          color={TIER_COLOR[def.tier]}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
  },
  rowUnlocked: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  rowLocked: {
    backgroundColor: color.surface,
    borderColor: color.border,
  },
  medal: {
    width: MEDAL_SIZE,
    height: MEDAL_SIZE,
    borderRadius: MEDAL_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  medalUnlocked: {
    backgroundColor: color.accentTint,
  },
  medalLocked: {
    backgroundColor: color.surfaceRaised,
  },
  emoji: {
    fontSize: 22,
    lineHeight: 28,
  },
  emojiLocked: {
    opacity: 0.45,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  name: {
    ...type.heading,
    color: color.text,
    flexShrink: 1,
  },
  newPip: {
    backgroundColor: color.accent,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 1,
  },
  newPipText: {
    ...type.micro,
    fontFamily: font.bodySemiBold,
    color: color.onAccent,
  },
  blurb: {
    ...type.body,
    color: color.textDim,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xs,
  },
  track: {
    flex: 1,
    height: BAR_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
});
