/**
 * Trends — FG% across the last 30 sessions, ONE hero.
 *
 * The hero card leads with the latest-FG% numeral rolling in via CountUp and
 * a trend-direction chip (up/down/flat vs the previous session, computed from
 * the same series the charts draw), then ONE chart slot: SegmentedTabs toggle
 * the SAME points[] between the accent sparkline (drawn on left-to-right,
 * labelled ends) and the per-session bars with a real y-axis (Skia rects,
 * recency-ramped accent, latest bar hot). The old layout drew that identical
 * series twice in two stacked cards. Below the hero: a hairline-divided stat
 * grid, the last session's entry-angle histogram and a lifetime strip. Cards
 * cascade in with a small stagger; under reduced motion they render
 * statically. Empty state until at least two sessions exist.
 */
import { Ionicons } from '@expo/vector-icons';
import { Canvas, Rect, RoundedRect } from '@shopify/react-native-skia';
import { router, useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, ReduceMotion } from 'react-native-reanimated';

import { CountUp, MotionStat, useCardStagger } from '@/components/motion';
import { SectionEyebrow } from '@/components/ScreenHeader';
import { BackPill } from '@/components/ShotList';
import {
  AngleHistogram,
  decidedEntryAngles,
} from '@/components/charts/AngleHistogram';
import { Sparkline } from '@/components/charts/Sparkline';
import { CourtHeatmap } from '@/components/charts/CourtHeatmap';
import { SegmentedTabs } from '@/components/SegmentedTabs';
import { Card, EmptyState, Eyebrow, Row, Screen, SkeletonCard } from '@/components/ui';
import { color, font, layout, motion, radius, space, type } from '@/constants/tokens';
import { fgTrend, listSessions, sessionShots, shotFromRow } from '@/data/db';
import { monthlyProgress, type MonthlyProgress } from '@/core/progression';
import { buildHeatmap, type Heatmap } from '@/core/heatmap';

type TrendPoint = Awaited<ReturnType<typeof fgTrend>>[number];

const SPARK_H = 132;
const BARS_H = 110;
/** Recent tracked sessions aggregated into the court-zone heatmap. */
const ZONE_SESSION_SCAN = 15;
/** Min attempts before the zone map is worth showing. */
const ZONE_MIN_ATTEMPTS = 6;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Measures its own width and renders children once it is known. */
function MeasuredWidth({
  accessibilityLabel,
  children,
}: {
  accessibilityLabel?: string;
  children: (width: number) => React.ReactNode;
}) {
  const [width, setWidth] = useState(0);
  return (
    <View
      accessible={accessibilityLabel != null}
      accessibilityLabel={accessibilityLabel}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
    >
      {width > 0 ? children(width) : null}
    </View>
  );
}

/**
 * Trend-direction chip: up/down/flat vs the previous session. Purely derived
 * from the delta already shown on screen — color + icon shape so the
 * direction never relies on color alone.
 */
function TrendChip({ deltaPct }: { deltaPct: number }) {
  const dir = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : 'flat';
  const tone =
    dir === 'up'
      ? { bg: color.makeTint, fg: color.make }
      : dir === 'down'
        ? { bg: color.missTint, fg: color.miss }
        : { bg: color.surfaceRaised, fg: color.textDim };
  const icon =
    dir === 'up' ? 'trending-up' : dir === 'down' ? 'trending-down' : 'remove';
  const label =
    dir === 'flat'
      ? 'Even vs last'
      : `${deltaPct > 0 ? '+' : ''}${deltaPct}% vs last`;
  const a11y =
    dir === 'flat'
      ? 'Trend flat: even with the previous session'
      : `Trending ${dir}: ${Math.abs(deltaPct)} percentage points ${dir === 'up' ? 'above' : 'below'} the previous session`;
  return (
    <View
      accessible
      accessibilityLabel={a11y}
      style={[styles.trendChip, { backgroundColor: tone.bg }]}
    >
      <Ionicons name={icon} size={14} color={tone.fg} />
      <Text style={[styles.trendChipLabel, { color: tone.fg }]}>{label}</Text>
    </View>
  );
}

/**
 * One bar per session, rounded caps. Accent-consistent recency ramp: older
 * bars sit low-heat, the latest runs full leather. Gridlines at 100 / 50 /
 * baseline anchor the y-axis labels beside the canvas.
 */
