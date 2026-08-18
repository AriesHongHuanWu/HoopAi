/**
 * DetectionHealthPanel — the "shows its work" live status chip that replaces
 * the inline DetectionHeartbeat.
 *
 *  - collapsed: one glass chip merging the rim-lock beacon (dot, or the 3-2-1
 *    countdown digit while locking) with the tracking heartbeat
 *    ("Rim locked · Tracking");
 *  - tap: expands into a deep glass card with four plain-language rows
 *    (Signal / Light / Speed / Engine) plus one contextual tip line.
 *
 * Strictly visual/informational: polls the engine's debug + overlay
 * SharedValues at ~3 Hz with change-gated setState (the sanctioned HUD
 * pattern — never per-frame React), and every tier/label derivation lives in
 * the pure core/detectionHealth module. Nothing here feeds detection.
 */
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import type { ShotEngine } from '@/camera/useShotEngine';
import { HudChip } from '@/components/hud/HudChip';
import { Row } from '@/components/ui';
import { color, motion, space, type } from '@/constants/tokens';
import {
  beaconState,
  delegateLabel,
  fpsTier,
  HEALTH_COPY,
  healthTip,
  lightTier,
  signalTier,
  type BeaconState,
  type FpsTier,
  type LightTier,
  type SignalTier,
} from '@/core/detectionHealth';

/** ~3 Hz — same cadence as the legacy heartbeat poll. */
const POLL_MS = 300;

/**
 * Bucket width for the displayed per-look latency. avgMs derives from the live
 * inference-time EMA, which wobbles ±1ms nearly every poll — comparing the raw
 * rounding in {@link snapEqual} would defeat the change gate and re-render the
 * panel on almost every tick. 5ms steps keep the expanded card honest while
 * letting the collapsed chip sit perfectly still.
 */
const AVG_MS_BUCKET = 5;

interface HealthSnap {
  signal: SignalTier;
  fps: FpsTier;
  avgMs: number;
  light: LightTier;
  engine: string;
  beacon: BeaconState;
  countdown: number | null;
}

function snapEqual(a: HealthSnap, b: HealthSnap): boolean {
  return (
    a.signal === b.signal &&
    a.fps === b.fps &&
    a.avgMs === b.avgMs &&
    a.light === b.light &&
    a.engine === b.engine &&
    a.beacon === b.beacon &&
    a.countdown === b.countdown
  );
}

const BEACON_TEXT: Record<BeaconState, string> = {
  searching: HEALTH_COPY.beaconSearching,
  locking: HEALTH_COPY.beaconLocking,
  locked: HEALTH_COPY.beaconLocked,
  drift: HEALTH_COPY.beaconDrift,
};

const BEACON_COLOR: Record<BeaconState, string> = {
  searching: color.textDim,
  locking: color.accent,
  locked: color.make,
  drift: color.miss,
};

const SIGNAL_TEXT: Record<SignalTier, string> = {
  good: HEALTH_COPY.signalGood,
  weak: HEALTH_COPY.signalWeak,
  blind: HEALTH_COPY.signalBlind,
};

/** Signal tint — COLOR + TEXT together (colorblind-safe). */
const SIGNAL_COLOR: Record<SignalTier, string> = {
  good: color.make,
  weak: color.unsure,
  blind: color.miss,
};

const LIGHT_TEXT: Record<LightTier, string> = {
  unmeasured: HEALTH_COPY.lightUnmeasured,
  good: HEALTH_COPY.lightGood,
  dim: HEALTH_COPY.lightDim,
  dark: HEALTH_COPY.lightDark,
};

const FPS_TEXT: Record<FpsTier, string> = {
  smooth: HEALTH_COPY.fpsSmooth,
  ok: HEALTH_COPY.fpsOk,
  slow: HEALTH_COPY.fpsSlow,
  off: HEALTH_COPY.fpsOff,
};

/**
 * PERF (memo): this panel owns its own ~3 Hz change-gated poll — it never
 * derives anything from the live screen's render. Its props are two stable
 * SharedValue refs plus one boolean, so memo turns every unrelated live.tsx
 * re-render (each shot, each countdown tick, each toast) into a no-op instead
 * of a full re-render of the chip and, when open, the four-row detail card.
 */
