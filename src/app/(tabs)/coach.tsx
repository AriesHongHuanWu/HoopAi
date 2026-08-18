/**
 * Coach's Corner — the multi-session coaching room.
 *
 * A weekly-report hero card (broadcast box-score idiom, like SummaryHero) with
 * a Mon–Sun week selector, then the insight cards — arc profile, four-week
 * timeline, season strip, NBA twin, weekly plan (+ Form Studio entries), form
 * readiness — and the ranked coach findings for that week: severity-toned cards
 * carrying the user's OWN evidence numbers and a prescription chip. The hero's
 * WSS wears the signature arc treatment: a static Skia progress ring (GoalRing
 * idiom) around a rolled numeral, with the shot-arc motif traced inside.
 *
 * ┌─ WHY THIS SCREEN IS SEGMENTED ──────────────────────────────────────────┐
 * │ Everything above used to arrive as ONE scroll of eight-plus cards of     │
 * │ equal weight, so the drill plan — the only part that asks the user to DO │
 * │ something — sat somewhere past the fold behind two charts and a promo,   │
 * │ and nothing signalled it was down there. The cards are now grouped by    │
 * │ the QUESTION they answer and switched with {@link SegmentedTabs}:        │
 * │                                                                          │
 * │   [This week]  what happened — four-week bars, season trend, the ranked  │
 * │                findings, share the read.                                 │
 * │   [Your form]  what my shot looks like — body direction, release arc,    │
 * │                NBA twin, Form Studio, how much form data is actually fed.│
 * │   [Plan]       what to do about it — the drill assignments and the       │
 * │                single-session deep dive.                                 │
 * │                                                                          │
 * │ The week selector and the weekly hero stay ABOVE the control in every    │
 * │ segment: the hero is this screen's answer to "how am I doing", so it is  │
 * │ the headline, not a section. Nothing was cut — every card and every      │
 * │ query that existed before still mounts, in the segment it belongs to.    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * All analysis is pure (src/core/coachEngine.ts + weeklyReport.ts); this screen
 * only loads sessions from SQLite, groups them into weeks, and renders. The
 * presentational cards live in src/components/coach/; WeeklyHero stays HERE
 * (layoutRhythmContract reads this file's source for the one hero Card).
 * Dark-broadcast tokens throughout; motion is one-shot and reduced-motion
 * aware; every stat block carries an a11y label. Skia on this screen is
 * STATIC — JS-built paths only, no worklets (the fx/particles precedent).
 */
import { BlurMask, Canvas, Path, Skia } from '@shopify/react-native-skia';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { MotionStat, Shimmer, arcMotif, useCardStagger, useStaggerAt } from '@/components/motion';
import { BodyDirectionCard } from '@/components/BodyDirectionCard';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { SegmentedTabs, type SegmentedTabItem } from '@/components/SegmentedTabs';
import { shareCoachCard, shareWeekCard } from '@/components/ShareCard';
import { ArcProfileCard } from '@/components/coach/ArcProfileCard';
import { CoachTimelineCard } from '@/components/coach/CoachTimelineCard';
import { FindingCard } from '@/components/coach/FindingCard';
import { FormReadinessCard } from '@/components/coach/FormReadinessCard';
import { NbaTwinCard } from '@/components/coach/NbaTwinCard';
import { SeasonStrip } from '@/components/coach/SeasonStrip';
import { WeekSelector } from '@/components/coach/WeekSelector';
import { WeeklyPlanCard } from '@/components/coach/WeeklyPlanCard';
import { Card, Chip, EmptyState, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, iconSize, layout, motion, radius, space, touch, type } from '@/constants/tokens';
import {
  runCoach,
  weeklyPlan,
  type CoachFinding,
  type CoachProfile,
  type CoachSession,
  type WeeklyAssignment,
} from '@/core/coachEngine';
import { arcProfile, coachTimeline, formReadiness, seasonComparison } from '@/core/coachInsights';
import {
  drillPrescription,
  drillResultFromModeState,
  levelForDrill,
  type DrillLevel,
  type DrillResult,
} from '@/core/drillProgression';
import {
  buildWeeklyReport,
  weekStart,
  type WeeklyReport,
} from '@/core/weeklyReport';
import { matchArchetype, type ArchetypeMatch } from '@/core/shotLab';
import { listSessions, sessionShots, shotFromRow } from '@/data/db';
import { recomputeStats } from '@/core/stats';
import { useProfile } from '@/state/profileStore';
import type { ChartZone } from '@/core/types';