function TrendBars({
  data,
  width,
  height,
}: {
  data: readonly number[];
  width: number;
  height: number;
}) {
  const n = data.length;
  const slot = width / n;
  const barW = Math.min(28, Math.max(4, slot * 0.55));
  const capR = Math.min(4, barW / 2);
  /** Same value→y mapping the bars use, so gridlines are honest. */
  const yFor = (v: number) => height - clamp01(v) * (height - 4);
  return (
    <Canvas style={{ width, height }}>
      <Rect
        x={0}
        y={Math.round(yFor(1))}
        width={width}
        height={1}
        color={color.border}
        opacity={0.35}
      />
      <Rect
        x={0}
        y={Math.round(yFor(0.5))}
        width={width}
        height={1}
        color={color.border}
        opacity={0.6}
      />
      <Rect x={0} y={height - 1} width={width} height={1} color={color.border} />
      {data.map((v, i) => {
        const h = Math.max(3, clamp01(v) * (height - 4));
        const x = slot * i + (slot - barW) / 2;
        const latest = i === n - 1;
        return (
          <RoundedRect
            key={i}
            x={x}
            y={height - h}
            width={barW}
            height={h}
            r={capR}
            color={color.accent}
            opacity={latest ? 1 : 0.16 + (n > 1 ? (i / (n - 1)) * 0.22 : 0)}
          />
        );
      })}
    </Canvas>
  );
}

/** The hero's chart styles — one slot, same series, user-picked lens. */
type ChartKind = 'line' | 'bars';

/**
 * Lens-swap entrance: the chart-slot subtree is keyed on the lens, so picking
 * Line/Bars remounts it and the new lens cross-fades in (no exiting — the old
 * lens unmounts instantly by design, per the shared disclosure grammar).
 */
const lensSwap = FadeIn.duration(motion.quick).reduceMotion(ReduceMotion.System);

