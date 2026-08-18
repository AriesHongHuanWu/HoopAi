/**
 * DrillOverlay — the live-session guidance chip for a structured drill.
 *
 * HONEST GUIDANCE, NOT FAKE AR. Hoopilot has no court calibration in v1, so
 * there is NO floor marker projected onto the camera feed — that would be a lie
 * about where "the spot" is. Instead this is a small, upfront half-court MAP
 * (Skia) that lights up the drill's ACTIVE spot, paired with a "Spot 2/5 · 3
 * more makes" progress line. The map reads like a coach's clipboard: cleared
 * spots are filled, the active spot pulses, upcoming spots sit as hollow rings.
 *
 * It renders bottom-center over the feed, out of the way of the top ModeBanner.
 * Pure presentation over {@link ModeState}; the live screen owns when to mount
 * it (only while a drill is the active mode). Reduced-motion aware: the pulse is
 * replaced by a static ring when the system asks for reduced motion.
 */
import { Canvas, Circle, Group, Line, Path, Rect, Skia, vec } from '@shopify/react-native-skia';
import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeInUp,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { color, motion, radius, space, type } from '../../constants/tokens';
import { drillOf } from '../../core/drills';
import type { ModeState } from '../../core/gameModes';
import { MODE_IDENTITY } from '../modes/modeIdentity';

/** Diagram footprint (px). Half-court, wider than tall (baseline at bottom). */
const COURT_W = 168;
const COURT_H = 108;
/** Inset of the drawn court inside the canvas so strokes aren't clipped. */
const PAD = 8;

/**
 * Maps a drill spot's normalized position — x across 0..1, y baseline 0 →
 * half-court 1 — to canvas px. Baseline (y=0) sits at the BOTTOM of the map
 * (near the hoop), the half-court line (y=1) at the top.
 */
function toCanvas(pos: { x: number; y: number }): { cx: number; cy: number } {
  const cx = PAD + pos.x * (COURT_W - PAD * 2);
  const cy = COURT_H - PAD - pos.y * (COURT_H - PAD * 2);
  return { cx, cy };
}

/** Static Skia half-court backdrop: boundary, key, arc, rim. Drawn once. */
function CourtLines({ stroke }: { stroke: string }) {
  const arc = React.useMemo(() => {
    const p = Skia.Path.Make();
    // 3-point arc: a shallow curve near the top, corners dropping to baseline.
    const left = toCanvas({ x: 0.08, y: 0.14 });
    const apex = toCanvas({ x: 0.5, y: 0.78 });
    const right = toCanvas({ x: 0.92, y: 0.14 });
    p.moveTo(left.cx, left.cy);
    p.quadTo(apex.cx, apex.cy - 26, right.cx, right.cy);
    return p;
  }, []);

  const key = React.useMemo(() => {
    const p = Skia.Path.Make();
    const tl = toCanvas({ x: 0.36, y: 0.5 });
    const tr = toCanvas({ x: 0.64, y: 0.5 });
    const br = toCanvas({ x: 0.64, y: 0.04 });
    const bl = toCanvas({ x: 0.36, y: 0.04 });
    p.moveTo(bl.cx, bl.cy);
    p.lineTo(tl.cx, tl.cy);
    p.lineTo(tr.cx, tr.cy);
    p.lineTo(br.cx, br.cy);
    return p;
  }, []);

  const rim = toCanvas({ x: 0.5, y: 0.02 });
  const ftLine = { a: toCanvas({ x: 0.36, y: 0.5 }), b: toCanvas({ x: 0.64, y: 0.5 }) };

  return (
    <Group opacity={0.5}>
      {/* Court boundary */}
      <Rect
        x={PAD}
        y={PAD}
        width={COURT_W - PAD * 2}
        height={COURT_H - PAD * 2}
        style="stroke"
        strokeWidth={1}
        color={stroke}
      />
      <Path path={key} style="stroke" strokeWidth={1} color={stroke} />
      <Line p1={vec(ftLine.a.cx, ftLine.a.cy)} p2={vec(ftLine.b.cx, ftLine.b.cy)} strokeWidth={1} color={stroke} />
      <Path path={arc} style="stroke" strokeWidth={1} color={stroke} />
      <Circle cx={rim.cx} cy={rim.cy} r={3} style="stroke" strokeWidth={1.2} color={stroke} />
    </Group>
  );
}

/**
 * PERF (memo): the overlay renders from the mode-store object alone. memo keeps
 * the live screen's per-shot / per-tick re-renders out of it.
 */
