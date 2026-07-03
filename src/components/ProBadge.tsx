/**
 * ProBadge — tiny "PRO" pill, downtown-gold tint.
 *
 * Purely informational while {@link IS_BETA} is true (see src/core/premium.ts):
 * it never blocks a tap or gates a screen, it just seeds the expectation of
 * what joins the paid plan at launch. The optional long form appends
 * " · free in beta" so the badge itself explains why a "Pro" feature is
 * sitting wide open right now.
 *
 * Kept deliberately small and quiet per the beta rule — a label, not a wall.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';

export function ProBadge({
  long = false,
  style,
}: {
  /** Append " · free in beta" for placements with room to spell it out. */
  long?: boolean;
  style?: object;
}) {
  return (
    <View
      style={[styles.badge, style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel="Pro feature, free during beta"
    >
      <Text style={styles.label}>{long ? 'PRO · FREE IN BETA' : 'PRO'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    backgroundColor: color.threePtTint,
  },
  label: {
    ...type.micro,
    color: color.threePt,
  },
});
