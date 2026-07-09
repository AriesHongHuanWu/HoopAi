/**
 * RimLockChecklist — pre-lock aiming checklist for the live HUD.
 *
 * Teaches the rim-lock ritual as three glanceable steps (Frame the rim →
 * Hold steady 3-2-1 → Locked) derived by the pure core/calibrationGuide
 * module, plus a low-light warning when the scene is too dark to detect
 * reliably. Mounted by the live screen only while !rimLocked in camera mode;
 * it unmounts at lock, so the "locked" row is never shown as done here.
 *
 * Also hosts the lens glare/haze advisory chip (core/lensCheck via the
 * engine's debug SharedValue): a small separate chip stacked ABOVE the
 * checklist so it never overlaps the steps. ADVISORY ONLY — hedged copy, it
 * never gates anything, and it disappears as soon as the engine clears the
 * flag (same change-gated 4 Hz poll as the checklist itself).
 *
 * READ-ONLY HUD: it never touches detection — it polls the engine's overlay
 * SharedValue at 4 Hz (never a per-frame React update, same pattern as
 * usePlacementGrade) and setStates ONLY when the derived checklist changes.
 * The whole chip is pointerEvents='none' so tap-to-set-rim passes through.
 * Announcements go through the polite live region only — ShotFlash owns
 * announceForAccessibility.
 */
import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import type { EngineDebug, OverlayState } from '@/camera/useShotEngine';
import { HudChip } from '@/components/hud/HudChip';
import { color, motion, space, type } from '@/constants/tokens';
import { rimAimChecklist, type AimStep } from '@/core/calibrationGuide';

/** 4 Hz poll — the sanctioned HUD cadence (see usePlacementGrade). */
const POLL_MS = 250;

/** One polled+derived frame of checklist state, keyed for change gating. */
interface ChecklistSnap {
  steps: AimStep[];
  lowLight: boolean;
  /** Whole seconds left on the hold-steady countdown, null when idle. */
  digit: number | null;
  /** Model load/detect failure — the error UI elsewhere owns that state. */
  modelFailed: boolean;
  /** Lens glare/haze advisory from the engine ('' = clear). Advisory only. */
  lens: EngineDebug['lens'];
  /** Serialized derived output — setState fires only when this differs. */
  key: string;
}

function deriveSnap(
  o: OverlayState,
  modelError: string,
  lens: EngineDebug['lens'],
): ChecklistSnap {
  const result = rimAimChecklist({
    rimSeen: o.rim != null,
    countdown: o.rimCountdown,
    // The live screen unmounts this component at lock, so "locked" here is
    // always false — the third row stays as the goal, never a claimed state.
    locked: false,
    light: o.light,
  });
  // Gate on the DISPLAYED digit (ceil), not the raw float, so the countdown
  // re-renders once per second instead of every poll tick.
  const digit = o.rimCountdown != null ? Math.ceil(o.rimCountdown) : null;
  const modelFailed = modelError !== '';
  const key =
    result.steps.map((s) => s.state).join() +
    (result.lowLight ? '!' : '') +
    (digit ?? '') +
    (modelFailed ? 'X' : '') +
    lens;
  return { steps: result.steps, lowLight: result.lowLight, digit, modelFailed, lens, key };
}

