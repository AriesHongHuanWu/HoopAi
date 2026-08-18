/**
 * Sub-navigation tiles for a tab-root screen.
 *
 * The bottom tab bar (app/(tabs)/_layout.tsx) gets you to a section; these
 * tiles are how a tab root reaches the standalone screens grouped under it —
 * Data → Trends/Records, Train → Scoreboard/Jump/Form/Video check, You →
 * Settings. Same tinted-icon-chip language as the old Home QuickLinks so the
 * affordance is familiar, just no longer buried at the bottom of one long
 * scroll. `onPress` (not an href) keeps callers passing typed router literals,
 * which is required with app.json `typedRoutes`.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, touch, type } from '@/constants/tokens';

export interface NavTileSpec {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  hint: string;
  onPress: () => void;
}

export function NavTile({ icon, label, hint, onPress }: NavTileSpec) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, pressed && styles.tilePressed]}
    >
      <View style={styles.iconChip}>
        <Ionicons name={icon} size={15} color={color.accent} />
      </View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Entry point for the offline friend leaderboard (app/leaderboard.tsx) — the
 * QR / AirDrop / dictated-code challenge loop from src/core/challengeShare.ts.
 */
export const LEADERBOARD_TILE: NavTileSpec = {
  icon: 'people-outline',
  label: 'Leaderboard',
  hint: 'Challenge a friend and compare scores — nothing leaves this phone unless you share it',
  onPress: () => router.push('/leaderboard'),
};

/**
 * The row {@link LEADERBOARD_TILE} joins automatically, matched on its eyebrow
 * — which is this component's only public handle on a row's identity.
 *
 * WHY here and not at the call site: each row's tile array is declared inside
 * the tab root that renders it (Data → app/(tabs)/history.tsx carries the
 * EXPLORE row; Train → app/(tabs)/modes.tsx carries the unlabelled tool rows).
 * Hanging the destination off the row component instead keeps the tile and the
 * screen it opens in one file, so the entry point cannot go missing when a tab
 * root is rewritten — the failure mode that leaves a shipped screen with no
 * way in.
 */
const LEADERBOARD_ROW_EYEBROW = 'EXPLORE';

/**
 * A labeled row of nav tiles (each flexes to share the width equally). Pass at
 * most 3 tiles per row for legible labels; compose multiple rows for more.
 */
export function NavTileRow({
  eyebrow,
  tiles,
}: {
  eyebrow?: string;
  tiles: NavTileSpec[];
}) {
  // Appended, never inserted, and skipped when the caller already passes it —
  // so a row that adopts the tile explicitly doesn't render it twice.
  const shown =
    eyebrow?.trim().toUpperCase() === LEADERBOARD_ROW_EYEBROW &&
    !tiles.some((t) => t.label === LEADERBOARD_TILE.label)
      ? [...tiles, LEADERBOARD_TILE]
      : tiles;
  return (
    <View style={styles.stack}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <View style={styles.row}>
        {shown.map((t) => (
          <NavTile key={t.label} {...t} />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.md,
  },
  eyebrow: {
    ...type.caption,
    color: color.textFaint,
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
  },
  tile: {
    flex: 1,
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
  },
  tilePressed: {
    backgroundColor: color.surfaceRaised,
  },
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
});
