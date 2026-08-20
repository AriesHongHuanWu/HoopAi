/**
 * ArcProfileCard — the average DETECTED entry angle across the coach window,
 * a flat / ideal / steep split bar, and a one-line coach read.
 *
 * Presentational only: numbers come from arcProfile()
 * (src/core/coachInsights.ts), which grades against the SAME band as the live
 * HUD (ARC_ENTRY_IDEAL_MIN–MAX in src/components/hud/arcHudGeometry.ts), so
 * this card can never disagree with the on-court readout. Copy stays inside
 * the honesty line: these are entry angles the camera DETECTED — never a
 * claim about shots the tracker missed, and never a judgment input.
 *
 * The split bar is color + text (legend carries the percentages), never color
 * alone (colorblind rule). Below MIN_ARCS detected arcs the card renders a
 * compact charging state instead of an average that would just be noise.
 */
import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import {
  ARC_ENTRY_IDEAL_MAX,
  ARC_ENTRY_IDEAL_MIN,
} from '@/components/hud/arcHudGeometry';
import { Card, Row, StatNumber } from '@/components/ui';
import { color, radius, space, type } from '@/constants/tokens';
import type { ArcProfile } from '@/core/coachInsights';

type IconName = ComponentProps<typeof Ionicons>['name'];

/** Minimum detected arcs before the average is worth showing. */
const MIN_ARCS = 5;

/** Local replica of coach.tsx's SectionEyebrow (the screen doesn't export it). */
function SectionEyebrow({ icon, children }: { icon: IconName; children: string }) {
  return (
    <Row gap={6} style={styles.eyebrowRow}>
      <Ionicons name={icon} size={12} color={color.accent} />
      <Text style={styles.eyebrowText}>{children.toUpperCase()}</Text>
    </Row>
  );
}

/** One-line coach read off the dominant band; ties lean ideal — keep it kind. */
function coachRead(flatPct: number, idealPct: number, steepPct: number): string {
  if (idealPct >= flatPct && idealPct >= steepPct) {
    return (
      `Most of your detected arcs drop in at ${ARC_ENTRY_IDEAL_MIN}–` +
      `${ARC_ENTRY_IDEAL_MAX}° — keep grooving that stroke.`
    );
  }
  if (flatPct >= steepPct) {
    return 'Your arc runs flat — add legs, aim just over the back rim.';
  }
  return 'Your arc runs steep — soften the rainbow and drive the ball forward, not just up.';
}

export function ArcProfileCard({
  profile,
  entering,
}: {
  profile: ArcProfile;
  entering?: ComponentProps<typeof Card>['entering'];
}) {
  if (profile.n < MIN_ARCS) {
    const body =
      profile.n === 0
        ? 'No detected arcs yet. This card charges up as the camera reads entry angles off your tracked shots.'
        : `${profile.n} of ${MIN_ARCS} detected arcs so far — this card charges up as tracked shots accrue.`;
    return (
      <Card entering={entering}>
        <SectionEyebrow icon="analytics-outline">Arc profile</SectionEyebrow>
        <Text style={styles.emptyBody} accessibilityLabel={`Arc profile: ${body}`}>
          {body}
        </Text>
      </Card>
    );
  }

  // n >= MIN_ARCS guarantees every aggregate is non-null.
  const avg = Math.round(profile.avgEntryDeg!);
  const flatPct = profile.flatPct!;
  const idealPct = profile.idealPct!;
  const steepPct = profile.steepPct!;
  const read = coachRead(flatPct, idealPct, steepPct);

  // Low angle → high angle, left to right. flat = miss-warm, ideal =
  // make-teal, steep = unsure-chalk (all from tokens).
  const segments = [
    { key: 'flat', label: 'Flat', pct: flatPct, fill: color.miss },
    { key: 'ideal', label: 'Ideal', pct: idealPct, fill: color.make },
    { key: 'steep', label: 'Steep', pct: steepPct, fill: color.unsure },
  ];

  const a11y =
    `Arc profile from ${profile.n} detected shots: average entry angle ${avg} degrees. ` +
    segments
      .map((s) => `${Math.round(s.pct * 100)} percent ${s.label.toLowerCase()}`)
      .join(', ') +
    `. ${read}`;

  return (
    <Card entering={entering}>
      <SectionEyebrow icon="analytics-outline">Arc profile</SectionEyebrow>

      <View accessible accessibilityLabel={a11y}>
        <StatNumber value={`${avg}°`} label="avg entry (detected)" size="large" />
        <Text style={styles.sub}>
          {profile.n} detected arcs · ideal entry {ARC_ENTRY_IDEAL_MIN}–
          {ARC_ENTRY_IDEAL_MAX}°
        </Text>

        <View style={styles.bar}>
          {segments.map(
            (s) =>
              s.pct > 0 && (
                <View key={s.key} style={{ flex: s.pct, backgroundColor: s.fill }} />
              ),
          )}
        </View>

        <View style={styles.legend}>
          {segments.map((s) => (
            <Row key={s.key} gap={4}>
              <View style={[styles.swatch, { backgroundColor: s.fill }]} />
              <Text style={styles.legendText}>
                {s.label} {Math.round(s.pct * 100)}%
              </Text>
            </Row>
          ))}
        </View>

        <Text style={styles.read}>{read}</Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  eyebrowRow: {
    marginBottom: space.sm,
  },
  eyebrowText: {
    ...type.caption,
    color: color.textFaint,
    letterSpacing: 1,
  },
  emptyBody: {
    ...type.body,
    color: color.textDim,
  },
  sub: {
    ...type.caption,
    color: color.textFaint,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
    marginTop: space.xs,
  },
  bar: {
    flexDirection: 'row',
    height: 10,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceRaised,
    overflow: 'hidden',
    marginTop: space.lg,
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.sm,
  },
  swatch: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  legendText: {
    ...type.micro,
    color: color.textDim,
    fontVariant: ['tabular-nums'],
  },
  read: {
    ...type.body,
    color: color.textDim,
    marginTop: space.md,
  },
});
