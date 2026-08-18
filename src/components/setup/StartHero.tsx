/**
 * StartHero — the one-tap GO moment at the top of /session/setup.
 *
 * Pure presentation, no store imports: the oversized START SESSION CTA
 * (absorbed verbatim from setup.tsx's old GoCta), a row of summary chips that
 * jump to their matching Options section, and the placement-tips micro strip.
 * All state lives in the screen; this component only reports presses and its
 * own bottom edge so the screen can decide when the StickyStartBar appears.
 */
import React, { useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Path } from '@shopify/react-native-skia';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

// Concrete import (the ScreenHeader precedent): screen suites stub the motion
// barrel down to the hooks under test, and arcMotif is pure geometry.
import { arcMotif } from '@/components/motion/ArcReveal';
import { color, font, radius, space, touch, type } from '@/constants/tokens';
import type { SetupSectionId } from './setupDefaults';

/**
 * Last-glance placement reminders under the summary chips — copy only.
 * Moved verbatim from setup.tsx (which drops its local copy on integration).
 */
export const PLACEMENT_TIPS: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
}[] = [
  { icon: 'footsteps-outline', label: '15–30 FT SIDE VIEW' },
  { icon: 'scan-outline', label: 'WHOLE RIM VISIBLE' },
  { icon: 'lock-closed-outline', label: 'STEADY PROP' },
];

/** Bottom edge (y + height) of a laid-out block, in the parent's coordinates. */
export function layoutBottom(layout: { y: number; height: number }): number {
  return layout.y + layout.height;
}

/** The CTA sub-line when starting is possible — the honest camera promise. */
const GO_SUB_DEFAULT = 'Opens the camera — tracking starts with your first shot';

/** onLeather alpha for the decorative arc inside the CTA. */
const ARC_OPACITY = 0.15;
const ARC_STROKE_WIDTH = 3;

/** One summary chip beneath the CTA — tapping it opens its Options section. */
export interface StartHeroChip {
  id: SetupSectionId;
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  /**
   * 'warning' paints the chip in the unsure/chalkYellow tint — the camera
   * chip when permission is hard-denied. Default: the neutral chip.
   */
  tone?: 'default' | 'warning';
}

export interface StartHeroProps {
  /**
   * One-line session summary. Mirrors the StickyStartBar's summary line;
   * currently not rendered inside the hero (the chips carry the same facts
   * visually) but kept in the contract so the screen passes one string to
   * both start surfaces.
   */
  summary: string;
  chips: StartHeroChip[];
  onStart: () => void;
  disabled: boolean;
  onChipPress: (id: SetupSectionId) => void;
  /**
   * Honesty: when starting is hard-blocked (camera permission denied and not
   * re-requestable), this replaces the CTA's "opens the camera" promise with
   * what is actually true and how to fix it. Never set while starting works.
   */
  disabledReason?: string;
  /**
   * Reports the hero's bottom edge (layout.y + layout.height) in the scroll
   * content's coordinates — the screen uses it for sticky-bar hysteresis.
   */
  onLayoutBottom: (y: number) => void;
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * The broadcast GO moment — one oversized live-style button. Same press
 * spring as PillButton, same disabled semantics as the old CTA.
 * (Copied verbatim from setup.tsx's GoCta; press spring mirrors the ungated
 * PillButton micro-interaction, entrance motion is gated by the parent.)
 */
function GoCta({
  onPress,
  disabled,
  sub,
}: {
  onPress: () => void;
  disabled: boolean;
  /** The one-line promise under the label — GO_SUB_DEFAULT or the honest block reason. */
  sub: string;
}) {
  const scale = useSharedValue(1);
  const animStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  // Measured CTA size for the decorative arc — the Skia canvas needs numbers.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      onLayout={(e: LayoutChangeEvent) =>
        setSize({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })
      }
      onPressIn={() => {
        scale.value = withSpring(0.97, { damping: 20, stiffness: 400 });
      }}
      onPressOut={() => {
        scale.value = withSpring(1, { damping: 16, stiffness: 300 });
      }}
      accessibilityRole="button"
      accessibilityLabel="Start session — open the camera"
      accessibilityState={{ disabled }}
      style={[styles.go, disabled && styles.goDisabled, animStyle]}
    >
      {/* ONE static shot-arc stroke in onLeather behind the label. arcMotif
          geometry, plain Skia path, drawn once — NO animation, NO worklet
          (the fx/particles crash precedent). */}
      {size != null && size.w > 0 && size.h > 0 && (
        <Canvas
          pointerEvents="none"
          accessible={false}
          importantForAccessibility="no"
          style={[styles.goArc, { width: size.w, height: size.h }]}
        >
          <Path
            path={arcMotif(size.w, size.h).path}
            style="stroke"
            strokeWidth={ARC_STROKE_WIDTH}
            color={color.onAccent}
            opacity={ARC_OPACITY}
          />
        </Canvas>
      )}
      <View style={styles.goIcon}>
        <Ionicons name="videocam" size={22} color={color.onAccent} />
      </View>
      <View style={styles.goBody}>
        <Text style={styles.goLabel}>START SESSION</Text>
        <Text style={styles.goSub}>{sub}</Text>
      </View>
    </AnimatedPressable>
  );
}

