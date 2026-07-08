/**
 * Shared prose primitives for the legal screens (privacy / terms / licenses).
 *
 * Keeps the three long-form documents visually identical and accessible: a
 * consistent broadcast heading rhythm, readable measure, and a "last updated"
 * stamp. Body copy is plain language on purpose — store reviewers and players
 * both read these, so no legalese wall.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { Eyebrow } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';

/** Document header: eyebrow + title + "Last updated" line. */
export function DocHeader({
  eyebrow,
  title,
  updated,
}: {
  eyebrow: string;
  title: string;
  /** e.g. "8 July 2026". */
  updated: string;
}) {
  return (
    <View style={styles.head} accessibilityRole="header">
      <Eyebrow>{eyebrow}</Eyebrow>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.updated}>Last updated {updated}</Text>
    </View>
  );
}

/** A section: heading + children (paragraphs / bullets). */
export function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.heading} accessibilityRole="header">
        {heading}
      </Text>
      {children}
    </View>
  );
}

/** A body paragraph. `lead` bumps weight/color for a section's first line. */
export function P({ children, lead = false }: { children: React.ReactNode; lead?: boolean }) {
  return <Text style={[styles.p, lead && styles.pLead]}>{children}</Text>;
}

/** A bulleted list item — arc-orange dot, hanging indent. */
export function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.bulletRow}>
      <View style={styles.bulletDot} />
      <Text style={styles.bulletText}>{children}</Text>
    </View>
  );
}

/** Emphasised inline run — for the load-bearing promises ("never leaves…"). */
export function Strong({ children }: { children: React.ReactNode }) {
  return <Text style={styles.strong}>{children}</Text>;
}

/** A callout card — used for the headline privacy promise up top. */
export function Callout({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.callout, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  head: {
    marginTop: space.sm,
    marginBottom: space.lg,
  },
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.xs,
  },
  updated: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 0,
  },
  section: {
    marginBottom: space.xl,
  },
  heading: {
    ...type.heading,
    color: color.text,
    marginBottom: space.sm,
  },
  p: {
    ...type.body,
    color: color.textDim,
    marginBottom: space.sm,
  },
  pLead: {
    ...type.bodyMedium,
    color: color.text,
  },
  strong: {
    ...type.body,
    fontFamily: font.bodySemiBold,
    color: color.text,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: space.sm,
    marginBottom: space.sm,
    paddingRight: space.sm,
  },
  bulletDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.accent,
    marginTop: 8,
  },
  bulletText: {
    ...type.body,
    color: color.textDim,
    flex: 1,
  },
  callout: {
    backgroundColor: color.accentTint,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
    marginBottom: space.xl,
  },
});
