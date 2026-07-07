/**
 * ShotToast — the last-shot micro-replay card on the live HUD.
 *
 * On every resolved shot a compact glass card slides in under the top HUD
 * chips for ~2.5 s:
 *   • outcome chip — color + shape (MakeMissDot), colorblind safe,
 *   • a mini Skia sparkline of the shot's trajectory in the outcome color,
 *   • the entry angle when it was measured ("48°"),
 *   • the current streak once it's ≥ 2.
 *
 * Self-contained: the parent only feeds the latest ResolvedShot + streak; the
 * card owns its enter/auto-dismiss timing. A new shot replaces the card
 * immediately; tapping dismisses it early (v1 — no clip navigation). Reduced
 * motion drops the slide/fade entirely (plain appear/disappear), and the
 * wrapper is box-none so only the card itself ever captures a touch.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import Animated, { FadeInUp, FadeOut, useReducedMotion } from 'react-native-reanimated';
import { Canvas, Path, Skia } from '@shopify/react-native-skia';

import { color, motion, space, type } from '../../constants/tokens';
import type { ResolvedShot, ShotOutcome } from '../../core/types';
import { Chip, MakeMissDot, Row } from '../ui';
import { HudChip } from './HudChip';
import { buildSparklinePoints, SPARK_HEIGHT, SPARK_WIDTH } from './shotSparkline';

/** How long the card stays up before fading out. */
const TOAST_MS = 2500;

const OUTCOME_UI: Record<
  ShotOutcome,
  { label: string; tone: 'make' | 'miss' | 'unsure'; stroke: string; spoken: string }
> = {
  make: { label: 'MAKE', tone: 'make', stroke: color.make, spoken: 'Make' },
  miss: { label: 'MISS', tone: 'miss', stroke: color.miss, spoken: 'Miss' },
  unsure: { label: 'REVIEW', tone: 'unsure', stroke: color.unsure, spoken: 'Unsure, review later' },
};

export function ShotToast({
  shot,
  streak,
}: {
  /** Latest resolved shot; each new one re-arms the toast. */
  shot: ResolvedShot | null;
  /** Current make streak from the session store; hidden below 2. */
  streak: number;
}) {
  const reducedMotion = useReducedMotion();
  const [visible, setVisible] = useState<ResolvedShot | null>(null);

  // A new resolved shot replaces the current card immediately and restarts
  // the dismiss clock; the pending timeout is cleared on replace/unmount.
  useEffect(() => {
    if (shot == null) return;
    setVisible(shot);
    const id = setTimeout(() => setVisible(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [shot]);

  const points = useMemo(
    () => (visible != null ? buildSparklinePoints(visible.trajectory) : []),
    [visible],
  );
  const sparkPath = useMemo(() => {
    const p = Skia.Path.Make();
    if (points.length >= 2) {
      p.moveTo(points[0]!.x, points[0]!.y);
      for (let i = 1; i < points.length; i++) p.lineTo(points[i]!.x, points[i]!.y);
    }
    return p;
  }, [points]);

  if (visible == null) return null;

  const ui = OUTCOME_UI[visible.outcome];
  const angle = visible.entryAngleDeg != null ? Math.round(visible.entryAngleDeg) : null;

  // No accessibilityLiveRegion here — ShotFlash already announces the result;
  // this card is a silent visual echo with a tappable dismiss.
  const a11yParts = [ui.spoken];
  if (angle != null) a11yParts.push(`entry angle ${angle} degrees`);
  if (streak >= 2) a11yParts.push(`streak ${streak}`);

  return (
    <Animated.View
      key={visible.id}
      entering={reducedMotion ? undefined : FadeInUp.duration(motion.quick)}
      exiting={reducedMotion ? undefined : FadeOut.duration(motion.standard)}
      style={styles.wrap}
      pointerEvents="box-none"
    >
      <Pressable
        onPress={() => setVisible(null)}
        accessibilityRole="button"
        accessibilityLabel={a11yParts.join(', ')}
        accessibilityHint="Dismisses the shot card"
      >
        <HudChip deep style={styles.chip}>
          <Row gap={space.sm}>
            <MakeMissDot outcome={visible.outcome} size={12} />
            <Chip label={ui.label} tone={ui.tone} />
            {points.length >= 2 && (
              <Canvas style={styles.spark} pointerEvents="none">
                <Path
                  path={sparkPath}
                  style="stroke"
                  strokeWidth={2}
                  strokeCap="round"
                  strokeJoin="round"
                  color={ui.stroke}
                />
              </Canvas>
            )}
            {angle != null && <Text style={styles.angle}>{`${angle}°`}</Text>}
            {streak >= 2 && <Text style={styles.streak}>{`🔥 ×${streak}`}</Text>}
          </Row>
        </HudChip>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    marginTop: space.sm,
  },
  chip: {
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
  },
  spark: {
    width: SPARK_WIDTH,
    height: SPARK_HEIGHT,
  },
  angle: {
    ...type.bodyMedium,
    color: color.text,
    fontVariant: ['tabular-nums'],
  },
  streak: {
    ...type.bodyMedium,
    color: color.accent,
  },
});
