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
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated from 'react-native-reanimated';
import { Canvas, Path } from '@shopify/react-native-skia';

import { ArcReveal, arcMotif, useCardStagger } from '@/components/motion';
import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, confidenceColor, iconSize, motion, radius, space, type } from '@/constants/tokens';
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

// --- Arc diagram (schematic) -------------------------------------------------

/** Diagram band height — a compact schematic, not a chart. */
const DIAGRAM_H = 96;
/** Rim-line half-width around the crossing point. */
const RIM_HALF = 28;
/** Radius of the entry-angle wedge mark. */
const WEDGE_R = 18;

/**
 * Static schematic of the PATH signal: the signature arc (the same arcMotif
 * every hero moment draws) crossing DOWN through a rim line, with the entry
 * angle wedged at the crossing point. Deliberately unlabeled — it teaches the
 * SHAPE of the test and never a number the pipeline doesn't measure that
 * precisely. All geometry is plain JS-thread math; the Skia overlay is
 * declarative Paths only, no worklet callbacks.
 */
function ArcDiagram() {
  const [w, setW] = useState(0);

  const motif = w > 0 ? arcMotif(w, DIAGRAM_H) : null;
  let rimPath = '';
  let wedgePath = '';
  let throughPath = '';
  if (motif != null) {
    const { c, p1 } = motif;
    // Incoming flight direction at the rim — the Bézier tangent at t = 1.
    const vx = p1.x - c.x;
    const vy = p1.y - c.y;
    const len = Math.hypot(vx, vy) || 1;
    const ux = vx / len;
    const uy = vy / len;
    rimPath = `M ${p1.x - RIM_HALF} ${p1.y} L ${p1.x + RIM_HALF} ${p1.y}`;
    // Entry-angle wedge: a small arc between the rim line (back along −x)
    // and the incoming flight direction (back up the arc).
    const ex = p1.x - ux * WEDGE_R;
    const ey = p1.y - uy * WEDGE_R;
    wedgePath = `M ${p1.x - WEDGE_R} ${p1.y} A ${WEDGE_R} ${WEDGE_R} 0 0 1 ${ex} ${ey}`;
    // "Crosses DOWN through": a short continuation of the flight below the rim.
    throughPath = `M ${p1.x} ${p1.y} L ${p1.x + ux * 14} ${p1.y + uy * 14}`;
  }

  return (
    <View
      style={styles.diagram}
      onLayout={(e) => setW(Math.round(e.nativeEvent.layout.width))}
      accessible
      accessibilityLabel="Diagram: the tracked shot arc crossing down through the rim line, with the entry angle marked at the crossing"
    >
      {motif != null && (
        <>
          <ArcReveal width={w} height={DIAGRAM_H} animate={false} />
          <Canvas style={styles.diagramOverlay} pointerEvents="none">
            <Path path={rimPath} style="stroke" strokeWidth={2} color={color.textDim} opacity={0.7} />
            <Path path={throughPath} style="stroke" strokeWidth={2} color={color.accent} opacity={0.35} />
            <Path path={wedgePath} style="stroke" strokeWidth={2} color={color.accent} opacity={0.9} />
          </Canvas>
        </>
      )}
    </View>
  );
}

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

  // Canonical card cascade (undefined under reduced motion — static render).
  const enter = useCardStagger({ durationMs: motion.standard });

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
        {/* The PATH test, drawn: arc over rim line, entry angle marked. */}
        <ArcDiagram />
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
            <Ionicons name={rule.icon} size={iconSize.sm} color={color.textDim} style={styles.ruleIcon} />
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
  // --- Arc diagram ------------------------------------------------------------
  diagram: {
    height: DIAGRAM_H,
    marginTop: space.lg,
  },
  diagramOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
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
    // Optically align the small glyph with the heading's 22px line height.
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
