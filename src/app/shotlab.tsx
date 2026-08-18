/**
 * Shot Lab — the deep-analysis screen: what separates your makes from your
 * misses, how your shooting profile compares to NBA references, which pro
 * your jumper resembles, a prioritized coach's plan with drills, and your
 * pose at the release instant.
 *
 * Works on the LIVE session (no param) or any HISTORY session (?sid=<rowId>).
 * Every section degrades gracefully: metrics that need the pose model explain
 * how to enable it, and small samples render means without statistical claims.
 *
 * Presentation: cards stagger in top-to-bottom (skipped under reduced
 * motion), every section opens with an icon eyebrow, and the NBA-twin card
 * ends in a hero share treatment.
 */
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { FadeInDown, useReducedMotion } from 'react-native-reanimated';
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { shareTwinCard } from '@/components/ShareCard';
import { BackPill } from '@/components/ShotList';
import { ArcCompare } from '@/components/charts/ArcCompare';
import { MetricDiffRow } from '@/components/charts/MetricDiffRow';
import { RadarChart } from '@/components/charts/RadarChart';
import { ReleaseSkeleton } from '@/components/charts/ReleaseSkeleton';
import { Card, Chip, EmptyState, PillButton, Row, Screen } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
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

/** Section eyebrow: small accent glyph + tracked caption. */
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

