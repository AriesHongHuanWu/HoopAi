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
  return (
    <View style={styles.stack}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <View style={styles.row}>
        {tiles.map((t) => (
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
