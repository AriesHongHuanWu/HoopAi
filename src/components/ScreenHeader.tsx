/**
 * ScreenHeader + SectionEyebrow — the header kit every screen opens with.
 *
 * WHY A NEW FILE: ui.tsx is READ-ONLY (the MotionStat precedent), and the
 * title/lede block was hand-rolled per screen — same type.title, but five
 * slightly different lede margins and three eyebrow dialects. This is the one
 * canonical block: title in type.title, lede in type.body/textDim with ONE
 * lede margin, optional eyebrow kicker above, optional `right` slot for a
 * trailing control (gear button, share).
 *
 * SCOPE — deliberately narrow: this component owns ONLY the title/lede/eyebrow
 * block. It never absorbs a screen's section stack or its gaps —
 * layoutRhythmContract.test.ts requires `layout.sectionGap` to appear in
 * screen source, so the rhythm between sections stays a screen concern.
 *
 * Consumers import this file CONCRETELY (not via a barrel) — the SegmentedTabs
 * rationale: screen suites stub barrels down to the symbols under test, and a
 * header that resolves to `undefined` fails far from the cause.
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { color, iconSize, space, type } from '@/constants/tokens';

export interface ScreenHeaderProps {
  /** The H1. On a tab root this is the tab word — pinned by tabIaCategorisation. */
  title: string;
  /** Friendly one-liner under the title. */
  lede?: string;
  /** UPPERCASE kicker above the title (rendered .toUpperCase()). */
  eyebrow?: string;
  /** Trailing control on the title row (gear button, share …). */
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function ScreenHeader({ title, lede, eyebrow, right, style }: ScreenHeaderProps) {
  return (
    <View style={style}>
      {eyebrow != null && <Text style={styles.eyebrow}>{eyebrow.toUpperCase()}</Text>}
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {right != null && <View style={styles.right}>{right}</View>}
      </View>
      {lede != null && <Text style={styles.lede}>{lede}</Text>}
    </View>
  );
}

/**
 * The UPPERCASE section kicker — 12px accent glyph + tracked eyebrow text.
 * Coach, Shot Lab and Profile each had a private copy; this is the export.
 * Margins stay at the call site (screens own their rhythm).
 */
export function SectionEyebrow({
  icon,
  children,
  style,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /** Rendered .toUpperCase() — pass sentence case. */
  children: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.eyebrowRow, style]}>
      <Ionicons name={icon} size={iconSize.xs} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  eyebrow: {
    ...type.eyebrow,
    color: color.textFaint,
    marginBottom: space.xs,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  title: {
    ...type.title,
    color: color.text,
    flexShrink: 1,
  },
  right: {
    flexShrink: 0,
  },
  /** THE canonical lede margin — one value, every screen. */
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  eyebrowText: {
    ...type.eyebrow,
    color: color.textFaint,
  },
});
