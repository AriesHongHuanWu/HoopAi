/**
 * LegalLink — the single row that opens the in-app legal hub (/legal).
 *
 * Lives here (not inlined in Settings) because Settings is owned by another
 * worktree; this is the drop-in the Settings About card imports and renders so
 * wiring is a one-line post-merge change:
 *
 *   import { LegalLink } from '@/components/LegalLink';
 *   ...
 *   <LegalLink />
 *
 * The hub itself (Privacy, Terms, Open-source licenses) is required chrome for
 * App Store Connect / Play Console review — every screen it links to ships
 * fully offline inside the bundle, so review works with no network and the
 * store's required Privacy Policy URL (docs/PRIVACY-POLICY.md, published to the
 * listing) mirrors the in-app copy word for word.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, touch, type } from '@/constants/tokens';

export function LegalLink({
  /** Optional override — defaults to the standard label/description. */
  label = 'Privacy, terms & licenses',
  description = 'What we collect (nothing leaves your phone), the terms of use, and open-source credits.',
}: {
  label?: string;
  description?: string;
} = {}) {
  return (
    <Pressable
      onPress={() => router.push('/legal')}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the privacy policy, terms of use and open-source licenses"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.text}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.description}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={color.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: touch.minTarget,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  rowPressed: {
    backgroundColor: color.surfaceRaised,
  },
  text: {
    flex: 1,
  },
  label: {
    ...type.bodyMedium,
    color: color.text,
  },
  description: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
    letterSpacing: 0,
  },
});