/** Sessions scanned back for the coach window (a couple of months of weeks). */
const SCAN_LIMIT = 120;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The three questions this screen answers. Ordered the way a user arrives at
 * them — what happened, what my shot looks like, what to do — so the default
 * segment is also the one the hero above it is already talking about.
 */
type CoachSegment = 'week' | 'form' | 'plan';
const DEFAULT_SEGMENT: CoachSegment = 'week';

// ---------------------------------------------------------------------------
// WSS ring (the hero's expressive moment)
// ---------------------------------------------------------------------------

/** Ring canvas box — a step up from the old 72pt square badge. */
const RING_SIZE = 84;
const RING_STROKE = 6;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
/** WSS past which the sweep earns its soft heat glow (GoalRing's threshold). */
const RING_HOT = 0.75;

/**
 * Static Skia progress ring for the week's WSS — the GoalRing idiom at hero
 * scale: track circle, addArc sweep = WSS/100, the signature shot-arc motif
 * (arcMotif from the motion barrel) traced faintly through the interior, and
 * a soft glow under the sweep once the score runs hot. Every path is built on
 * the JS thread in useMemo; the only motion is the numeral's MotionStat roll,
 * re-triggered per week so paging weeks re-rolls the score.
 */
function WssRing({ wss, weekStartMs }: { wss: number; weekStartMs: number }) {
  const progress = Math.max(0, Math.min(1, wss / 100));
  const hot = progress >= RING_HOT;

  const trackPath = useMemo(() => {
    const p = Skia.Path.Make();
    p.addCircle(RING_SIZE / 2, RING_SIZE / 2, RING_R);
    return p;
  }, []);

  const sweepPath = useMemo(() => {
    const p = Skia.Path.Make();
    const sweep = 360 * progress;
    if (sweep > 0) {
      p.addArc(
        Skia.XYWHRect(RING_STROKE / 2, RING_STROKE / 2, RING_R * 2, RING_R * 2),
        -90,
        sweep,
      );
    }
    return p;
  }, [progress]);

  // The canonical quadratic, clipped by the canvas so only the swoop through
  // the ring's interior shows — the same echo GoalRing traces.
  const motifPath = useMemo(
    () => arcMotif(RING_SIZE, RING_SIZE, { rimInset: 16 }).path,
    [],
  );

  return (
    // Hidden from the screen reader: the box-score strip below speaks the WSS.
    <View style={styles.wssRing} accessibilityElementsHidden>
      <Canvas style={styles.wssCanvas}>
        <Path path={motifPath} style="stroke" strokeWidth={2} color={color.text} opacity={0.14} />
        <Path
          path={trackPath}
          style="stroke"
          strokeWidth={RING_STROKE}
          color={color.hudGlassBorder}
          opacity={0.9}
        />
        {hot && (
          <Path
            path={sweepPath}
            style="stroke"
            strokeWidth={RING_STROKE}
            strokeCap="round"
            color={color.accent}
            opacity={0.4}
          >
            <BlurMask blur={7} style="normal" />
          </Path>
        )}
        <Path
          path={sweepPath}
          style="stroke"
          strokeWidth={RING_STROKE}
          strokeCap="round"
          color={color.accent}
        />
      </Canvas>
      <View style={styles.wssCenter} pointerEvents="none">
        <MotionStat value={wss} size="medium" tint={color.accent} trigger={weekStartMs} />
        <Text style={styles.wssLabel}>WSS</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Weekly report hero
// ---------------------------------------------------------------------------

const ZONE_NAME: Record<ChartZone, string> = { left: 'Left', center: 'Middle', right: 'Right' };

function WeeklyHero({ report }: { report: WeeklyReport }) {
  // Absolute-delay stagger (reduced-motion gated inside the hook).
  const enterAt = useStaggerAt({ durationMs: motion.standard });

  const delta = report.fgDeltaPtsVsPrior;
  const deltaText =
    delta == null
      ? null
      : delta > 0.5
        ? `▲ ${Math.round(delta)} pts vs last week`
        : delta < -0.5
          ? `▼ ${Math.round(Math.abs(delta))} pts vs last week`
          : 'level with last week';
  const deltaColor = delta == null ? color.textFaint : delta > 0.5 ? color.make : delta < -0.5 ? color.miss : color.textFaint;

  const a11y =
    report.sessions === 0
      ? 'No sessions this week.'
      : `Week shooting score ${report.wss}. ${report.headline}${
          deltaText ? ` ${deltaText}.` : ''
        }`;

  return (
    <Card entering={enterAt(0)} style={styles.heroCard}>
      {/* Eyebrow row — the share action rides here as a compact icon pill so
          the segment foot's "Share coach report" stays the ONE full-width
          share CTA on the screen. */}
      <Row style={styles.heroTopRow} gap={space.sm}>
        <SectionEyebrow icon="calendar-outline">{`Week of ${report.label}`}</SectionEyebrow>
        {report.sessions > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Share my week"
            hitSlop={8}
            onPress={() => {
              void shareWeekCard({
                label: report.label,
                fgPct: report.fgPct,
                makes: report.makes,
                attempts: report.attempts,
                bestStreak: report.bestStreak,
                wss: report.wss,
                sessions: report.sessions,
              });
            }}
            style={({ pressed }) => [styles.sharePill, pressed && styles.sharePillPressed]}
          >
            <Ionicons name="logo-instagram" size={iconSize.md} color={color.accent} />
          </Pressable>
        )}
      </Row>

      {/* WSS ring + headline (headline/delta stay plain Text — only the
          numerals roll). */}
      <Row style={styles.wssRow} gap={space.lg}>
        <WssRing wss={report.wss} weekStartMs={report.weekStartMs} />
        <View style={styles.wssHeadlineWrap}>
          <Text style={styles.wssHeadline}>{report.headline}</Text>
          {deltaText && <Text style={[styles.wssDelta, { color: deltaColor }]}>{deltaText}</Text>}
        </View>
      </Row>

      {/* Broadcast box-score strip */}
      <View style={styles.strip} accessible accessibilityLabel={a11y}>
        <View style={styles.col}>
          {/* Compound "12/20" can't roll honestly — stays static. */}
          <StatNumber value={`${report.makes}/${report.attempts}`} label="makes" size="medium" />
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          {report.fgPct != null ? (
            <MotionStat
              value={Math.round(report.fgPct * 100)}
              suffix="%"
              label="field goals"
              size="large"
              trigger={report.weekStartMs}
            />
          ) : (
            <StatNumber value="—" label="field goals" size="large" />
          )}
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <StatNumber value={String(report.points)} label="pts" size="medium" />
        </View>
      </View>

      {/* Best session + hottest zone receipts */}
      {(report.bestSession || report.hottestZone) && (
        <Row gap={space.sm} style={styles.receiptRow}>
          {report.bestSession && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Best session this week, ${Math.round(report.bestSession.fgPct * 100)} percent field goals. Opens the session.`}
              onPress={() => router.push(`/history/${report.bestSession!.id}`)}
              style={({ pressed }) => [styles.receipt, pressed && styles.receiptPressed]}
            >
              <Text style={styles.receiptLabel}>BEST SESSION</Text>
              <Text style={styles.receiptValue}>{`${Math.round(report.bestSession.fgPct * 100)}% · ${report.bestSession.makes}/${report.bestSession.attempts}`}</Text>
            </Pressable>
          )}
          {report.hottestZone && (
            <View style={styles.receipt} accessible accessibilityLabel={`Hottest zone ${ZONE_NAME[report.hottestZone.zone]}, ${Math.round(report.hottestZone.fgPct * 100)} percent`}>
              <Text style={styles.receiptLabel}>HOT ZONE</Text>
              <Text style={styles.receiptValue}>{`${ZONE_NAME[report.hottestZone.zone]} · ${Math.round(report.hottestZone.fgPct * 100)}%`}</Text>
            </View>
          )}
        </Row>
      )}

      {/* Next-week focus banner */}
      <View style={styles.focusBanner} accessible accessibilityLabel={`Next week's focus: ${report.nextWeekFocus}`}>
        <Ionicons name="flag" size={14} color={color.accent} />
        <Text style={styles.focusText} numberOfLines={2}>
          <Text style={styles.focusKicker}>NEXT WEEK  </Text>
          {report.nextWeekFocus}
        </Text>
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Loading skeleton
// ---------------------------------------------------------------------------

/**
 * The shape of what's coming: a hero-shaped block (raised surface + accent
 * hairline, ring + headline + strip), a segmented-control bar, two card rows.
 * Heights mirror the real layout so content lands without reflow. Mounted
 * behind load.status === 'loading' ONLY — error/empty render their own cards.
 */
function CoachSkeleton() {
  const { width: screenW } = useWindowDimensions();
  // Screen pads space.lg per side; the hero block pads space.lg again.
  const innerW = Math.max(touch.minTarget * 4, screenW - space.lg * 2);
  const cardInnerW = innerW - space.lg * 2;
  const headlineW = cardInnerW - RING_SIZE - space.lg;

  return (
    <View
      style={styles.skeleton}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your sessions"
    >
      <View style={styles.skelHero}>
        <Shimmer width={Math.round(cardInnerW * 0.4)} height={12} radius={radius.sm} />
        <Row gap={space.lg} style={styles.skelHeroRow}>
          <Shimmer width={RING_SIZE} height={RING_SIZE} radius={RING_SIZE / 2} />
          <View style={styles.skelHeroLines}>
            <Shimmer width={Math.round(headlineW * 0.9)} height={16} radius={radius.sm} />
            <Shimmer width={Math.round(headlineW * 0.55)} height={12} radius={radius.sm} />
          </View>
        </Row>
        <Shimmer width={cardInnerW} height={56} radius={radius.md} />
      </View>
      <View style={styles.skelBody}>
        <Shimmer width={innerW} height={touch.minTarget} radius={radius.pill} />
        <Shimmer width={innerW} height={120} radius={radius.lg} />
        <Shimmer width={innerW} height={120} radius={radius.lg} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; sessions: CoachSession[]; drillResults: DrillResult[] };

function useCoachSessions(): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const rows = await listSessions(SCAN_LIMIT);
        // Drill history for the level ladder — parsed off the SAME rows (no
        // extra DB queries). Drills persist as finished spotShooting states.
        const drillResults = rows
          .filter((r) => r.modeId === 'spotShooting' && r.modeResultJson)
          .map((r) => {
            try {
              return drillResultFromModeState(JSON.parse(r.modeResultJson!), r.startedAt);
            } catch {
              return null;
            }
          })
          .filter((x): x is DrillResult => x != null);
        const withShots = rows.filter((r) => r.attempts > 0);
        const sessions = await Promise.all(
          withShots.map(async (r): Promise<CoachSession> => {
            const shotRows = await sessionShots(r.id);
            const shots = shotRows.map(shotFromRow);
            return {
              id: r.id,
              startedAt: r.startedAt,
              label: r.label !== '' ? r.label : undefined,
              shots,
              stats: recomputeStats(shots),
            };
          }),
        );
        if (alive) setState({ status: 'ready', sessions, drillResults });
      } catch {
        if (alive) setState({ status: 'error' });
      }
    })();
    return () => {
      alive = false;
    };
  }, [nonce]);
  return { state, reload: () => setNonce((n) => n + 1) };
}

/** Distinct weeks (newest-first) present in the session window. */
function weeksOf(sessions: readonly CoachSession[]): { startMs: number; label: string; sessions: number }[] {
  const counts = new Map<number, number>();
  for (const s of sessions) {
    const ws = weekStart(s.startedAt);
    counts.set(ws, (counts.get(ws) ?? 0) + 1);
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return [...counts.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([startMs, n]) => {
      const start = new Date(startMs);
      const end = new Date(startMs + 6 * DAY_MS);
      const a = `${MONTHS[start.getMonth()]} ${start.getDate()}`;
      const b =
        start.getMonth() === end.getMonth() ? `${end.getDate()}` : `${MONTHS[end.getMonth()]} ${end.getDate()}`;
      return { startMs, label: `${a} – ${b}`, sessions: n };
    });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function CoachScreen() {
  const { state: load, reload } = useCoachSessions();
  const [weekIndex, setWeekIndex] = useState(0);
  // Which question the user is asking. Screen state, not widget state — the
  // stagger ladder restarts from it, and switching must NOT touch the loader
  // below (useCoachSessions keys off `nonce` only, so a segment change is a
  // pure re-render and the SQLite scan is never re-run).
  const [segment, setSegment] = useState<CoachSegment>(DEFAULT_SEGMENT);

  const sessions = load.status === 'ready' ? load.sessions : [];
  const drillResults = load.status === 'ready' ? load.drillResults : [];
  const weeks = useMemo(() => weeksOf(sessions), [sessions]);
  const activeWeek = weeks[Math.min(weekIndex, Math.max(0, weeks.length - 1))];

  const report = useMemo<WeeklyReport | null>(() => {
    if (activeWeek == null) return null;
    return buildWeeklyReport(sessions, activeWeek.startMs);
  }, [sessions, activeWeek]);

  // Player profile → the coach personalizes emphasis + framing to who you are
  // (a for-fun player isn't nagged about volume; a pro is held to the pro band;
  // a rookie hears it at their level). Persisted profile fields, mapped onto
  // the engine's structural CoachProfile.
  const experience = useProfile((s) => s.experience);
  const trainingGoal = useProfile((s) => s.trainingGoal);
  const position = useProfile((s) => s.position);
  const coachProfile = useMemo<CoachProfile>(
    () => ({ experience, goal: trainingGoal, position }),
    [experience, trainingGoal, position],
  );

  // Findings shown are the report's own (already week-scoped + ranked). Kept as
  // a separate memo in case the UI later wants the full un-truncated list.
  const findings = useMemo<CoachFinding[]>(() => {
    if (activeWeek == null) return [];
    const weekSessions = sessions.filter((s) => weekStart(s.startedAt) === activeWeek.startMs);
    return runCoach(weekSessions, coachProfile);
  }, [sessions, activeWeek, coachProfile]);

  // NBA twin for the week: matchArchetype runs on shot-flight metrics (release/
  // entry angle, timing), so it works WITHOUT any pose data — every tracked
  // session can have a twin. Null until there are enough measured shots.
  const twin = useMemo<ArchetypeMatch | null>(() => {
    if (activeWeek == null) return null;
    const weekShots = sessions
      .filter((s) => weekStart(s.startedAt) === activeWeek.startMs)
      .flatMap((s) => s.shots);
    const matches = matchArchetype(weekShots);
    return matches.length > 0 ? matches[0]! : null;
  }, [sessions, activeWeek]);

  // The ONE thing to work on this week: top finding that maps to a drill.
  const plan = useMemo<WeeklyAssignment[]>(
    () => weeklyPlan(findings),
    [findings],
  );

  // Findings the plan ACTUALLY contains — only these get the "Drill this"
  // bridge on their card. An unmapped finding never invents a drill.
  const plannedFindingIds = useMemo(
    () => new Set(plan.map((p) => p.finding.id)),
    [plan],
  );

  // Four-week timeline ending at the selected week (oldest-first, empty weeks
  // included so the bars read as a calendar, not a highlight reel).
  const timeline = useMemo(
    () => (activeWeek ? coachTimeline(sessions, activeWeek.startMs, 4) : []),
    [sessions, activeWeek],
  );

  // Last 28 days vs the 28 before — the season-scale trend strip.
  const season = useMemo(
    () => (activeWeek ? seasonComparison(sessions, activeWeek.startMs) : null),
    [sessions, activeWeek],
  );

  // Arc profile — the release-arc signature over the last ~15 sessions
  // (sessions come newest-first from listSessions). Deliberately NOT
  // week-scoped: the arc read is a habit, and it should hold steady while the
  // user flips between weeks. arcProfile is pure (band 43–52°).
  const arc = useMemo(
    () => arcProfile(sessions.slice(0, 15).flatMap((s) => s.shots)),
    [sessions],
  );

  // Timeline emptiness — with 3+ of the 4 weeks blank, the bars need one
  // gentle line of context so a new user reads "calendar", not "broken chart".
  const timelineMostlyEmpty = useMemo(
    () => timeline.filter((w) => w.sessions === 0).length >= 3,
    [timeline],
  );

  // Every logged shot in the scan window. Feeds the body plan's DISTANCE
  // half, which needs volume (RANGE_MIN_ATTEMPTS) and must not flip as the
  // user pages between weeks.
  const allShots = useMemo(() => sessions.flatMap((s) => s.shots), [sessions]);

  // Pose/form data coverage across the whole scan window (not week-scoped).
  const readiness = useMemo(() => formReadiness(sessions.flatMap((s) => s.shots)), [sessions]);

  // Drill progression per planned drill: current level + the level prescription.
  const planLevels = useMemo(() => {
    const m: Partial<Record<string, { level: DrillLevel; prescription: string }>> = {};
    for (const item of plan) {
      const rs = drillResults.filter((r) => r.drillId === item.drillId);
      const level = levelForDrill(rs);
      m[item.drillId] = { level, prescription: drillPrescription(item.drillId, level, rs) };
    }
    return m;
  }, [plan, drillResults]);

  // Canonical stagger for the insight-card ladder (reduced-motion gated
  // inside). Every segment restarts its ladder at 0, so no section ever gets
  // near useCardStagger's STAGGER_CAP_INDEX — the whole point of segmenting is
  // that a section is short enough to arrive as one gesture.
  const cardEnter = useCardStagger({ stepMs: 70, durationMs: 380 });

  // Badges carry only counts the screen actually has: findings for the week
  // read, assignments for the plan. Zero renders no badge (SegmentedTabs drops
  // it), so an empty section never advertises phantom content.
  const segmentItems = useMemo<SegmentedTabItem<CoachSegment>[]>(
    () => [
      {
        value: 'week',
        label: 'This week',
        badge: findings.length,
        badgeLabel: `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`,
      },
      { value: 'form', label: 'Your form' },
      {
        value: 'plan',
        label: 'Plan',
        badge: plan.length,
        badgeLabel: `${plan.length} ${plan.length === 1 ? 'drill' : 'drills'}`,
      },
    ],
    [findings.length, plan.length],
  );

  return (
    <Screen scroll>
      <View style={styles.stack}>
        <View>
          <Text style={styles.kicker}>COACH'S CORNER</Text>
          <Text style={styles.title} accessibilityRole="header">
            Your week, coached
          </Text>
        </View>

        {load.status === 'loading' ? (
          <CoachSkeleton />
        ) : load.status === 'error' ? (
          <EmptyState
            title="Couldn't load your sessions"
            body="Your stats are safe — this is usually temporary."
            actionLabel="Try again"
            onAction={reload}
          />
        ) : sessions.length === 0 || report == null ? (
          <>
            <EmptyState
              title="No sessions to coach yet"
              body="Track a few shooting sessions and the coach will break down your week — what's working, what to fix, and one focus for next week."
              actionLabel="Start a session"
              onAction={() => router.push('/session/setup')}
            />

            {/* Body sets the direction — this half needs the profile, not
                shots, so it is the one thing the coach can say on day one. */}
            <BodyDirectionCard shots={allShots} entering={cardEnter(1)} />
          </>
        ) : (
          <>
            <WeekSelector
              weeks={weeks}
              activeIndex={Math.min(weekIndex, weeks.length - 1)}
              onPick={setWeekIndex}
            />

            {/* The hero is the HEADLINE, not a section: it answers "how am I
                doing" and therefore stays above the switcher in every
                segment. */}
            <WeeklyHero report={report} />

            <View style={styles.segmentBlock}>
              <SegmentedTabs
                segments={segmentItems}
                value={segment}
                onChange={setSegment}
                accessibilityLabel="Coach sections"
              />

              {/* ---- [This week] what happened ---------------------------- */}
              {segment === 'week' && (
                <View style={styles.segmentBody}>
                  {/* Four-week timeline — tap a bar to jump the week selector */}
                  {timeline.some((w) => w.sessions > 0) && (
                    <View style={styles.timelineBlock}>
                      <CoachTimelineCard
                        weeks={timeline}
                        activeStartMs={activeWeek!.startMs}
                        onPickWeek={(ms) => {
                          const i = weeks.findIndex((w) => w.startMs === ms);
                          if (i >= 0) setWeekIndex(i);
                        }}
                        entering={cardEnter(0)}
                      />
                      {timelineMostlyEmpty && (
                        <Text style={styles.timelineHint}>
                          Your timeline fills in as the weeks stack up.
                        </Text>
                      )}
                    </View>
                  )}

                  {/* Season strip — shown whenever EITHER 28-day window has data */}
                  {season != null && (season.recent.attempts > 0 || season.prior.attempts > 0) && (
                    <SeasonStrip comparison={season} entering={cardEnter(1)} />
                  )}

                  {/* Findings */}
                  <View>
                    <SectionEyebrow icon="clipboard-outline" style={styles.eyebrow}>
                      The read on your week
                    </SectionEyebrow>
                    {findings.length === 0 ? (
                      <Card entering={cardEnter(2)}>
                        <Text style={styles.body}>
                          {report.attempts < 8
                            ? 'A few more shots this week and the coach will have enough to break things down.'
                            : 'Nothing systematic to fix this week — your habits sit inside the good bands. Bank the reps and keep grooving it.'}
                        </Text>
                      </Card>
                    ) : (
                      <View style={styles.findingList}>
                        {findings.map((f, i) => (
                          <FindingCard
                            key={f.id}
                            finding={f}
                            index={i}
                            onDrillThis={
                              plannedFindingIds.has(f.id) ? () => setSegment('plan') : undefined
                            }
                          />
                        ))}
                      </View>
                    )}
                  </View>

                  {/* Share the whole coach read as a story card */}
                  {report.sessions > 0 && (
                    <PillButton
                      label="Share coach report"
                      icon="share-outline"
                      variant="ghost"
                      onPress={() => {
                        void shareCoachCard({
                          label: report.label,
                          wss: report.wss,
                          fgPct: report.fgPct,
                          makes: report.makes,
                          attempts: report.attempts,
                          sessions: report.sessions,
                          topFinding: findings[0]?.title ?? null,
                          focus: report.nextWeekFocus,
                        });
                      }}
                    />
                  )}
                </View>
              )}

              {/* ---- [Your form] what my shot looks like ------------------ */}
              {segment === 'form' && (
                <View style={styles.segmentBody}>
                  {/* THE headline read: body data sets the style DIRECTION, the
                      user's own logged shots set the practice DISTANCE. Each half
                      renders its own honest gap state when its data is missing. */}
                  <BodyDirectionCard shots={allShots} entering={cardEnter(0)} />

                  {/* Arc profile — the release-arc signature over recent sessions.
                      The card owns its own n<5 "charging" state, so it mounts from
                      the very first measured shot. */}
                  {arc.n >= 1 && <ArcProfileCard profile={arc} entering={cardEnter(1)} />}

                  {/* NBA twin — who you shoot like this week + what to steal */}
                  {twin != null && <NbaTwinCard match={twin} entering={cardEnter(2)} />}

                  {/* Form Studio — two honest doors. The side-by-side theater is
                      2D; the orbitable skeleton lives in Form Studio 3D and says
                      "estimated" out loud. One card no longer promises the one
                      while routing to the other. */}
                  <Card entering={cardEnter(3)}>
                    <Row gap={space.sm} style={styles.promoHead}>
                      <Ionicons name="body-outline" size={18} color={color.accent} />
                      <Text style={styles.promoTitle} numberOfLines={1}>
                        Form Studio
                      </Text>
                      <Chip label="NEW" tone="accent" compact />
                    </Row>
                    <Text style={styles.body}>
                      Study the mechanics of your tracked shots — side-by-side on video, or as an
                      estimated 3D skeleton.
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Compare your motion side-by-side. Opens Form Studio."
                      onPress={() => router.push('/formstudio')}
                      style={({ pressed }) => [styles.promoRow, pressed && { opacity: 0.6 }]}
                    >
                      <Ionicons name="albums-outline" size={iconSize.sm} color={color.accent} />
                      <Text style={styles.promoRowText}>Compare your motion side-by-side</Text>
                      <Ionicons name="chevron-forward" size={iconSize.sm} color={color.textFaint} />
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Orbit your shot in 3D, estimated. Opens Form Studio 3D."
                      onPress={() => router.push('/formstudio3d')}
                      style={({ pressed }) => [styles.promoRow, pressed && { opacity: 0.6 }]}
                    >
                      <Ionicons name="cube-outline" size={iconSize.sm} color={color.accent} />
                      <Text style={styles.promoRowText}>Orbit your shot in 3D (estimated)</Text>
                      <Ionicons name="chevron-forward" size={iconSize.sm} color={color.textFaint} />
                    </Pressable>
                  </Card>

                  {/* Form-data readiness — how much of the coach's form read is
                      fed. It lands LAST in this segment on purpose: it is the
                      honesty line under everything above it. */}
                  <FormReadinessCard
                    readiness={readiness}
                    onOpenSettings={() => router.push('/settings')}
                    onOpenFormStudio={() => router.push('/formstudio')}
                    entering={cardEnter(4)}
                  />
                </View>
              )}

              {/* ---- [Plan] what to do about it --------------------------- */}
              {segment === 'plan' && (
                <View style={styles.segmentBody}>
                  {/* This week's plan — the top fixes + drills to groove them */}
                  {plan.length > 0 ? (
                    <WeeklyPlanCard plan={plan} levels={planLevels} entering={cardEnter(0)} />
                  ) : (
                    // Honest empty: the plan is built from drillable findings,
                    // so "no plan" means the coach found nothing to prescribe —
                    // never a fabricated drill to fill the tab.
                    <Card entering={cardEnter(0)}>
                      <SectionEyebrow icon="barbell-outline" style={styles.eyebrow}>
                        This week&apos;s plan
                      </SectionEyebrow>
                      <Text style={styles.body}>
                        {findings.length === 0
                          ? 'No drill plan this week — the coach found nothing systematic to fix. Bank the reps.'
                          : "This week's findings don't map to a drill yet. Keep tracking and the plan fills in."}
                      </Text>
                    </Card>
                  )}

                  {/* Deeper dive hook */}
                  <Card entering={cardEnter(1)}>
                    <SectionEyebrow icon="flask-outline" style={styles.eyebrow}>
                      Go deeper
                    </SectionEyebrow>
                    <Text style={styles.body}>
                      Coach's Corner reads across your whole week. For a single session — make-vs-miss
                      breakdowns, shot-by-shot form and a drill plan — open the Shot Lab.
                    </Text>
                    <PillButton
                      label="Open Shot Lab"
                      icon="flask"
                      variant="ghost"
                      onPress={() => router.push('/shotlab')}
                      style={styles.deepBtn}
                    />
                  </Card>
                </View>
              )}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    // Common tab rhythm — see `layout` in constants/tokens.ts. No paddingBottom
    // here: Screen already tails the scroll with insets.bottom + space.xxl, so
    // a local one just stacked a second dead gap above the tab bar.
    gap: layout.sectionGap,
    paddingTop: space.md,
  },
  /**
   * The weekly report is the ENTRY POINT: eight sibling cards of identical
   * weight gave the eye nowhere to land. Raised surface + a full-weight accent
   * edge (vs the hairline every other card wears) makes the hierarchy legible
   * before a single word is read.
   */
  heroCard: {
    backgroundColor: color.surfaceRaised,
    borderWidth: 1,
    borderColor: color.accentEdge,
  },
  /**
   * The switcher hugs the cards it filters (cardGap), while those cards keep
   * the screen's top-level rhythm between themselves (sectionGap). Both values
   * come from `layout` — nothing here hand-picks a gap.
   */
  segmentBlock: {
    gap: layout.cardGap,
  },
  segmentBody: {
    gap: layout.sectionGap,
  },
  kicker: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.4,
    marginBottom: 2,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  // Shared SectionEyebrow leaves margins to the call site (screens own rhythm).
  eyebrow: {
    marginBottom: space.sm,
  },

  // Timeline block (card + optional sparse-history hint hugging it)
  timelineBlock: {
    gap: space.xs,
  },
  timelineHint: {
    ...type.caption,
    color: color.textFaint,
    paddingHorizontal: space.xs,
  },

  // Form Studio card (two entry rows)
  promoHead: {
    alignItems: 'center',
  },
  promoTitle: {
    ...type.heading,
    color: color.text,
    flex: 1,
    minWidth: 0,
  },
  promoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingVertical: space.xs,
  },
  promoRowText: {
    ...type.caption,
    color: color.accent,
    flex: 1,
    minWidth: 0,
  },

  // Hero top row: eyebrow + compact share icon pill
  heroTopRow: {
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: space.sm,
  },
  sharePill: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sharePillPressed: {
    backgroundColor: color.surface,
  },

  // WSS ring + headline
  wssRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  wssRing: {
    width: RING_SIZE,
    height: RING_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wssCanvas: {
    width: RING_SIZE,
    height: RING_SIZE,
  },
  wssCenter: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wssLabel: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.2,
    opacity: 0.8,
  },
  wssHeadlineWrap: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  wssHeadline: {
    ...type.heading,
    color: color.text,
  },
  wssDelta: {
    ...type.caption,
    fontVariant: ['tabular-nums'],
  },

  // Box-score strip
  strip: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: space.lg,
    marginTop: space.lg,
  },
  col: {
    flex: 1,
    alignItems: 'center',
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 44,
    backgroundColor: color.border,
    marginBottom: space.xs,
  },

  // Receipts
  receiptRow: {
    marginTop: space.lg,
    alignItems: 'stretch',
  },
  receipt: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    // One step BELOW the hero card that holds them. These tiles used to sit on
    // surfaceRaised over a `surface` card; now the card itself is raised, so
    // the same value would make them disappear into their own container.
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
  },
  receiptPressed: {
    // Presses push IN here rather than lighting up: on a raised card the only
    // free direction is down toward the canvas.
    backgroundColor: color.bg,
  },
  receiptLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
  },
  receiptValue: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },

  // Focus banner
  focusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    marginTop: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: color.accentTint,
  },
  focusKicker: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.2,
  },
  focusText: {
    ...type.body,
    color: color.text,
    flex: 1,
  },

  // Findings
  findingList: {
    gap: layout.cardGap,
  },
  deepBtn: {
    marginTop: space.md,
    alignSelf: 'flex-start',
  },

  // Loading skeleton — the hero shape, the switcher bar, two card rows.
  skeleton: {
    gap: layout.sectionGap,
  },
  skelHero: {
    borderRadius: radius.lg,
    backgroundColor: color.surfaceRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentEdge,
    padding: space.lg,
    gap: space.lg,
  },
  skelHeroRow: {
    alignItems: 'center',
  },
  skelHeroLines: {
    flex: 1,
    minWidth: 0,
    gap: space.sm,
  },
  skelBody: {
    gap: layout.cardGap,
  },
});
