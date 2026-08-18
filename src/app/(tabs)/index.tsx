/**
 * Home dashboard — the app's face.
 *
 * Giant Start CTA (the one daily action) with the signature shot arc and a
 * quick-start chip, a recommendation entry into Train, a TODAY shelf (streak
 * ladder + goal ring on one row), compact daily/weekly challenge decks, and a
 * last-session payoff card whose FG% rolls in over a full-width trend band.
 * Redirects to /onboarding on first launch; the root layout guarantees the
 * settings store is hydrated before this screen renders, so the check is
 * flash-free.
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
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { BootIntro, bootIntroDelayMs } from '@/components/BootIntro';
import { MotionStat, SuccessBurst, arcMotif, useCardStagger } from '@/components/motion';
import { Sparkline } from '@/components/charts/Sparkline';
import { CoachMarks, useCoachMarks, type CoachStep } from '@/components/coach/CoachMarks';
import { GoalRing } from '@/components/GoalRing';
import { FirstRunScene } from '@/components/home/FirstRunScene';
import { WeeklyChallengeSummary } from '@/components/home/WeeklyChallengeSummary';
import { DRILL_IDENTITY, MODE_IDENTITY } from '@/components/modes/modeIdentity';
import { ProfileButton } from '@/components/profile/ProfileButton';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { StreakTierCard } from '@/components/StreakTierCard';
import {
  Card,
  Chip,
  ErrorCard,
  Eyebrow,
  PressableCard,
  Row,
  Screen,
  SkeletonCard,
} from '@/components/ui';
import { color, iconSize, layout, radius, space, touch, type } from '@/constants/tokens';
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
import { getDrill } from '@/core/drills';
import { getModeDef } from '@/core/gameModes';
import { todayMakes } from '@/core/goals';
import {
  recommendFromSessions,
  recommendationReason,
  type ModeRecommendation,
} from '@/core/modeRecommendation';
import { computeDayStreak, type StreakResult } from '@/core/streak';
import {
  emptyWeekAggregate,
  evaluateWeekly,
  isoWeekKey,
  pickWeeklyChallenges,
  type WeekAggregate,
} from '@/core/weeklyChallenges';
import { listSessions, type SessionSummaryRow } from '@/data/db';
import { useCameraPermission } from 'react-native-vision-camera';

import { loadTodayAggregate, loadWeekAggregate, useChallenges } from '@/state/challengeStore';
import { useMode } from '@/state/modeStore';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

const HERO_HEIGHT = 176;
/** Sessions pulled for the last-session card + its FG% trend band. */
const RECENT_LIMIT = 8;
/** Height of the full-width FG% trend band inside the last-session card. */
const SPARK_BAND_H = 36;
/** GoalRing diameter on the TODAY shelf — scaled down from its default 120. */
const TODAY_RING_SIZE = 88;
/**
 * Sessions scanned for today's make-goal progress. Generous relative to
 * RECENT_LIMIT so a heavy shooting day (many short sessions) still counts
 * every make, not just the ones in the last-session trend window.
 */
const GOAL_SCAN_LIMIT = 100;

/**
 * Day stamp of the last perfect-day celebration, per JS runtime — the same
 * pattern as GoalRing's celebratedDay. Home's ONE celebration moment fires
 * the first time all three daily challenges flip done on a given day;
 * refocuses and remounts never replay it.
 */
