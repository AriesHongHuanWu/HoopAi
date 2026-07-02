/**
 * HudChip — translucent "glass" chip for the live HUD.
 *
 * No expo-blur: a plain rgba fill from tokens (color.hudGlass) keeps the chip
 * cheap to composite over the 30fps camera feed while still reading as glass.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius, space } from '../../constants/tokens';

export function HudChip({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[styles.chip, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: color.hudGlass,
    borderColor: color.hudGlassBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
