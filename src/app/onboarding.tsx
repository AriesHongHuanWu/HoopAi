/**
 * Onboarding — 3-pane horizontal pager shown on first launch.
 *
 * Panes: (1) phone placement, (2) shot counting, (3) clips + stats.
 * Illustrations are abstract Skia drawings built from design tokens and the
 * signature shot-arc motif — no image assets. "Let's hoop" and Skip both set
 * settings.onboardingDone and replace back to the dashboard.
 */
import {
  Canvas,
  Circle,
  DashPathEffect,
  Line,
  Path,
  RoundedRect,
  vec,
} from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState, type ReactElement } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MakeMissDot, PillButton, Row, Screen } from '@/components/ui';
import { color, motion, radius, space, touch, type } from '@/constants/tokens';
import { useSettings } from '@/state/settingsStore';

const ILLO_HEIGHT = 200;

interface Pt {
  x: number;
  y: number;
}

/** Point on a quadratic bezier at t — keeps the ball ON the drawn arc. */
function quadPoint(t: number, p0: Pt, c: Pt, p1: Pt): Pt {
  const mt = 1 - t;
  return {
    x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y,
  };
}

/** Pane 1 — phone on the sideline, sight line to the rim, arc it will watch. */
function AimIllustration({ w }: { w: number }) {
  const h = ILLO_HEIGHT;
  const rim: Pt = { x: w * 0.78, y: h * 0.36 };
  // Faint preview of the shot arc the camera is set up to see.
  const arcStart: Pt = { x: w * 0.2, y: h - 24 };
  const arcCtrl: Pt = { x: w * 0.46, y: -h * 0.22 };
  const arcEnd: Pt = { x: rim.x, y: rim.y - 10 };
  const preview = `M ${arcStart.x} ${arcStart.y} Q ${arcCtrl.x} ${arcCtrl.y} ${arcEnd.x} ${arcEnd.y}`;
  return (
    <Canvas style={{ width: w, height: h, alignSelf: 'center' }}>
      {/* Floor */}
      <Line p1={vec(space.sm, h - 16)} p2={vec(w - space.sm, h - 16)} color={color.border} strokeWidth={2} />
      {/* Ghost of the arc the camera will track */}
      <Path path={preview} style="stroke" strokeWidth={2} color={color.accent} opacity={0.22}>
        <DashPathEffect intervals={[2, 8]} />
      </Path>
      {/* Phone propped at the left */}
      <RoundedRect x={28} y={h - 86} width={32} height={62} r={6} style="stroke" color={color.textDim} strokeWidth={2} />
      <Circle cx={44} cy={h - 78} r={2} color={color.textFaint} />
      {/* Rim + net + backboard at the right */}
      <Circle cx={rim.x} cy={rim.y} r={10} style="stroke" color={color.accent} strokeWidth={3} />
      <Line p1={vec(rim.x - 6, rim.y + 9)} p2={vec(rim.x - 3, rim.y + 22)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x, rim.y + 10)} p2={vec(rim.x, rim.y + 24)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x + 6, rim.y + 9)} p2={vec(rim.x + 3, rim.y + 22)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x + 16, rim.y - 26)} p2={vec(rim.x + 16, rim.y + 10)} color={color.textDim} strokeWidth={3} />
      <Line p1={vec(rim.x + 16, rim.y + 10)} p2={vec(rim.x + 16, h - 16)} color={color.border} strokeWidth={2} />
      {/* Dashed sight line: camera → rim */}
      <Line p1={vec(62, h - 80)} p2={vec(rim.x - 14, rim.y + 2)} color={color.textFaint} strokeWidth={2}>
        <DashPathEffect intervals={[6, 6]} />
      </Line>
    </Canvas>
  );
}