let perfectDayCelebrated: string | null = null;

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
 * Decorative shot arc over the hero CTA — the signature motif, drawn from the
 * canonical arcMotif (motion/ArcReveal); the default rim inset IS this hero's
 * geometry, byte-identical to the old hand-rolled quadratic (pinned by
 * arcReveal.test.ts). The ball dot at the rim breathes on a slow loop; under
 * reduced motion it holds still.
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
  // Canonical quadratic, launch bottom-left up to the "rim" at right.
  const motif = arcMotif(width, HERO_HEIGHT);
  const rimX = motif.p1.x;
  const rimY = motif.p1.y;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Canvas style={{ width, height: HERO_HEIGHT }}>
        {/* Soft wide echo under the crisp stroke — same geometry, quieter
            opacity, so the arc reads as light rather than a line. */}
        <Path path={motif.path} style="stroke" strokeWidth={7} color={color.onAccent} opacity={0.08} />
        <Path path={motif.path} style="stroke" strokeWidth={3} color={color.onAccent} opacity={0.22} />
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
  // Canonical stagger hook: adds the reduced-motion gate the old hand-rolled
  // helper was missing (returns undefined per index under reduced motion).
  // introDelay stays reactive — the hook re-memoizes when baseDelayMs changes.
  const enter = useCardStagger({ baseDelayMs: introDelay, stepMs: 70, durationMs: 420 });

  // undefined = loading, null = no sessions yet.
  const [lastSession, setLastSession] = useState<SessionSummaryRow | null | undefined>(undefined);
  /** FG% of recent sessions with shots, oldest first — the trend band. */
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
  /**
   * Recommendation over the SAME listSessions rows fetched below — zero extra
   * queries. Display-only on Home: the entry card deep-links to /modes,
   * arming the mode stays Train's contract.
   */
  const [reco, setReco] = useState<ModeRecommendation | null>(null);
  /** Local day key driving today's deterministic challenge picks. */
  const [challengeDay, setChallengeDay] = useState(() => dateKeyFor(Date.now()));
  /** Today's aggregate for challenge progress (src/state/challengeStore.ts). */
  const [dayAgg, setDayAgg] = useState<DayAggregate>(emptyDayAggregate);
  /** Local ISO week key ('YYYY-Www') driving this week's deterministic picks. */
  const [challengeWeek, setChallengeWeek] = useState(() => isoWeekKey(Date.now()));
  /** This week's aggregate for the weekly summary (src/state/challengeStore.ts). */
  const [weekAgg, setWeekAgg] = useState<WeekAggregate>(emptyWeekAggregate);
  /** Day the perfect-day burst is firing for; null = no burst mounted. */
  const [burstDay, setBurstDay] = useState<string | null>(null);
  const totalPoints = useChallenges((s) => s.totalPoints);
  const challengesHydrated = useChallengesHydrated();

  // Coach marks: measured target rects for the hero CTA, mode row and quick
  // links, filled in as each view lays out. Steps render centered until a
  // rect is known, then the card re-anchors near it.
  const heroRef = useRef<View>(null);
  const modeRowRef = useRef<View>(null);
  const [heroRect, setHeroRect] = useState<LayoutRectangle | undefined>();
  const [modeRowRect, setModeRowRect] = useState<LayoutRectangle | undefined>();

  /**
   * Measure into state ONLY when the rect actually moved. The old version
   * pushed a freshly allocated LayoutRectangle on every onLayout, so an
   * identical measurement still re-rendered the screen — and a re-render that
   * can retrigger onLayout is a loop waiting to happen. Comparing the four
   * numbers and returning `prev` makes an unchanged measurement a no-op.
   */
  const measure = useCallback(
    (
      ref: React.RefObject<View | null>,
      set: React.Dispatch<React.SetStateAction<LayoutRectangle | undefined>>,
    ) => {
      ref.current?.measureInWindow((x, y, w, h) => {
        set((prev) =>
          prev != null && prev.x === x && prev.y === y && prev.width === w && prev.height === h
            ? prev
            : { x, y, width: w, height: h },
        );
      });
    },
    [],
  );
  // Stable handlers so the measured views don't take a new onLayout prop on
  // every render of this (frequently re-rendering) screen.
  const onHeroLayout = useCallback(() => measure(heroRef, setHeroRect), [measure]);
  const onModeRowLayout = useCallback(() => measure(modeRowRef, setModeRowRect), [measure]);

  /**
   * The step copy is constant; only the two anchor rects change. Building this
   * array fresh every render handed useCoachMarks (and through it CoachMarks)
   * a new `steps` identity on every unrelated state change on this screen —
   * challenge awards, focus reloads, streak updates. Memoised on the rects
   * alone, it changes exactly when an anchor really moves.
   */
  const homeSteps = useMemo<CoachStep[]>(
    () => [
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
    ],
    [heroRect, modeRowRect],
  );
  const coach = useCoachMarks('home', homeSteps);

  /**
   * ONE session read per focus. The last-session card, its FG% trend band,
   * the day streak, today's goal progress and the mode recommendation all
   * derive from the same newest-first rows, so we read the wider window once
   * and slice the recent window out of it — `rows.slice(0, RECENT_LIMIT)` is
   * byte-identical to what listSessions(8) returned, so the card and trend
   * are unchanged.
   */
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      listSessions(GOAL_SCAN_LIMIT)
        .then((rows) => {
          if (!alive) return;
          const recent = rows.slice(0, RECENT_LIMIT);
          setLastSession(recent[0] ?? null);
          setRecentTrend(
            recent
              .filter((r) => r.attempts > 0)
              .map((r) => r.fgPct)
              .reverse(),
          );
          setDbFailed(false);
          const now = Date.now();
          setStreak(computeDayStreak(rows.map((r) => r.startedAt), now));
          if (dailyGoalMakes > 0) setGoalMakes(todayMakes(rows, now));
          setReco(recommendFromSessions(rows, now));
        })
        .catch(() => {
          if (!alive) return;
          // One read, one failure path: every derived surface falls back to its
          // honest empty state rather than showing stale numbers.
          setLastSession(null);
          setRecentTrend([]);
          setDbFailed(true);
          setGoalMakes(0);
          setStreak({ current: 0, longest: 0, shotToday: false });
          setReco(null);
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

  // Weekly challenges: same rhythm as the daily pass above, one ISO week wide.
  // Kept as its OWN effect rather than folded into the daily one because the
  // two periods roll over on different clocks — a midnight rollover must not
  // be able to skip the weekly award, and vice versa. This award pass runs
  // even while the deck is presentationally hidden (first run) or compacted
  // (WeeklyChallengeSummary): points writes are Home-owned by contract,
  // modes.tsx displays read-only.
  useFocusEffect(
    useCallback(() => {
      // Same hydration gate as the daily pass: awardWeekly rewrites the shared
      // career points total, so it must never run against pre-hydration zeros.
      if (!challengesHydrated) return;
      let alive = true;
      const key = isoWeekKey(Date.now());
      setChallengeWeek(key);
      useChallenges.getState().ensureWeek(key);
      loadWeekAggregate()
        .then((agg) => {
          if (!alive) return;
          setWeekAgg(agg);
          const { awardWeekly } = useChallenges.getState();
          for (const r of evaluateWeekly(pickWeeklyChallenges(key), agg)) {
            if (r.done) awardWeekly(key, r.def.id, r.def.points);
          }
        })
        .catch(() => {
          if (!alive) return;
          // Honest fallback: an unreadable week shows true zeros, never the
          // stale numbers from a previous focus.
          setWeekAgg(emptyWeekAggregate());
        });
      return () => {
        alive = false;
      };
    }, [challengesHydrated]),
  );

  /** Today's three challenges — deterministic for the day key, so stable
   *  across re-renders and refocuses until local midnight. */
  const dailyChallenges = useMemo(() => pickDailyChallenges(challengeDay), [challengeDay]);
  /** This week's three — deterministic for the week key, so stable until the
   *  next local Monday 00:00. */
  const weeklyChallengeSet = useMemo(() => pickWeeklyChallenges(challengeWeek), [challengeWeek]);
  const allChallengesDone =
    dailyChallenges.length > 0 &&
    dailyChallenges.every((c) => isChallengeComplete(c, dayAgg));

  // Perfect-day celebration — Home's ONE celebration moment. Fires only the
  // first time allChallengesDone flips true on a given day (module-level day
  // stamp, the GoalRing pattern), so refocuses never replay it. SuccessBurst
  // is reduced-motion aware on its own (renders null; the perfect-day banner
  // stays as the static signal) and unmounts itself via onDone.
  useEffect(() => {
    if (!allChallengesDone) return;
    const day = new Date().toDateString();
    if (perfectDayCelebrated === day) return;
    perfectDayCelebrated = day;
    setBurstDay(day);
  }, [allChallengesDone]);
  const clearBurst = useCallback(() => setBurstDay(null), []);

  /**
   * Presentation for the recommendation entry card. `reason` is the exact
   * db-derived count from recommendationReason() and is rendered VERBATIM
   * (iron rule 8 — never dressed up with invented stats).
   */
  const recoView = useMemo(() => {
    if (reco == null) return null;
    if (reco.kind === 'mode') {
      const identity = MODE_IDENTITY[reco.modeId];
      return {
        name: getModeDef(reco.modeId).name,
        icon: identity.icon,
        accent: identity.accent,
        tint: identity.tint,
        reason: recommendationReason(reco),
      };
    }
    const drill = getDrill(reco.drillId);
    const identity = DRILL_IDENTITY[reco.drillId];
    return {
      name: drill.title,
      icon: drill.icon as IoniconName,
      accent: identity.accent,
      tint: identity.tint,
      reason: recommendationReason(reco),
    };
  }, [reco]);

  /**
   * Honest FG% delta vs the previous session — plain arithmetic on the stored
   * fgPct values already fetched above, in the same whole-percent rounding
   * the card displays. NEVER a projected or smoothed number. Only meaningful
   * when the last session took shots (otherwise the trend's newest point is
   * an older session and "vs previous" would lie).
   */
  const fgDelta = useMemo(() => {
    if (recentTrend.length < 2) return null;
    const last = recentTrend[recentTrend.length - 1]!;
    const prev = recentTrend[recentTrend.length - 2]!;
    return Math.round(last * 100) - Math.round(prev * 100);
  }, [recentTrend]);

  if (!onboardingDone) return <Redirect href="/onboarding" />;

  const startSession = () => {
    if (hapticsEnabled) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // The hero ALWAYS opens setup — orientation choice and the pre-flight
    // checklist live there. (An earlier "one tap to ball" hero skipped it and
    // made orientation unpickable; the quick chip below is the deliberate shortcut.)
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

  /** First run = the db read succeeded and found no sessions. Hides the
   *  challenge decks (presentation only — the award effects above keep
   *  running) and swaps the last-session slot for the FirstRunScene. */
  const firstRun = lastSession === null && !dbFailed;
  const goalDone = dailyGoalMakes > 0 && goalMakes >= dailyGoalMakes;

  return (
    <View style={styles.root}>
    <Screen scroll>
      <View style={styles.stack}>
        {/* Header: wordmark + beta chip + settings. The chip keeps the honest
            disclosure (premium entitlements are defined but unwired) without
            spending a full line on it. */}
        <Row style={styles.header}>
          <View
            accessible
            accessibilityRole="header"
            accessibilityLabel="Hoopilot. Beta — everything unlocked."
          >
            <Row gap={space.sm}>
              <Text style={styles.wordmark}>
                HOOP<Text style={styles.wordmarkAccent}>ILOT</Text>
              </Text>
              {/* Content-sized wrapper neutralises Chip's own alignSelf so it
                  centers against the wordmark instead of pinning to the top. */}
              <View>
                <Chip compact label="Beta — everything unlocked" />
              </View>
            </Row>
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
                <Ionicons name="settings-sharp" size={iconSize.xl} color={color.textDim} />
              </Pressable>
            </Link>
          </Row>
        </Row>

        {/* Hero Start CTA. Two separate accessible buttons live here: the
            hero itself and the quick-start chip (repeat sessions only — it
            needs a granted camera and reuses the last orientation). The
            coach-mark anchor measures the OUTER container, so the "Start a
            session" step still frames the whole hero. */}
        <Animated.View entering={enter(0)}>
        <View ref={heroRef} onLayout={onHeroLayout}>
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
            <Row gap={space.md} style={styles.heroFootRow}>
              <Text style={[styles.heroSub, styles.heroSubFlex]}>
                Point your phone at the hoop — we do the counting.
              </Text>
              {cameraPermission.hasPermission && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Quick start"
                  accessibilityHint={`Skips setup and starts in ${useSettings.getState().lastOrient} like last time`}
                  hitSlop={space.sm}
                  onPress={quickStart}
                  style={({ pressed }) => [styles.quickChip, pressed && styles.quickChipPressed]}
                >
                  <Ionicons name="flash" size={iconSize.sm} color={color.onAccent} />
                  <Text style={styles.quickChipLabel}>Same setup as last time</Text>
                </Pressable>
              )}
            </Row>
          </Pressable>
        </View>
        </Animated.View>

        {/* Recommendation entry into Train. When the session history supports
            a pick (recommendFromSessions over the rows fetched above), the row
            leads with that mode; otherwise it stays the generic mode door.
            Home only deep-links /modes — arming the mode is Train's contract. */}
        <Animated.View entering={enter(2)}>
        <View ref={modeRowRef} onLayout={onModeRowLayout}>
        <PressableCard
          onPress={() => router.push('/modes')}
          haptic="selection"
          accessibilityLabel={
            recoView
              ? `Choose a mode. Recommended: ${recoView.name}. ${recoView.reason}.`
              : 'Choose a mode. Around the World, Timed Challenge, HORSE and more.'
          }
          style={styles.modeCard}
        >
          <View
            style={[
              styles.modeBadge,
              recoView != null && { backgroundColor: recoView.tint },
            ]}
          >
            <Ionicons
              name={recoView?.icon ?? 'basketball'}
              size={iconSize.lg}
              color={recoView?.accent ?? color.accent}
            />
          </View>
          <View style={styles.modeText}>
            {recoView ? (
              <>
                <Text style={styles.modeReco}>RECOMMENDED</Text>
                <Text style={styles.modeTitle} numberOfLines={1}>
                  {recoView.name}
                </Text>
                {/* Exact db-derived count, VERBATIM — never dressed up. */}
                <Text style={styles.modeSub} numberOfLines={1}>
                  {recoView.reason}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.modeTitle}>Choose a mode</Text>
                <Text style={styles.modeSub}>
                  Around the World · Timed · 3-Point Contest · HORSE and more
                </Text>
              </>
            )}
          </View>
          <Ionicons name="chevron-forward" size={iconSize.lg} color={color.accent} />
        </PressableCard>
        </View>
        </Animated.View>

        {/* TODAY shelf — streak ladder and goal ring on ONE row, one eyebrow.
            Shown once either loop is live; the ring keeps its own one-shot
            celebration and hot-glow behavior at the smaller size. */}
        {(streak.current >= 1 || dailyGoalMakes > 0) && (
          <Card
            entering={enter(3)}
            style={goalDone ? styles.todayShelfDone : undefined}
          >
            <SectionEyebrow icon="today" style={styles.todayEyebrow}>
              Today
            </SectionEyebrow>
            <Row gap={space.lg} style={styles.todayRow}>
              <View style={styles.todayLeft}>
                {streak.current >= 1 && <StreakTierCard streak={streak} embedded />}
                {dailyGoalMakes > 0 &&
                  (goalDone ? (
                    <Row gap={space.sm} style={styles.goalDoneRow}>
                      <Ionicons name="checkmark-circle" size={iconSize.md} color={color.make} />
                      <Text style={[styles.goalHeadline, styles.goalHeadlineDone]}>
                        Goal reached — nice shooting today.
                      </Text>
                    </Row>
                  ) : (
                    <Text style={styles.goalHeadline}>
                      {`${dailyGoalMakes - goalMakes} makes to go today.`}
                    </Text>
                  ))}
              </View>
              {dailyGoalMakes > 0 && (
                <GoalRing made={goalMakes} goal={dailyGoalMakes} size={TODAY_RING_SIZE} />
              )}
            </Row>
          </Card>
        )}

        {/* Daily challenges — three per day, drawn deterministically from the
            date, progress recomputed from today's sessions on focus. Display
            only: no navigation, the loop lives right here. Hidden on first
            run (the award effects above still run — they're idempotent). */}
        {!firstRun && (
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
                      name={done ? 'checkmark' : (c.icon as IoniconName)}
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
          {/* One-shot perfect-day burst over the banner (day-stamped above).
              Reduced motion: SuccessBurst renders null; the banner carries
              the meaning. */}
          {burstDay != null && <SuccessBurst trigger={burstDay} onDone={clearBurst} />}
        </Card>
        )}

        {/* Weekly challenges, compacted to one row + one aggregate bar. The
            FULL card renders read-only in Train's CHALLENGES section; the
            award pass stays in the focus effect above (Home-owned writes). */}
        {!firstRun && (
          <WeeklyChallengeSummary
            challenges={weeklyChallengeSet}
            agg={weekAgg}
            entering={enter(5)}
            onPress={() => router.push('/modes')}
          />
        )}

        {/* Last session */}
        <Animated.View entering={enter(6)}>
        {lastSession === undefined ? (
          <SkeletonCard lines={2} />
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
                    size={iconSize.sm}
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
                    {/* Honest delta: plain arithmetic on stored fgPct values
                        (same rounding as the numeral) — never projected. */}
                    {fgDelta != null && lastSession.attempts > 0 && (
                      <Text
                        style={[
                          styles.sessionDelta,
                          {
                            color:
                              fgDelta > 0
                                ? color.make
                                : fgDelta < 0
                                  ? color.miss
                                  : color.textDim,
                          },
                        ]}
                      >
                        {`${fgDelta > 0 ? '+' : ''}${fgDelta}% vs previous session`}
                      </Text>
                    )}
                  </View>
                  {/* Broadcast stat block: FG% rolls in, re-rolling only when
                      a genuinely new session lands (trigger = session id). */}
                  <View style={styles.sessionStat}>
                    <MotionStat
                      size="medium"
                      value={Math.round(lastSession.fgPct * 100)}
                      suffix="%"
                      label="FG"
                      trigger={lastSession.id}
                    />
                  </View>
                </Row>
                {/* Quiet full-width trend band under the payoff numbers. */}
                {recentTrend.length >= 2 && (
                  <View
                    accessible
                    accessibilityLabel={`FG% trend across your last ${recentTrend.length} sessions`}
                    style={styles.sparkBand}
                  >
                    <View style={styles.sparkBandChart}>
                      <Sparkline
                        data={recentTrend}
                        width={contentWidth - space.lg * 2}
                        height={SPARK_BAND_H}
                      />
                    </View>
                    <Text style={styles.sparkBandLabel}>
                      {`LAST ${recentTrend.length} SESSIONS`}
                    </Text>
                  </View>
                )}
              </Card>
            )}
          </Pressable>
        ) : (
          <FirstRunScene width={contentWidth} />
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
    gap: layout.sectionGap,
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
  hero: {
    minHeight: HERO_HEIGHT,
    borderRadius: radius.lg,
    padding: space.xl,
    justifyContent: 'flex-end',
    gap: space.xs,
    overflow: 'hidden',
  },
  heroEyebrow: {
    // Broadcast eyebrow voice — the shared tracked-caps step.
    ...type.eyebrow,
    color: color.onAccent,
    opacity: 0.7,
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
  heroFootRow: {
    alignItems: 'flex-end',
  },
  heroSubFlex: {
    flex: 1,
    minWidth: 0,
  },
  quickChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    backgroundColor: color.accentPressed,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  quickChipPressed: {
    opacity: 0.8,
  },
  quickChipLabel: {
    ...type.caption,
    color: color.onAccent,
  },
  modeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  modeBadge: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeReco: {
    ...type.micro,
    color: color.accent,
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
  cardPressed: {
    backgroundColor: color.surfaceRaised,
  },
  todayShelfDone: {
    // Quiet make-green edge — the completed state reads at a glance without
    // shouting over the ring's own green flip. The shared 14% make tint doubles
    // as the hairline (deliberately no dedicated edge token for this).
    borderColor: color.makeTint,
  },
  todayEyebrow: {
    marginBottom: space.md,
  },
  todayRow: {
    alignItems: 'center',
  },
  todayLeft: {
    flex: 1,
    minWidth: 0,
    gap: space.md,
    justifyContent: 'center',
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
  challengeIconChip: {
    // Same tinted circle as the weekly rows — one icon voice.
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
  challengeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
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
  sessionDelta: {
    ...type.caption,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  sparkBand: {
    marginTop: space.md,
    gap: space.xs,
  },
  sparkBandChart: {
    opacity: 0.75,
  },
  sparkBandLabel: {
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
});
