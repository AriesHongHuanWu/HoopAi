/**
 * JumpLabButton — an entry point into the Jump Lab (src/app/jump.tsx).
 *
 * Exported as a standalone component so it can be dropped into the Home hero,
 * a tools row, or the Shot Lab without touching app/index.tsx or the navigator
 * (the /jump route is file-based — creating jump.tsx registered it). Two shapes:
 * a full-width feature `card` (default) and a compact `pill` for dense rows.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';

export function JumpLabButton({
  variant = 'card',
  style,
  onPress,
}: {
  variant?: 'card' | 'pill';
  style?: StyleProp<ViewStyle>;
  /** Override the default navigation (e.g. to close a sheet first). */
  onPress?: () => void;
}) {
  const go = onPress ?? (() => router.push('/jump'));

  if (variant === 'pill') {
    return (
      <Pressable
        onPress={go}
        accessibilityRole="button"
        accessibilityLabel="Open Jump Lab to measure your vertical jump"
        style={({ pressed }) => [styles.pill, pressed && styles.pressed, style]}
      >
        <Ionicons name="body-outline" size={16} color={color.accent} />
        <Text style={styles.pillLabel}>Jump Lab</Text>
        <Ionicons name="chevron-forward" size={15} color={color.textFaint} />
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={go}
      accessibilityRole="button"
      accessibilityLabel="Open Jump Lab to measure and train your vertical jump"
      style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
    >
      <View style={styles.iconBadge}>
        <Ionicons name="body-outline" size={22} color={color.accent} />
      </View>
      <View style={styles.body}>
        <Text style={styles.eyebrow}>VERTICAL</Text>
        <Text style={styles.title}>Jump Lab</Text>
        <Text style={styles.sub}>Measure your vertical from hang time, then train it.</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={color.textFaint} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  pressed: {
    backgroundColor: color.surfaceRaised,
  },
  iconBadge: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
  },
  eyebrow: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.2,
    marginBottom: 1,
  },
  title: {
    ...type.heading,
    fontSize: 18,
    color: color.text,
  },
  sub: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  pillLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
});
