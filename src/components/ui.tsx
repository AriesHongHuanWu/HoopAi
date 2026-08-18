/**
 * Shared UI primitives — the only building blocks screens should use for
 * basic structure. Dark broadcast system; tokens in src/constants/tokens.ts.
 */
import React, { useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { color, radius, space, touch, type } from '../constants/tokens';
import type { ShotOutcome } from '../core/types';
// Imported from the CONCRETE module, not the '@/components/motion' barrel:
// this kit sits underneath every screen, and several suites stub that barrel
// down to the two or three symbols the screen under test uses. Reaching past
// the barrel keeps Card's press physics real everywhere instead of resolving
// to `undefined` in any suite that happens to mock the barrel.
import { PressScale } from './motion/PressScale';

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

/** Entering animation shape shared by every card in the kit. */
type Entering = React.ComponentProps<typeof Animated.View>['entering'];

/**
 * PressableCard — a Card that answers the finger.
 *
 * WHY it exists: PillButton was the only surface in the app with press
 * physics, so session cards, mode tiles and profile rows all flat-cut on
 * touch and the app read as a slideshow of static panels. This routes the
 * card shape through the shared {@link PressScale} spring (identical numbers
 * to PillButton, reduced-motion aware, haptics via the gated gateway) so
 * screens stop hand-rolling their own — and so every press in the app has
 * the same weight.
 */
export function PressableCard({
  children,
  style,
  onPress,
  onLongPress,
  disabled = false,
  haptic = 'none',
  accessibilityLabel,
  entering,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** Settings-gated haptic fired on press. See PressScale. */
  haptic?: 'none' | 'selection' | 'impactLight';
  accessibilityLabel?: string;
  /** See {@link Card}. */
  entering?: Entering;
}) {
  const pressable = (
    <PressScale
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      haptic={haptic}
      accessibilityLabel={accessibilityLabel}
      style={[styles.card, disabled && styles.cardDisabled, style]}
    >
      {children}
    </PressScale>
  );
  return entering ? <Animated.View entering={entering}>{pressable}</Animated.View> : pressable;
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
  entering?: Entering;
}) {
  // A tappable Card IS a PressableCard. Delegating here (rather than adding
  // the spring only to a new opt-in export) is the whole point of the change:
  // every `<Card onPress>` already written across the app inherits the press
  // physics without a single screen being touched. The old pressed-state
  // background tint is gone on purpose — the spring is the feedback now, and
  // two simultaneous press signals read as a flicker.
  if (onPress) {
    return (
      <PressableCard onPress={onPress} style={style} entering={entering}>
        {children}
      </PressableCard>
    );
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
// Skeletons

/**
 * Shimmer is pulled in on FIRST USE instead of at module scope.
 *
 * WHY: it paints on a Skia canvas, and @shopify/react-native-skia is an
 * ESM-only package. A top-level import would drag Skia into every module that
 * touches this kit — which is every screen, and every unit test that renders
 * so much as a Card — forcing a Skia mock on suites that never paint one.
 * Behind a getter, that cost lands on SkeletonCard alone. Metro still sees a
 * static require, so nothing changes about bundling.
 */
type ShimmerComponent = (typeof import('./motion/Shimmer'))['Shimmer'];
let shimmerImpl: ShimmerComponent | null = null;
function getShimmer(): ShimmerComponent {
  shimmerImpl ??= (require('./motion/Shimmer') as typeof import('./motion/Shimmer')).Shimmer;
  return shimmerImpl;
}

/** Hero block height — a `statLarge` numeral is what's arriving. */
const SKELETON_HERO_H = type.statLarge.lineHeight;
/** Text-bar height: the ink height of a body line, not its full line box. */
const SKELETON_LINE_H = type.body.fontSize;
/**
 * Floor for the seeded bar width, so the Skia canvas never gets a nonsense
 * size on a first frame that hasn't been measured yet.
 */
const SKELETON_MIN_W = touch.minTarget * 2;

/**
 * Ragged right edge. A stack of identical full-width bars reads as a table;
 * real paragraphs break short and the LAST line breaks shortest, which is what
 * makes a skeleton parse as "text is coming" without being read.
 */
function skeletonLineFactor(index: number, total: number): number {
  if (index === total - 1) return total === 1 ? 0.72 : 0.6;
  return index % 2 === 0 ? 1 : 0.88;
}

/**
 * SkeletonCard — the SHAPE of the card that is loading.
 *
 * WHY: loading screens showed a single line of dim text, so the layout
 * visibly reflowed the instant data landed and every load felt like a jump
 * cut. A skeleton reserves the real geometry, so content arrives INTO the
 * space it was always going to occupy.
 *
 * `hero` adds the big-numeral block on top; `lines` is how many text bars sit
 * under it. Unmount it when the content arrives — see the Shimmer contract.
 */
export function SkeletonCard({
  lines = 3,
  hero = false,
  style,
}: {
  /** Text bars to draw under the optional hero block. Minimum 1. */
  lines?: number;
  /** Draw a hero-numeral block above the bars. */
  hero?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const ShimmerBlock = getShimmer();
  const { width: screenW } = useWindowDimensions();
  const [measuredW, setMeasuredW] = useState(0);

  // Shimmer is a Skia canvas, so it needs REAL pixel widths. Seed them from
  // the natural full-bleed card width (screen minus Screen's horizontal
  // padding and the card's own padding, both sides) and refine on first
  // layout. WHY not simply wait for onLayout: a skeleton that renders empty
  // on its first frame flashes blank at exactly the moment it exists to
  // reassure.
  const innerW =
    measuredW > 0 ? measuredW : Math.max(SKELETON_MIN_W, screenW - (space.lg + space.lg) * 2);
  const count = Math.max(1, Math.floor(lines));

  const onLayout = (e: LayoutChangeEvent) => {
    const next = Math.max(SKELETON_MIN_W, e.nativeEvent.layout.width - space.lg * 2);
    // Guard the setState so a re-layout at the same width can't spin.
    setMeasuredW((prev) => (Math.abs(prev - next) < 1 ? prev : next));
  };

  return (
    <View
      style={[styles.card, style]}
      onLayout={onLayout}
      // One node to the screen reader: the bars are decoration, the message
      // is "this is loading".
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
    >
      {hero && (
        <ShimmerBlock
          width={innerW}
          height={SKELETON_HERO_H}
          radius={radius.md}
          style={styles.skeletonHero}
        />
      )}
      {Array.from({ length: count }, (_, i) => (
        <ShimmerBlock
          key={i}
          width={Math.round(innerW * skeletonLineFactor(i, count))}
          height={SKELETON_LINE_H}
          radius={radius.sm}
          style={i === 0 ? undefined : styles.skeletonLine}
        />
      ))}
    </View>
  );
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
  compact = false,
}: {
  label: string;
  tone?: 'default' | 'make' | 'miss' | 'accent' | 'unsure';
  /** Micro-type, tighter-padding variant for dense sub-rows (evidence receipts). */
  compact?: boolean;
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
    <View style={[styles.chip, compact && styles.chipCompact, { backgroundColor: t.bg }]}>
      <Text style={[compact ? styles.chipLabelCompact : styles.chipLabel, { color: t.fg }]}>
        {label}
      </Text>
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
  cardDisabled: {
    opacity: 0.4,
  },
  skeletonHero: {
    marginBottom: space.lg,
  },
  skeletonLine: {
    marginTop: space.sm,
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
  chipCompact: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipLabel: {
    ...type.caption,
  },
  chipLabelCompact: {
    ...type.micro,
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
