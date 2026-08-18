/**
 * Coach's Corner — the multi-session coaching room.
 *
 * A weekly-report hero card (broadcast box-score idiom, like SummaryHero) with
 * a Mon–Sun week selector, then the insight cards in narrative order — arc
 * profile, four-week timeline, season strip, NBA twin, weekly plan (+ Form
 * Studio 3D promo), form readiness — then the ranked coach findings for that
 * week: severity-toned cards carrying the user's OWN evidence numbers and a
 * prescription chip. "Share my week" pushes the report through the existing
 * ShareCard story pipeline.
 *
 * All analysis is pure (src/core/coachEngine.ts + weeklyReport.ts); this screen
 * only loads sessions from SQLite, groups them into weeks, and renders.
 * Dark-broadcast tokens throughout; motion is one-shot and reduced-motion
 * aware; every stat block carries an a11y label.
 */
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Animated from 'react-native-reanimated';

import { useCardStagger, useStaggerAt } from '@/components/motion';
import { BodyDirectionCard } from '@/components/BodyDirectionCard';
import { shareCoachCard, shareWeekCard } from '@/components/ShareCard';
import { ArcProfileCard } from '@/components/coach/ArcProfileCard';
import { CoachTimelineCard } from '@/components/coach/CoachTimelineCard';
import { FormReadinessCard } from '@/components/coach/FormReadinessCard';
import { SeasonStrip } from '@/components/coach/SeasonStrip';
import { Card, Chip, EmptyState, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, font, layout, motion, radius, space, type } from '@/constants/tokens';
import {
  runCoach,
  weeklyPlan,
  type CoachFinding,
  type CoachProfile,
  type CoachSession,
  type Severity,
  type Trend,
  type WeeklyAssignment,
} from '@/core/coachEngine';
import { arcProfile, coachTimeline, formReadiness, seasonComparison } from '@/core/coachInsights';
import { getDrill } from '@/core/drills';
import {
  drillPrescription,
  drillResultFromModeState,
  levelForDrill,
  LEVEL_LABEL,
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

// ---------------------------------------------------------------------------
// Section eyebrow (matches Shot Lab's idiom exactly)
// ---------------------------------------------------------------------------

function SectionEyebrow({
  icon,
  children,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  children: string;
}) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Severity + trend visual language
// ---------------------------------------------------------------------------

const SEVERITY_META: Record<Severity, { label: string; fg: string; bg: string; edge: string }> = {
  3: { label: 'FIX FIRST', fg: color.miss, bg: color.missTint, edge: color.missEdge },
  2: { label: 'WORK ON', fg: color.accent, bg: color.accentTint, edge: color.accentEdge },
  1: { label: 'NOTE', fg: color.textDim, bg: color.surfaceRaised, edge: color.border },
};

function trendVisual(trend: Trend): { icon: React.ComponentProps<typeof Ionicons>['name']; fg: string; label: string } | null {
  switch (trend) {
    case 'improving':
      return { icon: 'trending-up', fg: color.make, label: 'improving' };
    case 'worsening':
      return { icon: 'trending-down', fg: color.miss, label: 'worsening' };
    case 'flat':
      return { icon: 'remove', fg: color.textFaint, label: 'holding steady' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Finding card
// ---------------------------------------------------------------------------

function FindingCard({ finding, index }: { finding: CoachFinding; index: number }) {
  const meta = SEVERITY_META[finding.severity];
  const trend = trendVisual(finding.trend);
  // Canonical stagger (reduced-motion gated inside the hook).
  const enter = useCardStagger({ stepMs: 70 });
  const entering = enter(index);
  return (
    <Animated.View
      entering={entering}
      accessible
      accessibilityLabel={`${meta.label}. ${finding.title}. ${finding.evidence} Prescription: ${finding.prescription}${
        trend ? `. Trend ${trend.label}` : ''
      }`}
      style={[styles.finding, { borderLeftColor: meta.edge }]}
    >
      <Row style={styles.findingHead} gap={space.sm}>
        <View style={[styles.sevChip, { backgroundColor: meta.bg }]}>
          <Text style={[styles.sevChipText, { color: meta.fg }]}>{meta.label}</Text>
        </View>
        {trend && (
          <View style={styles.trendPill}>
            <Ionicons name={trend.icon} size={13} color={trend.fg} />
            <Text style={[styles.trendText, { color: trend.fg }]}>{trend.label}</Text>
          </View>
        )}
      </Row>
      <Text style={styles.findingTitle}>{finding.title}</Text>
      <Text style={styles.findingEvidence}>{finding.evidence}</Text>
      <Row gap={space.xs} style={styles.rxRow}>
        <View style={styles.rxIcon}>
          <Ionicons name="basketball-outline" size={13} color={color.accent} />
        </View>
        <Text style={styles.rxText}>{finding.prescription}</Text>
      </Row>
    </Animated.View>
  );
}

// ---------------------------------------------------------------------------
// Weekly report hero
// ---------------------------------------------------------------------------

const ZONE_NAME: Record<ChartZone, string> = { left: 'Left', center: 'Middle', right: 'Right' };

function WeeklyHero({ report }: { report: WeeklyReport }) {
  const fg = report.fgPct != null ? `${Math.round(report.fgPct * 100)}%` : '—';
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
      <SectionEyebrow icon="calendar-outline">{`Week of ${report.label}`}</SectionEyebrow>

      {/* WSS badge + headline */}
      <Row style={styles.wssRow} gap={space.lg}>
        <View style={styles.wssBadge} accessibilityElementsHidden>
          <Text style={styles.wssNum}>{report.wss}</Text>
          <Text style={styles.wssLabel}>WSS</Text>
        </View>
        <View style={styles.wssHeadlineWrap}>
          <Text style={styles.wssHeadline}>{report.headline}</Text>
          {deltaText && <Text style={[styles.wssDelta, { color: deltaColor }]}>{deltaText}</Text>}
        </View>
      </Row>

      {/* Broadcast box-score strip */}
      <View style={styles.strip} accessible accessibilityLabel={a11y}>
        <View style={styles.col}>
          <StatNumber value={`${report.makes}/${report.attempts}`} label="makes" size="medium" />
        </View>
        <View style={styles.divider} />
        <View style={styles.col}>
          <StatNumber value={fg} label="field goals" size="large" />
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

      {/* Share */}
      {report.sessions > 0 && (
        <PillButton
          label="Share my week"
          icon="logo-instagram"
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
          style={styles.shareBtn}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Week selector
// ---------------------------------------------------------------------------

function WeekSelector({
  weeks,
  activeIndex,
  onPick,
}: {
  weeks: { startMs: number; label: string; sessions: number }[];
  activeIndex: number;
  onPick: (i: number) => void;
}) {
  if (weeks.length <= 1) return null;
  return (
    <View accessibilityRole="tablist" style={styles.weekBar}>
      {weeks.map((w, i) => {
        const active = i === activeIndex;
        return (
          <Pressable
            key={w.startMs}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`Week of ${w.label}, ${w.sessions} ${w.sessions === 1 ? 'session' : 'sessions'}`}
            onPress={() => onPick(i)}
            style={({ pressed }) => [
              styles.weekChip,
              active && styles.weekChipActive,
              pressed && !active && styles.weekChipPressed,
            ]}
          >
            <Text style={[styles.weekChipText, active && styles.weekChipTextActive]} numberOfLines={1}>
              {w.label}
            </Text>
          </Pressable>
        );
      })}
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

/**
 * "Your NBA twin" — the closest shooting archetype for the week (matched on
 * ball-flight metrics, so no pose needed) plus the coachable universals worth
 * stealing from that player's form. The identity hook the user asked for
 * ("who do I shoot like?") folded into the weekly report.
 */
function NbaTwinCard({
  match,
  entering,
}: {
  match: ArchetypeMatch;
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}) {
  const p = match.player;
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="person-outline">Your NBA twin</SectionEyebrow>
      <Row style={styles.twinHead} gap={space.md}>
        <View style={styles.twinHeadText}>
          <Text
            style={styles.twinName}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.7}
          >
            {p.name}
          </Text>
          <Text style={styles.twinStyle}>{p.style}</Text>
        </View>
        <Chip label={`${match.similarity}% match`} tone="accent" />
      </Row>
      <Text style={styles.body}>{p.mechanics}</Text>
      <Text style={styles.twinCopyLabel}>STEAL THIS FROM THEIR FORM</Text>
      <View style={styles.twinCopyList}>
        {p.whatToCopy.slice(0, 2).map((c, i) => (
          <Row key={i} gap={space.sm} style={styles.twinCopyRow}>
            <Ionicons
              name="checkmark-circle"
              size={16}
              color={color.make}
              style={styles.twinCopyIcon}
            />
            <Text style={styles.twinCopy}>{c}</Text>
          </Row>
        ))}
      </View>
    </Card>
  );
}

/**
 * "This week's plan" — the coach as a training partner: the top few drillable
 * findings, each with its fix and the exact drill to groove it, numbered as a
 * checklist. Turns diagnosis into a week of work.
 */
function WeeklyPlanCard({
  plan,
  levels,
  entering,
}: {
  plan: readonly WeeklyAssignment[];
  /** Per-drill progression: current level + the coach's level prescription. */
  levels: Partial<Record<string, { level: DrillLevel; prescription: string }>>;
  entering?: React.ComponentProps<typeof Animated.View>['entering'];
}) {
  return (
    <Card entering={entering}>
      <SectionEyebrow icon="barbell-outline">This week&apos;s plan</SectionEyebrow>
      <Text style={styles.planLede}>
        {`Your top ${plan.length} ${plan.length === 1 ? 'fix' : 'fixes'}, each with a drill to groove it.`}
      </Text>
      <View style={styles.planList}>
        {plan.map((item, i) => {
          const drill = getDrill(item.drillId);
          const lv = levels[item.drillId];
          return (
            <View key={item.finding.id} style={styles.planItem}>
              <View style={styles.planNum}>
                <Text style={styles.planNumText}>{i + 1}</Text>
              </View>
              <View style={styles.planBody}>
                <Text style={styles.assignTitle}>{item.finding.title}</Text>
                <Text style={styles.body}>{item.finding.prescription}</Text>
                {lv != null && (
                  <>
                    <Row gap={space.sm} style={styles.planLevelRow}>
                      <Chip
                        label={`LEVEL ${lv.level} · ${LEVEL_LABEL[lv.level].toUpperCase()}`}
                        tone={lv.level > 1 ? 'accent' : 'default'}
                        compact
                      />
                    </Row>
                    <Text style={styles.planLevelRx}>{lv.prescription}</Text>
                  </>
                )}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Practice ${drill.title} at level ${lv?.level ?? 1} in Train`}
                  onPress={() =>
                    router.push({
                      pathname: '/modes',
                      params: { drill: item.drillId, level: String(lv?.level ?? 1) },
                    })
                  }
                  style={({ pressed }) => [styles.planDrill, pressed && { opacity: 0.6 }]}
                >
                  <Ionicons name="basketball" size={14} color={color.accent} />
                  <Text style={styles.planDrillText}>{`Practice: ${drill.title}`}</Text>
                </Pressable>
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

export default function CoachScreen() {
  const { state: load, reload } = useCoachSessions();
  const [weekIndex, setWeekIndex] = useState(0);

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

  // Canonical stagger for the insight-card ladder (reduced-motion gated inside).
  const cardEnter = useCardStagger({ stepMs: 70, durationMs: 380 });

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
          <Text style={styles.dim}>Loading your sessions…</Text>
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

            <WeeklyHero report={report} />

            {/* THE headline read: body data sets the style DIRECTION, the
                user's own logged shots set the practice DISTANCE. Each half
                renders its own honest gap state when its data is missing. */}
            <BodyDirectionCard shots={allShots} entering={cardEnter(1)} />

            {/* Arc profile — the release-arc signature over recent sessions.
                The card owns its own n<5 "charging" state, so it mounts from
                the very first measured shot. */}
            {arc.n >= 1 && <ArcProfileCard profile={arc} entering={cardEnter(2)} />}

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
                  entering={cardEnter(3)}
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
              <SeasonStrip comparison={season} entering={cardEnter(4)} />
            )}

            {/* NBA twin — who you shoot like this week + what to steal */}
            {twin != null && <NbaTwinCard match={twin} entering={cardEnter(5)} />}

            {/* This week's plan — the top fixes + drills to groove them */}
            {plan.length > 0 && (
              <WeeklyPlanCard plan={plan} levels={planLevels} entering={cardEnter(6)} />
            )}

            {/* Form Studio 3D promo — the upgrade's flagship, one tap away */}
            <Card entering={cardEnter(7)}>
              <Row gap={space.sm} style={styles.promoHead}>
                <Ionicons name="cube-outline" size={18} color={color.accent} />
                <Text style={styles.promoTitle} numberOfLines={1}>
                  See your shooting form in 3D
                </Text>
                <Chip label="NEW" tone="accent" compact />
              </Row>
              <Text style={styles.body}>
                Your tracked shots, rebuilt as a 3D skeleton you can orbit from any angle.
              </Text>
              <PillButton
                label="Open Form Studio"
                icon="cube-outline"
                variant="ghost"
                onPress={() => router.push('/formstudio')}
                style={styles.promoBtn}
              />
            </Card>

            {/* Form-data readiness — how much of the coach's form read is fed */}
            <FormReadinessCard
              readiness={readiness}
              onOpenSettings={() => router.push('/settings')}
              onOpenFormStudio={() => router.push('/formstudio')}
              entering={cardEnter(8)}
            />

            {/* Findings */}
            <View>
              <SectionEyebrow icon="clipboard-outline">The read on your week</SectionEyebrow>
              {findings.length === 0 ? (
                <Card entering={cardEnter(8)}>
                  <Text style={styles.body}>
                    {report.attempts < 8
                      ? 'A few more shots this week and the coach will have enough to break things down.'
                      : 'Nothing systematic to fix this week — your habits sit inside the good bands. Bank the reps and keep grooving it.'}
                  </Text>
                </Card>
              ) : (
                <View style={styles.findingList}>
                  {findings.map((f, i) => (
                    <FindingCard key={f.id} finding={f} index={i} />
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

            {/* Deeper dive hook */}
            <Card entering={cardEnter(8)}>
              <SectionEyebrow icon="flask-outline">Go deeper</SectionEyebrow>
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
  dim: {
    ...type.body,
    color: color.textDim,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  twinHead: {
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: space.sm,
  },
  twinHeadText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  assignTitle: {
    ...type.heading,
    color: color.text,
    marginBottom: space.xs,
  },
  planLede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
    marginBottom: space.md,
  },
  planList: {
    gap: space.md,
  },
  planItem: {
    flexDirection: 'row',
    gap: space.sm,
  },
  planNum: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  planNumText: {
    ...type.bodyMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  planBody: {
    flex: 1,
    minWidth: 0,
  },
  planLevelRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  planLevelRx: {
    ...type.caption,
    color: color.textDim,
    marginTop: 4,
  },
  planDrill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: space.sm,
  },
  planDrillText: {
    ...type.caption,
    color: color.accent,
    fontFamily: font.bodyMedium,
  },
  twinName: {
    ...type.heading,
    color: color.text,
  },
  twinStyle: {
    ...type.body,
    color: color.textDim,
  },
  twinCopyLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
    marginTop: space.md,
    marginBottom: space.sm,
  },
  twinCopyList: {
    gap: space.sm,
  },
  twinCopyRow: {
    alignItems: 'flex-start',
  },
  twinCopyIcon: {
    marginTop: 1,
  },
  twinCopy: {
    ...type.body,
    color: color.text,
    flex: 1,
    minWidth: 0,
  },
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
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

  // Form Studio 3D promo
  promoHead: {
    alignItems: 'center',
  },
  promoTitle: {
    ...type.heading,
    color: color.text,
    flex: 1,
    minWidth: 0,
  },
  promoBtn: {
    marginTop: space.md,
    alignSelf: 'flex-start',
  },

  // Week selector
  weekBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  weekChip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    backgroundColor: color.surface,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  weekChipActive: {
    backgroundColor: color.accentTint,
    borderColor: color.accentEdge,
  },
  weekChipPressed: {
    backgroundColor: color.surfaceRaised,
  },
  weekChipText: {
    ...type.caption,
    color: color.textDim,
  },
  weekChipTextActive: {
    color: color.accent,
    fontFamily: font.bodySemiBold,
  },

  // WSS + headline
  wssRow: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  wssBadge: {
    width: 72,
    height: 72,
    borderRadius: radius.md,
    backgroundColor: color.accentTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.accentEdge,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wssNum: {
    ...type.statMedium,
    color: color.accent,
    fontVariant: ['tabular-nums'],
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
  shareBtn: {
    marginTop: space.lg,
    alignSelf: 'stretch',
  },

  // Findings
  findingList: {
    gap: layout.cardGap,
  },
  finding: {
    backgroundColor: color.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderLeftWidth: 3,
    padding: space.lg,
    gap: space.sm,
  },
  findingHead: {
    justifyContent: 'space-between',
  },
  sevChip: {
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 4,
  },
  sevChipText: {
    ...type.micro,
    letterSpacing: 1,
  },
  trendPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  trendText: {
    ...type.micro,
    letterSpacing: 0.6,
  },
  findingTitle: {
    ...type.headingLarge,
    color: color.text,
  },
  findingEvidence: {
    ...type.body,
    color: color.textDim,
  },
  rxRow: {
    alignItems: 'flex-start',
    marginTop: space.xs,
  },
  rxIcon: {
    width: 22,
    height: 22,
    borderRadius: radius.pill,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  rxText: {
    ...type.body,
    color: color.text,
    flex: 1,
  },
  deepBtn: {
    marginTop: space.md,
    alignSelf: 'flex-start',
  },
});
