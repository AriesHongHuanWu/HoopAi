/**
 * ContestRacks — the 3-Point Contest ball board.
 *
 * Five racks of five balls; the last ball in each rack is a gold money ball.
 * Balls already thrown dim out, the ball on deck pulses, upcoming balls sit
 * hollow. The engine carries the thrown-ball count as progress * 25, so we
 * derive the on-deck ball from {@link ModeState.progress}.
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

const RACKS = 5;
const BALLS_PER_RACK = 5;
const TOTAL = RACKS * BALLS_PER_RACK;

export function ContestRacks({
  progress,
  done,
}: {
  /** 0..1; thrown-ball count = round(progress * 25). */
  progress: number;
  done?: boolean;
}) {
  const thrown = Math.min(TOTAL, Math.round(progress * TOTAL));
  const onDeck = done ? -1 : thrown; // index of the next ball to shoot

  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(1, { duration: 850, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse]);

  return (
    <View
      style={styles.wrap}
      accessible
      accessibilityLabel={`3-point contest, ${thrown} of ${TOTAL} balls thrown`}
    >
      {Array.from({ length: RACKS }, (_, rack) => (
        <View key={rack} style={styles.rack}>
          {Array.from({ length: BALLS_PER_RACK }, (_, b) => {
            const idx = rack * BALLS_PER_RACK + b;
            const money = b === BALLS_PER_RACK - 1;
            const spent = idx < thrown;
            const current = idx === onDeck;
            return (
              <Ball
                key={b}
                money={money}
                spent={spent}
                current={current}
                pulse={pulse}
              />
            );
          })}
        </View>
      ))}
      <Text style={styles.legend}>Gold = money ball</Text>
    </View>
  );
}

function Ball({
  money,
  spent,
  current,
  pulse,
}: {
  money: boolean;
  spent: boolean;
  current: boolean;
  pulse: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    if (!current) return { transform: [{ scale: 1 }] };
    return { transform: [{ scale: 1 + pulse.value * 0.2 }] };
  });

  const base = money ? styles.money : styles.regular;
  return (
    <Animated.View
      style={[
        styles.ball,
        base,
        spent && styles.spent,
        current && (money ? styles.currentMoney : styles.current),
        style,
      ]}
    />
  );
}

const BALL = 12;

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.xs,
  },
  rack: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: 6,
  },
  ball: {
    width: BALL,
    height: BALL,
    borderRadius: BALL / 2,
    borderWidth: 1.5,
  },
  regular: {
    borderColor: color.hudGlassBorder,
    backgroundColor: 'transparent',
  },
  money: {
    borderColor: color.threePt,
    backgroundColor: color.threePtTint,
  },
  spent: {
    backgroundColor: color.accent,
    borderColor: color.accent,
    opacity: 0.4,
  },
  current: {
    borderColor: color.accent,
    backgroundColor: color.accentTint,
  },
  currentMoney: {
    borderColor: color.threePt,
    backgroundColor: color.threePt,
  },
  legend: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
});
