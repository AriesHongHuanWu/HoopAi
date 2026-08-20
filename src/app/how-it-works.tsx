/**
 * How detection works — the honesty explainer behind every make/miss call.
 *
 * Pure copy + a sample receipt: the three fusion signals, the rules that keep
 * calls honest, and the ONE confidence scale. All copy comes from
 * src/core/detectionExplainer.ts and the receipt row renders through the REAL
 * evidence.ts helpers, so this screen can never drift from what the shot-list
 * receipts actually say. No camera, no engine, no polling.
 *
 * Expo-router file route — pushes over the tab bar like calibration-guide.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, confidenceColor, motion, radius, space, type } from '@/constants/tokens';
import { EXPLAINER, type ExplainerSignalKey } from '@/core/detectionExplainer';
import {
  EVIDENCE_CHANNELS,
  confidenceLabel,
  evidenceGlyph,
  evidenceSummary,
  evidenceTone,
  type ConfidenceLevel,
} from '@/core/evidence';
import { useSettings } from '@/state/settingsStore';

/** Receipt chip label for a signal key — sourced from the receipt row's own
 *  channel list so the explainer can never invent its own channel names. */
function channelLabel(key: ExplainerSignalKey): string {
  return EVIDENCE_CHANNELS.find((c) => c.key === key)!.label;
}

/** The one confidence scale, best tier first (matches confidenceColor). */
const CONFIDENCE_TIERS: readonly ConfidenceLevel[] = ['high', 'medium', 'low'];

/**
 * Confidence-tier pill — dot + label in the tier's confidenceColor. The
 * shared Chip has fixed outcome tones; confidence deliberately reads through
 * its own single palette (tokens.confidenceColor), so this stays local.
 */
function TierChip({ level }: { level: ConfidenceLevel }) {
  return (
    <View style={styles.tierChip}>
      <View style={[styles.tierDot, { backgroundColor: confidenceColor[level] }]} />
      <Text style={[styles.tierLabel, { color: confidenceColor[level] }]}>
        {confidenceLabel(level)}
      </Text>
    </View>
  );
}