export default function TrendsScreen() {
  const [trend, setTrend] = useState<TrendPoint[] | null>(null);
  /** Which lens the hero chart slot shows. State-local; Line is the default. */
  const [chartKind, setChartKind] = useState<ChartKind>('line');
  /** Entry angles of the LAST session's decided shots (null = loading). */
  const [lastAngles, setLastAngles] = useState<number[] | null>(null);
  const [lifetime, setLifetime] = useState<{
    sessions: number;
    makes: number;
  } | null>(null);
  const [monthly, setMonthly] = useState<MonthlyProgress | null>(null);
  /** Aggregate court-zone heatmap across recent sessions (null = loading). */
  const [zones, setZones] = useState<Heatmap | null>(null);
  // Canonical card cascade — this screen keeps its wider 70 ms step
  // (undefined under reduced motion — cards render static).
  const enter = useCardStagger({ stepMs: 70, durationMs: motion.standard });

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void fgTrend(30).then(async (t) => {
        if (!alive) return;
        setTrend(t);
        const last = t[t.length - 1];
        if (last == null) {
          setLastAngles([]);
          return;
        }
        const rows = await sessionShots(last.sessionId);
        if (alive) setLastAngles(decidedEntryAngles(rows));
      });
      void listSessions(1000).then(async (rows) => {
        if (!alive) return;
        const tracked = rows.filter((r) => r.attempts > 0);
        setLifetime({
          sessions: tracked.length,
          // SUM over a shot-less session can surface as null — guard it.
          makes: tracked.reduce((sum, r) => sum + (r.makes ?? 0), 0),
        });
        setMonthly(monthlyProgress(tracked, Date.now()));
        // Court zones: decided shots across the most recent tracked sessions
        // (bounded) so the map reflects the current game, not all-time.
        const recent = tracked.slice(0, ZONE_SESSION_SCAN);
        const shotRows = await Promise.all(recent.map((r) => sessionShots(r.id)));
        if (!alive) return;
        setZones(buildHeatmap(shotRows.flat().map(shotFromRow)));
      });
      return () => {
        alive = false;
      };
    }, []),
  );

  const points = trend?.map((p) => p.fgPct) ?? [];
  const enough = points.length >= 2;
  const latest = points[points.length - 1] ?? 0;
  const previous = points[points.length - 2] ?? 0;
  const deltaPct = Math.round((latest - previous) * 100);
  const avg =
    points.length > 0
      ? points.reduce((a, b) => a + b, 0) / points.length
      : 0;
  const best = points.length > 0 ? Math.max(...points) : 0;
  const attempts = trend?.reduce((a, p) => a + p.attempts, 0) ?? 0;

  return (
    <Screen scroll>
      <Row style={{ marginBottom: space.lg }}>
        <BackPill />
      </Row>
      <Eyebrow>Trends</Eyebrow>
      <Text style={styles.title} accessibilityRole="header">
        FG% over time
      </Text>

      {/* This month vs last — the glanceable "am I improving?" signal. */}
      {monthly != null && monthly.thisMonth.sessions > 0 && (
        <Card entering={enter(0)} style={styles.monthCard}>
          <Row style={styles.monthRow}>
            <View style={styles.monthText}>
              <SectionEyebrow icon="calendar-outline" style={styles.cardKicker}>
                This month
              </SectionEyebrow>
              <Text style={styles.monthMeta}>
                {`${monthly.thisMonth.makes} makes · ${monthly.thisMonth.sessions} session${
                  monthly.thisMonth.sessions === 1 ? '' : 's'
                }`}
              </Text>
            </View>
            {monthly.rateDelta != null && (
              <TrendChip deltaPct={Math.round(monthly.rateDelta * 100)} />
            )}
          </Row>
        </Card>
      )}

      {trend === null ? (
        // One loading language: the shape of the hero card that is arriving.
        <SkeletonCard hero lines={2} />
      ) : !enough ? (
        <EmptyState
          title="Not enough sessions yet"
          body="Finish at least two tracked sessions and your FG% trend will draw itself here."
          actionLabel="Start a session"
          onAction={() => router.push('/session/setup')}
        />
      ) : (
        <View style={styles.cardStack}>
          <Card entering={enter(0)}>
            <SectionEyebrow icon="trending-up" style={styles.cardKicker}>
              Field goal %
            </SectionEyebrow>
            <Row style={{ justifyContent: 'space-between' }}>
              <View
                accessible
                accessibilityLabel={`Latest session field goal ${Math.round(latest * 100)} percent`}
              >
                {/* Expressive hero: the numeral rolls in (settle haptic off —
                    this is a chart, not a celebration moment). */}
                <CountUp
                  to={Math.round(latest * 100)}
                  suffix="%"
                  durationMs={motion.celebrate}
                  haptic={false}
                  style={styles.heroValue}
                />
                <Text style={styles.heroLabel}>LATEST SESSION</Text>
              </View>
              <TrendChip deltaPct={deltaPct} />
            </Row>
            {/* ONE chart slot: the same points[] under two lenses. The old
                layout drew this series twice (sparkline card + bars card). */}
            <SegmentedTabs<ChartKind>
              segments={[
                { value: 'line', label: 'Line' },
                { value: 'bars', label: 'Bars' },
              ]}
              value={chartKind}
              onChange={setChartKind}
              accessibilityLabel="Chart style"
              style={{ marginTop: space.lg }}
            />
            {/* Keyed on the lens: a SegmentedTabs switch remounts this subtree
                and the incoming chart fades in (see lensSwap). */}
            <Animated.View key={chartKind} entering={lensSwap}>
              {chartKind === 'line' ? (
                <>
                  <View style={{ marginTop: space.lg }}>
                    <MeasuredWidth
                      accessibilityLabel={`FG% trend across ${points.length} sessions, latest ${Math.round(latest * 100)} percent`}
                    >
                      {(w) => (
                        // progress opts the line into its left-to-right draw-on
                        // (static under reduced motion — see Sparkline).
                        <Sparkline data={points} width={w} height={SPARK_H} progress={1} />
                      )}
                    </MeasuredWidth>
                  </View>
                  <Row
                    style={{ justifyContent: 'space-between', marginTop: space.xs }}
                  >
                    <Text style={styles.micro}>OLDEST</Text>
                    <Text style={styles.micro}>{`${points.length} SESSIONS`}</Text>
                    <Text style={styles.micro}>LATEST</Text>
                  </Row>
                </>
              ) : (
                <>
                  <Row style={{ alignItems: 'stretch', marginTop: space.lg }} gap={space.sm}>
                    <View style={styles.axisGutter}>
                      <Text style={styles.micro}>100</Text>
                      <Text style={styles.micro}>50</Text>
                      <Text style={styles.micro}>0</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <MeasuredWidth
                        accessibilityLabel={`Bar chart of FG% for the last ${points.length} sessions`}
                      >
                        {(w) => <TrendBars data={points} width={w} height={BARS_H} />}
                      </MeasuredWidth>
                    </View>
                  </Row>
                  <Row
                    style={{ justifyContent: 'space-between', marginTop: space.xs }}
                  >
                    <Text style={styles.caption}>
                      One bar per session — the latest runs hot.
                    </Text>
                    <Text style={styles.micro}>FG%</Text>
                  </Row>
                </>
              )}
            </Animated.View>
          </Card>

          <Card entering={enter(1)}>
            <SectionEyebrow icon="stats-chart-outline" style={styles.cardKicker}>
              {`Across ${points.length} sessions`}
            </SectionEyebrow>
            <View style={styles.statGrid}>
              <View style={styles.statCell}>
                <MotionStat
                  value={Math.round(avg * 100)}
                  suffix="%"
                  size="medium"
                  label="avg FG"
                  trigger={Math.round(avg * 100)}
                />
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCell}>
                <MotionStat
                  value={Math.round(best * 100)}
                  suffix="%"
                  size="medium"
                  label="best"
                  trigger={Math.round(best * 100)}
                />
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCell}>
                <MotionStat
                  value={attempts}
                  size="medium"
                  label="attempts"
                  trigger={attempts}
                />
              </View>
            </View>
          </Card>

          {lastAngles != null && (
            <Card entering={enter(2)}>
              <SectionEyebrow icon="analytics-outline" style={styles.cardKicker}>
                Entry angles — last session
              </SectionEyebrow>
              <AngleHistogram angles={lastAngles} />
            </Card>
          )}

          {zones != null && zones.totalAttempts >= ZONE_MIN_ATTEMPTS && (
            <Card entering={enter(3)}>
              <SectionEyebrow icon="map-outline" style={styles.cardKicker}>
                {`Court zones · last ${ZONE_SESSION_SCAN} sessions`}
              </SectionEyebrow>
              <View style={{ marginTop: space.sm }}>
                <CourtHeatmap heatmap={zones} />
              </View>
              <Text style={[styles.caption, { marginTop: space.md }]}>
                {`${zones.totalMakes}/${zones.totalAttempts} placed · where you're hot and where to get up more.`}
              </Text>
            </Card>
          )}

          {lifetime != null && lifetime.sessions > 0 && (
            <Card entering={enter(4)}>
              <SectionEyebrow icon="infinite-outline" style={styles.cardKicker}>
                Lifetime
              </SectionEyebrow>
              <View style={styles.statGrid}>
                <View style={styles.statCell}>
                  <MotionStat
                    value={lifetime.sessions}
                    size="medium"
                    label="sessions"
                    trigger={lifetime.sessions}
                  />
                </View>
                <View style={styles.statDivider} />
                <View style={styles.statCell}>
                  <MotionStat
                    value={lifetime.makes}
                    size="medium"
                    label="total makes"
                    trigger={lifetime.makes}
                  />
                </View>
              </View>
            </Card>
          )}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: {
    ...type.title,
    color: color.text,
    marginBottom: space.lg,
  },
  /** Sits above the card stack, so its trailing margin IS a section gap. */
  monthCard: {
    marginBottom: layout.sectionGap,
  },
  /** Common rhythm — see `layout` in constants/tokens.ts. */
  cardStack: {
    gap: layout.sectionGap,
  },
  monthRow: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  /**
   * SectionEyebrow ships no margins (screens own rhythm); this restores the
   * space.sm the old ui.tsx Eyebrow baked in under every card kicker.
   */
  cardKicker: {
    marginBottom: space.sm,
  },
  monthText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  monthMeta: {
    ...type.heading,
    color: color.text,
  },
  caption: {
    ...type.caption,
    color: color.textDim,
    flexShrink: 1,
  },
  micro: {
    ...type.micro,
    color: color.textFaint,
    fontVariant: ['tabular-nums'],
  },
  /** Emphasized hero numeral — broadcast display face, between statLarge and scoreboard. */
  heroValue: {
    fontFamily: font.display,
    fontSize: 72,
    lineHeight: 76,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  heroLabel: {
    ...type.micro,
    color: color.textFaint,
    marginTop: 2,
  },
  trendChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  trendChipLabel: {
    ...type.caption,
  },
  /** Y-axis labels beside the bar canvas, pinned to the 100/50/0 gridlines. */
  axisGutter: {
    height: BARS_H,
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    paddingBottom: 1,
  },
  statGrid: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
    marginVertical: space.xs,
  },
});