export const DetectionHealthPanel = React.memo(function DetectionHealthPanel({
  debug,
  overlay,
  drift,
}: {
  debug: ShotEngine['debug'];
  overlay: ShotEngine['overlay'];
  drift: boolean;
}) {
  const [snap, setSnap] = useState<HealthSnap>({
    signal: 'blind',
    fps: 'off',
    avgMs: 0,
    light: 'unmeasured',
    engine: delegateLabel('loading'),
    beacon: 'searching',
    countdown: null,
  });
  const [expanded, setExpanded] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const id = setInterval(() => {
      const d = debug.value;
      const o = overlay.value;
      const next: HealthSnap = {
        signal: signalTier(d.maxScore),
        fps: fpsTier(d.fps),
        avgMs: Math.round(d.avgMs / AVG_MS_BUCKET) * AVG_MS_BUCKET,
        light: lightTier(d.light),
        engine: delegateLabel(d.delegate),
        beacon: beaconState({
          // Rim-locked proxy: the overlay only publishes a rim box once locked,
          // and the countdown clears on lock. The drift prop (live.tsx local
          // state) overrides inside beaconState.
          rimLocked: o.rim != null && o.rimCountdown == null,
          drift,
          countdown: o.rimCountdown,
        }),
        countdown: o.rimCountdown != null ? Math.ceil(o.rimCountdown) : null,
      };
      setSnap((prev) => (snapEqual(prev, next) ? prev : next));
    }, POLL_MS);
    return () => clearInterval(id);
  }, [debug, overlay, drift]);

  const beaconText = BEACON_TEXT[snap.beacon];
  const signalText = SIGNAL_TEXT[snap.signal];
  const tip = healthTip({ signal: snap.signal, fps: snap.fps, light: snap.light });
  const speedValue =
    snap.fps === 'off' ? FPS_TEXT.off : `${FPS_TEXT[snap.fps]} · ~${snap.avgMs}ms per look`;

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        accessibilityRole="button"
        accessibilityLabel={`Detection status: ${beaconText}, ${signalText}. Tap for details.`}
        hitSlop={8}
        style={styles.press}
      >
        <HudChip>
          <Row gap={space.sm}>
            {snap.beacon === 'locking' && snap.countdown != null ? (
              <Text style={styles.countdown}>{snap.countdown}</Text>
            ) : (
              <View style={[styles.beaconDot, { backgroundColor: BEACON_COLOR[snap.beacon] }]} />
            )}
            <Text
              style={styles.label}
              accessibilityLiveRegion="polite"
              accessibilityLabel={`${beaconText}, ${signalText}`}
            >
              {beaconText} ·
            </Text>
            <View style={[styles.signalDot, { backgroundColor: SIGNAL_COLOR[snap.signal] }]} />
            <Text style={styles.label}>{signalText}</Text>
          </Row>
        </HudChip>
      </Pressable>
      {expanded && (
        <Animated.View
          entering={reducedMotion ? undefined : FadeInDown.duration(motion.quick)}
          style={styles.detailWrap}
        >
          <HudChip deep style={styles.detailChip}>
            <View style={styles.detailBody}>
              <Row gap={space.sm} style={styles.detailRow}>
                <Text style={styles.rowLabel}>{HEALTH_COPY.rowSignal}</Text>
                <View style={[styles.signalDot, { backgroundColor: SIGNAL_COLOR[snap.signal] }]} />
                <Text style={styles.rowValue} numberOfLines={1}>
                  {signalText}
                </Text>
              </Row>
              <Row gap={space.sm} style={styles.detailRow}>
                <Text style={styles.rowLabel}>{HEALTH_COPY.rowLight}</Text>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {LIGHT_TEXT[snap.light]}
                </Text>
              </Row>
              <Row gap={space.sm} style={styles.detailRow}>
                <Text style={styles.rowLabel}>{HEALTH_COPY.rowSpeed}</Text>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {speedValue}
                </Text>
              </Row>
              <Row gap={space.sm} style={styles.detailRow}>
                <Text style={styles.rowLabel}>{HEALTH_COPY.rowEngine}</Text>
                <Text style={styles.rowValue} numberOfLines={1}>
                  {snap.engine}
                </Text>
              </Row>
              {tip != null && <Text style={styles.tip}>{tip}</Text>}
            </View>
          </HudChip>
        </Animated.View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  /** Stretches to the HUD column so the expanded card's flex:1 values get
   *  real width (an auto-width parent collapses flex-basis-0 children —
   *  same trap the FT chip documents in live.tsx). */
  wrap: {
    alignSelf: 'stretch',
    marginBottom: space.sm,
  },
  /** Collapsed chip stays compact while the wrap spans the column. */
  press: {
    alignSelf: 'flex-start',
  },
  beaconDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  /** Countdown digit replaces the beacon dot while the lock counts down. */
  countdown: {
    ...type.micro,
    color: color.accent,
    fontVariant: ['tabular-nums'],
  },
  signalDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  label: {
    ...type.micro,
    color: color.text,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  detailWrap: {
    marginTop: space.sm,
    alignSelf: 'stretch',
  },
  /** HudChip centers children; stretch so rows own the full width. */
  detailChip: {
    alignSelf: 'stretch',
  },
  detailBody: {
    alignSelf: 'stretch',
    gap: space.xs,
  },
  detailRow: {
    alignSelf: 'stretch',
  },
  rowLabel: {
    ...type.micro,
    color: color.textFaint,
    width: 56,
  },
  /** The one shrinking region — minWidth:0 so HudChip's overflow:hidden never
   *  clips a pushed-out sibling. */
  rowValue: {
    ...type.caption,
    color: color.text,
    flex: 1,
    minWidth: 0,
  },
  tip: {
    ...type.micro,
    color: color.unsure,
    fontStyle: 'italic',
    marginTop: space.xs,
  },
});