export default function HowItWorksScreen() {
  // Mark the explainer as seen so entry points (Settings row, first-summary
  // nudge) can stop pointing here. `detectionExplainerSeen` lands in
  // settingsStore v7 (integrator-owned); the cast keeps this route compiling
  // regardless of merge order — zustand merges the key and persist saves it
  // either way, and until v7 lands the flag simply reads as unseen elsewhere.
  useEffect(() => {
    (useSettings.getState().set as (key: string, value: boolean) => void)(
      'detectionExplainerSeen',
      true,
    );
  }, []);

  // Entrance stagger — same cadence as calibration-guide; off under reduced motion.
  const reducedMotion = useReducedMotion();
  const enter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.duration(motion.standard).delay(i * 70);

  const demo = EXPLAINER.receiptDemo;

  return (
    <Screen scroll>
      <Row style={styles.backRow}>
        <BackPill />
      </Row>
      <Animated.View entering={enter(0)}>
        <Eyebrow>How detection works</Eyebrow>
      </Animated.View>

      {/* SIGNALS — the three fusion channels, in receipt order. */}
      <Card entering={enter(1)} style={styles.card}>
        <Text style={styles.title} accessibilityRole="header">
          {EXPLAINER.headline}
        </Text>
        <Text style={styles.lede}>{EXPLAINER.lede}</Text>
        <View style={styles.signalList}>
          {EXPLAINER.signals.map((signal) => (
            <Row key={signal.key} style={styles.signalRow} gap={space.md}>
              <Chip label={channelLabel(signal.key)} tone="accent" />
              <View style={styles.rowBody}>
                <Text style={styles.itemTitle}>{signal.title}</Text>
                <Text style={styles.itemBody}>{signal.body}</Text>
              </View>
            </Row>
          ))}
        </View>

        {/* Sample receipt — rendered with the REAL helpers the shot list uses,
            grouped for screen readers via the same evidenceSummary sentence. */}
        <View
          style={styles.receiptRow}
          accessible
          accessibilityLabel={evidenceSummary(demo.signals, demo.rimBounce)}
        >
          {EVIDENCE_CHANNELS.map((c) => (
            <Chip
              key={c.key}
              label={`${evidenceGlyph(demo.signals[c.key])} ${c.label}`}
              tone={evidenceTone(demo.signals[c.key])}
              compact
            />
          ))}
        </View>
        <Text style={styles.receiptCaption}>
          A real receipt: ✓ yes, ✕ no, — no data. Every shot in your summary carries one.
        </Text>
      </Card>

      {/* RULES — the honesty contract, one row per rule. */}
      <Card entering={enter(2)} style={styles.card}>
        <Eyebrow>The rules that keep it honest</Eyebrow>
        {EXPLAINER.rules.map((rule, i) => (
          <Row key={rule.title} style={[styles.ruleRow, i > 0 && styles.ruleRowGap]} gap={space.md}>
            <Ionicons name={rule.icon} size={13} color={color.textDim} style={styles.ruleIcon} />
            <View style={styles.rowBody}>
              <Text style={styles.itemTitle}>{rule.title}</Text>
              <Text style={styles.itemBody}>{rule.body}</Text>
            </View>
          </Row>
        ))}
      </Card>

      {/* CONFIDENCE — the one scale every detection surface speaks. */}
      <Card entering={enter(3)} style={styles.card}>
        <Eyebrow>One confidence scale</Eyebrow>
        <Row style={styles.tierRow} gap={space.sm}>
          {CONFIDENCE_TIERS.map((level) => (
            <TierChip key={level} level={level} />
          ))}
        </Row>
        <Text style={styles.itemBody}>
          Confidence is one scale app-wide — the receipt, the badge and the zone tint all mean the
          same thing.
        </Text>
      </Card>

      <Animated.View entering={enter(4)} style={styles.ctaBlock}>
        <PillButton
          label="See the calibration guide"
          icon="grid-outline"
          onPress={() => router.push('/calibration-guide')}
        />
        <PillButton
          label="Done"
          variant="ghost"
          onPress={() => {
            // Deep-link guard: with no history (e.g. cold start on this route)
            // fall back to the tab home instead of throwing on back().
            if (router.canGoBack()) router.back();
            else router.replace('/');
          }}
        />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  backRow: {
    marginBottom: space.md,
  },
  card: {
    marginBottom: space.lg,
  },
  title: {
    ...type.title,
    color: color.text,
  },
  lede: {
    ...type.body,
    color: color.textDim,
    marginTop: space.xs,
  },
  // --- Signal rows ----------------------------------------------------------
  signalList: {
    marginTop: space.lg,
    gap: space.lg,
  },
  signalRow: {
    alignItems: 'flex-start',
  },
  rowBody: {
    flex: 1,
  },
  itemTitle: {
    ...type.heading,
    color: color.text,
  },
  itemBody: {
    ...type.caption,
    color: color.textDim,
    marginTop: 2,
  },
  // --- Sample receipt ---------------------------------------------------------
  receiptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    marginTop: space.lg,
  },
  receiptCaption: {
    ...type.micro,
    color: color.textFaint,
    marginTop: space.sm,
  },
  // --- Rule rows --------------------------------------------------------------
  ruleRow: {
    alignItems: 'flex-start',
  },
  ruleRowGap: {
    marginTop: space.lg,
  },
  ruleIcon: {
    // Optically align the 13px glyph with the heading's 22px line height.
    marginTop: 4,
  },
  // --- Confidence tiers ---------------------------------------------------------
  tierRow: {
    marginBottom: space.md,
  },
  tierChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  tierDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tierLabel: {
    ...type.caption,
  },
  // --- CTA -----------------------------------------------------------------------
  ctaBlock: {
    marginTop: space.sm,
    marginBottom: space.xl,
    gap: space.md,
  },
});
