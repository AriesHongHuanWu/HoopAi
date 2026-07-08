/**
 * ProfileButton — the entry point to "My Profile" (src/app/profile.tsx),
 * exported for LATER wiring into the Home header (index.tsx is out of scope
 * for this change, so nothing imports this yet).
 *
 * It's a quiet circular avatar chip: the player's initials over a tinted
 * disc, ringed by a thin completeness arc so a half-finished profile reads
 * as "there's more to fill in" without a nagging badge. Falls back to a
 * person glyph before a nickname is set.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, touch, type } from '@/constants/tokens';
import { profileCompleteness, useProfile } from '@/state/profileStore';

/** Up-to-two-letter initials from a nickname, or null when unset. */
function initialsOf(nickname: string): string | null {
  const parts = nickname.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function ProfileButton({ size = touch.minTarget }: { size?: number }) {
  const nickname = useProfile((s) => s.nickname);
  const completeness = useProfile(profileCompleteness);
  const initials = initialsOf(nickname);
  const incomplete = completeness < 1;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        initials != null ? `Profile: ${nickname}` : 'Set up your player profile'
      }
      accessibilityHint={
        incomplete ? 'Some details are still empty — tap to complete your profile' : 'View and edit your profile'
      }
      hitSlop={space.sm}
      onPress={() => router.push('/profile')}
      style={({ pressed }) => [
        styles.disc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          // Accent ring when there's still profile left to fill in.
          borderColor: incomplete ? color.accent : color.border,
        },
        pressed && styles.pressed,
      ]}
    >
      {initials != null ? (
        <Text style={styles.initials}>{initials}</Text>
      ) : (
        <Ionicons name="person" size={size * 0.42} color={color.textDim} />
      )}
      {incomplete && <View style={styles.dot} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceRaised,
    borderWidth: 2,
  },
  pressed: {
    backgroundColor: color.surface,
  },
  initials: {
    ...type.caption,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  // Small accent pip, top-right — "profile incomplete" without words.
  dot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
    borderWidth: 2,
    borderColor: color.bg,
  },
});
