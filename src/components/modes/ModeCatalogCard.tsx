/**
 * ModeCatalogCard — ONE compact catalog row card for the mode picker.
 *
 * Replaces the near-duplicate ModeCard/DrillCard cartridges with a single
 * glanceable row: 40px identity badge, name, one-line tagline, optional
 * rules-at-a-glance micro chips, and a right cluster (ProBadge / PICKED tag /
 * chevron). The FULL rules text moves into accessibilityHint — screen readers
 * still hear it here, and sighted players see it again on the setup screen.
 *
 * Fully prop-driven: no store reads, no self-animation (entrance is owned by
 * the parent's Animated.View wrapper; the only motion is the pressed-state
 * style). Tokens-only colors — identity accent/tint arrive as props from
 * MODE_IDENTITY / DRILL_IDENTITY.
 *
 * `children` (the ghost source picker) render in a full-width block under the
 * row, inside the card. Children own their own top spacing.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { type ComponentProps, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ProBadge } from '@/components/ProBadge';
import { color, radius, space, touch, type } from '@/constants/tokens';

export interface ModeCatalogCardProps {
  /** The mode/drill's Ionicons mark. */
  icon: ComponentProps<typeof Ionicons>['name'];
  /** Display name, e.g. 'Around the World'. */
  name: string;
  /** One-liner, rendered on a single line. */
  tagline: string;
  /** Identity accent (token-derived). */
  accent: string;
  /** Identity 14% tint wash for the badge fill. */
  tint: string;
  /** Armed mode/drill → PICKED tag + accent border. */
  selected: boolean;
  showProBadge: boolean;
  onPress: () => void;
  /** Ghost with no eligible sources. */
  disabled?: boolean;
  /** Rules-at-a-glance chips, ≤2, uppercased micro chips. */
  glance?: readonly string[];
  /** FULL rules text lives here — the visible card stays compact. */
  accessibilityHint?: string;
  /** Defaults to 'chevron-forward'; ghost passes 'chevron-up'/'chevron-down'. */
  rightIcon?: ComponentProps<typeof Ionicons>['name'];
  /** Ghost source list renders below the row, inside the card. */
  children?: ReactNode;
}

export function ModeCatalogCard({
  icon,
  name,
  tagline,
  accent,
  tint,
  selected,
  showProBadge,
  onPress,
  disabled,
  glance,
  accessibilityHint,
  rightIcon,
  children,
}: ModeCatalogCardProps): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${tagline}`}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ selected, disabled: !!disabled }}
      style={({ pressed }) => [
        styles.card,
        selected && [styles.cardSelected, { borderColor: accent }],
        pressed && !disabled && styles.cardPressed,
        disabled && styles.cardDisabled,
      ]}
    >
      <View style={styles.row}>
        {/* The identity mark — glyph on its accent-tinted badge. */}
        <View style={[styles.iconBadge, { borderColor: accent, backgroundColor: tint }]}>
          <Ionicons name={icon} size={20} color={accent} />
        </View>

        <View style={styles.body}>
          <View style={styles.head}>
            <Text style={styles.name} numberOfLines={1}>
              {name}
            </Text>
            <View style={styles.cluster}>
              {showProBadge && <ProBadge />}
              {selected && (
                <View style={[styles.pickedTag, { backgroundColor: accent }]}>
                  <Text style={styles.pickedText}>✓ PICKED</Text>
                </View>
              )}
              <Ionicons name={rightIcon ?? 'chevron-forward'} size={16} color={accent} />
            </View>
          </View>
          <Text style={styles.tagline} numberOfLines={1}>
            {tagline}
          </Text>
          {glance != null && glance.length > 0 && (
            <View style={styles.glanceRow}>
              {glance.map((g) => (
                <View key={g} style={styles.glanceChip}>
                  <Text style={styles.glanceText}>{g.toUpperCase()}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </View>

      {/* Full-width block under the row (Pressable lays out as a column). */}
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.md,
    minHeight: touch.minTarget,
  },
  cardSelected: {
    borderWidth: 1.5,
    backgroundColor: color.surfaceRaised,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
    transform: [{ scale: 0.985 }],
  },
  cardDisabled: {
    opacity: 0.55,
  },
  row: {
    flexDirection: 'row',
    gap: space.md,
    alignItems: 'center',
  },
  iconBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  name: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  cluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
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
  tagline: {
    ...type.caption,
    color: color.textDim,
    marginTop: 1,
  },
  glanceRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: space.xs,
  },
  glanceChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingHorizontal: space.sm + 2,
    paddingVertical: 2,
  },
  glanceText: {
    ...type.micro,
    color: color.textFaint,
  },
});
