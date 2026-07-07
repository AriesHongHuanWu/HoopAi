/**
 * Shared UI primitives — the only building blocks screens should use for
 * basic structure. Dark broadcast system; tokens in src/constants/tokens.ts.
 */
import React from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, radius, space, touch, type } from '../constants/tokens';
import type { ShotOutcome } from '../core/types';

// ---------------------------------------------------------------------------

export function Screen({
  children,
  scroll = false,
  padded = true,
  style,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const insets = useSafeAreaInsets();
  const base: StyleProp<ViewStyle> = [
    styles.screen,
    { paddingTop: insets.top },
    padded && { paddingHorizontal: space.lg },
    style,
  ];
  if (scroll) {
    return (
      <ScrollView
        style={styles.screen}
        contentContainerStyle={[
          { paddingTop: insets.top, paddingBottom: insets.bottom + space.xxl },
          padded && { paddingHorizontal: space.lg },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }
  return <View style={base}>{children}</View>;
}

export function Card({
  children,
  style,
  onPress,
  entering,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  /**
   * Optional reanimated entering animation (e.g. FadeInDown.delay(i * 60)).
   * Screens stagger their cards on mount so navigation feels alive; leave
   * undefined for cards inside frequently-updating lists.
   */
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}) {
  if (onPress) {
    const pressable = (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed, style]}
      >
        {children}
      </Pressable>
    );
    return entering ? <Animated.View entering={entering}>{pressable}</Animated.View> : pressable;
  }
  if (entering) {
    return (
      <Animated.View entering={entering} style={[styles.card, style]}>
        {children}
      </Animated.View>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
}

// ---------------------------------------------------------------------------

/** Pressable that can carry a reanimated style — no wrapper view, so call-site
 *  layout styles (flex, margins) land exactly where they always did. */
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export function PillButton({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  style,
  icon,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'ghost' | 'danger';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Optional leading Ionicons glyph — primary actions read faster with one. */
  icon?: React.ComponentProps<typeof Ionicons>['name'];
}) {
  // Press micro-interaction: a quick spring scale-down, applied DIRECTLY on
  // the Pressable (no wrapper — a wrapper broke call-site flex/margin layout).
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  const fg = variant === 'ghost' ? color.text : color.onAccent;
  return (
    <AnimatedPressable
      onPress={onPress}
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 300 });
      }}
      disabled={disabled}
      accessibilityRole="button"
      style={[
        styles.pill,
        variant === 'ghost' && styles.pillGhost,
        variant === 'primary' && { backgroundColor: color.accent },
        variant === 'danger' && { backgroundColor: color.miss },
        disabled && { opacity: 0.4 },
        style,
        animStyle,
      ]}
    >
      {icon != null && <Ionicons name={icon} size={17} color={fg} style={styles.pillIcon} />}
      <Text style={[styles.pillLabel, { color: fg }]}>{label}</Text>
    </AnimatedPressable>
  );
}

// ---------------------------------------------------------------------------

const statSizes = {
  hero: type.scoreboard,
  large: type.statLarge,
  medium: type.statMedium,
} as const;

/** Big broadcast numeral with a small label underneath. */
export function StatNumber({
  value,
  label,
  size = 'large',
  tint,
  style,
}: {
  value: string;
  label?: string;
  size?: keyof typeof statSizes;
  tint?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      <Text
        style={[
          statSizes[size] as TextStyle,
          { color: tint ?? color.text, fontVariant: ['tabular-nums'] },
        ]}
      >
        {value}
      </Text>
      {label != null && <Text style={styles.statLabel}>{label.toUpperCase()}</Text>}
    </View>
  );
}

export function Eyebrow({ children }: { children: string }) {
  return <Text style={styles.eyebrow}>{children.toUpperCase()}</Text>;
}

export function Chip({
  label,
  tone = 'default',
}: {
  label: string;
  tone?: 'default' | 'make' | 'miss' | 'accent' | 'unsure';
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    default: { bg: color.surfaceRaised, fg: color.textDim },
    make: { bg: color.makeTint, fg: color.make },
    miss: { bg: color.missTint, fg: color.miss },
    accent: { bg: color.accentTint, fg: color.accent },
    unsure: { bg: 'rgba(232,184,79,0.14)', fg: color.unsure },
  };
  const t = tones[tone]!;
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }]}>
      <Text style={[styles.chipLabel, { color: t.fg }]}>{label}</Text>
    </View>
  );
}

/**
 * Make/miss/unsure marker — ALWAYS color + shape (colorblind safe):
 * make = filled dot, miss = X, unsure = hollow ring.
 */
export function MakeMissDot({
  outcome,
  size = 14,
}: {
  outcome: ShotOutcome;
  size?: number;
}) {
  if (outcome === 'make') {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color.make,
        }}
      />
    );
  }
  if (outcome === 'miss') {
    return (
      <Text
        style={{
          color: color.miss,
          fontSize: size + 2,
          lineHeight: size + 4,
          fontFamily: type.heading.fontFamily,
        }}
      >
        ✕
      </Text>
    );
  }
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: color.unsure,
      }}
    />
  );
}

/**
 * ErrorCard — the shared "couldn't load" / "not found" card shape, so screens
 * stop hand-rolling near-identical Card + heading + dim-body markup with
 * drifting copy and spacing. Optional `onRetry` renders a ghost retry CTA;
 * omit it for permanent states (e.g. "this session was deleted").
 */
export function ErrorCard({
  title,
  body,
  onRetry,
  retryLabel = 'Try again',
}: {
  title: string;
  body?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <Card>
      <Text style={styles.errorTitle} accessibilityRole="header">
        {title}
      </Text>
      {body != null && <Text style={styles.errorBody}>{body}</Text>}
      {onRetry != null && (
        <PillButton
          variant="ghost"
          label={retryLabel}
          onPress={onRetry}
          style={styles.errorRetry}
        />
      )}
    </Card>
  );
}

/**
 * EmptyState — same shape as ErrorCard for the non-error "nothing here yet"
 * case (distinct name so call sites read intent-first), with an optional
 * primary action instead of a retry.
 */
export function EmptyState({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <Card>
      <Text style={styles.errorTitle} accessibilityRole="header">
        {title}
      </Text>
      {body != null && <Text style={styles.errorBody}>{body}</Text>}
      {actionLabel != null && onAction != null && (
        <PillButton
          variant="ghost"
          label={actionLabel}
          onPress={onAction}
          style={styles.errorRetry}
        />
      )}
    </Card>
  );
}

/** Row helper. */
export function Row({
  children,
  style,
  gap = space.sm,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  gap?: number;
}) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: color.bg,
  },
  card: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  pill: {
    minHeight: touch.minTarget,
    borderRadius: radius.pill,
    paddingHorizontal: space.xl,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillIcon: {
    marginRight: space.sm,
  },
  pillGhost: {
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: 'transparent',
  },
  pillContent: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillLabel: {
    ...type.heading,
  },
  statLabel: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  eyebrow: {
    ...type.caption,
    color: color.textFaint,
    marginBottom: space.sm,
  },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  chipLabel: {
    ...type.caption,
  },
  errorTitle: {
    ...type.heading,
    color: color.text,
  },
  errorBody: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  errorRetry: {
    marginTop: space.lg,
    alignSelf: 'flex-start',
  },
});
