/**
 * Calibration guide — the learn-surface for Hoopilot's calibration rituals.
 *
 * Pure copy + diagrams: why calibrate (the 2/3-accuracy ladder), how to place
 * the phone, and what the three in-session steps look like. All copy comes
 * from src/core/calibrationGuide.ts so this screen, the live overlay and the
 * health card can never drift apart. No camera, no engine, no polling.
 */
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { BackPill } from '@/components/ShotList';
import { Card, Chip, Eyebrow, PillButton, Row, Screen } from '@/components/ui';
import { color, font, motion, radius, space, type } from '@/constants/tokens';
import { PLACEMENT_STEPS, WHY_CALIBRATE } from '@/core/calibrationGuide';
import { useSettings } from '@/state/settingsStore';

type ChipTone = React.ComponentProps<typeof Chip>['tone'];

/**
 * Ladder rung → Chip tone. Mirrors the per-shot receipt language: heuristic
 * reads neutral, the measured upgrade reads accent, court-registered reads
 * make-green (the "trust me" tier).
 */
const LADDER_TONES: Record<(typeof WHY_CALIBRATE.ladder)[number]['source'], ChipTone> = {
  heuristic: 'default',
  metric: 'accent',
  court: 'make',
};

/** The three live-session steps, in the order they happen on court. */
const LIVE_STEPS = [
  {
    title: 'Rim lock — automatic',
    body: 'Frame the rim and hold steady for the 3-2-1. Everything starts here.',
  },
  {
    title: 'Tap the court — optional, 30 seconds',
    body: 'After lock, hit Calibrate and tap 5 floor landmarks. Corner-accurate 3s.',
  },
  {
    title: 'Free-throw anchor — optional, 5 seconds',
    body: 'Stand on the FT line when the chip offers. Upgrades distance to measured.',
  },
] as const;

/**
 * 72x54 placement diagram — pure Views, purely decorative (the row's title and
 * body carry the meaning, so the whole sketch is hidden from screen readers).
 */
function PlacementDiagram({ kind }: { kind: (typeof PLACEMENT_STEPS)[number]['id'] }) {
  return (
    <View
      style={styles.diagram}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      {kind === 'side' && (
        <>
          <View style={styles.sideCourt} />
          <View style={styles.sidePole} />
          <View style={styles.sideHoop} />
          <View style={styles.sidePhone} />
        </>
      )}
      {kind === 'frame' && (
        <View style={styles.framePhone}>
          <View style={styles.frameRim} />
          <View style={styles.frameFloor} />
        </View>
      )}
      {kind === 'height' && (
        <>
          <View style={styles.heightPole} />
          <View style={styles.heightTripod} />
          <View style={styles.heightPhone} />
        </>
      )}
    </View>
  );
}

