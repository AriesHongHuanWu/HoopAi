/**
 * Home dashboard — the app's face.
 *
 * Giant Start CTA (the one daily action) with a slow-breathing shot arc,
 * last-session recap from SQLite with a mini FG% sparkline across recent
 * sessions, quiet icon tiles to history and trends. Redirects to /onboarding
 * on first launch; the root layout guarantees the settings store is hydrated
 * before this screen renders, so the check is flash-free.
 */
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Circle, Path } from '@shopify/react-native-skia';
import * as Haptics from 'expo-haptics';
import { Link, Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type LayoutRectangle,
} from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { BootIntro, bootIntroDelayMs } from '@/components/BootIntro';
import { Sparkline } from '@/components/charts/Sparkline';
import { CoachMarks, useCoachMarks, type CoachStep } from '@/components/coach/CoachMarks';
import { GoalRing } from '@/components/GoalRing';
import { ProfileButton } from '@/components/profile/ProfileButton';
import { Card, Chip, EmptyState, ErrorCard, Eyebrow, Row, Screen, StatNumber } from '@/components/ui';
import { color, radius, space, touch, type } from '@/constants/tokens';
import {
  PERFECT_DAY_BONUS,
  PERFECT_DAY_ID,
  challengeGoalTarget,
  dateKeyFor,
  emptyDayAggregate,
  isChallengeComplete,
  pickDailyChallenges,
  progressFor,
  type DayAggregate,
} from '@/core/dailyChallenges';
import { todayMakes } from '@/core/goals';
import { computeDayStreak, type StreakResult } from '@/core/streak';
import { listSessions, type SessionSummaryRow } from '@/data/db';
import { useCameraPermission } from 'react-native-vision-camera';

import { loadTodayAggregate, useChallenges } from '@/state/challengeStore';
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
        {/* Soft wide echo under the crisp stroke — same geometry, quieter
            opacity, so the arc reads as light rather than a line. */}
        <Path path={path} style="stroke" strokeWidth={7} color={color.onAccent} opacity={0.08} />
        <Path path={path} style="stroke" strokeWidth={3} color={color.onAccent} opacity={0.22} />
        <Circle cx={rimX} cy={rimY} r={haloR} color={color.onAccent} opacity={haloOpacity} />
        <Circle cx={rimX} cy={rimY} r={7} color={color.onAccent} opacity={dotOpacity} />
      </Canvas>
    </View>
  );
}

/**
 * True once the persisted challenge ledger has rehydrated from SQLite —
 * same zustand-persist gate pattern as _layout.tsx's settings hydration.
 * The award pass below MUST wait for it: award() rewrites { dateKey,
 * completedIds, totalPoints } wholesale, so running against the pre-hydration
 * defaults clobbers the persisted career points ledger with a zero-point day.
 */
