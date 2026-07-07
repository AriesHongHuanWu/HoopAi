/**
 * BrandMark — the "HOOP|ILOT" wordmark micro-lockup.
 *
 * A tiny, purely decorative watermark for surfaces users screen-record and
 * share (highlight reel, replay player): user-recorded clips ARE the
 * marketing channel, so every shareable frame should quietly read HOOPILOT.
 *
 * Visual grammar matches the ShareCard's Skia-drawn wordmark (HOOP in chalk,
 * ILOT in leather accent, condensed caps, ~0.13em tracking) so the brand
 * reads identically across RN and Skia rendering contexts — only the
 * renderer differs.
 *
 * Deliberately quiet: defaults to 11pt at 55% opacity with a whisper of
 * shadow so it survives bright video without ever demanding attention.
 * Decorative only — hidden from screen readers, ignores font scaling, and
 * never intercepts touches. Position it from the call site via `style`.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, font } from '@/constants/tokens';

/** Tracking ratio lifted from the ShareCard wordmark (8px at 60px type). */
const TRACKING_RATIO = 8 / 60;

export function BrandMark({
  size = 11,
  opacity = 0.55,
  style,
}: {
  /** Font size in dp. Defaults to a watermark-quiet 11. */
  size?: number;
  /** Overall mark opacity. Defaults to 0.55 — visible in a recording, ignorable in person. */
  opacity?: number;
  /** Positioning from the call site (e.g. absolute corner placement). */
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[styles.wrap, { opacity }, style]}
    >
      <Text
        allowFontScaling={false}
        style={[
          styles.mark,
          {
            fontSize: size,
            lineHeight: Math.ceil(size * 1.2),
            letterSpacing: size * TRACKING_RATIO,
          },
        ]}
      >
        HOOP<Text style={styles.accent}>ILOT</Text>
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    pointerEvents: 'none',
  },
  mark: {
    fontFamily: font.display,
    color: color.text,
    textShadowColor: 'rgba(0, 0, 0, 0.45)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  accent: {
    color: color.accent,
  },
});