export default function CalibrationGuideScreen() {
  // Mark the guide as seen so entry points can stop nudging toward it.
  useEffect(() => {
    useSettings.getState().set('calGuideSeen', true);
  }, []);

  // Entrance stagger — same cadence as session/setup; off under reduced motion.
  const reducedMotion = useReducedMotion();
  const enter = (i: number) =>
    reducedMotion ? undefined : FadeInDown.duration(motion.standard).delay(i * 70);

  return (
    <Screen scroll>
      <Row style={styles.backRow}>
        <BackPill />
      </Row>
      <Animated.View entering={enter(0)}>
        <Eyebrow>Calibration guide</Eyebrow>
      </Animated.View>

      {/* WHY — the 2/3-accuracy ladder, in receipt language. */}
      <Card entering={enter(1)} style={styles.card}>
        <Text style={styles.title} accessibilityRole="header">
          {WHY_CALIBRATE.headline}
        </Text>
        <Text style={styles.lede}>{WHY_CALIBRATE.body}</Text>
        <View style={styles.ladder}>
          {WHY_CALIBRATE.ladder.map((rung) => (
            <Row key={rung.source} style={styles.ladderRow} gap={space.md}>
              <Chip label={rung.label} tone={LADDER_TONES[rung.source]} />
              <Text style={styles.ladderBlurb}>{rung.blurb}</Text>
            </Row>
          ))}
        </View>
      </Card>

      {/* PLACEMENT — where the phone goes, one sketch per rule. */}
      <Card entering={enter(2)} style={styles.card}>
        <Eyebrow>Set up the phone</Eyebrow>
        {PLACEMENT_STEPS.map((step, i) => (
          <Row key={step.id} style={[styles.placeRow, i > 0 && styles.placeRowGap]} gap={space.md}>
            <PlacementDiagram kind={step.id} />
            <View style={styles.rowBody}>
              <Text style={styles.itemTitle}>{step.title}</Text>
              <Text style={styles.itemBody}>{step.body}</Text>
            </View>
          </Row>
        ))}
      </Card>

      {/* LIVE — the three in-session steps, numbered rail like setup's checklist. */}
      <Card entering={enter(3)} style={styles.card}>
        <Eyebrow>What happens live</Eyebrow>
        {LIVE_STEPS.map((step, i) => (
          <Row key={step.title} style={styles.stepRow} gap={space.md}>
            <View style={styles.stepRail}>
              <View style={styles.stepBadge}>
                <Text style={styles.stepNum}>{i + 1}</Text>
              </View>
              {i < LIVE_STEPS.length - 1 && <View style={styles.railLine} />}
            </View>
            <View style={[styles.rowBody, i < LIVE_STEPS.length - 1 && styles.stepBodyGap]}>
              <Text style={styles.itemTitle}>{step.title}</Text>
              <Text style={styles.itemBody}>{step.body}</Text>
            </View>
          </Row>
        ))}
        <Row style={styles.honestyRow} gap={space.sm}>
          <Ionicons name="shield-checkmark-outline" size={13} color={color.textDim} />
          <Text style={styles.honestyNote}>
            Calibration is per session. Move or re-aim the camera and it clears itself — we never
            guess from a stale map.
          </Text>
        </Row>
      </Card>

      <Animated.View entering={enter(4)} style={styles.ctaBlock}>
        <PillButton
          label="Start a session"
          icon="videocam"
          onPress={() => router.push('/session/setup')}
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
  ladder: {
    marginTop: space.lg,
    gap: space.md,
  },
  ladderRow: {
    alignItems: 'center',
  },
  ladderBlurb: {
    ...type.caption,
    color: color.textDim,
    flex: 1,
  },
  // --- Placement rows -----------------------------------------------------
  placeRow: {
    alignItems: 'flex-start',
  },
  placeRowGap: {
    marginTop: space.lg,
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
  // --- Placement diagrams (72x54, decorative) ------------------------------
  diagram: {
    width: 72,
    height: 54,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    backgroundColor: color.bg,
    overflow: 'hidden',
  },
  // 'side': court band with a hoop at the left and the phone at the right edge.
  sideCourt: {
    position: 'absolute',
    left: 8,
    right: 8,
    bottom: 8,
    height: 24,
    borderRadius: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    backgroundColor: color.surface,
  },
  sidePole: {
    position: 'absolute',
    left: 16,
    top: 17,
    width: 1.5,
    height: 15,
    backgroundColor: color.hudGlassBorder,
  },
  sideHoop: {
    position: 'absolute',
    left: 13,
    top: 12,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.accent,
  },
  sidePhone: {
    position: 'absolute',
    right: 10,
    bottom: 12,
    width: 8,
    height: 16,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: color.textDim,
    backgroundColor: color.surfaceRaised,
  },
  // 'frame': the viewfinder — rim in the upper half, floor line below it.
  framePhone: {
    position: 'absolute',
    left: 23,
    top: 7,
    width: 26,
    height: 40,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: color.textDim,
    backgroundColor: color.surface,
    overflow: 'hidden',
  },
  frameRim: {
    position: 'absolute',
    top: 9,
    left: 9,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: color.accent,
  },
  frameFloor: {
    position: 'absolute',
    left: 3,
    right: 3,
    bottom: 8,
    height: 1,
    backgroundColor: color.hudGlassBorder,
  },
  // 'height': phone at ~60% up a vertical line, tripod triangle at the floor.
  heightPole: {
    position: 'absolute',
    left: 24,
    top: 6,
    bottom: 6,
    width: 1,
    backgroundColor: color.hudGlassBorder,
  },
  // Border-triangle trick — the only way to draw a filled triangle in pure RN.
  heightTripod: {
    position: 'absolute',
    left: 16,
    bottom: 6,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 11,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: color.surfaceRaised,
  },
  heightPhone: {
    position: 'absolute',
    left: 20,
    top: 14,
    width: 9,
    height: 16,
    borderRadius: 2,
    borderWidth: 1,
    borderColor: color.textDim,
    backgroundColor: color.surfaceRaised,
  },
  // --- Live walkthrough rail ------------------------------------------------
  stepRow: {
    alignItems: 'stretch',
  },
  stepRail: {
    width: 28,
    alignItems: 'center',
  },
  stepBadge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: color.accentTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNum: {
    fontFamily: font.bodySemiBold,
    fontSize: 13,
    lineHeight: 18,
    color: color.accent,
  },
  railLine: {
    flex: 1,
    width: 1.5,
    borderRadius: 1,
    backgroundColor: color.border,
    marginTop: space.xs,
  },
  stepBodyGap: {
    paddingBottom: space.lg,
  },
  honestyRow: {
    marginTop: space.md,
    alignItems: 'flex-start',
  },
  honestyNote: {
    ...type.micro,
    color: color.textDim,
    flex: 1,
  },
  // --- CTA -------------------------------------------------------------------
  ctaBlock: {
    marginTop: space.sm,
    marginBottom: space.xl,
    gap: space.md,
  },
});
