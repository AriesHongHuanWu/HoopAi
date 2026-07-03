/**
 * HudChip — translucent "glass" panel for the live HUD.
 *
 * No expo-blur (too heavy to composite over the 30fps feed): the glass look
 * comes from a layered rgba fill + hairline top-highlight border from tokens,
 * which reads as frosted glass while staying cheap. `tone` tints the border and
 * a faint inner wash so a chip can carry make/downtown identity.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius, space } from '../../constants/tokens';

export type HudChipTone = 'default' | 'accent' | 'downtown';

export function HudChip({
  children,
  style,
  tone = 'default',
  deep = false,
  accessible,
  accessibilityLabel,
  accessibilityLiveRegion,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  tone?: HudChipTone;
  /** Deeper glass for the primary panel so it sits above the split chips. */
  deep?: boolean;
  /** Groups the chip's contents into one accessibility element. */
  accessible?: boolean;
  accessibilityLabel?: string;
  /** Announce content changes (e.g. a live score) without manual re-focus. */
  accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
}) {
  const toneStyle =
    tone === 'accent'
      ? { borderColor: color.accent, backgroundColor: color.accentTint }
      : tone === 'downtown'
        ? { borderColor: color.threePt, backgroundColor: color.threePtTint }
        : null;
  return (
    <View
      style={[styles.chip, deep && styles.deep, toneStyle, style]}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion={accessibilityLiveRegion}
    >
      {/* top highlight — the single hairline that sells the glass */}
      <View pointerEvents="none" style={styles.highlight} />
      {children}
    </View>
  );
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
    overflow: 'hidden',
  },
  deep: {
    backgroundColor: color.hudGlassDeep,
    borderRadius: radius.lg,
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(245, 241, 236, 0.22)',
  },
});
