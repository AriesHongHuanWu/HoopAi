/**
 * Coach's Corner — the multi-session coaching room.
 *
 * A weekly-report hero card (broadcast box-score idiom, like SummaryHero) with
 * a Mon–Sun week selector, then the ranked coach findings for that week:
 * severity-toned cards carrying the user's OWN evidence numbers and a
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
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { shareWeekCard } from '@/components/ShareCard';
import { Card, Chip, EmptyState, PillButton, Row, Screen, StatNumber } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
import {
  runCoach,
  type CoachFinding,
  type CoachSession,
  type Severity,
  type Trend,
} from '@/core/coachEngine';
import {
  buildWeeklyReport,
  weekStart,
  type WeeklyReport,
} from '@/core/weeklyReport';
import { listSessions, sessionShots, shotFromRow } from '@/data/db';
import { recomputeStats } from '@/core/stats';
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
  3: { label: 'FIX FIRST', fg: color.miss, bg: color.missTint, edge: 'rgba(232, 87, 79, 0.45)' },
  2: { label: 'WORK ON', fg: color.accent, bg: color.accentTint, edge: 'rgba(240, 90, 36, 0.4)' },
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

function FindingCard({ finding, index, reducedMotion }: { finding: CoachFinding; index: number; reducedMotion: boolean }) {
  const meta = SEVERITY_META[finding.severity];
  const trend = trendVisual(finding.trend);
  const entering = reducedMotion ? undefined : FadeInDown.delay(index * 70).duration(360);
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

function WeeklyHero({ report, reducedMotion }: { report: WeeklyReport; reducedMotion: boolean }) {
  const fg = report.fgPct != null ? `${Math.round(report.fgPct * 100)}%` : '—';
  const enter = (delayMs: number) =>
    reducedMotion ? undefined : FadeInDown.duration(260).delay(delayMs);

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
    <Card entering={enter(0)}>
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
  | { status: 'ready'; sessions: CoachSession[] };

function useCoachSessions(): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const rows = await listSessions(SCAN_LIMIT);
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
        if (alive) setState({ status: 'ready', sessions });
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
  const reducedMotion = useReducedMotion();
  const { state: load, reload } = useCoachSessions();
  const [weekIndex, setWeekIndex] = useState(0);

  const sessions = load.status === 'ready' ? load.sessions : [];
  const weeks = useMemo(() => weeksOf(sessions), [sessions]);
  const activeWeek = weeks[Math.min(weekIndex, Math.max(0, weeks.length - 1))];

  const report = useMemo<WeeklyReport | null>(() => {
    if (activeWeek == null) return null;
    return buildWeeklyReport(sessions, activeWeek.startMs);
  }, [sessions, activeWeek]);

  // Findings shown are the report's own (already week-scoped + ranked). Kept as
  // a separate memo in case the UI later wants the full un-truncated list.
  const findings = useMemo<CoachFinding[]>(() => {
    if (activeWeek == null) return [];
    const weekSessions = sessions.filter((s) => weekStart(s.startedAt) === activeWeek.startMs);
    return runCoach(weekSessions);
  }, [sessions, activeWeek]);

  const cardEnter = (i: number) => (reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(380));

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
          <EmptyState
            title="No sessions to coach yet"
            body="Track a few shooting sessions and the coach will break down your week — what's working, what to fix, and one focus for next week."
            actionLabel="Start a session"
            onAction={() => router.push('/session/setup')}
          />
        ) : (
          <>
            <WeekSelector
              weeks={weeks}
              activeIndex={Math.min(weekIndex, weeks.length - 1)}
              onPick={setWeekIndex}
            />

            <WeeklyHero report={report} reducedMotion={reducedMotion} />

            {/* Findings */}
            <View>
              <SectionEyebrow icon="clipboard-outline">The read on your week</SectionEyebrow>
              {findings.length === 0 ? (
                <Card entering={cardEnter(1)}>
                  <Text style={styles.body}>
                    {report.attempts < 8
                      ? 'A few more shots this week and the coach will have enough to break things down.'
                      : 'Nothing systematic to fix this week — your habits sit inside the good bands. Bank the reps and keep grooving it.'}
                  </Text>
                </Card>
              ) : (
                <View style={styles.findingList}>
                  {findings.map((f, i) => (
                    <FindingCard key={f.id} finding={f} index={i} reducedMotion={reducedMotion} />
                  ))}
                </View>
              )}
            </View>

            {/* Deeper dive hook */}
            <Card entering={cardEnter(2)}>
              <SectionEyebrow icon="flask-outline">Go deeper</SectionEyebrow>
              <Text style={styles.body}>
                Coach's Corner reads across your whole week. For a single session — make-vs-miss
                breakdowns, your NBA twin and a drill plan — open the Shot Lab.
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
    gap: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
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
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
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
    borderColor: 'rgba(240, 90, 36, 0.5)',
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
    borderColor: 'rgba(240, 90, 36, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wssNum: {
    fontFamily: font.display,
    fontSize: 34,
    lineHeight: 36,
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
    backgroundColor: color.surfaceRaised,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: 2,
  },
  receiptPressed: {
    backgroundColor: color.surface,
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
    gap: space.md,
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
    ...type.heading,
    fontSize: 18,
    lineHeight: 24,
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
