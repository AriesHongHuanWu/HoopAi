/**
 * MotionStat — a StatNumber whose value rolls in with fx/CountUp.
 *
 * ui.tsx StatNumber takes only strings and its statSizes styles are
 * module-private (ui.tsx is READ-ONLY), so this replicates the visual layout
 * instead of editing it: centered column, big display numeral, UPPERCASED
 * caption label underneath. The value node is fx/CountUp driven on the UI
 * thread (zero per-frame React re-render), durationMs = motion.celebrate,
 * haptic off by default.
 */
import React from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { color, motion, type } from '@/constants/tokens';
import { CountUp } from '../fx/CountUp';

// Mirrors ui.tsx StatNumber statSizes — keep in sync (ui.tsx is read-only).
const statSizes = {
  hero: type.scoreboard,
  large: type.statLarge,
  medium: type.statMedium,
} as const;

export interface MotionStatProps {
  /** Target value the numeral rolls to. */
  value: number;
  label?: string;
  size?: keyof typeof statSizes;
  tint?: string;
  decimals?: number;
  /** Appended to the numeral (e.g. '%'). */
  suffix?: string;
  /** Re-run the roll when this changes (in addition to `value`). */
  trigger?: number | string;
  style?: StyleProp<ViewStyle>;
}

export function MotionStat({
  value,
  label,
  size = 'large',
  tint,
  decimals = 0,
  suffix = '',
  trigger,
  style,
}: MotionStatProps) {
  return (
    <View style={[{ alignItems: 'center' }, style]}>
      <CountUp
        to={value}
        decimals={decimals}
        suffix={suffix}
        trigger={trigger}
        durationMs={motion.celebrate}
        haptic={false}
        style={[
          statSizes[size] as TextStyle,
          styles.value,
          { color: tint ?? color.text },
        ]}
      />
      {label != null && <Text style={styles.statLabel}>{label.toUpperCase()}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  value: {
    fontVariant: ['tabular-nums'],
    // CountUp renders a TextInput: strip its implicit padding and (Android)
    // font padding so the numeral's baseline matches a plain Text.
    padding: 0,
    includeFontPadding: false,
  },
  // Mirrors ui.tsx styles.statLabel — keep in sync (ui.tsx is read-only).
  statLabel: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
});

export default MotionStat;
