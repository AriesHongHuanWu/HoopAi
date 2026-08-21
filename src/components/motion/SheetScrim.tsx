/**
 * SheetScrim — the ONE overlay grammar for in-screen sheets and dialogs.
 *
 * The app had four overlay dialects: share sheets, editors, import sheets and
 * the mode-complete card each picked their own scrim color and entrance. This
 * is the shared shape — a full-screen `color.scrim` layer fading in quick,
 * with a panel slot rising FadeInDown at the standard beat. It is exactly the
 * grammar ModeComplete already speaks, and the same "a panel appeared"
 * reading as the root stack's Class-4 utility routes (slide_from_bottom).
 * Exits fade quick: a dismissed sheet gets out of the way faster than it
 * arrived.
 *
 * Mount contract: render it conditionally ({open && <SheetScrim>…}) INSIDE a
 * screen that stays mounted, so Reanimated can play the exit. Inside an RN
 * <Modal>, `exiting` does NOT play when the Modal unmounts — Modal-based
 * adopters get the entrance only.
 *
 * A11y: the root announces as a modal view. The tap-to-dismiss catcher is
 * hidden from assistive tech — adopters keep an explicit close control inside
 * the panel.
 *
 * Motion: entering/exiting builders only, no worklets. Every builder chains
 * .reduceMotion(ReduceMotion.System), so the whole grammar collapses to a
 * plain appearance under the OS Reduce Motion setting.
 */
import React from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';

import { color, motion, space } from '@/constants/tokens';

/** RN 0.86 dropped StyleSheet.absoluteFillObject — local equivalent. */
const absoluteFill = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
} as const;

export interface SheetScrimProps {
  /** The panel content — usually a Card. */
  children: React.ReactNode;
  /** Tap on the scrim outside the panel. Omit for blocking dialogs. */
  onDismiss?: () => void;
  /** 'bottom' = Class-4 sheet (default); 'center' = dialog/celebration. */
  align?: 'bottom' | 'center';
  /** Extra style for the panel slot (width caps, inset overrides). */
  panelStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SheetScrim({
  children,
  onDismiss,
  align = 'bottom',
  panelStyle,
  testID,
}: SheetScrimProps) {
  return (
    <Animated.View
      entering={FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(motion.quick).reduceMotion(ReduceMotion.System)}
      style={[styles.scrim, align === 'center' ? styles.center : styles.bottom]}
      accessibilityViewIsModal
      testID={testID}
    >
      {onDismiss != null && (
        <Pressable
          style={absoluteFill}
          onPress={onDismiss}
          accessible={false}
          importantForAccessibility="no"
        />
      )}
      <Animated.View
        entering={FadeInDown.duration(motion.standard).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(motion.quick).reduceMotion(ReduceMotion.System)}
        style={panelStyle}
      >
        {children}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...absoluteFill,
    backgroundColor: color.scrim,
    padding: space.lg,
  },
  bottom: {
    justifyContent: 'flex-end',
  },
  center: {
    justifyContent: 'center',
  },
});

export default SheetScrim;
