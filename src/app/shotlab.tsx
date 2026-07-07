/**
 * Shot Lab — the deep-analysis screen: what separates your makes from your
 * misses, how your shooting profile compares to NBA references, which pro
 * your jumper resembles, a prioritized coach's plan with drills, and your
 * pose at the release instant.
 *
 * Works on the LIVE session (no param) or any HISTORY session (?sid=<rowId>).
 * Every section degrades gracefully: metrics that need the pose model explain
 * how to enable it, and small samples render means without statistical claims.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { FadeInDown } from 'react-native-reanimated';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { shareTwinCard } from '@/components/ShareCard';
import { BackPill } from '@/components/ShotList';
import { ArcCompare } from '@/components/charts/ArcCompare';
import { MetricDiffRow } from '@/components/charts/MetricDiffRow';
import { RadarChart } from '@/components/charts/RadarChart';
import { ReleaseSkeleton } from '@/components/charts/ReleaseSkeleton';
import { Card, Chip, EmptyState, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, space, type } from '@/constants/tokens';
import { sessionShots, shotFromRow } from '@/data/db';
import {
  coachPlan,
  makeMissReport,
  matchArchetype,
  normalizedArcs,
  radarScores,
} from '@/core/shotLab';
import type { ResolvedShot } from '@/core/types';
import { useSession } from '@/state/sessionStore';
import { useSettings } from '@/state/settingsStore';

/** Staggered card entrance (i = card index top-to-bottom). */
const cardEnter = (i: number) => FadeInDown.delay(i * 70).duration(380);

