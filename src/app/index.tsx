/**
 * Home dashboard — the app's face.
 *
 * Giant Start CTA (the one daily action) with a slow-breathing shot arc,
 * last-session recap from SQLite with a mini FG% sparkline across recent
 * sessions, quiet glyph links to history and trends. Redirects to /onboarding
 * on first launch; the root layout guarantees the settings store is hydrated
 * before this screen renders, so the check is flash-free.
 */
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutRectangle,
} from 'react-native';
import {
  Easing,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Sparkline } from '@/components/charts/Sparkline';
import { CoachMarks, useCoachMarks, type CoachStep } from '@/components/coach/CoachMarks';
import { GoalRing } from '@/components/GoalRing';
import { Card, EmptyState, ErrorCard, Eyebrow, Row, Screen, StatNumber } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import { todayMakes } from '@/core/goals';
import { listSessions, type SessionSummaryRow } from '@/data/db';
import { useCameraPermission } from 'react-native-vision-camera';

import { useMode } from '@/state/modeStore';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

const HERO_HEIGHT = 176;
/** Sessions pulled for the last-session card + its mini FG% sparkline. */
const RECENT_LIMIT = 8;
const MINI_SPARK_W = 76;
const MINI_SPARK_H = 30;
/**
 * Sessions scanned for today's make-goal progress. Generous relative to
 * RECENT_LIMIT so a heavy shooting day (many short sessions) still counts
 * every make, not just the ones in the last-session sparkline window.
 */
const GOAL_SCAN_LIMIT = 100;

function formatSessionDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * Decorative shot arc over the hero CTA — the signature motif. The ball dot
 * at the rim breathes on a slow loop; under reduced motion it holds still.
 */
function HeroArc({ width }: { width: number }) {
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion]);

  const dotOpacity = useDerivedValue(() => 0.32 + pulse.value * 0.22);
  const haloR = useDerivedValue(() => 10 + pulse.value * 4);
  const haloOpacity = useDerivedValue(() => 0.1 + pulse.value * 0.1);

  if (width <= 0) return null;
  // Quadratic arc from just off the bottom-left up toward a "rim" at right.
  const rimX = width - 44;
  const rimY = HERO_HEIGHT * 0.42;
  const path = `M -24 ${HERO_HEIGHT + 24} Q ${width * 0.36} ${-HERO_HEIGHT * 0.6} ${rimX} ${rimY}`;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={{ width, height: HERO_HEIGHT }}>
        <Path path={path} style="stroke" strokeWidth={3} color={color.onAccent} opacity={0.24} />
        <Circle cx={rimX} cy={rimY} r={haloR} color={color.onAccent} opacity={haloOpacity} />
        <Circle cx={rimX} cy={rimY} r={7} color={color.onAccent} opacity={dotOpacity} />
      </Canvas>
    </View>
  );
}

/** Quiet glyph link card — History / Trends. */
function QuickLink({
  glyph,
  label,
  hint,
  onPress,
}: {
  glyph: string;
  label: string;
  hint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({ pressed }) => [styles.quickLink, pressed && styles.quickLinkPressed]}
    >
      <Text style={styles.quickGlyph}>{glyph}</Text>
      <Text style={styles.quickLabel}>{label}</Text>
    </Pressable>
  );
}