/** Pane 2 — the shot arc into the rim, ball mid-flight with a comet trail. */
function CountIllustration({ w }: { w: number }) {
  const h = ILLO_HEIGHT;
  const rim: Pt = { x: w * 0.8, y: h * 0.42 };
  const start: Pt = { x: 28, y: h - 24 };
  const ctrl: Pt = { x: w * 0.42, y: -h * 0.35 };
  const end: Pt = { x: rim.x, y: rim.y - 8 };
  const ball = quadPoint(0.72, start, ctrl, end);
  // Comet trail: fading echoes of the ball behind it along the arc.
  const trail = [0.64, 0.56, 0.48, 0.4].map((t, i) => ({
    ...quadPoint(t, start, ctrl, end),
    r: 6 - i * 1.1,
    opacity: 0.4 - i * 0.09,
  }));
  const path = `M ${start.x} ${start.y} Q ${ctrl.x} ${ctrl.y} ${end.x} ${end.y}`;
  return (
    <Canvas style={{ width: w, height: h, alignSelf: 'center' }}>
      {/* Floor */}
      <Line p1={vec(space.sm, h - 16)} p2={vec(w - space.sm, h - 16)} color={color.border} strokeWidth={2} />
      {/* Rim + net + backboard */}
      <Circle cx={rim.x} cy={rim.y} r={10} style="stroke" color={color.textDim} strokeWidth={3} />
      <Line p1={vec(rim.x - 6, rim.y + 9)} p2={vec(rim.x - 3, rim.y + 22)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x, rim.y + 10)} p2={vec(rim.x, rim.y + 24)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x + 6, rim.y + 9)} p2={vec(rim.x + 3, rim.y + 22)} color={color.textFaint} strokeWidth={1.5} />
      <Line p1={vec(rim.x + 16, rim.y - 26)} p2={vec(rim.x + 16, rim.y + 10)} color={color.textDim} strokeWidth={3} />
      {/* The arc + comet trail + ball */}
      <Path path={path} style="stroke" strokeWidth={3} color={color.accent} />
      {trail.map((p, i) => (
        <Circle key={i} cx={p.x} cy={p.y} r={p.r} color={color.accent} opacity={p.opacity} />
      ))}
      <Circle cx={ball.x} cy={ball.y} r={8} color={color.accent} />
    </Canvas>
  );
}

/** Pane 3 — a highlight clip card and a rising FG% spark line. */
function ClipsIllustration({ w }: { w: number }) {
  const h = ILLO_HEIGHT;
  const clipX = 24;
  const clipW = w * 0.4;
  const clipCx = clipX + clipW / 2;
  const clipCy = h / 2;
  const chartL = w * 0.56;
  const chartR = w - 24;
  const baseY = h - 40;
  const stepX = (chartR - chartL) / 4;
  const ys = [0.42, 0.5, 0.34, 0.38, 0.2].map((f) => h * f + 24);
  const spark = ys
    .map((y, i) => `${i === 0 ? 'M' : 'L'} ${chartL + stepX * i} ${y}`)
    .join(' ');
  const area =
    `M ${chartL} ${baseY} ` +
    ys.map((y, i) => `L ${chartL + stepX * i} ${y}`).join(' ') +
    ` L ${chartR} ${baseY} Z`;
  return (
    <Canvas style={{ width: w, height: h, alignSelf: 'center' }}>
      {/* Clip card with play button and a REC dot */}
      <RoundedRect x={clipX} y={28} width={clipW} height={h - 68} r={12} style="stroke" color={color.textDim} strokeWidth={2} />
      <Circle cx={clipX + 16} cy={44} r={4} color={color.miss} />
      <Path
        path={`M ${clipCx - 8} ${clipCy - 13} L ${clipCx + 13} ${clipCy} L ${clipCx - 8} ${clipCy + 13} Z`}
        color={color.accent}
      />
      {/* FG% spark line, trending up */}
      <Path path={area} color={color.accentTint} />
      <Line p1={vec(chartL, baseY)} p2={vec(chartR, baseY)} color={color.border} strokeWidth={2} />
      <Path path={spark} style="stroke" strokeWidth={3} strokeJoin="round" color={color.accent} />
      <Circle cx={chartR} cy={ys[4]!} r={5} color={color.make} />
    </Canvas>
  );
}

interface PageDef {
  key: string;
  eyebrow: string;
  title: string;
  body: string;
  Illustration: (props: { w: number }) => ReactElement;
}

const PAGES: PageDef[] = [
  {
    key: 'aim',
    eyebrow: 'Step 1 · Setup',
    title: 'Point it at the hoop',
    body: 'Prop your phone 15–30 feet to the side of the basket with the whole rim in frame. A tripod, a bench or a water bottle all work.',
    Illustration: AimIllustration,
  },
  {
    key: 'count',
    eyebrow: 'Step 2 · Tracking',
    title: 'Every shot, counted',
    body: "We follow the ball's arc and call every make and miss in real time, with courtside sounds you can hear from the free-throw line.",
    Illustration: CountIllustration,
  },
  {
    key: 'clips',
    eyebrow: 'Step 3 · Highlights',
    title: 'Your clips, your stats',
    body: "Record your session and keep the clips you want — makes only by default. FG%, streaks and entry angle land on your dashboard. Each screen will show you around the first time — look for the Skip if you'd rather dive in.",
    Illustration: ClipsIllustration,
  },
];

