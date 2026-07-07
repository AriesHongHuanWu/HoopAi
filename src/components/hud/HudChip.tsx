/**
 * HudChip — translucent "glass" panel for the live HUD.
 *
 * No expo-blur (too heavy to composite over the 30fps feed): the premium glass
 * comes from cheap stacked layers instead —
 *   base translucent fill → tone wash → top sheen → hairline top highlight →
 *   hairline bottom shade.
 * `tone` KEEPS the glass base and floats a tinted wash + tinted hairline above
 * it, so accent/downtown chips stay legible over a bright court instead of
 * going see-through. Radii stay on radius.lg so every HUD chip reads as one
 * family.
 */
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, radius, space } from '../../constants/tokens';

export type HudChipTone = 'default' | 'accent' | 'downtown';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

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
  const toneBorder =
    tone === 'accent'
      ? styles.accentBorder
      : tone === 'downtown'
        ? styles.downtownBorder
        : null;
  const toneWash =
    tone === 'accent' ? styles.accentWash : tone === 'downtown' ? styles.downtownWash : null;
  return (
    <View
      style={[styles.chip, deep && styles.deep, toneBorder, style]}
      accessible={accessible}
      accessibilityLabel={accessibilityLabel}
      accessibilityLiveRegion={accessibilityLiveRegion}
    >
      {/* layered glass — every layer is a static View, nothing composites per frame */}
      {toneWash != null && <View pointerEvents="none" style={[styles.wash, toneWash]} />}
      <View pointerEvents="none" style={styles.sheen} />
      <View pointerEvents="none" style={styles.highlight} />
      <View pointerEvents="none" style={styles.shade} />
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
  /** Tinted identity wash — sits over the glass base so depth is preserved. */
  wash: {
    ...absoluteFill,
  },
  accentWash: {
    backgroundColor: color.accentTint,
  },
  downtownWash: {
    backgroundColor: color.threePtTint,
  },
  /** Tinted hairline for toned chips — translucent so it stays a hairline, not a stroke. */
  accentBorder: {
    borderColor: 'rgba(240, 90, 36, 0.7)',
  },
  downtownBorder: {
    borderColor: 'rgba(242, 193, 78, 0.7)',
  },
  /** Faint light pooling across the top half — the "curved glass" cue. */
  sheen: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '42%',
    backgroundColor: 'rgba(245, 241, 236, 0.05)',
  },
  /** Top highlight — the single hairline that sells the glass edge. */
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(245, 241, 236, 0.28)',
  },
  /** Bottom shade hairline — grounds the chip against the bright feed. */
  shade: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
  },
});