export default function HomeScreen() {
  const onboardingDone = useSettings((s) => s.onboardingDone);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const cameraPermission = useCameraPermission();
  const dailyGoalMakes = useSettings((s) => s.dailyGoalMakes);
  const { width } = useWindowDimensions();
  const contentWidth = width - space.lg * 2;

  // undefined = loading, null = no sessions yet.
  const [lastSession, setLastSession] = useState<SessionSummaryRow | null | undefined>(undefined);
  /** FG% of recent sessions with shots, oldest first — the mini sparkline. */
  const [recentTrend, setRecentTrend] = useState<number[]>([]);
  const [dbFailed, setDbFailed] = useState(false);
  /** Makes so far today, for the goal ring (src/core/goals.ts todayMakes). */
  const [goalMakes, setGoalMakes] = useState(0);

  // Coach marks: measured target rects for the hero CTA, mode row and quick
  // links, filled in as each view lays out. Steps render centered until a
  // rect is known, then the card re-anchors near it.
  const heroRef = useRef<View>(null);
  const modeRowRef = useRef<View>(null);
  const quickLinksRef = useRef<View>(null);
  const [heroRect, setHeroRect] = useState<LayoutRectangle | undefined>();
  const [modeRowRect, setModeRowRect] = useState<LayoutRectangle | undefined>();
  const [quickLinksRect, setQuickLinksRect] = useState<LayoutRectangle | undefined>();

  const measure = (ref: React.RefObject<View | null>, set: (r: LayoutRectangle) => void) => {
    ref.current?.measureInWindow((x, y, w, h) => set({ x, y, width: w, height: h }));
  };

  const homeSteps: CoachStep[] = [
    {
      title: 'Start a session',
      text: 'Tap Start session to open the camera. Prop your phone up, and once the rim locks on, every shot you take gets counted automatically.',
      targetRect: heroRect,
    },
    {
      title: 'Or play a mode',
      text: 'Around the World, Timed Challenge, HORSE and more — structured games with their own rules and a finish line, all tracked the same way.',
      targetRect: modeRowRect,
    },
    {
      title: 'Your data lives here',
      text: 'History holds every past session, Trends charts your FG% over time, and Records keeps your best streaks and lifetime badges.',
      targetRect: quickLinksRect,
    },
  ];
  const coach = useCoachMarks('home', homeSteps);

  // Reload whenever the dashboard regains focus (e.g. after a session ends).
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listSessions(RECENT_LIMIT)
        .then((rows) => {
          if (!alive) return;
          setLastSession(rows[0] ?? null);
          setRecentTrend(
            rows
              .filter((r) => r.attempts > 0)
              .map((r) => r.fgPct)
              .reverse(),
          );
          setDbFailed(false);
        })
        .catch(() => {
          if (!alive) return;
          setLastSession(null);
          setRecentTrend([]);
          setDbFailed(true);
        });
      return () => {
        alive = false;
      };
    }, []),
  );

  // Goal ring only needs data when a goal is actually set.
  useFocusEffect(
    useCallback(() => {
      if (dailyGoalMakes <= 0) return;
      let alive = true;
      listSessions(GOAL_SCAN_LIMIT)
        .then((rows) => {
          if (!alive) return;
          setGoalMakes(todayMakes(rows, Date.now()));
        })
        .catch(() => {
          if (!alive) return;
          setGoalMakes(0);
        });
      return () => {
        alive = false;
      };
    }, [dailyGoalMakes]),
  );

  if (!onboardingDone) return <Redirect href="/onboarding" />;

  const startSession = () => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Quick-start is an open run — clear any mode picked in a past session so a
    // stale game HUD never leaks in. The mode picker is the path to a game.
    useMode.getState().reset();
    // ONE TAP TO BALL: permissions already granted ⇒ skip the setup checklist
    // and reuse the last session's orientation. First run (or a revoked
    // permission) still gets the full pre-flight.
    if (cameraPermission.hasPermission) {
      useSession.getState().beginSetup();
      router.push(`/session/live?orient=${useSettings.getState().lastOrient}`);
    } else {
      router.push('/session/setup');
    }
  };

  return (
    <View style={styles.root}>
    <Screen scroll>
      <View style={styles.stack}>
        {/* Header: wordmark + settings */}
        <Row style={styles.header}>
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel="Hoopilot. Beta — everything unlocked."
          >
            <Text style={styles.wordmark}>
              HOOP<Text style={styles.wordmarkAccent}>ILOT</Text>
            </Text>
            <Text style={styles.betaNote}>Beta — everything unlocked</Text>
          </View>
          <Link href="/settings" asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Settings"
              hitSlop={space.sm}
              style={({ pressed }) => [styles.gearButton, pressed && styles.gearPressed]}
            >
              <Text style={styles.gearGlyph}>{'⚙︎'}</Text>
            </Pressable>
          </Link>
        </Row>

        {/* Hero Start CTA */}
        <View ref={heroRef} onLayout={() => measure(heroRef, setHeroRect)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Start session"
            accessibilityHint="Opens camera setup to track your shots"
            onPress={startSession}
            style={({ pressed }) => [
              styles.hero,
              { backgroundColor: pressed ? color.accentPressed : color.accent },
            ]}
          >
            <HeroArc width={contentWidth} />
            <Text style={styles.heroEyebrow}>READY WHEN YOU ARE</Text>
            <Text
              style={styles.heroLabel}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
            >
              START SESSION
            </Text>
            <Text style={styles.heroSub}>Point your phone at the hoop — we do the counting.</Text>
          </Pressable>
        </View>

        {/* Choose a game mode */}
        <View ref={modeRowRef} onLayout={() => measure(modeRowRef, setModeRowRect)}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose a mode"
          accessibilityHint="Pick a game like Around the World, Timed Challenge or HORSE"
          onPress={() => {
            if (hapticsEnabled) void Haptics.selectionAsync();
            router.push('/modes');
          }}
          style={({ pressed }) => [styles.modeRow, pressed && styles.modeRowPressed]}
        >
          <View style={styles.modeText}>
            <Text style={styles.modeTitle}>Choose a mode</Text>
            <Text style={styles.modeSub}>
              Around the World · Timed · 3-Point Contest · HORSE and more
            </Text>
          </View>
          <Text style={styles.modeChevron}>{'›'}</Text>
        </Pressable>
        </View>

        {/* Daily goal */}
        {dailyGoalMakes > 0 && (
          <Card style={styles.goalCard}>
            <View style={styles.goalText}>
              <Eyebrow>Daily goal</Eyebrow>
              <Text style={styles.goalHeadline}>
                {goalMakes >= dailyGoalMakes
                  ? 'Goal reached — nice shooting today.'
                  : `${dailyGoalMakes - goalMakes} makes to go today.`}
              </Text>
            </View>
            <GoalRing made={goalMakes} goal={dailyGoalMakes} />
          </Card>
        )}

        {/* Last session */}
        {lastSession === undefined ? (
          <Card>
            <Eyebrow>Last session</Eyebrow>
            <Text style={styles.emptyBody}>Loading…</Text>
          </Card>
        ) : dbFailed ? (
          <View>
            <Eyebrow>Last session</Eyebrow>
            <ErrorCard
              title="Couldn't load your sessions"
              body="Your stats are safe — try again after a restart."
            />
          </View>
        ) : lastSession ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Last session, ${formatSessionDate(lastSession.startedAt)}, ${
              lastSession.attempts
            } attempts, ${Math.round(lastSession.fgPct * 100)} percent field goals`}
            onPress={() => router.push(`/history/${lastSession.id}`)}
          >
            {({ pressed }) => (
              <Card style={pressed ? styles.cardPressed : undefined}>
                <Eyebrow>Last session</Eyebrow>
                <Row style={styles.sessionRow} gap={space.lg}>
                  <View style={styles.sessionInfo}>
                    <Text style={styles.sessionDate}>
                      {formatSessionDate(lastSession.startedAt)}
                    </Text>
                    <Text style={styles.sessionMeta}>
                      {lastSession.attempts > 0
                        ? `${lastSession.makes} makes · ${lastSession.attempts} attempts`
                        : 'No shots logged'}
                    </Text>
                    {recentTrend.length >= 2 && (
                      <View
                        accessible
                        accessibilityLabel={`FG% trend across your last ${recentTrend.length} sessions`}
                        style={styles.miniSpark}
                      >
                        <Sparkline
                          data={recentTrend}
                          width={MINI_SPARK_W}
                          height={MINI_SPARK_H}
                        />
                      </View>
                    )}
                  </View>
                  <StatNumber
                    size="medium"
                    value={`${Math.round(lastSession.fgPct * 100)}%`}
                    label="FG"
                  />
                </Row>
              </Card>
            )}
          </Pressable>
        ) : (
          <View>
            <Eyebrow>First session</Eyebrow>
            <EmptyState
              title="Prop your phone up. We'll count every shot."
              body="Makes, misses, streaks and FG% land here after your first run."
            />
          </View>
        )}

        {/* Quick links */}
        <View
          ref={quickLinksRef}
          onLayout={() => measure(quickLinksRef, setQuickLinksRect)}
          style={styles.quickLinksStack}
        >
          <Row gap={space.md}>
            <QuickLink
              glyph="≣"
              label="History"
              hint="Browse your past sessions"
              onPress={() => router.push('/history')}
            />
            <QuickLink
              glyph="↗"
              label="Trends"
              hint="See your FG% over time"
              onPress={() => router.push('/trends')}
            />
            <QuickLink
              glyph="★"
              label="Records"
              hint="See your lifetime records and badges"
              onPress={() => router.push('/records')}
            />
          </Row>
          <Row gap={space.md}>
            <QuickLink
              glyph="🏀"
              label="Scoreboard"
              hint="Track a live head-to-head score"
              onPress={() => router.push('/scoreboard')}
            />
            <QuickLink
              glyph="◎"
              label="Test AI"
              hint="Run the shot detector on a video from your library"
              onPress={() => router.push('/session/analyze')}
            />
          </Row>
        </View>
      </View>
    </Screen>
    {coach.visible && (
      <CoachMarks steps={coach.steps} onFinish={coach.finish} onSkip={coach.finish} />
    )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  stack: {
    gap: space.xl,
    paddingTop: space.md,
  },
  header: {
    justifyContent: 'space-between',
  },
  wordmark: {
    ...type.title,
    color: color.text,
  },
  wordmarkAccent: {
    color: color.accent,
  },
  gearButton: {
    width: touch.minTarget,
    height: touch.minTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  gearPressed: {
    backgroundColor: color.surfaceRaised,
  },
  gearGlyph: {
    fontSize: type.title.fontSize,
    color: color.textDim,
  },
  betaNote: {
    ...type.caption,
    color: color.textFaint,
  },
  hero: {
    minHeight: HERO_HEIGHT,
    borderRadius: radius.lg,
    padding: space.xl,
    justifyContent: 'flex-end',
    gap: space.xs,
    overflow: 'hidden',
  },
  heroEyebrow: {
    ...type.caption,
    color: color.onAccent,
    opacity: 0.7,
  },
  heroLabel: {
    ...type.statLarge,
    color: color.onAccent,
  },
  heroSub: {
    ...type.body,
    color: color.onAccent,
    opacity: 0.85,
  },
  modeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingVertical: space.lg,
    paddingHorizontal: space.lg,
    minHeight: touch.minTarget,
  },
  modeRowPressed: {
    backgroundColor: color.surfaceRaised,
  },
  modeText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  modeTitle: {
    ...type.heading,
    color: color.text,
  },
  modeSub: {
    ...type.body,
    color: color.textDim,
  },
  modeChevron: {
    ...type.title,
    color: color.accent,
  },
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  goalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.lg,
  },
  goalText: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
  },
  goalHeadline: {
    ...type.heading,
    color: color.text,
  },
  sessionRow: {
    justifyContent: 'space-between',
  },
  sessionInfo: {
    flex: 1,
    gap: space.xs,
  },
  sessionDate: {
    ...type.heading,
    color: color.text,
  },
  sessionMeta: {
    ...type.body,
    color: color.textDim,
  },
  miniSpark: {
    marginTop: space.xs,
    width: MINI_SPARK_W,
    height: MINI_SPARK_H,
  },
  emptyTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.xs,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
  quickLinksStack: {
    gap: space.md,
  },
  quickLink: {
    flex: 1,
    minHeight: touch.minTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: space.lg,
  },
  quickLinkPressed: {
    backgroundColor: color.surfaceRaised,
  },
  quickGlyph: {
    ...type.heading,
    color: color.accent,
  },
  quickLabel: {
    ...type.heading,
    color: color.text,
  },
});