/** One progress dot; grows into a pill and warms up when active. */
function PagerDot({ active }: { active: boolean }) {
  const style = useAnimatedStyle(() => ({
    width: withTiming(active ? space.xl : space.sm, {
      duration: motion.quick,
      reduceMotion: ReduceMotion.System,
    }),
    opacity: withTiming(active ? 1 : 0.5, {
      duration: motion.quick,
      reduceMotion: ReduceMotion.System,
    }),
  }));
  return (
    <Animated.View
      style={[styles.dot, active && styles.dotActive, style]}
    />
  );
}

export default function OnboardingScreen() {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<PageDef>>(null);
  const [page, setPage] = useState(0);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const setSetting = useSettings((s) => s.set);

  const lastIndex = PAGES.length - 1;

  const finish = () => {
    if (hapticsEnabled) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
    setSetting('onboardingDone', true);
    router.replace('/');
  };

  const next = () => {
    if (page >= lastIndex) {
      finish();
      return;
    }
    listRef.current?.scrollToIndex({ index: page + 1, animated: true });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const raw = Math.round(e.nativeEvent.contentOffset.x / width);
    const clamped = Math.max(0, Math.min(lastIndex, raw));
    if (clamped !== page) setPage(clamped);
  };

  return (
    <Screen padded={false}>
      {/* Skip — top right, quiet but always available */}
      <Row style={styles.topBar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Skip onboarding"
          onPress={finish}
          hitSlop={space.sm}
          style={({ pressed }) => [styles.skip, pressed && styles.skipPressed]}
        >
          <Text style={styles.skipLabel}>Skip</Text>
        </Pressable>
      </Row>

      <FlatList
        ref={listRef}
        data={PAGES}
        keyExtractor={(item) => item.key}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <View importantForAccessibility="no-hide-descendants">
              <item.Illustration w={width - space.xl * 2} />
            </View>
            {item.key === 'count' && (
              <Row gap={space.lg} style={styles.legend}>
                <Row gap={space.xs}>
                  <MakeMissDot outcome="make" />
                  <Text style={styles.legendLabel}>Make</Text>
                </Row>
                <Row gap={space.xs}>
                  <MakeMissDot outcome="miss" />
                  <Text style={styles.legendLabel}>Miss</Text>
                </Row>
                <Row gap={space.xs}>
                  <MakeMissDot outcome="unsure" />
                  <Text style={styles.legendLabel}>Unsure — tap to fix</Text>
                </Row>
              </Row>
            )}
            <Text style={styles.pageEyebrow}>{item.eyebrow.toUpperCase()}</Text>
            <Text style={styles.pageTitle} accessibilityRole="header">
              {item.title}
            </Text>
            <Text style={styles.pageBody}>{item.body}</Text>
          </View>
        )}
      />

      {/* Dots + CTA */}
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.xl }]}>
        {/* Decorative page dots — no text, invisible to screen readers. */}
        <View importantForAccessibility="no-hide-descendants">
          <Row gap={space.sm} style={styles.dots}>
            {PAGES.map((p, i) => (
              <PagerDot key={p.key} active={i === page} />
            ))}
          </Row>
        </View>
        <PillButton label={page === lastIndex ? "Let's hoop" : 'Next'} onPress={next} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    justifyContent: 'flex-end',
    paddingHorizontal: space.lg,
  },
  skip: {
    minWidth: touch.minTarget,
    minHeight: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  skipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  skipLabel: {
    ...type.bodyMedium,
    color: color.textFaint,
  },
  page: {
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
    gap: space.md,
  },
  legend: {
    alignSelf: 'center',
  },
  legendLabel: {
    ...type.caption,
    color: color.textDim,
  },
  pageEyebrow: {
    ...type.caption,
    color: color.accent,
    marginTop: space.lg,
  },
  pageTitle: {
    ...type.title,
    color: color.text,
  },
  pageBody: {
    ...type.body,
    color: color.textDim,
  },
  footer: {
    paddingHorizontal: space.xl,
    gap: space.lg,
  },
  dots: {
    justifyContent: 'center',
  },
  dot: {
    width: space.sm,
    height: space.sm,
    borderRadius: radius.pill,
    backgroundColor: color.border,
  },
  dotActive: {
    backgroundColor: color.accent,
  },
});
