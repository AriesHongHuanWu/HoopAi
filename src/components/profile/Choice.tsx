/**
 * Shared single-choice primitives for the identity flow — used both in the
 * first-run wizard (full-bleed cards) and inline in the profile editor.
 *
 * - ChoiceCard: a rich, tappable card with an icon, title and one-line blurb,
 *   for the low-cardinality "which of these are you" questions (experience,
 *   goal). Selected = accent border + tint + a check, mirroring settings.tsx's
 *   PresetRow so the whole app's radio language is one voice.
 * - ChipSelect: a wrapping row of pill chips for compact options (position,
 *   plays-per-week), mirroring settings.tsx's SelectChip.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { color, radius, space, touch, type } from '@/constants/tokens';

type IconName = ComponentProps<typeof Ionicons>['name'];

export function ChoiceCard({
  icon,
  title,
  blurb,
  selected,
  onPress,
}: {
  icon: IconName;
  title: string;
  blurb: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={title}
      accessibilityHint={blurb}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        selected && styles.cardSelected,
        pressed && !selected && styles.cardPressed,
      ]}
    >
      <View style={[styles.iconChip, selected && styles.iconChipSelected]}>
        <Ionicons name={icon} size={20} color={selected ? color.accent : color.textDim} />
      </View>
      <View style={styles.cardText}>
        <Text style={[styles.cardTitle, selected && styles.cardTitleSelected]}>{title}</Text>
        <Text style={styles.cardBlurb}>{blurb}</Text>
      </View>
      {selected ? (
        <Ionicons name="checkmark-circle" size={22} color={color.accent} />
      ) : (
        <View style={styles.radioIdle} />
      )}
    </Pressable>
  );
}

export function ChipSelect<T extends string | number>({
  options,
  value,
  label,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T | null;
  /** Group name, spoken as a prefix on each chip for screen readers. */
  label: string;
  onChange: (v: T) => void;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={styles.chipWrap}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={String(opt.value)}
            accessibilityRole="radio"
            accessibilityLabel={opt.label}
            accessibilityState={{ selected }}
            onPress={() => onChange(opt.value)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              pressed && !selected && styles.chipPressed,
              pressed && selected && { opacity: 0.82 },
            ]}
          >
            {selected && <Ionicons name="checkmark" size={13} color={color.accent} />}
            <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: touch.minTarget + space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  cardSelected: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  iconChip: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconChipSelected: {
    backgroundColor: color.accentTint,
  },
  cardText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  cardTitle: {
    ...type.heading,
    color: color.text,
  },
  cardTitleSelected: {
    color: color.text,
  },
  cardBlurb: {
    ...type.body,
    color: color.textDim,
  },
  radioIdle: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: color.border,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    minHeight: touch.minTarget,
    minWidth: touch.minTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
  },
  chipSelected: {
    backgroundColor: color.accentTint,
    borderColor: color.accent,
  },
  chipPressed: {
    backgroundColor: color.surfaceRaised,
    borderColor: color.textFaint,
  },
  chipLabel: {
    ...type.bodyMedium,
    color: color.textDim,
  },
  chipLabelSelected: {
    color: color.accent,
  },
});