function useChallengesHydrated(): boolean {
  const [hydrated, setHydrated] = useState(() => useChallenges.persist.hasHydrated());
  useEffect(() => {
    if (useChallenges.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useChallenges.persist.onFinishHydration(() => setHydrated(true));
  }, []);
  return hydrated;
}

export default function HomeScreen() {
  const onboardingDone = useSettings((s) => s.onboardingDone);
  const hapticsEnabled = useSettings((s) => s.hapticsEnabled);
  const cameraPermission = useCameraPermission();
  const dailyGoalMakes = useSettings((s) => s.dailyGoalMakes);
  const { width } = useWindowDimensions();
  const contentWidth = width - space.lg * 2;
  const reducedMotion = useReducedMotion();
  // Captured once per mount: on a cold start the cards wait for the boot
  // intro's cover to lift, on every later mount they rise immediately.
  const [introDelay] = useState(() => bootIntroDelayMs(reducedMotion));
  const enter = (i: number) => FadeInDown.duration(420).delay(introDelay + i * 70);

  // undefined = loading, null = no sessions yet.
  const [lastSession, setLastSession] = useState<SessionSummaryRow | null | undefined>(undefined);
  /** FG% of recent sessions with shots, oldest first — the mini sparkline. */
  const [recentTrend, setRecentTrend] = useState<number[]>([]);
  const [dbFailed, setDbFailed] = useState(false);
  /** Makes so far today, for the goal ring (src/core/goals.ts todayMakes). */
  const [goalMakes, setGoalMakes] = useState(0);
  /** Consecutive-day shooting streak (src/core/streak.ts) — the return loop. */
  const [streak, setStreak] = useState<StreakResult>({
    current: 0,
    longest: 0,
    shotToday: false,
  });
  /** Local day key driving today's deterministic challenge picks. */
  const [challengeDay, setChallengeDay] = useState(() => dateKeyFor(Date.now()));
  /** Today's aggregate for challenge progress (src/state/challengeStore.ts). */
  const [dayAgg, setDayAgg] = useState<DayAggregate>(emptyDayAggregate);
  const totalPoints = useChallenges((s) => s.totalPoints);
  const challengesHydrated = useChallengesHydrated();

  // Coach marks: measured target rects for the hero CTA, mode row and quick
  // links, filled in as each view lays out. Steps render centered until a
  // rect is known, then the card re-anchors near it.
  const heroRef = useRef<View>(null);
  const modeRowRef = useRef<View>(null);
  const [heroRect, setHeroRect] = useState<LayoutRectangle | undefined>();
  const [modeRowRect, setModeRowRect] = useState<LayoutRectangle | undefined>();

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
      title: 'Everything else is in the tabs',
      text: 'The bar at the bottom is always there: Train for game modes and drills, Data for your history, trends and records, Coach for your weekly report, and You for your profile and settings.',
      // No anchor — the tab bar lives outside this screen, so this step centers.
      targetRect: undefined,
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

  // Session scan (100 sessions): drives the day streak always, and today's
  // goal progress when a goal is set — one DB read for both.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listSessions(GOAL_SCAN_LIMIT)
        .then((rows) => {
          if (!alive) return;
          const now = Date.now();
          setStreak(computeDayStreak(rows.map((r) => r.startedAt), now));
          if (dailyGoalMakes > 0) setGoalMakes(todayMakes(rows, now));
        })
        .catch(() => {
          if (!alive) return;
          setGoalMakes(0);
          setStreak({ current: 0, longest: 0, shotToday: false });
        });
      return () => {
        alive = false;
      };
    }, [dailyGoalMakes]),
  );

  // Daily challenges: recompute today's aggregate on every focus (same rhythm
  // as the goal ring above) and bank points for anything newly complete —
  // awards are idempotent per day, so refocusing never double-counts.
  useFocusEffect(
    useCallback(() => {
      // Wait for the persisted ledger before touching the store (see
      // useChallengesHydrated). The hydration flip re-creates this callback,
      // which re-fires the focus effect while the screen is focused — so the
      // pass still runs, just never against pre-hydration defaults.
      if (!challengesHydrated) return;
      let alive = true;
      const key = dateKeyFor(Date.now());
      setChallengeDay(key);
      useChallenges.getState().ensureDay(key);
      loadTodayAggregate()
        .then((agg) => {
          if (!alive) return;
          setDayAgg(agg);
          const picks = pickDailyChallenges(key);
          const { award } = useChallenges.getState();
          let allDone = picks.length > 0;
          for (const c of picks) {
            if (isChallengeComplete(c, agg)) award(key, c.id, c.points);
            else allDone = false;
          }
          if (allDone) award(key, PERFECT_DAY_ID, PERFECT_DAY_BONUS);
        })
        .catch(() => {
          if (!alive) return;
          setDayAgg(emptyDayAggregate());
        });
      return () => {
        alive = false;
      };
    }, [challengesHydrated]),
  );

  /** Today's three challenges — deterministic for the day key, so stable
   *  across re-renders and refocuses until local midnight. */
  const dailyChallenges = useMemo(() => pickDailyChallenges(challengeDay), [challengeDay]);
  const allChallengesDone =
    dailyChallenges.length > 0 &&
    dailyChallenges.every((c) => isChallengeComplete(c, dayAgg));

  if (!onboardingDone) return <Redirect href="/onboarding" />;

  const startSession = () => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // The hero ALWAYS opens setup — orientation choice and the pre-flight
    // checklist live there. (An earlier "one tap to ball" hero skipped it and
    // made orientation unpickable; quickStart below is the deliberate shortcut.)
    router.push('/session/setup');
  };

  const quickStart = () => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // Skip the checklist, reuse the last orientation. An open run — clear any
    // mode picked in a past session so a stale game HUD never leaks in.
    useMode.getState().reset();
    useSession.getState().beginSetup();
    router.push(`/session/live?orient=${useSettings.getState().lastOrient}`);
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
          <Row gap={space.sm}>
            <ProfileButton size={40} />
            <Link href="/settings" asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Settings"
                hitSlop={space.sm}
                style={({ pressed }) => [styles.gearButton, pressed && styles.gearPressed]}
              >
                <Ionicons name="settings-sharp" size={22} color={color.textDim} />
              </Pressable>
            </Link>
          </Row>
        </Row>

        {/* Hero Start CTA */}
        <Animated.View entering={enter(0)}>
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
        </Animated.View>

        {/* Quick start — the deliberate skip-setup shortcut (repeat sessions
            only: it needs a granted camera and reuses the last orientation). */}
        {cameraPermission.hasPermission && (
          <Animated.View entering={enter(1)}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Quick start"
            accessibilityHint={`Skips setup and starts in ${useSettings.getState().lastOrient} like last time`}
            onPress={quickStart}
            style={({ pressed }) => [styles.quickStart, pressed && styles.quickStartPressed]}
          >
            <Ionicons name="flash" size={15} color={color.accent} />
            <Text style={styles.quickStartLabel}>Quick start — same setup as last time</Text>
          </Pressable>
          </Animated.View>
        )}

        {/* Choose a game mode */}
        <Animated.View entering={enter(2)}>
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
          <Ionicons name="chevron-forward" size={20} color={color.accent} />
        </Pressable>
        </View>
        </Animated.View>

        {/* Day streak — the return loop. Shown once a streak exists; stays live
            through today until a full day is missed. */}
        {streak.current >= 1 && (
          <Animated.View entering={enter(3)}>
            <View
              style={styles.streakRow}
              accessible
              accessibilityLabel={`${streak.current} day shooting streak.${
                streak.shotToday ? '' : ' Shoot today to keep it going.'
              }`}
            >
              <View style={styles.streakFlame}>
                <Ionicons name="flame" size={18} color={color.accent} />
              </View>
              <View style={styles.streakText}>
                <Text style={styles.streakTitle}>
                  {`${streak.current}-day streak`}
                </Text>
                <Text style={styles.streakSub} numberOfLines={1}>
                  {streak.shotToday
                    ? streak.current >= streak.longest && streak.longest > 1
                      ? 'Your best run yet — keep it alive.'
                      : `Longest: ${streak.longest} ${streak.longest === 1 ? 'day' : 'days'}`
                    : 'Shoot today to keep it going.'}
                </Text>
              </View>
              {!streak.shotToday && <Text style={styles.streakNudge}>TODAY</Text>}
            </View>
          </Animated.View>
        )}

        {/* Daily goal */}
        {dailyGoalMakes > 0 && (
          <Card
            entering={enter(3)}
            style={[styles.goalCard, goalMakes >= dailyGoalMakes && styles.goalCardDone]}
          >
            <View style={styles.goalText}>
              <Eyebrow>Daily goal</Eyebrow>
              {goalMakes >= dailyGoalMakes ? (
                <Row gap={space.sm} style={styles.goalDoneRow}>
                  <Ionicons name="checkmark-circle" size={18} color={color.make} />
                  <Text style={[styles.goalHeadline, styles.goalHeadlineDone]}>
                    Goal reached — nice shooting today.
                  </Text>
                </Row>
              ) : (
                <Text style={styles.goalHeadline}>
                  {`${dailyGoalMakes - goalMakes} makes to go today.`}
                </Text>
              )}
            </View>
            <GoalRing made={goalMakes} goal={dailyGoalMakes} />
          </Card>
        )}

        {/* Daily challenges — three per day, drawn deterministically from the
            date, progress recomputed from today's sessions on focus. Display
            only: no navigation, the loop lives right here. */}
        <Card entering={enter(4)}>
          <Row style={styles.challengeHeader}>
            <Eyebrow>Daily challenges</Eyebrow>
            {/* '★ N', not 'N PTS' — PTS is reserved app-wide for scored
                basketball points (SummaryHero, StatStrip); reusing it here
                made challenge points read as game score. */}
            <Text
              style={styles.challengeTotal}
              accessibilityLabel={`${totalPoints} total challenge points`}
            >
              {`★ ${totalPoints}`}
            </Text>
          </Row>
          <View style={styles.challengeList}>
            {dailyChallenges.map((c) => {
              const target = challengeGoalTarget(c.goal);
              const progress = progressFor(c, dayAgg);
              const done = isChallengeComplete(c, dayAgg);
              const frac = target > 0 ? Math.min(1, progress / target) : 0;
              return (
                <View
                  key={c.id}
                  accessible
                  accessibilityLabel={`${c.title}, ${progress} of ${target}${
                    done ? ', completed' : ''
                  }, worth ${c.points} points`}
                  style={styles.challengeRow}
                >
                  <View
                    style={[styles.challengeIconChip, done && styles.challengeIconChipDone]}
                  >
                    <Ionicons
                      name={
                        done
                          ? 'checkmark'
                          : (c.icon as React.ComponentProps<typeof Ionicons>['name'])
                      }
                      size={15}
                      color={done ? color.make : color.accent}
                    />
                  </View>
                  <View style={styles.challengeBody}>
                    <Row style={styles.challengeTitleRow}>
                      <Text
                        style={[styles.challengeTitle, done && styles.challengeTitleDone]}
                        numberOfLines={1}
                      >
                        {c.title}
                      </Text>
                      <Text style={styles.challengeCount}>{`${progress}/${target}`}</Text>
                    </Row>
                    <View style={styles.challengeTrack}>
                      <View
                        style={[
                          styles.challengeFill,
                          { width: `${frac * 100}%` },
                          done && styles.challengeFillDone,
                        ]}
                      />
                    </View>
                  </View>
                  <Chip compact label={`+${c.points}`} tone={done ? 'make' : 'accent'} />
                </View>
              );
            })}
          </View>
          {allChallengesDone && (
            <View
              accessible
              accessibilityLabel={`Perfect day, all challenges done, ${PERFECT_DAY_BONUS} bonus points`}
              style={styles.perfectBanner}
            >
              <Ionicons name="trophy" size={15} color={color.make} />
              <Text style={styles.perfectLabel} numberOfLines={1}>
                {`Perfect day — all three done. +${PERFECT_DAY_BONUS} bonus`}
              </Text>
            </View>
          )}
        </Card>

        {/* Last session */}
        <Animated.View entering={enter(5)}>
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
                <Row style={styles.sessionEyebrowRow}>
                  <Eyebrow>Last session</Eyebrow>
                  <Ionicons
                    name="chevron-forward"
                    size={14}
                    color={color.textFaint}
                    style={styles.sessionEyebrowChevron}
                  />
                </Row>
                <Row style={styles.sessionRow} gap={space.md}>
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
                        <Text style={styles.miniSparkLabel}>
                          {`LAST ${recentTrend.length} SESSIONS`}
                        </Text>
                      </View>
                    )}
                  </View>
                  {/* Broadcast stat block: FG% set off behind its own hairline. */}
                  <View style={styles.sessionStat}>
                    <StatNumber
                      size="medium"
                      value={`${Math.round(lastSession.fgPct * 100)}%`}
                      label="FG"
                    />
                  </View>
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
        </Animated.View>
      </View>
    </Screen>
    {coach.visible && (
      <CoachMarks steps={coach.steps} onFinish={coach.finish} onSkip={coach.finish} />
    )}
    <BootIntro />
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
  betaNote: {
    ...type.caption,
    color: color.textFaint,
    marginTop: 2,
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
    // Wider tracking than the base caption — broadcast eyebrow voice.
    letterSpacing: 1.2,
    marginBottom: 2,
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
  quickStart: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    minHeight: touch.minTarget,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.border,
    paddingHorizontal: space.lg,
  },
  quickStartPressed: {
    backgroundColor: color.surfaceRaised,
  },
  quickStartLabel: {
    ...type.caption,
    color: color.textDim,
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
  streakRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  streakFlame: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  streakText: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  streakTitle: {
    ...type.bodyMedium,
    color: color.text,
  },
  streakSub: {
    ...type.caption,
    color: color.textDim,
  },
  streakNudge: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1,
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
  goalCardDone: {
    // Quiet make-green edge — the completed state reads at a glance without
    // shouting over the ring's own green flip.
    borderColor: 'rgba(47, 214, 163, 0.3)',
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
  goalDoneRow: {
    alignItems: 'flex-start',
  },
  goalHeadlineDone: {
    flex: 1,
    minWidth: 0,
  },
  challengeHeader: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  challengeTotal: {
    ...type.caption,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  challengeList: {
    gap: space.md,
  },
  challengeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  challengeIconChip: {
    // Same tinted circle as the quick-link chips below — one icon voice.
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  challengeIconChipDone: {
    backgroundColor: color.makeTint,
  },
  challengeBody: {
    flex: 1,
    minWidth: 0,
    gap: space.xs,
  },
  challengeTitleRow: {
    justifyContent: 'space-between',
  },
  challengeTitle: {
    ...type.bodyMedium,
    color: color.text,
    flexShrink: 1,
  },
  challengeTitleDone: {
    color: color.textDim,
  },
  challengeCount: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  challengeTrack: {
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
  },
  challengeFill: {
    height: '100%',
    borderRadius: radius.pill,
    backgroundColor: color.accent,
  },
  challengeFillDone: {
    backgroundColor: color.make,
  },
  perfectBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.makeTint,
  },
  perfectLabel: {
    ...type.caption,
    color: color.make,
    flexShrink: 1,
  },
  sessionEyebrowRow: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  sessionEyebrowChevron: {
    marginTop: 1,
  },
  sessionRow: {
    justifyContent: 'space-between',
    alignItems: 'stretch',
  },
  sessionInfo: {
    flex: 1,
    gap: 2,
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
    marginTop: space.sm,
    gap: space.xs,
    alignSelf: 'flex-start',
  },
  miniSparkLabel: {
    ...type.micro,
    color: color.textFaint,
  },
  sessionStat: {
    justifyContent: 'center',
    alignItems: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: color.border,
    paddingLeft: space.lg,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
});