export default function ShotLabScreen() {
  const { sid } = useLocalSearchParams<{ sid?: string }>();
  const { width } = useWindowDimensions();
  const hand = useSettings((s) => s.shootingHand);
  const reducedMotion = useReducedMotion();

  /** Staggered card entrance (i = card index top-to-bottom); off under reduced motion. */
  const cardEnter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.delay(i * 70).duration(380);

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
      <View style={styles.stack}>
        <Row style={styles.header}>
          <BackPill />
          <PillButton label="Coach's Corner" icon="school" variant="ghost" onPress={() => router.dismissTo('/coach')} style={styles.coachPill} />
        </Row>
        <View>
          <Text style={styles.kicker}>ANALYSIS ROOM</Text>
          <Text style={styles.title} accessibilityRole="header">
            Shot Lab
          </Text>
        </View>

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
              <SectionEyebrow icon="pulse">The verdict</SectionEyebrow>
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
                <SectionEyebrow icon="trending-up">Ball flight — makes vs misses</SectionEyebrow>
                <View style={{ marginTop: space.sm }}>
                  <ArcCompare
                    arcs={arcs}
                    width={chartW}
                    height={210}
                    accessibilityLabel="Overlay of every shot's flight arc, makes versus misses, with an NBA-average launch reference"
                  />
                </View>
                <Text style={styles.caption}>
                  Every tracked flight, normalized release→rim. Bold lines are each
                  group's average arc; the dashed curve is an NBA-average launch over
                  the same span.
                </Text>
              </Card>
            )}

            {/* Make vs miss metric table */}
            <Card entering={cardEnter(2)}>
              <SectionEyebrow icon="git-compare-outline">What separates your makes</SectionEyebrow>
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
              <SectionEyebrow icon="aperture-outline">You vs the NBA</SectionEyebrow>
              <View style={{ alignItems: 'center', marginTop: space.sm }}>
                <RadarChart
                  scores={radar}
                  size={Math.min(chartW, 320)}
                  accessibilityLabel="Radar chart of your shooting profile against NBA average and elite references"
                />
              </View>
              <Text style={styles.caption}>
                NBA reference values are estimates from public shooting research
                (Noah arc studies, reported release times).
              </Text>
            </Card>

            {/* Archetype */}
            {best && best.similarity > 40 && (
              <Card entering={cardEnter(4)}>
                <SectionEyebrow icon="people">Your NBA twin</SectionEyebrow>
                <Row gap={space.md} style={{ marginTop: space.sm, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <Text style={styles.archetypeName}>{best.player.name}</Text>
                  <Row gap={4} style={{ alignItems: 'baseline' }}>
                    <Text style={styles.similarityNum}>{best.similarity}%</Text>
                    <Text style={styles.similarityLabel}>MATCH</Text>
                  </Row>
                </Row>
                <Row gap={space.sm} style={{ marginTop: space.xs, flexWrap: 'wrap' }}>
                  <Chip label={best.player.style} tone="accent" />
                  <Chip label={best.player.motion} />
                  <Chip label={`release ~${best.player.releaseHeightM.toFixed(1)}m`} />
                </Row>
                <Text style={styles.body}>{best.player.mechanics}</Text>
                <View style={{ marginTop: space.md, gap: space.xs }}>
                  <Row gap={space.md}>
                    <View style={{ flex: 1 }} />
                    <Text style={styles.colHead}>YOU</Text>
                    <Text style={styles.colHead}>HIM</Text>
                  </Row>
                  {best.rows.map((r) => (
                    <Row key={r.key} gap={space.md}>
                      <Text style={[styles.rowLabel, { flex: 1 }]}>{r.label}</Text>
                      <Text style={[styles.compareVal, { color: color.text }]}>
                        {r.user.toFixed(0)}
                        {r.unit}
                      </Text>
                      <Text style={styles.compareVal}>
                        {r.player.toFixed(0)}
                        {r.unit}
                      </Text>
                    </Row>
                  ))}
                </View>
                <Row gap={6} style={styles.sectionLabelRow}>
                  <Ionicons name="download-outline" size={13} color={color.accent} />
                  <Text style={styles.sectionLabel}>Steal this</Text>
                </Row>
                {best.player.whatToCopy.map((c) => (
                  <Text key={c} style={styles.bullet}>
                    <Text style={{ color: color.accent }}>▸ </Text>
                    {c}
                  </Text>
                ))}
                <Row gap={6} style={styles.sectionLabelRow}>
                  <Ionicons name="finger-print" size={13} color={color.textFaint} />
                  <Text style={styles.sectionLabel}>His thing — not yours</Text>
                </Row>
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
                {/* Share hero — the card's payoff moment. */}
                <View style={styles.ctaPanel}>
                  <Text style={styles.ctaKicker}>SHOW IT OFF</Text>
                  <Text style={styles.ctaLine}>
                    Put your {best.similarity}% {best.player.name} match on your story.
                  </Text>
                  <PillButton
                    label="Share my NBA twin"
                    icon="logo-instagram"
                    onPress={() => {
                      void shareTwinCard(best);
                    }}
                    style={styles.ctaButton}
                  />
                </View>
                <Text style={styles.caption}>
                  Player numbers are estimates compiled from public shooting analyses
                  (ESPN Sport Science, Noah arc research, coaching film), normalized to
                  this app's measurements — references, not lab data.
                </Text>
              </Card>
            )}

            {/* Coach plan */}
            <Card entering={cardEnter(5)}>
              <SectionEyebrow icon="clipboard-outline">Coach's plan</SectionEyebrow>
              {plan.length === 0 ? (
                <Text style={styles.body}>
                  {decided < 4
                    ? 'A few more decided shots and the coach will have enough to work with.'
                    : 'Nothing systematic to fix — your measured habits sit inside the ideal bands. Volume and consistency from here.'}
                </Text>
              ) : (
                plan.map((focus, i) => (
                  <View key={focus.def.key} style={[styles.planItem, i > 0 && styles.planItemDivider]}>
                    <Row gap={space.sm}>
                      <View style={styles.planBadge}>
                        <Text style={styles.planBadgeText}>{i + 1}</Text>
                      </View>
                      <Text style={[styles.planTitle, { flex: 1 }]}>{focus.title}</Text>
                    </Row>
                    <Text style={styles.body}>{focus.dataLine}</Text>
                    <Row gap={space.xs} style={{ alignItems: 'flex-start' }}>
                      <Ionicons
                        name="basketball-outline"
                        size={13}
                        color={color.accent}
                        style={{ marginTop: 3 }}
                      />
                      <Text style={[styles.drill, { flex: 1 }]}>Drill: {focus.drill}</Text>
                    </Row>
                    <Text style={styles.target}>{focus.targetLine}</Text>
                  </View>
                ))
              )}
            </Card>

            {/* Release snapshot */}
            {releaseShot?.form?.releasePose && (
              <Card entering={cardEnter(6)}>
                <SectionEyebrow icon="body-outline">Release snapshot</SectionEyebrow>
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
    justifyContent: 'space-between',
  },
  coachPill: {
    minHeight: 40,
    paddingHorizontal: space.lg,
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
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  headline: {
    ...type.heading,
    fontSize: 18,
    lineHeight: 25,
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
  archetypeName: {
    ...type.statMedium,
    color: color.text,
  },
  similarityNum: {
    fontFamily: font.display,
    fontSize: 28,
    lineHeight: 30,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  similarityLabel: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
  },
  colHead: {
    ...type.micro,
    color: color.textFaint,
    letterSpacing: 1,
    minWidth: 64,
    textAlign: 'right',
  },
  rowLabel: {
    ...type.caption,
    color: color.textFaint,
  },
  compareVal: {
    ...type.caption,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
    minWidth: 64,
    textAlign: 'right',
  },
  sectionLabelRow: {
    marginTop: space.md,
  },
  sectionLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
  bullet: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  ctaPanel: {
    marginTop: space.lg,
    backgroundColor: color.accentTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(240, 90, 36, 0.45)',
    borderRadius: radius.md,
    padding: space.md,
  },
  ctaKicker: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1.4,
  },
  ctaLine: {
    ...type.body,
    color: color.text,
    marginTop: space.xs,
  },
  ctaButton: {
    marginTop: space.md,
    alignSelf: 'stretch',
  },
  planItem: {
    marginTop: space.md,
    gap: space.xs,
  },
  planItemDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingTop: space.md,
  },
  planBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planBadgeText: {
    fontFamily: font.display,
    fontSize: 15,
    lineHeight: 18,
    color: color.accent,
  },
  planTitle: {
    ...type.heading,
    color: color.text,
  },
  drill: {
    ...type.body,
    color: color.text,
  },
  target: {
    ...type.caption,
    color: color.accent,
  },
});
