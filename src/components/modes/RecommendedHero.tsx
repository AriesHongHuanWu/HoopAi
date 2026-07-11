/**
 * RecommendedHero — the larger QUICK START card for the recommended mode/drill.
 *
 * Bigger identity badge (52px — same recipe as the old ModeCard cartridge),
 * accent tagline, an honesty/reason line and a bold START pill. Tapping arms
 * the recommended target and routes to setup (the caller owns that sequence).
 *
 * Iron rule 8 (honesty): `reason` is rendered VERBATIM from
 * recommendationReason() — this component never invents copy. The only text it
 * appends is the fixed provenance suffix "from your session history", which
 * states exactly where the count came from (real db rows, not a fabricated
 * stat).
 *
 * Fully prop-driven: no store reads, no self-animation (entrance is owned by
 * the parent's Animated.View wrapper; the only motion is the pressed-state
 * style).
 */
import { Ionicons } from '@expo/vector-icons';
import React, { type ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, type } from '@/constants/tokens';

export interface RecommendedHeroProps {
  /** The recommended mode/drill's Ionicons mark. */
  icon: ComponentProps<typeof Ionicons>['name'];
  name: string;
  tagline: string;
  /** Identity accent (token-derived). */
  accent: string;
  /** Identity 14% tint wash for the badge fill. */
  tint: string;
  /** Exact recommendationReason() output, e.g. 'Played 3× in the last 2 weeks'. */
  reason: string;
  /** Hero target is the currently armed mode. */
  selected: boolean;
  onPress: () => void;
}

export function RecommendedHero({
  icon,
  name,
  tagline,
  accent,
  tint,
  reason,
  selected,
  onPress,
}: RecommendedHeroProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Recommended: ${name}. ${tagline}`}
      accessibilityHint={`${reason}. Starts setup with this mode armed.`}
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: accent }],
        pressed && styles.cardPressed,
      ]}
    >
      {/* The identity mark — glyph on its accent-tinted badge. */}
      <View style={[styles.iconBadge, { borderColor: accent, backgroundColor: tint }]}>
        <Ionicons name={icon} size={24} color={accent} />
      </View>

      <View style={styles.body}>
        <View style={styles.eyebrowRow}>
          <Text style={styles.eyebrow}>RECOMMENDED FOR YOU</Text>
          {selected && (
            <View style={[styles.pickedTag, { backgroundColor: accent }]}>
              <Text style={styles.pickedText}>✓ PICKED</Text>
            </View>
          )}
        </View>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[styles.tagline, { color: accent }]} numberOfLines={1}>
          {tagline}
        </Text>

        {/* Honesty line: exact db-derived count, labeled with its source. */}
        <View style={styles.reasonRow}>
          <Ionicons name="time-outline" size={12} color={color.textFaint} />
          <Text style={styles.reasonText}>{`${reason} · from your session history`}</Text>
        </View>

        <View style={styles.footRow}>
          <View style={[styles.startPill, { backgroundColor: accent }]}>
            <Ionicons name="play" size={11} color={color.onAccent} />
            <Text style={styles.startText}>START</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space.lg,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  cardSelected: {
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
    transform: [{ scale: 0.985 }],
  },
  iconBadge: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  eyebrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  eyebrow: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
  },
  pickedTag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
  },
  pickedText: {
    ...type.micro,
    color: color.onAccent,
  },
  name: {
    ...type.heading,
    color: color.text,
    marginTop: space.xs,
  },
  tagline: {
    ...type.bodyMedium,
    marginTop: 2,
  },
  reasonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.xs,
  },
  reasonText: {
    ...type.caption,
    color: color.textFaint,
    flexShrink: 1,
  },
  footRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: space.md,
  },
  startPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  startText: {
    ...type.micro,
    color: color.onAccent,
  },
});
