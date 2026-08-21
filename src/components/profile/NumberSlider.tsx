/**
 * NumberSlider — a gesture-driven value slider for the identity flow.
 *
 * There's no slider package in the app, and building one on the two libs we
 * DO ship (gesture-handler + reanimated) keeps the broadcast look consistent:
 * a hairline track, a leather fill, a chalk knob, and a giant Barlow numeral
 * above it. Fully accessible via `accessibilityRole="adjustable"` + the
 * increment/decrement actions so VoiceOver/TalkBack users get the same reach
 * without the drag.
 *
 * Used on the height / weight / wingspan wizard steps and inline in the
 * profile editor. The value is CONTROLLED — the parent owns it and every drag
 * frame calls back on the JS thread (cheap: one setState per settled pixel).
 *
 * READOUT RULE — do not nest anything inside the big numeral's <Text>. It is
 * an `adjustsFontSizeToFit` + `numberOfLines={1}` paragraph, and iOS cannot
 * shrink one line that mixes font runs: a nested unit chip (96/96 numeral +
 * 32/34 unit) rendered NOTHING AT ALL on device, which is how the height step
 * shipped with no number on it. The unit is a sibling. Every other hero
 * numeral in the app (ModeComplete's hero, Home's START SESSION) already does
 * it this way; numberSliderReadout.test.tsx pins it here.
 */
import * as Haptics from 'expo-haptics';
import { useCallback } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, radius, space, type } from '@/constants/tokens';
import { useSettings } from '@/state/settingsStore';

const KNOB = 30;
const TRACK_H = 6;

function clamp(v: number, min: number, max: number): number {
  'worklet';
  return Math.min(max, Math.max(min, v));
}

export function NumberSlider({
  value,
  min,
  max,
  step = 1,
  unit,
  label,
  formatValue,
  spokenValue,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Trailing unit shown small after the numeral (e.g. "cm"). */
  unit?: string;
  /** Accessible name of the control (e.g. "Height"). */
  label: string;
  /** Override the big displayed value (e.g. feet/inches). Defaults to the number. */
  formatValue?: (v: number) => string;
  /**
   * Spoken form of the value, when the printed one is punctuation a screen
   * reader cannot be trusted with (`5'11"`). Defaults to the printed value
   * plus `unit`.
   */
  spokenValue?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const trackW = useSharedValue(0);
  const range = max - min;

  const commit = useCallback(
    (next: number) => {
      const snapped = clamp(Math.round(next / step) * step, min, max);
      if (snapped !== value) {
        if (useSettings.getState().hapticsEnabled) void Haptics.selectionAsync();
        onChange(snapped);
      }
    },
    [max, min, onChange, step, value],
  );

  const valueFromX = (x: number) => {
    'worklet';
    const w = trackW.value;
    if (w <= 0) return value;
    const frac = clamp(x / w, 0, 1);
    return min + frac * range;
  };

  const pan = Gesture.Pan()
    .onBegin((e) => {
      runOnJS(commit)(valueFromX(e.x));
    })
    .onUpdate((e) => {
      runOnJS(commit)(valueFromX(e.x));
    });

  const tap = Gesture.Tap().onEnd((e) => {
    runOnJS(commit)(valueFromX(e.x));
  });

  const gesture = Gesture.Race(pan, tap);

  const frac = range > 0 ? clamp((value - min) / range, 0, 1) : 0;

  const fillStyle = useAnimatedStyle(() => ({
    width: withTiming(`${frac * 100}%`, { duration: motion.instant }),
  }));
  const knobStyle = useAnimatedStyle(() => ({
    left: withTiming(`${frac * 100}%`, { duration: motion.instant }),
  }));

  const onLayout = (e: LayoutChangeEvent) => {
    trackW.value = e.nativeEvent.layout.width;
  };

  const shown = formatValue ? formatValue(value) : String(value);
  const spokenNumber = spokenValue ? spokenValue(value) : `${shown}${unit ? ` ${unit}` : ''}`;
  const spoken = `${label}: ${spokenNumber}`;
  // The end-of-track labels wear the SAME formatter as the readout: an
  // imperial slider must read 3'11" … 7'3", never the raw inch counts.
  const endLabel = (v: number) => (formatValue ? formatValue(v) : String(v));

  return (
    <View style={styles.wrap}>
      {/* The numeral is the ONLY child of the auto-shrinking Text. iOS cannot
          shrink a single line that mixes font runs, and the unit nested inside
          here is what blanked the height readout — it stays a sibling. */}
      <View style={styles.readout} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Text style={styles.value} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
          {shown}
        </Text>
        {unit != null && <Text style={styles.unit}>{unit}</Text>}
      </View>
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={spoken}
          accessibilityValue={{ min, max, now: value }}
          accessibilityActions={[
            { name: 'increment', label: `Increase ${label.toLowerCase()}` },
            { name: 'decrement', label: `Decrease ${label.toLowerCase()}` },
          ]}
          onAccessibilityAction={(ev) => {
            if (ev.nativeEvent.actionName === 'increment') commit(value + step);
            else if (ev.nativeEvent.actionName === 'decrement') commit(value - step);
          }}
          style={styles.hit}
        >
          <View style={styles.track} onLayout={onLayout}>
            <Animated.View style={[styles.fill, fillStyle]} />
            <Animated.View style={[styles.knob, knobStyle]} />
          </View>
          <View style={styles.scaleRow} importantForAccessibility="no-hide-descendants">
            <Text style={styles.scaleLabel}>{endLabel(min)}</Text>
            <Text style={styles.scaleLabel}>{endLabel(max)}</Text>
          </View>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: space.xl,
    alignSelf: 'stretch',
  },
  readout: {
    flexDirection: 'row',
    justifyContent: 'center',
    // Baseline so the small unit sits on the numeral's feet rather than
    // floating at the middle of a 96pt line box.
    alignItems: 'baseline',
    gap: space.xs,
  },
  value: {
    ...type.scoreboard,
    color: color.text,
    fontVariant: ['tabular-nums'],
    // Lets the numeral (not the unit) absorb the squeeze on narrow screens.
    flexShrink: 1,
  },
  unit: {
    ...type.statMedium,
    color: color.textDim,
  },
  // Tall touch area so the thin track is comfortably grabbable.
  hit: {
    paddingVertical: space.lg,
    justifyContent: 'center',
  },
  track: {
    height: TRACK_H,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: TRACK_H,
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  knob: {
    position: 'absolute',
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: color.text,
    borderWidth: 3,
    borderColor: color.accent,
    // Center the knob on the value point.
    marginLeft: -KNOB / 2,
    top: -(KNOB - TRACK_H) / 2,
  },
  scaleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  scaleLabel: {
    ...type.micro,
    color: color.textFaint,
  },
});