export default function ShotLabScreen() {
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  const { width } = useWindowDimensions();
  const hand = useSettings((s) => s.shootingHand);

  // Live-session shots (used when no sid param).
  const liveEntries = useSession((s) => s.shots);
  const liveShots = useMemo(() => liveEntries.map((e) => e.shot), [liveEntries]);

  // History-session shots (loaded async when sid is present).
  const [historyShots, setHistoryShots] = useState<ResolvedShot[] | null>(null);
  const historyId = sid != null ? Number(sid) : null;
  useEffect(() => {
    if (historyId == null || !Number.isFinite(historyId)) return;
    let alive = true;
    void sessionShots(historyId).then((rows) => {
      if (alive) setHistoryShots(rows.map(shotFromRow));
    });
    return () => {
      alive = false;
    };
  }, [historyId]);

  const shots = historyId != null ? (historyShots ?? []) : liveShots;
  const loading = historyId != null && historyShots == null;

  // All analytics are pure + memoized off the shot array.
  const report = useMemo(() => makeMissReport(shots), [shots]);
  const arcs = useMemo(() => normalizedArcs(shots), [shots]);
  const radar = useMemo(() => radarScores(shots), [shots]);
  const archetypes = useMemo(() => matchArchetype(shots), [shots]);
  const plan = useMemo(() => coachPlan(shots), [shots]);
  const releaseShot = useMemo(() => {
    const withPose = shots.filter((s) => s.form?.releasePose != null);
    return withPose.find((s) => s.outcome === 'make') ?? withPose[0] ?? null;
  }, [shots]);

  const chartW = Math.min(width - 76, 560);
  const decided = report.makes + report.misses;
  const anyPose = shots.some((s) => s.form != null);
  const best = archetypes[0];

  return (
    <Screen scroll>
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.stack}>
          <Row style={styles.header}>
            <BackPill />
          </Row>
          <Text style={styles.title} accessibilityRole="header">
            Shot Lab
          </Text>

          {loading ? (
            <Text style={styles.dim}>Loading session…</Text>
          ) : decided === 0 ? (
            <EmptyState
              title="No decided shots yet"
              body="Track a session with a few makes and misses, then come back — Shot Lab compares the two to find what actually changes your shot."
              actionLabel="Back"
              onAction={() => router.back()}
            />
          ) : (
            <>
              {/* Verdict hero */}
              <Card entering={cardEnter(0)}>
                <Eyebrow>The verdict</Eyebrow>
                <Row gap={space.md} style={{ marginTop: space.sm }}>
                  <Chip label={`${report.makes} makes`} tone="make" />
                  <Chip label={`${report.misses} misses`} tone="miss" />
                </Row>
                <Text style={styles.headline}>
                  {report.headline ??
                    (decided < 6
                      ? 'Keep shooting — differences become statistically real around 6+ makes and misses.'
                      : 'No single habit separates your makes from your misses yet — your form is consistent; keep grooving it.')}
                </Text>
              </Card>

              {/* Arc overlay */}
              {arcs.length >= 2 && (
                <Card entering={cardEnter(1)}>
                  <Eyebrow>Ball flight — makes vs misses</Eyebrow>
                  <View style={{ marginTop: space.sm }}>
                    <ArcCompare
                      arcs={arcs}
                      width={chartW}
                      height={190}
                      accessibilityLabel="Overlay of every shot's flight arc, makes versus misses"
                    />
                  </View>
                  <Text style={styles.caption}>
                    Every tracked flight, normalized release→rim. Bold lines are each
                    group's average arc.
                  </Text>
                </Card>
              )}

              {/* Make vs miss metric table */}
              <Card entering={cardEnter(2)}>
                <Eyebrow>What separates your makes</Eyebrow>
                {report.splits.map((split) => (
                  <MetricDiffRow key={split.def.key} split={split} />
                ))}
                {!anyPose && (
                  <Text style={styles.caption}>
                    Turn on Settings › Coaching › Shooting form analysis to unlock the
                    body-mechanics rows (elbow, knees, release time).
                  </Text>
                )}
              </Card>

              {/* Radar vs NBA */}
              <Card entering={cardEnter(3)}>
                <Eyebrow>You vs the NBA</Eyebrow>
                <View style={{ alignItems: 'center', marginTop: space.sm }}>
                  <RadarChart
                    scores={radar}
                    size={Math.min(chartW, 320)}
                    accessibilityLabel="Radar chart of your shooting profile against NBA average and elite references"
                  />
                </View>
                <Row gap={space.md} style={{ marginTop: space.sm, flexWrap: 'wrap' }}>
                  <Row gap={space.xs}>
                    <View style={[styles.legendSwatch, { backgroundColor: color.accent }]} />
                    <Text style={styles.caption}>you</Text>
                  </Row>
                  <Row gap={space.xs}>
                    <View style={[styles.legendSwatch, styles.legendOutline]} />
                    <Text style={styles.caption}>NBA avg</Text>
                  </Row>
                  <Row gap={space.xs}>
                    <View style={[styles.legendSwatch, { backgroundColor: color.surfaceRaised }]} />
                    <Text style={styles.caption}>elite</Text>
                  </Row>
                </Row>
                <Text style={styles.caption}>
                  NBA reference values are estimates from public shooting research
                  (Noah arc studies, reported release times).
                </Text>
              </Card>

              {/* Archetype */}
              {best && best.similarity > 40 && (
                <Card entering={cardEnter(4)}>
                  <Eyebrow>Your NBA twin</Eyebrow>
                  <Row gap={space.md} style={{ marginTop: space.sm, alignItems: 'baseline' }}>
                    <Text style={styles.archetypeName}>{best.player.name}</Text>
                    <Text style={styles.similarity}>{best.similarity}% match</Text>
                  </Row>
                  <Row gap={space.sm} style={{ marginTop: space.xs, flexWrap: 'wrap' }}>
                    <Chip label={best.player.style} tone="accent" />
                    <Chip label={best.player.motion} />
                    <Chip label={`release ~${best.player.releaseHeightM.toFixed(1)}m`} />
                  </Row>
                  <Text style={styles.body}>{best.player.mechanics}</Text>
                  <View style={{ marginTop: space.md, gap: space.xs }}>
                    {best.rows.map((r) => (
                      <Row key={r.key} gap={space.md}>
                        <Text style={[styles.caption, { flex: 1 }]}>{r.label}</Text>
                        <Text style={styles.compareVal}>
                          you {r.user.toFixed(0)}
                          {r.unit}
                        </Text>
                        <Text style={styles.compareVal}>
                          him {r.player.toFixed(0)}
                          {r.unit}
                        </Text>
                      </Row>
                    ))}
                  </View>
                  <Text style={styles.sectionLabel}>Steal this</Text>
                  {best.player.whatToCopy.map((c) => (
                    <Text key={c} style={styles.bullet}>
                      {'•'} {c}
                    </Text>
                  ))}
                  <Text style={styles.sectionLabel}>His thing — not yours</Text>
                  {best.player.idiosyncratic.map((c) => (
                    <Text key={c} style={[styles.bullet, { color: color.textFaint }]}>
                      {'•'} {c}
                    </Text>
                  ))}
                  {archetypes.length > 1 && (
                    <Row gap={space.sm} style={{ marginTop: space.md, flexWrap: 'wrap' }}>
                      {archetypes.slice(1, 3).map((m) => (
                        <Chip key={m.player.name} label={`${m.player.name} ${m.similarity}%`} />
                      ))}
                    </Row>
                  )}
                  <PillButton
                    label="Share my NBA twin"
                    icon="logo-instagram"
                    onPress={() => {
                      void shareTwinCard(best);
                    }}
                    style={{ marginTop: space.md }}
                  />
                  <Text style={styles.caption}>
                    Player numbers are estimates compiled from public shooting analyses
                    (ESPN Sport Science, Noah arc research, coaching film), normalized to
                    this app's measurements — references, not lab data.
                  </Text>
                </Card>
              )}

              {/* Coach plan */}
              <Card entering={cardEnter(5)}>
                <Eyebrow>Coach's plan</Eyebrow>
                {plan.length === 0 ? (
                  <Text style={styles.body}>
                    {decided < 4
                      ? 'A few more decided shots and the coach will have enough to work with.'
                      : 'Nothing systematic to fix — your measured habits sit inside the ideal bands. Volume and consistency from here.'}
                  </Text>
                ) : (
                  plan.map((focus, i) => (
                    <View key={focus.def.key} style={styles.planItem}>
                      <Row gap={space.sm}>
                        <Text style={styles.planIndex}>{i + 1}</Text>
                        <Text style={styles.planTitle}>{focus.title}</Text>
                      </Row>
                      <Text style={styles.body}>{focus.dataLine}</Text>
                      <Text style={styles.drill}>Drill: {focus.drill}</Text>
                      <Text style={styles.target}>{focus.targetLine}</Text>
                    </View>
                  ))
                )}
              </Card>

              {/* Release snapshot */}
              {releaseShot?.form?.releasePose && (
                <Card entering={cardEnter(6)}>
                  <Eyebrow>Release snapshot</Eyebrow>
                  <View style={{ alignItems: 'center', marginTop: space.sm }}>
                    <ReleaseSkeleton
                      pose={releaseShot.form.releasePose}
                      hand={hand}
                      elbowDeg={releaseShot.form.metrics.followThroughElbowDeg}
                      kneeDeg={releaseShot.form.metrics.kneeFlexionDeg}
                      width={Math.min(chartW, 300)}
                      height={240}
                    />
                  </View>
                  <Text style={styles.caption}>
                    Your body at the instant the ball left your hand
                    {releaseShot.outcome === 'make' ? ' (a make)' : ''} — shooting arm
                    highlighted.
                  </Text>
                </Card>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  header: {
    marginBottom: space.sm,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  dim: {
    ...type.body,
    color: color.textDim,
  },
  headline: {
    ...type.heading,
    color: color.text,
    marginTop: space.md,
  },
  caption: {
    ...type.caption,
    color: color.textFaint,
    marginTop: space.sm,
  },
  body: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  legendSwatch: {
    width: 10,
    height: 10,
    borderRadius: 3,
  },
  legendOutline: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: color.textFaint,
  },
  archetypeName: {
    ...type.statMedium,
    color: color.text,
  },
  similarity: {
    ...type.bodyMedium,
    color: color.accent,
  },
  archetypeStyle: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
  },
  compareVal: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    minWidth: 64,
    textAlign: 'right',
  },
  sectionLabel: {
    ...type.bodyMedium,
    color: color.text,
    marginTop: space.md,
  },
  bullet: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  planItem: {
    marginTop: space.md,
    gap: space.xs,
  },
  planIndex: {
    ...type.heading,
    color: color.accent,
  },
  planTitle: {
    ...type.heading,
    color: color.text,
  },
  drill: {
    ...type.body,
    color: color.text,
    marginTop: space.xs,
  },
  target: {
    ...type.caption,
    color: color.accent,
  },
});
