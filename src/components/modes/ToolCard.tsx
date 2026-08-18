/**
 * ToolCard — a TRAINING TOOLS entry card for the Train tab's 2-column grid.
 *
 * NavTile kept each tool to an icon + label and hid the one-line hint in the
 * accessibility tree, so "Jump Lab" and "Form Studio" were unreadable to a new
 * player. This card makes the hint VISIBLE: icon chip (NavTiles' tinted-chip
 * language), label, and the hint as a second line — on the same
 * surface/hairline recipe as ModeCatalogCard so the whole Train shelf reads as
 * one catalog.
 *
 * Deliberately a NEW component instead of a NavTiles variant: NavTiles is
 * owned by the system package and its LEADERBOARD_TILE/NavTileRow contract is
 * pinned by the IA suites. Same reason this keeps NavTile's flat Pressable
 * shape (one node carrying accessibilityLabel + onPress — the pinned suites
 * count controls that way) and fires the settings-gated selection haptic
 * through src/utils/haptics.ts, never raw expo-haptics.
 *
 * Fully prop-driven: no store reads, no self-animation. Callers pass typed
 * router literals inside `onPress` (app.json typedRoutes).
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, iconSize, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

export interface ToolCardProps {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Tool name, e.g. 'Jump Lab'. */
  label: string;
  /** One-line "what is this" — VISIBLE here, unlike the old NavTile hint. */
  hint: string;
  onPress: () => void;
}

export function ToolCard({ icon, label, hint, onPress }: ToolCardProps): React.JSX.Element {
  const press = () => {
    haptic.selection();
    onPress();
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={press}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
    >
      <View style={styles.head}>
        <View style={styles.iconChip}>
          <Ionicons name={icon} size={iconSize.sm} color={color.accent} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {/* Two lines max at half-width — the copy is one sentence. */}
      <Text style={styles.hint} numberOfLines={2}>
        {hint}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Same surface/hairline recipe as ModeCatalogCard; flex: 1 shares the
  // 2-column grid row equally (the grid row owns the gap).
  card: {
    flex: 1,
    minHeight: touch.minTarget,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.md,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  /** NavTiles' tinted icon-chip language — the familiar tool affordance. */
  iconChip: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  hint: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.xs,
  },
});
