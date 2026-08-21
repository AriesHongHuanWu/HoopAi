/**
 * FindingCard — one ranked coach finding: severity chip + trend pill, the
 * finding in the user's OWN evidence numbers, and the prescription chip.
 *
 * Extracted 1:1 from coach.tsx (the screen was carrying four inline
 * components); the severity/trend visual language moved with it because this
 * card is its only consumer.
 *
 * When the week's plan actually contains this finding's drill, the screen
 * passes `onDrillThis` and the card appends a compact "Drill this" row
 * (accent caption + chevron — the same idiom as the plan item's Practice
 * link). The bridge is only offered for findings the plan REALLY maps to a
 * drill — an unmapped finding never invents one (honesty contract).
 */
import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useCardStagger } from '@/components/motion';
import { Row } from '@/components/ui';
import { color, font, radius, space, type } from '@/constants/tokens';
import { haptic } from '@/utils/haptics';
import type { CoachFinding, Severity, Trend } from '@/core/coachEngine';

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

export function FindingCard({
  finding,
  index,
  onDrillThis,
}: {
  finding: CoachFinding;
  index: number;
  /**
   * Present ONLY when this week's plan carries a drill for this finding —
   * jumps the user to the [Plan] segment. The screen decides; the card never
   * fabricates the mapping.
   */
  onDrillThis?: () => void;
}) {
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
      }${onDrillThis ? ". Drill this — in this week's plan." : ''}`}
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
      {onDrillThis != null && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Drill this — opens this week's plan"
          onPress={() => {
            // Arming a drill is a commitment tick, not a selection — the same
            // weight modes' pickDrill carries (via the settings-gated gateway).
            haptic.impactLight();
            onDrillThis();
          }}
          style={({ pressed }) => [styles.drillRow, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.drillRowText}>Drill this</Text>
          <Ionicons name="chevron-forward" size={13} color={color.accent} />
        </Pressable>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
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
  // "Drill this" bridge — same idiom as WeeklyPlanCard's Practice link.
  drillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: space.xs,
    alignSelf: 'flex-start',
  },
  drillRowText: {
    ...type.caption,
    color: color.accent,
    fontFamily: font.bodyMedium,
  },
});