export function RimLockChecklist({
  overlay,
  debug,
}: {
  overlay: SharedValue<OverlayState>;
  // modelError (hide-on-failure) + lens (advisory chip) are read today.
  debug: SharedValue<EngineDebug>;
}) {
  const [snap, setSnap] = useState<ChecklistSnap | null>(null);
  const lastKey = useRef('');

  useEffect(() => {
    const tick = () => {
      const next = deriveSnap(overlay.value, debug.value.modelError, debug.value.lens);
      if (next.key !== lastKey.current) {
        lastKey.current = next.key;
        setSnap(next);
      }
    };
    tick(); // seed immediately so the chip doesn't appear a poll cycle late
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [overlay, debug]);

  // Gentle opacity pulse on the in-progress glyph. Declared at top level
  // (hook order), static when the system asks for reduced motion.
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) {
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(
      withTiming(0.45, { duration: 900, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  if (snap == null || snap.modelFailed) return null;

  const firstOpen = snap.steps.find((s) => s.state !== 'done');
  const summary =
    (firstOpen != null
      ? `Aim check: ${firstOpen.label.toLowerCase()} — in progress.`
      : 'Aim check complete.') + (snap.lowLight ? ' Low light.' : '');
  // Hedged on purpose (lensCheck honesty contract): luma statistics can't
  // tell flare from a bright sky with certainty, so the copy advises, never asserts.
  const lensCopy =
    snap.lens === 'glare'
      ? 'Wipe or shade the lens — glare detected'
      : 'Wipe the lens — haze detected';

  return (
    <Animated.View
      pointerEvents="none"
      style={styles.wrap}
      entering={FadeInDown.duration(motion.standard).reduceMotion(ReduceMotion.System)}
    >
      {snap.lens !== '' && (
        // Own entering animation: the advisory typically appears seconds into
        // aiming (the accumulator needs ~5 snapshots), after the wrap mounted.
        <Animated.View
          entering={FadeInDown.duration(motion.standard).reduceMotion(ReduceMotion.System)}
        >
          <HudChip
            accessible
            accessibilityLabel={lensCopy}
            accessibilityLiveRegion="polite"
            style={styles.lensChip}
          >
            <View style={styles.row}>
              <View style={styles.glyph}>
                <Ionicons
                  name={snap.lens === 'glare' ? 'sunny' : 'water'}
                  size={14}
                  color={color.unsure}
                />
              </View>
              <Text style={styles.lensText}>{lensCopy}</Text>
            </View>
          </HudChip>
        </Animated.View>
      )}
      <HudChip
        accessible
        accessibilityLabel={summary}
        accessibilityLiveRegion="polite"
        style={styles.chip}
      >
        <Text style={styles.eyebrow}>AIM CHECK</Text>
        {snap.steps.map((step) => {
          // Countdown runs only during the hold-steady phase, so the digit
          // always belongs to the current 'doing' row — no step-id coupling.
          const label =
            step.state === 'doing' && snap.digit != null
              ? `${step.label} · ${snap.digit}`
              : step.label;
          return (
            <View key={step.label} style={styles.row}>
              <View style={styles.glyph}>
                {step.state === 'done' ? (
                  <Ionicons name="checkmark-circle" size={16} color={color.make} />
                ) : step.state === 'doing' ? (
                  <Animated.View style={pulseStyle}>
                    <Ionicons name="ellipse-outline" size={16} color={color.accent} />
                  </Animated.View>
                ) : (
                  <Ionicons
                    name="ellipse-outline"
                    size={16}
                    color={color.textDim}
                    style={styles.todoGlyph}
                  />
                )}
              </View>
              <Text
                style={[
                  styles.stepLabel,
                  step.state === 'doing'
                    ? styles.stepDoing
                    : step.state === 'todo'
                      ? styles.stepTodo
                      : null,
                ]}
                numberOfLines={1}
              >
                {label}
              </Text>
            </View>
          );
        })}
        {snap.lowLight && (
          <View style={styles.row}>
            <View style={styles.glyph}>
              <Ionicons name="moon" size={14} color={color.unsure} />
            </View>
            <Text style={styles.lowLight}>
              Low light — move closer or brighten the court
            </Text>
          </View>
        )}
      </HudChip>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: space.lg,
    // Clears the bottom action bar (BOTTOM_BAR_CLEARANCE=56 in live.tsx) with
    // margin; bottom-left stays free of the ghost rim, the landscape docked
    // HUD column on the right, and the top HUD chips. Bottom-anchored column:
    // the lens advisory chip stacks ABOVE the checklist and grows upward.
    bottom: 64 + space.lg,
    alignItems: 'flex-start',
    gap: space.sm,
  },
  chip: {
    alignItems: 'stretch',
    // ≤260 keeps the chip clear of the landscape docked column (300 wide).
    maxWidth: 260,
    gap: space.xs,
  },
  lensChip: {
    alignItems: 'stretch',
    maxWidth: 260,
  },
  lensText: {
    ...type.micro,
    color: color.unsure,
    flexShrink: 1,
  },
  eyebrow: {
    ...type.micro,
    color: color.accent,
    letterSpacing: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  glyph: {
    width: 18,
    alignItems: 'center',
  },
  todoGlyph: {
    opacity: 0.5,
  },
  stepLabel: {
    ...type.caption,
    color: color.textDim,
    flexShrink: 1,
  },
  stepDoing: {
    color: color.text,
  },
  stepTodo: {
    color: color.textDim,
    opacity: 0.6,
  },
  lowLight: {
    ...type.micro,
    color: color.unsure,
    flexShrink: 1,
  },
});
