/**
 * Sub-navigation tiles for a tab-root screen.
 *
 * The bottom tab bar (app/(tabs)/_layout.tsx) gets you to a section; these
 * tiles are how a tab root reaches the standalone screens grouped under it —
 * Data → Trends/Records, Train → Leaderboard and Scoreboard/Jump/Form/Video
 * check, You → Settings. Same tinted-icon-chip language as the old Home
 * QuickLinks so the affordance is familiar, just no longer buried at the
 * bottom of one long scroll. `onPress` (not an href) keeps callers passing
 * typed router literals, which is required with app.json `typedRoutes`.
 *
 * PRESS FEEDBACK — deliberately NOT PressScale. The pinned IA suites
 * (tabIaCategorisation, leaderboard) count these controls by finding the ONE
 * node carrying both `accessibilityLabel` and `onPress`; any wrapper
 * component receiving those props is a second matching node, so wrapping in
 * PressScale double-counts every tile (verified empirically). The tile keeps
 * its flat pressed background swap and fires the settings-gated selection
 * haptic through src/utils/haptics.ts — never raw expo-haptics.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, touch, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';

export interface NavTileSpec {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  hint: string;
  /**
   * Optional visible second line for RICH rows (see NavTileRow `variant`).
   * Compact rows ignore it — three-across tiles cannot fit a sentence.
   */
  description?: string;
  onPress: () => void;
}

export function NavTile({
  icon,
  label,
  hint,
  description,
  onPress,
  rich = false,
}: NavTileSpec & {
  /**
   * Row-driven, never set per-tile: NavTileRow's `variant` decides whether a
   * whole row renders descriptions, so siblings always match.
   */
  rich?: boolean;
}) {
  const showDescription = rich && description != null;
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
      style={({ pressed }) => [
        styles.tile,
        showDescription && styles.tileRich,
        pressed && styles.tilePressed,
      ]}
    >
      <View style={styles.tileHead}>
        <View style={styles.iconChip}>
          <Ionicons name={icon} size={15} color={color.accent} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      </View>
      {showDescription && (
        <Text style={styles.description} numberOfLines={1}>
          {description}
        </Text>
      )}
    </Pressable>
  );
}

/**
 * Entry point for the offline friend leaderboard (app/leaderboard.tsx) — the
 * QR / AirDrop / dictated-code challenge loop from src/core/challengeShare.ts.
 *
 * Exported as a ready-made spec (rather than re-typed at each call site) so
 * the label, hint and destination of the app's only social screen live in one
 * place. It is PLACED EXPLICITLY by whichever screen wants it — today the
 * Train tab's Challenges section (app/(tabs)/modes.tsx).
 *
 * WHY this is a plain constant and no longer auto-injected: NavTileRow used to
 * append this tile to any row whose eyebrow string matched 'EXPLORE'. That made
 * a copy edit — renaming one all-caps label — silently delete the only way into
 * the leaderboard, with nothing at the call site to notice it had gone. An
 * entry point that can vanish because a word changed is worse than one a
 * rewrite might forget: a forgotten tile is visible in the diff.
 */
export const LEADERBOARD_TILE: NavTileSpec = {
  icon: 'people-outline',
  label: 'Leaderboard',
  hint: 'Challenge a friend and compare scores — nothing leaves this phone unless you share it',
  onPress: () => router.push('/leaderboard'),
};

/**
 * A labeled row of nav tiles (each flexes to share the width equally). Pass at
 * most 3 tiles per row for legible labels; compose multiple rows for more.
 *
 * Renders exactly the tiles it is given, in the given order — `eyebrow` is
 * presentation only and never selects content.
 *
 * `variant`: 'compact' (default) is the classic single-line tile; 'rich'
 * renders each tile's `description` as a visible second line. The variant is
 * a ROW decision on purpose — a 3-across row cannot fit descriptions, and a
 * row where only some tiles carry a second line reads as broken.
 */
export function NavTileRow({
  eyebrow,
  tiles,
  variant = 'compact',
}: {
  eyebrow?: string;
  tiles: NavTileSpec[];
  variant?: 'compact' | 'rich';
}) {
  return (
    <View style={styles.stack}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <View style={styles.row}>
        {tiles.map((t) => (
          <NavTile key={t.label} {...t} rich={variant === 'rich'} />
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
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    backgroundColor: color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm,
    paddingVertical: space.md,
  },
  /** Rich tiles left-align so the second line hangs from the label. */
  tileRich: {
    alignItems: 'flex-start',
    paddingHorizontal: space.md,
    gap: space.xs,
  },
  tilePressed: {
    backgroundColor: color.surfaceRaised,
  },
  /** The classic chip + label line — the whole tile in compact rows. */
  tileHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
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
  description: {
    ...type.caption,
    color: color.textFaint,
  },
});
