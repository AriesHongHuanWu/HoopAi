/**
 * PlacementGrade — pre-lock placement guidance for the aiming overlay:
 *
 *  - usePlacementGrade: polls the engine's overlay + debug SharedValues at
 *    5 Hz (the same cadence as the rimCountdown poll in live.tsx — never a
 *    per-frame React update) and grades the current camera placement via the
 *    pure core/placementGrade module.
 *  - PlacementGradeChip: the small Good / OK / Poor chip with the actionable
 *    reason ("Move closer — the rim looks too small").
 *  - GhostRim: the dashed "ideal rim" silhouette the user frames the real
 *    hoop over — solid make-green while the lock countdown runs.
 */
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas, DashPathEffect, Oval } from '@shopify/react-native-skia';
import type { SharedValue } from 'react-native-reanimated';

import type { EngineDebug, OverlayState } from '../../camera/useShotEngine';
import { color, glow, space, type } from '../../constants/tokens';
import { classifyLight, type LightProfile } from '../../core/lightProfile';
import {
  GRADE_POLL_MS,
  bestRimWidth,
  gradePlacement,
  type PlacementGradeLevel,
  type PlacementGradeResult,
} from '../../core/placementGrade';
import { HudChip } from './HudChip';

/**
 * Ghost rim width as a fraction of the SHORTER view side — the middle of the
 * good apparent-size band (RIM_FRACTION_IDEAL_MIN..MAX ≈ 8–15%), so a hoop
 * framed over the ghost lands the placement grade in the good band.
 */
export const GHOST_RIM_WIDTH_FRAC = 0.115;
/** Ghost rim height : width. A side-view rim box is wide and shallow (the
 *  supported aspect band is ~2.5–6 wide; 2.5:1 is the friendliest target). */
export const GHOST_RIM_ASPECT = 0.4;
/** Ghost rim center as a fraction of view height — the upper third. */
export const GHOST_RIM_CENTER_Y_FRAC = 1 / 3;

/**
 * 5 Hz placement grade off the engine SharedValues. Pre-lock the LOCKED rim
 * on the overlay is null, so rim sightings come from the raw detection list;
 * the last sighting (time + width) is remembered so a blinking detector reads
 * as steady guidance, and only a >2 s gap degrades to "point at the hoop".
 * Returns null while disabled (model warming) — the chip simply hides.
 */
export function usePlacementGrade(
  overlay: SharedValue<OverlayState>,
  debug: SharedValue<EngineDebug>,
  enabled: boolean,
): PlacementGradeResult | null {
  const [result, setResult] = useState<PlacementGradeResult | null>(null);
  // Last rim sighting. Seeded with the enable time so "never saw a rim" flows
  // through the same no-rim timeout as "lost the rim".
  const lastSeenMs = useRef(Date.now());
  const lastWidthPx = useRef<number | null>(null);
  // Scene-light profile with hysteresis: classifyLight is keyed off the
  // PREVIOUS profile so the low-light hint can't flap at a boundary. Null
  // until the engine publishes a real luma (overlay.light > 0).
  const lightRef = useRef<LightProfile | null>(null);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      return;
    }
    lastSeenMs.current = Date.now();
    lastWidthPx.current = null;
    lightRef.current = null;
    const id = setInterval(() => {
      const o = overlay.value;
      const now = Date.now();
      const w = bestRimWidth(o.dets) ?? (o.rim != null ? o.rim.width : null);
      if (w != null && w > 0) {
        lastSeenMs.current = now;
        lastWidthPx.current = w;
      }
      if (o.light > 0) {
        lightRef.current = classifyLight(o.light, lightRef.current);
      }
      const next = gradePlacement({
        rimWidthPx: lastWidthPx.current,
        frameSide: Math.max(o.frameW, o.frameH),
        msSinceRimSeen: now - lastSeenMs.current,
        fps: debug.value.fps,
        light: lightRef.current,
      });
      // Re-render only when the grade actually changes, not 5x/second.
      setResult((prev) =>
        prev != null && prev.grade === next.grade && prev.reason === next.reason
          ? prev
          : next,
      );
    }, GRADE_POLL_MS);
    return () => clearInterval(id);
  }, [overlay, debug, enabled]);

  return result;
}

const GRADE_LABEL: Record<PlacementGradeLevel, string> = {
  good: 'Good',
  ok: 'OK',
  poor: 'Poor',
};

/** Grade → dot/label color. COLOR + TEXT together (colorblind-safe). */
function gradeColor(grade: PlacementGradeLevel): string {
  return grade === 'good' ? color.make : grade === 'ok' ? color.unsure : color.miss;
}

/**
 * The placement chip: a status dot + grade word + the one actionable reason.
 * Rendered inside the aiming Pressable (which owns the accessibility label),
 * so the chip itself stays purely visual.
 */
export function PlacementGradeChip({ result }: { result: PlacementGradeResult }) {
  const tint = gradeColor(result.grade);
  return (
    <HudChip>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: tint }]} />
        <Text style={[styles.gradeLabel, { color: tint }]}>
          {GRADE_LABEL[result.grade]}
        </Text>
        <Text style={styles.reason}>{result.reason}</Text>
      </View>
    </HudChip>
  );
}

/**
 * The ghost rim silhouette: a dashed ellipse at the IDEAL apparent rim size.
 * `active` (countdown running) switches it to a solid make-green stroke — the
 * same green-lock language as the trajectory overlay's rim brackets.
 */
export function GhostRim({
  width,
  height,
  active,
}: {
  width: number;
  height: number;
  active: boolean;
}) {
  const sw = active ? 3 : 2;
  return (
    <Canvas style={{ width, height }} pointerEvents="none">
      <Oval
        x={sw}
        y={sw}
        width={width - sw * 2}
        height={height - sw * 2}
        style="stroke"
        strokeWidth={sw}
        color={active ? glow.rimLive : glow.rimIdle}
        opacity={active ? 0.95 : 0.6}
      >
        {active ? null : <DashPathEffect intervals={[7, 6]} />}
      </Oval>
    </Canvas>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  gradeLabel: {
    ...type.caption,
    textTransform: 'uppercase',
  },
  reason: {
    ...type.caption,
    color: color.text,
    flexShrink: 1,
  },
});