export const DrillOverlay = React.memo(function DrillOverlay({ mode }: { mode: ModeState }) {
  const drill = drillOf(mode);
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      pulse.value = 0;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion]);

  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.35 + pulse.value * 0.45,
    transform: [{ scale: 1 + pulse.value * 0.35 }],
  }));

  // Not a drill (defensive — the live screen gates on this already).
  if (drill == null || mode.spots == null) return null;

  const idx = mode.currentSpot ?? 0;
  const spots = mode.spots;
  const active = spots[idx];
  const activeGeo = drill.spots[idx]?.pos ?? { x: 0.5, y: 0.5 };
  const goal = drill.spots[idx]?.goal ?? 1;
  const id = MODE_IDENTITY[mode.modeId]; // spotShooting identity (drill host)
  const accent = id.accent;

  const activeCanvas = toCanvas(activeGeo);
  const remaining = mode.done ? 0 : Math.max(0, goal - (active?.makes ?? 0));
  const remainingWord = remaining === 1 ? 'make' : 'makes';

  const stepLabel = `Spot ${Math.min(idx + 1, spots.length)}/${spots.length}`;
  const makeLabel = mode.done
    ? 'Drill complete'
    : remaining > 0
      ? `${remaining} more ${remainingWord}`
      : 'Spot cleared';

  const a11y = mode.done
    ? `${drill.title} complete.`
    : `${drill.title}. ${stepLabel}. ${active?.label ?? ''}. ${remaining} more ${remainingWord}.`;

  return (
    <Animated.View
      entering={FadeInUp.duration(motion.standard).reduceMotion(ReduceMotion.System)}
      style={styles.wrap}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={a11y}
    >
      {/* Glass panel (HudChip recipe: fill + top highlight) */}
      <View pointerEvents="none" style={styles.highlight} />

      <View style={styles.court}>
        <Canvas style={{ width: COURT_W, height: COURT_H }}>
          <CourtLines stroke={color.hudGlassBorder} />
          {/* Cleared + upcoming spot dots */}
          <Group>
            {spots.map((s, i) => {
              const p = toCanvas(drill.spots[i]?.pos ?? { x: 0.5, y: 0.5 });
              const cleared = mode.done || i < idx;
              if (i === idx && !mode.done) return null; // active drawn separately
              return (
                <Circle
                  key={s.label}
                  cx={p.cx}
                  cy={p.cy}
                  r={4}
                  style={cleared ? 'fill' : 'stroke'}
                  strokeWidth={1.4}
                  color={cleared ? accent : color.textFaint}
                  opacity={cleared ? 0.9 : 0.6}
                />
              );
            })}
          </Group>
          {/* Active spot: solid dot (the animated halo is an RN view on top) */}
          {!mode.done && <Circle cx={activeCanvas.cx} cy={activeCanvas.cy} r={5} color={accent} />}
        </Canvas>
        {/* Animated pulse halo over the active dot (RN view — Skia stays static
            so the canvas never re-renders per frame). */}
        {!mode.done && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.halo,
              {
                left: activeCanvas.cx - HALO / 2,
                top: activeCanvas.cy - HALO / 2,
                backgroundColor: accent,
              },
              haloStyle,
            ]}
          />
        )}
      </View>

      <View style={styles.info}>
        <Text style={styles.drillName} numberOfLines={1}>
          {drill.title.toUpperCase()}
        </Text>
        <Text style={[styles.spotName, { color: accent }]} numberOfLines={1}>
          {mode.done ? 'ALL SPOTS CLEARED' : (active?.label ?? '').toUpperCase()}
        </Text>
        <View style={styles.chipRow}>
          <View style={styles.chip}>
            <Text style={styles.chipText}>{stepLabel.toUpperCase()}</Text>
          </View>
          <View style={[styles.chip, styles.chipAccent, { borderColor: accent }]}>
            <Text style={[styles.chipText, { color: accent }]}>{makeLabel.toUpperCase()}</Text>
          </View>
        </View>
      </View>
    </Animated.View>
  );
});

const HALO = 22;

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    alignSelf: 'center',
    backgroundColor: color.hudGlassDeep,
    borderColor: color.hudGlassBorder,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(245, 241, 236, 0.22)',
  },
  court: {
    width: COURT_W,
    height: COURT_H,
  },
  halo: {
    position: 'absolute',
    width: HALO,
    height: HALO,
    borderRadius: HALO / 2,
  },
  info: {
    minWidth: 118,
    maxWidth: 150,
    gap: 3,
  },
  drillName: {
    ...type.micro,
    color: color.textFaint,
  },
  spotName: {
    ...type.caption,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs,
    marginTop: 2,
  },
  chip: {
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hudGlassBorder,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  chipAccent: {
    borderWidth: 1,
  },
  chipText: {
    ...type.micro,
    color: color.textDim,
  },
});