export function StartHero({
  chips,
  onStart,
  disabled,
  onChipPress,
  disabledReason,
  onLayoutBottom,
  entering,
}: StartHeroProps) {
  return (
    <Animated.View
      entering={entering}
      onLayout={(e: LayoutChangeEvent) => onLayoutBottom(layoutBottom(e.nativeEvent.layout))}
    >
      <GoCta onPress={onStart} disabled={disabled} sub={disabledReason ?? GO_SUB_DEFAULT} />

      {/* Summary chips — each one jumps to the matching Options section. */}
      <View style={styles.chipRow}>
        {chips.map((chip) => (
          <Pressable
            key={chip.id}
            accessibilityRole="button"
            accessibilityLabel={`${chip.label} — opens options`}
            onPress={() => onChipPress(chip.id)}
            style={({ pressed }) => [
              styles.chip,
              chip.tone === 'warning' && styles.chipWarning,
              pressed && styles.chipPressed,
            ]}
          >
            <Ionicons
              name={chip.icon}
              size={13}
              color={chip.tone === 'warning' ? color.unsure : color.accent}
            />
            <Text
              style={[styles.chipLabel, chip.tone === 'warning' && styles.chipLabelWarning]}
              numberOfLines={1}
            >
              {chip.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {/* Placement tips micro strip — last-glance reminders, copy only. */}
      <View style={styles.tipsStrip}>
        {PLACEMENT_TIPS.map((tip, i) => (
          <React.Fragment key={tip.label}>
            {i > 0 && (
              <Text
                style={styles.tipDivider}
                accessible={false}
                importantForAccessibility="no"
              >
                ·
              </Text>
            )}
            <View style={styles.tipItem}>
              <Ionicons name={tip.icon} size={12} color={color.accent} />
              <Text style={styles.tipLabel}>{tip.label}</Text>
            </View>
          </React.Fragment>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // --- GO CTA (verbatim from setup.tsx styles.go*) ------------------------
  go: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 72,
    backgroundColor: color.accent,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    // Clips the decorative arc to the rounded CTA.
    overflow: 'hidden',
  },
  goDisabled: {
    opacity: 0.4,
  },
  // RN 0.86 dropped StyleSheet.absoluteFillObject — explicit edges only.
  goArc: {
    position: 'absolute',
    left: 0,
    top: 0,
  },
  goIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    // Pre-existing rgba from setup.tsx styles.goIcon — a dark well on the
    // accent fill; deliberately kept byte-identical (not a new raw color).
    backgroundColor: 'rgba(20, 10, 5, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  goBody: {
    flex: 1,
  },
  goLabel: {
    fontFamily: font.display,
    fontSize: 24,
    lineHeight: 26,
    letterSpacing: 1,
    color: color.onAccent,
  },
  goSub: {
    ...type.caption,
    color: color.onAccent,
    opacity: 0.7,
    marginTop: 2,
  },
  // --- Summary chips ------------------------------------------------------
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  chip: {
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
  },
  chipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  /** The unsure/chalkYellow treatment — the camera chip when access is blocked. */
  chipWarning: {
    backgroundColor: color.unsureTint,
    borderColor: color.unsure,
  },
  chipLabel: {
    ...type.caption,
    color: color.textDim,
  },
  chipLabelWarning: {
    color: color.unsure,
  },
  // --- Tips strip (verbatim from setup.tsx styles.tips*) ------------------
  tipsStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  tipItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  tipLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  tipDivider: {
    ...type.micro,
    color: color.textFaint,
  },
});
