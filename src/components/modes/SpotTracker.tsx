/**
 * SpotTracker — the five shooting spots for Around the World / Spot Shooting.
 *
 * A horizontal rail of pips: cleared spots fill leather, the active spot pulses,
 * upcoming spots sit as hollow rings. Spot Shooting also shows the running
 * makes/target under the active pip so the player knows how many are left.
 * Reads {@link ModeState.spots} + currentSpot directly; no local scoring.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { color, space, type } from '../../constants/tokens';
import type { ModeSpot } from '../../core/gameModes';

export function SpotTracker({
  spots,
  currentSpot,
  makesPerSpot,
  done,
}: {
  spots: ModeSpot[];
  currentSpot: number;
  /** Present for Spot Shooting; drives the "n/N" caption on the active pip. */
  makesPerSpot?: number;
  done?: boolean;
}) {
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  const active = spots[currentSpot];
  const activeLabel = active?.label ?? '';

  return (
    <View style={styles.wrap} accessible accessibilityLabel={`Spot ${currentSpot + 1} of ${spots.length}: ${activeLabel}`}>
      <View style={styles.rail}>
        {spots.map((spot, i) => {
          const isCurrent = !done && i === currentSpot;
          const isCleared = done || i < currentSpot;
          return (
            <Pip
              key={spot.label}
              index={i}
              cleared={isCleared}
              current={isCurrent}
              pulse={pulse}
            />
          );
        })}
      </View>
      <View style={styles.caption}>
        <Text style={styles.spotLabel} numberOfLines={1}>
          {done ? 'All spots cleared' : activeLabel}
        </Text>
        {!done && makesPerSpot != null && active != null && (
          <Text style={styles.counter}>
            {`${active.makes}/${makesPerSpot}`}
          </Text>
        )}
      </View>
    </View>
  );
}

function Pip({
  index,
  cleared,
  current,
  pulse,
}: {
  index: number;
  cleared: boolean;
  current: boolean;
  pulse: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    if (!current) return { transform: [{ scale: 1 }], opacity: cleared ? 1 : 0.55 };
    return {
      transform: [{ scale: 1 + pulse.value * 0.18 }],
      opacity: 0.7 + pulse.value * 0.3,
    };
  });

  return (
    <Animated.View
      style={[
        styles.pip,
        cleared && styles.pipCleared,
        current && styles.pipCurrent,
        style,
      ]}
    >
      <Text
        style={[
          styles.pipNum,
          cleared && styles.pipNumCleared,
          current && styles.pipNumCurrent,
        ]}
      >
        {index + 1}
      </Text>
    </Animated.View>
  );
}

const PIP = 30;

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
  },
  rail: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  pip: {
    width: PIP,
    height: PIP,
    borderRadius: PIP / 2,
    borderWidth: 2,
    borderColor: color.hudGlassBorder,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pipCleared: {
    backgroundColor: color.accent,
    borderColor: color.accent,
  },
  pipCurrent: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  pipNum: {
    ...type.caption,
    color: color.textFaint,
  },
  pipNumCleared: {
    color: color.onAccent,
  },
  pipNumCurrent: {
    color: color.accent,
  },
  caption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  spotLabel: {
    ...type.caption,
    color: color.text,
    textTransform: 'uppercase',
  },
  counter: {
    ...type.caption,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
});
