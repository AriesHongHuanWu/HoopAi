/**
 * FormReportCard — pose-based shooting-form report for one shot.
 *
 * Leads with the top coaching cue (the severity-3 "fix this first" tip, when
 * present) in a leather-accented callout, then lists every FormMetrics row
 * with its value colored by whether it falls inside its optimal band (see
 * FORM in src/core/config.ts). Null metrics render a quiet em dash rather
 * than being hidden, so the shape of the report stays constant shot to shot.
 *
 * Tokens only, tabular-nums for all numerals, reduced-motion aware (the
 * entrance fade is skipped under the system setting), and every value row
 * carries an accessibility label pairing the metric name with its verdict.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { color, motion, radius, space, type } from '../constants/tokens';
import { FORM } from '../core/config';
import type { CoachingTip, FormMetrics, FormReport } from '../core/types';

// ---------------------------------------------------------------------------
// Band evaluation
// ---------------------------------------------------------------------------

type Verdict = 'good' | 'bad' | 'neutral';

interface Row {
  key: keyof FormMetrics;
  label: string;
  format: (metrics: FormMetrics) => string | null;
  verdict: (metrics: FormMetrics) => Verdict;
  bandHint: string;
}

function inBand(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

const ROWS: Row[] = [
  {
    key: 'setPointElbowDeg',
    label: 'Elbow set point',
    format: (m) => (m.setPointElbowDeg != null ? `${Math.round(m.setPointElbowDeg)}°` : null),
    verdict: (m) =>
      m.setPointElbowDeg == null
        ? 'neutral'
        : inBand(m.setPointElbowDeg, FORM.elbowSetPoint.min, FORM.elbowSetPoint.max)
          ? 'good'
          : 'bad',
    bandHint: `${FORM.elbowSetPoint.min}–${FORM.elbowSetPoint.max}°`,
  },
  {
    key: 'kneeFlexionDeg',
    label: 'Knee flexion',
    format: (m) => (m.kneeFlexionDeg != null ? `${Math.round(m.kneeFlexionDeg)}°` : null),
    verdict: (m) =>
      m.kneeFlexionDeg == null
        ? 'neutral'
        : inBand(m.kneeFlexionDeg, FORM.kneeFlexion.min, FORM.kneeFlexion.max)
          ? 'good'
          : 'bad',
    bandHint: `${FORM.kneeFlexion.min}–${FORM.kneeFlexion.max}°`,
  },
  {
    key: 'releaseAngleDeg',
    label: 'Release angle',
    format: (m) => (m.releaseAngleDeg != null ? `${Math.round(m.releaseAngleDeg)}°` : null),
    verdict: (m) =>
      m.releaseAngleDeg == null
        ? 'neutral'
        : inBand(m.releaseAngleDeg, FORM.releaseAngle.min, FORM.releaseAngle.max)
          ? 'good'
          : 'bad',
    bandHint: `${FORM.releaseAngle.min}–${FORM.releaseAngle.max}°`,
  },
  {
    key: 'entryAngleDeg',
    label: 'Entry angle',
    format: (m) => (m.entryAngleDeg != null ? `${Math.round(m.entryAngleDeg)}°` : null),
    verdict: (m) =>
      m.entryAngleDeg == null
        ? 'neutral'
        : inBand(m.entryAngleDeg, FORM.entryAngle.min, FORM.entryAngle.max)
          ? 'good'
          : 'bad',
    bandHint: `${FORM.entryAngle.min}–${FORM.entryAngle.max}°`,
  },
  {
    key: 'releaseTimeMs',
    label: 'Release time',
    format: (m) => (m.releaseTimeMs != null ? `${(m.releaseTimeMs / 1000).toFixed(2)}s` : null),
    verdict: (m) =>
      m.releaseTimeMs == null
        ? 'neutral'
        : m.releaseTimeMs <= FORM.releaseTime.typical * 1000
          ? 'good'
          : 'bad',
    bandHint: `under ${FORM.releaseTime.typical.toFixed(1)}s`,
  },
  {
    key: 'followThroughHeldMs',
    label: 'Follow-through hold',
    format: (m) => (m.followThroughHeldMs != null ? `${Math.round(m.followThroughHeldMs)}ms` : null),
    verdict: (m) =>
      m.followThroughHeldMs == null
        ? 'neutral'
        : m.followThroughHeldMs >= FORM.followThrough.holdSec * 1000
          ? 'good'
          : 'bad',
    bandHint: `${Math.round(FORM.followThrough.holdSec * 1000)}ms+`,
  },
];

const VERDICT_COLOR: Record<Verdict, string> = {
  good: color.make,
  bad: color.accent,
  neutral: color.textFaint,
};

const VERDICT_WORD: Record<Verdict, string> = {
  good: 'in range',
  bad: 'out of range',
  neutral: 'not measured',
};

// ---------------------------------------------------------------------------
// Top cue callout
// ---------------------------------------------------------------------------

function topTip(tips: readonly CoachingTip[]): CoachingTip | null {
  const headline = tips.find((t) => t.severity === 3);
  if (headline != null) return headline;
  return tips.length > 0 ? tips[0]! : null;
}

function TopCue({ tip }: { tip: CoachingTip }) {
  return (
    <View
      style={styles.cue}
      accessible
      accessibilityLabel={`Top cue: ${tip.title}. ${tip.message}`}
    >
      <Text style={styles.cueEyebrow}>Fix this first</Text>
      <Text style={styles.cueTitle}>{tip.title}</Text>
      <Text style={styles.cueMessage}>{tip.message}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Metric row
// ---------------------------------------------------------------------------

/**
 * Verdict glyph shown ahead of the metric value — the same colorblind-safe
 * color + SHAPE convention as MakeMissDot: a filled check for in-range, a
 * warning triangle for out-of-range, nothing for not-measured.
 */
