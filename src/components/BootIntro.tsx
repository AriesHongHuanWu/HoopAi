/**
 * BootIntro — the once-per-cold-start branded entrance, played over Home.
 *
 * The signature shot arc draws itself while a ball rides its tip into the
 * rim, the halo pops on arrival, the wordmark rises, then the whole cover
 * lifts away to reveal Home (whose cards stagger in underneath — Home reads
 * {@link bootIntroDelayMs} to time them). Total ~1.5s, non-blocking (pure
 * overlay, Home mounts and loads data beneath it), skipped entirely under
 * reduced motion and on every later mount in the same app process.
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { color, space, type } from '../constants/tokens';

/** One cold-start per process: subsequent Home mounts skip the intro. */
let played = false;

/**
 * Delay (ms) Home should add to its card-entrance stagger so the cards rise
 * exactly as the intro cover lifts. 0 once the intro has already played (or
 * will be skipped) this process.
 */
export function bootIntroDelayMs(reducedMotion: boolean): number {
  return played || reducedMotion ? 0 : REVEAL_AT_MS;
}

const ARC_H = 240;
/** When the cover starts lifting — Home's stagger anchors to this. */
const REVEAL_AT_MS = 1150;

export function BootIntro() {
  const reducedMotion = useReducedMotion();
  const { width: W, height: H } = useWindowDimensions();
  const [visible, setVisible] = useState(() => !played && !reducedMotion);

  // Flight progress: 0 → 1 draws the arc and carries the ball on its tip.
  const flight = useSharedValue(0);
  const halo = useSharedValue(0);
  const wordOp = useSharedValue(0);
  const wordY = useSharedValue(14);
  const cover = useSharedValue(1);

  useEffect(() => {
    if (!visible) return;
    played = true;
    flight.value = withDelay(
      120,
      withTiming(1, { duration: 640, easing: Easing.out(Easing.cubic) }),
    );
    halo.value = withDelay(
      700,
      withSequence(
        withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) }),
        withTiming(0.55, { duration: 260 }),
      ),
    );
    wordOp.value = withDelay(380, withTiming(1, { duration: 420 }));
    wordY.value = withDelay(
      380,
      withTiming(0, { duration: 420, easing: Easing.out(Easing.cubic) }),
    );
    cover.value = withDelay(
      REVEAL_AT_MS,
      withTiming(0, { duration: 380, easing: Easing.in(Easing.quad) }, (done) => {
        if (done) runOnJS(setVisible)(false);
      }),
    );
  }, [visible, flight, halo, wordOp, wordY, cover]);

  // Arc geometry — same motif as the hero CTA, scaled to the screen.
  const rimX = W - 72;
  const rimY = ARC_H * 0.42;
  const p0 = { x: -24, y: ARC_H + 24 };
  const c = { x: W * 0.36, y: -ARC_H * 0.6 };
  const arcPath = `M ${p0.x} ${p0.y} Q ${c.x} ${c.y} ${rimX} ${rimY}`;

  // Ball rides the quadratic Bézier at the drawn tip: P(t) = (1-t)²P0 + 2(1-t)tC + t²P1.
  const ballX = useDerivedValue(() => {
    const t = flight.value;
    const u = 1 - t;
    return u * u * p0.x + 2 * u * t * c.x + t * t * rimX;
  });
  const ballY = useDerivedValue(() => {
    const t = flight.value;
    const u = 1 - t;
    return u * u * p0.y + 2 * u * t * c.y + t * t * rimY;
  });
  const haloR = useDerivedValue(() => 12 + halo.value * 14);
  const haloOp = useDerivedValue(() => halo.value * 0.35);
  const ballOp = useDerivedValue(() => 0.25 + flight.value * 0.75);

  const coverStyle = useAnimatedStyle(() => ({ opacity: cover.value }));
  const wordStyle = useAnimatedStyle(() => ({
    opacity: wordOp.value,
    transform: [{ translateY: wordY.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.cover, coverStyle]}
    >
      <View style={{ height: H * 0.24 }} />
      <Canvas style={{ width: W, height: ARC_H }}>
        <Path
          path={arcPath}
          style="stroke"
          strokeWidth={3}
          color={color.accent}
          opacity={0.5}
          start={0}
          end={flight}
        />
        <Circle cx={rimX} cy={rimY} r={haloR} color={color.accent} opacity={haloOp} />
        <Circle cx={ballX} cy={ballY} r={8} color={color.accent} opacity={ballOp} />
      </Canvas>
      <Animated.View style={[styles.wordRow, wordStyle]}>
        <Text style={styles.word}>
          HOOP
          <Text style={styles.wordAccent}>ILOT</Text>
        </Text>
        <Text style={styles.tagline}>EVERY SHOT COUNTED</Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  cover: {
    backgroundColor: color.bg,
    zIndex: 10,
  },
  wordRow: {
    alignItems: 'center',
    marginTop: space.xl,
  },
  word: {
    ...type.scoreboard,
    color: color.text,
  },
  wordAccent: {
    color: color.accent,
  },
  tagline: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 3,
    marginTop: space.xs,
  },
});