function VerdictGlyph({ verdict }: { verdict: Verdict }) {
  if (verdict === 'good') {
    return (
      <Text style={[styles.verdictGlyph, { color: VERDICT_COLOR.good }]}>✓</Text>
    );
  }
  if (verdict === 'bad') {
    return (
      <Text style={[styles.verdictGlyph, { color: VERDICT_COLOR.bad }]}>▲</Text>
    );
  }
  return null;
}

function MetricRow({ row, metrics }: { row: Row; metrics: FormMetrics }) {
  const display = row.format(metrics);
  const verdict = display == null ? 'neutral' : row.verdict(metrics);
  return (
    <View
      style={styles.metricRow}
      accessible
      accessibilityLabel={
        display != null
          ? `${row.label}: ${display}, ${VERDICT_WORD[verdict]}. Optimal ${row.bandHint}.`
          : `${row.label}: not measured.`
      }
    >
      <View style={styles.metricLabelWrap}>
        <Text style={styles.metricLabel}>{row.label}</Text>
        <Text style={styles.metricBand}>{row.bandHint}</Text>
      </View>
      <View style={styles.metricValueRow}>
        <VerdictGlyph verdict={verdict} />
        <Text style={[styles.metricValue, { color: VERDICT_COLOR[verdict] }]}>
          {display ?? '—'}
        </Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------

function Legend() {
  return (
    <View
      style={styles.legend}
      accessible
      accessibilityLabel="Legend: check mark, green, means in the optimal range. Triangle, orange, means outside it. Dash means not measured."
    >
      <View style={styles.legendItem}>
        <VerdictGlyph verdict="good" />
        <Text style={styles.legendLabel}>In range</Text>
      </View>
      <View style={styles.legendItem}>
        <VerdictGlyph verdict="bad" />
        <Text style={styles.legendLabel}>Out of range</Text>
      </View>
      <View style={styles.legendItem}>
        <Text style={[styles.legendDot, styles.legendDash]}>—</Text>
        <Text style={styles.legendLabel}>Not measured</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// FormReportCard
// ---------------------------------------------------------------------------

export function FormReportCard({ report }: { report: FormReport }) {
  const reducedMotion = useReducedMotion();
  const tip = topTip(report.tips);

  const content = (
    <View
      style={styles.card}
      accessibilityRole="summary"
      accessibilityLabel="Shooting form report"
    >
      {tip != null && <TopCue tip={tip} />}
      <View style={styles.metrics}>
        {ROWS.map((row, i) => (
          <View key={row.key}>
            {i > 0 && <View style={styles.divider} />}
            <MetricRow row={row} metrics={report.metrics} />
          </View>
        ))}
      </View>
      <Legend />
    </View>
  );

  if (reducedMotion) return content;
  return <Animated.View entering={FadeIn.duration(motion.quick)}>{content}</Animated.View>;
}

// ---------------------------------------------------------------------------

const styles = StyleSheet.create({
  card: {
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    padding: space.lg,
    gap: space.md,
  },
  cue: {
    backgroundColor: color.accentTint,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.accent,
    padding: space.md,
    gap: 2,
  },
  cueEyebrow: {
    ...type.micro,
    color: color.accent,
  },
  cueTitle: {
    ...type.heading,
    color: color.text,
  },
  cueMessage: {
    ...type.body,
    color: color.textDim,
  },
  metrics: {
    gap: 0,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: space.sm,
    gap: space.md,
  },
  metricLabelWrap: {
    flex: 1,
    gap: 1,
  },
  metricLabel: {
    ...type.bodyMedium,
    color: color.text,
  },
  metricBand: {
    ...type.micro,
    color: color.textFaint,
  },
  metricValueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  metricValue: {
    ...type.bodyMedium,
    fontVariant: ['tabular-nums'],
  },
  verdictGlyph: {
    fontSize: 13,
    lineHeight: 16,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.border,
  },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.md,
    marginTop: space.xs,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendDash: {
    ...type.micro,
    width: 8,
    height: 8,
    lineHeight: 8,
    textAlign: 'center',
    color: color.textFaint,
  },
  legendLabel: {
    ...type.micro,
    color: color.textFaint,
  },
});
